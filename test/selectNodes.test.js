// Phase 3b-1 (getLogs plan): select() must make exactly the same decisions as the pre-3b code.
// Run: npx jest test/selectNodes.test.js
const config = require('../config');
const { setNodeTimingData } = require('../utils/nodeTimingUtils');
const heavyInFlight = require('../utils/heavyInFlight');
const { select, takeSnapshot } = require('../utils/selectNodes');
const { decideLegacy } = require('../utils/routeLegacy');

// Config lists as they were written before the profile table (2026-09-25)
const LEGACY_LISTS = {
  "nodeDefaultTimeout": 3000,
  "nodeMethodSpecificTimeouts": {
    "eth_getBlockReceipts": 2000,
    "eth_getBlockByNumber": 1500,
    "eth_getBlockByHash": 1500,
    "eth_getLogs": 10000,
    "eth_getTransactionReceipt": 2000
  },
  "methodsToSkipComparison": [
    "eth_chainId",
    "net_version",
    "eth_protocolVersion",
    "eth_accounts",
    "eth_syncing",
    "eth_mining",
    "eth_hashrate",
    "eth_coinbase",
    "net_listening",
    "net_peerCount",
    "web3_clientVersion",
    "web3_sha3",
    "eth_blockNumber",
    "eth_gasPrice",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
    "eth_getLogs",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
    "eth_uninstallFilter",
    "eth_newFilter",
    "eth_newBlockFilter",
    "eth_newPendingTransactionFilter",
    "eth_pendingTransactions",
    "txpool_status",
    "txpool_content",
    "txpool_inspect"
  ],
  "heavyMethods": {
    "eth_getLogs": {
      "timeout": 5000,
      "retry": false,
      "maxPerNode": 4
    },
    "eth_getFilterLogs": {
      "timeout": 5000,
      "retry": false,
      "maxPerNode": 4
    },
    "eth_newFilter": {
      "timeout": 3000,
      "retry": false,
      "maxPerNode": 4
    },
    "eth_getFilterChanges": {
      "timeout": 3000,
      "retry": false,
      "maxPerNode": 4
    }
  },
  "disabledMethods": [
    "eth_newFilter",
    "eth_newBlockFilter",
    "eth_newPendingTransactionFilter",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
    "eth_uninstallFilter"
  ]
};

// Seeded PRNG so both implementations see the same random numbers
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEAD = 26056000;
const hex = (n) => '0x' + n.toString(16);
const strip = (d) => { const { reason, ...rest } = d; return rest; };
const realRandom = Math.random;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  Math.random = realRandom;
  setNodeTimingData(null);
  jest.restoreAllMocks();
});

function withSeed(seed, fn) {
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = realRandom; }
}

// Runs legacy and pipeline on the same pool with the same seed
function decideBoth(poolMap, request, timing, seed) {
  setNodeTimingData(timing);
  const legacy = withSeed(seed, () => decideLegacy(request, poolMap));
  const pipeline = withSeed(seed, () => select(request, takeSnapshot(poolMap)));
  return { legacy, pipeline };
}

function makeNode(id, overrides = {}) {
  return { id, owner: 'o', wsID: `ws-${id}`, machine_id: id, execution_client: 'reth v2.5.0',
    receipt_floor: 25300000, block_number: String(HEAD), suspicious: false, ...overrides };
}
const poolOf = (nodes) => new Map(nodes.map((n) => [n.wsID || n.id, n]));
const getLogs = (filter) => ({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [filter] });

describe('config: profile table reproduces the old lists', () => {
  test('timeouts (entries used on the live path), comparison skips, heavy, disabled', () => {
    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort());
    const oldT = { ...LEGACY_LISTS.nodeMethodSpecificTimeouts };
    delete oldT.eth_getLogs; // rollback-only entry (10 s); heavy methods use their heavy timeout
    const newT = { ...config.nodeMethodSpecificTimeouts };
    delete newT.eth_getLogs; delete newT.eth_getFilterLogs;
    expect(sortObj(newT)).toEqual(sortObj(oldT));
    expect([...config.methodsToSkipComparison].sort()).toEqual([...LEGACY_LISTS.methodsToSkipComparison].sort());
    expect(sortObj(config.heavyMethods)).toEqual(sortObj(LEGACY_LISTS.heavyMethods));
    expect([...config.disabledMethods].sort()).toEqual([...LEGACY_LISTS.disabledMethods].sort());
  });
});

describe('parity: select() === legacy decision on generated pools', () => {
  const METHODS = ['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_chainId', 'eth_getBlockReceipts',
    'eth_getBlockByNumber', 'net_version', 'txpool_status', 'unknown_method',
    'eth_getLogs', 'eth_getLogs', 'eth_getLogs', 'eth_getLogs',
    'eth_newFilter', 'eth_getFilterChanges', 'eth_newBlockFilter', 'eth_uninstallFilter'];
  const FROMS = [undefined, 'latest', 'safe', 'finalized', 'earliest', 'pending', hex(24000000), hex(25300000),
    hex(25500000), hex(25800000), hex(HEAD - 100), '12345', 42];

  function randomPool(r, caseId) {
    const n = Math.floor(r() * 11);
    const nodes = [];
    for (let k = 0; k < n; k++) {
      const id = r() < 0.05 ? (r() < 0.5 ? 'N/A' : undefined) : `n${k}-c${caseId}`;
      const client = r() < 0.6 ? 'reth v2.5.0' : r() < 0.5 ? 'geth v1.16.1' : r() < 0.5 ? 'nethermind v1.30' : undefined;
      const floor = [25300000, 25800000, 25800000, null, undefined][Math.floor(r() * 5)];
      const lag = [0, 0, 0, 1, 2][Math.floor(r() * 5)];
      const block = r() < 0.05 ? ['SUSPICIOUS', 'N/A', undefined, null][Math.floor(r() * 4)] : String(HEAD - lag);
      nodes.push({
        id, wsID: `ws${k}-c${caseId}`,
        owner: r() < 0.05 ? undefined : 'owner',
        machine_id: r() < 0.05 ? (r() < 0.5 ? 'N/A' : null) : id,
        suspicious: r() < 0.08,
        execution_client: client,
        receipt_floor: client && client.startsWith('reth') ? floor : undefined,
        block_number: block,
      });
    }
    return nodes;
  }

  function randomTiming(r, nodes) {
    if (r() < 0.3) return null;
    const t = {};
    for (const node of nodes) if (node.id && r() < 0.7) t[node.id] = [0, 0.01, 0.05, 0.051, 0.2, 0.9][Math.floor(r() * 6)];
    return t;
  }

  function randomRequest(r) {
    const method = METHODS[Math.floor(r() * METHODS.length)];
    if (method !== 'eth_getLogs' && method !== 'eth_newFilter') return { jsonrpc: '2.0', id: 1, method, params: [] };
    const filter = {};
    const roll = r();
    if (roll < 0.08) filter.blockHash = '0xabc';
    else {
      const from = FROMS[Math.floor(r() * FROMS.length)];
      if (from !== undefined) filter.fromBlock = from;
      if (r() < 0.2) filter.toBlock = r() < 0.3 ? 'pending' : 'latest';
    }
    const shape = r();
    const params = shape < 0.7 ? [filter] : shape < 0.9 ? { filter } : r() < 0.5 ? [] : 'garbage';
    return { jsonrpc: '2.0', id: 1, method, params };
  }

  test('20,000 generated cases decide identically', () => {
    const gen = mulberry32(20260925);
    const mismatches = [];
    const counts = {};
    for (let i = 0; i < 20000; i++) {
      const nodes = randomPool(gen, i);
      const timing = randomTiming(gen, nodes);
      // In-flight heavy requests: 0-5 per node
      for (const node of nodes) {
        if (!node.id) continue;
        const k = Math.floor(gen() * 6);
        for (let j = 0; j < k; j++) heavyInFlight.acquire(node.id, node.wsID);
      }
      const request = randomRequest(gen);
      const seed = Math.floor(gen() * 1e9);
      const { legacy, pipeline } = decideBoth(poolOf(nodes), request, timing, seed);
      for (const node of nodes) heavyInFlight.releaseSocket(node.wsID);

      const key = legacy.error ? `error ${legacy.error.code}` : `${legacy.heavy ? 'heavy' : 'light'} ${legacy.handler} x${legacy.socketIds.length}`;
      counts[key] = (counts[key] || 0) + 1;
      if (JSON.stringify(strip(pipeline)) !== JSON.stringify(strip(legacy))) {
        mismatches.push({ i, request, timing, nodes, legacy, pipeline });
        if (mismatches.length >= 5) break;
      }
    }
    realConsoleLog('outcome mix over 20,000 cases:', JSON.stringify(counts));
    expect(mismatches).toEqual([]);
    expect(heavyInFlight.total()).toBe(0);
  });
});

// Fixed cases from the plan (3b tests). Behavior is still pre-3b here; D13 changes come in 3b-3.
describe('fixed cases', () => {
  test('a geth node one block ahead is never picked for getLogs', () => {
    const pool = poolOf([makeNode('geth', { execution_client: 'geth v1.16', receipt_floor: undefined, block_number: String(HEAD + 1) }),
      makeNode('reth')]);
    for (let s = 0; s < 50; s++) {
      const { pipeline } = decideBoth(pool, getLogs({ fromBlock: 'latest' }), null, s);
      expect(pipeline.socketIds).toEqual(['ws-reth']);
    }
  });

  test('below every floor → -32602 naming the lowest floor (positional and by-name)', () => {
    const pool = poolOf([makeNode('a', { receipt_floor: 25300000 }), makeNode('b', { receipt_floor: 25800000 })]);
    for (const request of [getLogs({ fromBlock: hex(25000000) }), { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: { filter: { fromBlock: 'earliest' } } }]) {
      const { pipeline } = decideBoth(pool, request, null, 1);
      expect(pipeline.error).toEqual({ code: -32602, message: 'Logs older than block 25300000 are not available on this endpoint' });
    }
  });

  test('a range only one node covers goes to it; -32005 when it is full', () => {
    const pool = poolOf([makeNode('deep', { receipt_floor: 25300000 }), makeNode('shallow', { receipt_floor: 25800000 })]);
    expect(decideBoth(pool, getLogs({ fromBlock: hex(25500000) }), null, 1).pipeline.socketIds).toEqual(['ws-deep']);
    for (let j = 0; j < 4; j++) heavyInFlight.acquire('deep', 'ws-deep');
    expect(decideBoth(pool, getLogs({ fromBlock: hex(25500000) }), null, 1).pipeline.error.code).toBe(-32005);
    expect(decideBoth(pool, getLogs({ fromBlock: 'latest' }), null, 1).pipeline.socketIds).toEqual(['ws-shallow']);
    heavyInFlight.releaseSocket('ws-deep');
  });

  test('blockHash skips the floor check; pending is rejected', () => {
    const pool = poolOf([makeNode('a', { receipt_floor: 25800000 })]);
    expect(decideBoth(pool, getLogs({ blockHash: '0xabc' }), null, 1).pipeline.socketIds).toEqual(['ws-a']);
    expect(decideBoth(pool, getLogs({ fromBlock: 'latest', toBlock: 'pending' }), null, 1).pipeline.error.code).toBe(-32602);
  });

  test('disabled filter methods → -32601; no nodes → -69000', () => {
    const pool = poolOf([makeNode('a')]);
    expect(decideBoth(pool, { jsonrpc: '2.0', id: 1, method: 'eth_newFilter', params: [{}] }, null, 1).pipeline.error.code).toBe(-32601);
    expect(decideBoth(new Map(), { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, null, 1).pipeline.error.code).toBe(-69000);
  });

  test('light: with 3+ nodes a fast node goes first; comparison only for methods that allow it', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => makeNode(id));
    const timing = { a: 0.5, b: 0.5, c: 0.01 }; // a, b slow; c, d fast
    for (let s = 0; s < 200; s++) {
      const { pipeline } = decideBoth(poolOf(nodes), { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, timing, s);
      expect(['ws-c', 'ws-d']).toContain(pipeline.socketIds[0]);
      const skip = decideBoth(poolOf(nodes), { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, timing, s).pipeline;
      expect(skip.handler).toBe('single');
    }
  });
});

const realConsoleLog = console.log.bind(console);
