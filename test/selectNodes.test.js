// Phase 3b (getLogs plan): select() vs the pre-3b code (routeLegacy.js).
// 3b-1 matched it exactly; 3b-3 changes behavior on purpose (power of two, D13), so the generated
// cases now check rules and the differences from the old code that D13 allows.
// Run: npx jest test/selectNodes.test.js
const config = require('../config');
const { setNodeTimingData } = require('../utils/nodeTimingUtils');
const heavyInFlight = require('../utils/heavyInFlight');
const { select, takeSnapshot, resolveFromBlock, getHeavyStatus } = require('../utils/selectNodes');
const nodeLoad = require('../utils/nodeLoad');
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
// cost (3b-2) and reason are new in select(); the old code has neither
const strip = (d) => { const { reason, cost, ...rest } = d; return rest; };
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

describe('generated pools: 3b-3 rules, and differences from the old code only where D13 allows', () => {
  const METHODS = ['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_chainId', 'eth_getBlockReceipts',
    'eth_getBlockByNumber', 'net_version', 'txpool_status', 'unknown_method',
    'eth_getLogs', 'eth_getLogs', 'eth_getLogs', 'eth_getLogs',
    'eth_newFilter', 'eth_getFilterChanges', 'eth_newBlockFilter', 'eth_uninstallFilter'];
  const FROMS = [undefined, 'latest', 'safe', 'finalized', 'earliest', 'pending', hex(24000000), hex(25300000),
    hex(25500000), hex(25800000), hex(HEAD - 100), '12345', 42];
  const COMPARE = new Set(['eth_call', 'eth_getBalance', 'eth_getBlockReceipts', 'eth_getBlockByNumber', 'unknown_method']);

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
    if (r() < 0.08) filter.blockHash = '0xabc';
    else {
      const from = FROMS[Math.floor(r() * FROMS.length)];
      if (from !== undefined) filter.fromBlock = from;
      if (r() < 0.2) filter.toBlock = r() < 0.3 ? 'pending' : 'latest';
    }
    const shape = r();
    const params = shape < 0.7 ? [filter] : shape < 0.9 ? { filter } : r() < 0.5 ? [] : 'garbage';
    return { jsonrpc: '2.0', id: 1, method, params };
  }

  const eligible = (n) => n.id && n.owner && n.wsID && n.machine_id && n.machine_id !== 'N/A' && !n.suspicious &&
    n.block_number !== undefined && n.block_number !== null && n.block_number !== 'N/A' && !isNaN(parseInt(n.block_number));
  const isFastNode = (n, timing) => !timing || !n.id || n.id === 'N/A' || timing[n.id] === undefined || timing[n.id] <= 0.05;
  const blockOf = (n) => parseInt(n.block_number);

  function checkLight(request, nodes, timing, legacy, pipeline, fail) {
    const fast = nodes.filter((n) => eligible(n) && isFastNode(n, timing));
    if (fast.length === 0) {
      if (pipeline.error?.code !== -69000) fail('light with no fast node must be -69000');
      if (legacy.error?.code !== -69000) fail('old code served with no fast node');
      return;
    }
    if (pipeline.error || legacy.error) return fail('light with a fast node must be served (old and new)');
    const target = Math.max(...fast.map(blockOf));
    const picked = pipeline.socketIds.map((ws) => nodes.find((n) => n.wsID === ws));
    if (new Set(pipeline.socketIds).size !== picked.length) fail('duplicate node');
    if (!picked.every((n) => eligible(n) && blockOf(n) === target)) fail('picked a node not at the exact highest block among fast nodes');
    if (!isFastNode(picked[0], timing)) fail('first node is slow');
    if (pipeline.handler === 'single') {
      if (picked.length !== 1 || !isFastNode(picked[0], timing)) fail('single: one fast node (the retry is chosen later, 3b-4)');
    } else {
      if (!COMPARE.has(request.method)) fail('comparison for a method that skips it');
      if (picked.length !== 3 || picked.filter((n) => !isFastNode(n, timing)).length > 2) fail('set: 3 nodes, at most 2 slow');
    }

    // 3b-4: a retry without the first node → another fast node at the highest block among
    // the remaining fast nodes, or none
    const tried = picked[0];
    const retry = withSeed(7, () => select(request, { ...takeSnapshot(poolOf(nodes)), exclude: [tried.id], retry: true }));
    const otherFast = fast.filter((n) => n.id !== tried.id);
    if (otherFast.length === 0) {
      if (retry.error?.code !== -69000) fail('retry with no other fast node must find none');
    } else {
      const node = nodes.find((n) => n.wsID === retry.socketIds?.[0]);
      const retryTarget = Math.max(...otherFast.map(blockOf));
      if (retry.error || retry.socketIds.length !== 1 || retry.handler !== 'single') fail('retry: exactly one node, never a comparison set');
      else if (node.id === tried.id || !isFastNode(node, timing) || blockOf(node) !== retryTarget) fail('retry picked the tried node, a slow node, or one not at the highest block');
    }
  }

  function checkHeavy(request, nodes, timing, legacy, pipeline, fail) {
    const resolved = resolveFromBlock(request);
    if (resolved.error) {
      if (JSON.stringify(pipeline.error) !== JSON.stringify(resolved.error)) fail('pending must be rejected as before');
      return;
    }
    if (!pipeline.error) {
      const node = nodes.find((n) => n.wsID === pipeline.socketIds[0]);
      const ok = eligible(node) && node.execution_client?.startsWith('reth') && Number.isFinite(node.receipt_floor) &&
        (resolved.fromBlock === null || node.receipt_floor <= resolved.fromBlock) && isFastNode(node, timing) &&
        nodeLoad.heavyCount(node.id) < 4;
      if (!ok || pipeline.socketIds.length !== 1) fail('getLogs picked an ineligible node');
    }
    // vs the old code
    if (legacy.error) {
      if (legacy.error.code === -32005) { if (pipeline.error?.code !== -32005) fail('old -32005 must stay -32005'); }
      else if (JSON.stringify(pipeline.error) !== JSON.stringify(legacy.error)) fail('old error must be unchanged');
    } else {
      const oldNode = nodes.find((n) => n.wsID === legacy.socketIds[0]);
      if (isFastNode(oldNode, timing) && pipeline.error) fail('old code served from a fast node; new must serve too');
      if (!isFastNode(oldNode, timing) && pipeline.error?.code !== -32005) fail('old code used a slow node; new must answer -32005 (D13)');
    }
  }

  test('20,000 generated cases follow the rules', () => {
    const gen = mulberry32(20260925);
    const failures = [];
    const counts = {};
    for (let i = 0; i < 20000 && failures.length < 5; i++) {
      const nodes = randomPool(gen, i);
      const timing = randomTiming(gen, nodes);
      for (const node of nodes) {
        if (!node.id) continue;
        const k = Math.floor(gen() * 6);
        for (let j = 0; j < k; j++) heavyInFlight.acquire(node.id, node.wsID);            // heavy (cost 1)
        const light = Math.floor(gen() * 4);
        for (let j = 0; j < light; j++) nodeLoad.acquire(node.id, node.wsID, { cost: 1 + Math.floor(gen() * 11) });
      }
      const request = randomRequest(gen);
      const seed = Math.floor(gen() * 1e9);
      const { legacy, pipeline } = decideBoth(poolOf(nodes), request, timing, seed);
      const fail = (why) => failures.push({ why, i, request, timing, nodes, legacy, pipeline });

      if (config.disabledMethods.includes(request.method)) {
        if (JSON.stringify(pipeline.error) !== JSON.stringify(legacy.error)) fail('disabled must be unchanged');
      } else if (config.heavyMethods[request.method]) {
        checkHeavy(request, nodes, timing, legacy, pipeline, fail);
      } else {
        checkLight(request, nodes, timing, legacy, pipeline, fail);
      }
      for (const node of nodes) nodeLoad.releaseSocket(node.wsID);

      const key = pipeline.error ? `error ${pipeline.error.code}` : `${pipeline.heavy ? 'heavy' : 'light'} ${pipeline.handler} x${pipeline.socketIds.length}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    realConsoleLog('outcome mix over 20,000 cases:', JSON.stringify(counts));
    expect(failures.map((f) => f.why)).toEqual([]);
    expect(nodeLoad.heavyTotal()).toBe(0);
  });
});

describe('power of two choices', () => {
  const nodes = ['a', 'b', 'c'].map((id) => makeNode(id));
  const pickFirst = (loads, seed, method = 'eth_chainId') =>
    withSeed(seed, () => select({ jsonrpc: '2.0', id: 1, method, params: [] }, { nodes, timing: null, heavyCounts: {}, loads })).socketIds[0];
  const share = (loads, ws, n = 3000) => { let k = 0; for (let s = 0; s < n; s++) if (pickFirst(loads, s) === ws) k++; return k / n; };

  test('equal loads: roughly even', () => {
    for (const ws of ['ws-a', 'ws-b', 'ws-c']) expect(share({ a: 0, b: 0, c: 0 }, ws)).toBeGreaterThan(0.28);
  });
  test('one idle node among busy ones wins whenever it is drawn (2 of 3 draws)', () => {
    const p = share({ a: 0, b: 10, c: 10 }, 'ws-a');
    expect(p).toBeGreaterThan(0.62); expect(p).toBeLessThan(0.71);
  });
  test('the busiest node is never the first pick while others are less loaded', () => {
    expect(share({ a: 0, b: 1, c: 100 }, 'ws-c')).toBe(0);
  });
  test('getLogs: same rule, on weighted load', () => {
    const snap = (loads) => ({ nodes, timing: null, heavyCounts: {}, loads });
    let busy = 0;
    for (let s = 0; s < 2000; s++) {
      const d = withSeed(s, () => select(getLogs({ fromBlock: 'latest' }), snap({ a: 44, b: 0, c: 0 })));
      if (d.socketIds[0] === 'ws-a') busy++;
    }
    expect(busy).toBe(0);
  });
});

describe('D13: fast/slow is a hard switch', () => {
  const nodes = ['f1', 'f2', 's1', 's2'].map((id) => makeNode(id));
  const timing = { s1: 0.5, s2: 0.2 };
  const decide = (seed, method = 'eth_call', flags = {}) =>
    withSeed(seed, () => select({ jsonrpc: '2.0', id: 1, method, params: [] }, { nodes, timing, heavyCounts: {}, loads: {}, ...flags }));

  test('retry: never the tried node, never slow, even when only slow nodes are left → none', () => {
    const snap = (exclude) => ({ nodes, timing, heavyCounts: {}, loads: {}, exclude, retry: true });
    for (let s = 0; s < 500; s++) {
      expect(withSeed(s, () => select({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, snap(['f1']))).socketIds).toEqual(['ws-f2']);
    }
    expect(select({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, snap(['f1', 'f2'])).error.code).toBe(-69000);
  });

  test('retry picks by load at retry time', () => {
    const three = ['a', 'b', 'c'].map((id) => makeNode(id));
    let toBusy = 0;
    for (let s = 0; s < 1000; s++) {
      const d = withSeed(s, () => select({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] },
        { nodes: three, timing: null, heavyCounts: {}, loads: { b: 30, c: 0 }, exclude: ['a'], retry: true }));
      if (d.socketIds[0] === 'ws-b') toBusy++;
    }
    expect(toBusy).toBe(0);
  });

  test('slow nodes never take a first attempt or a retry; only comparison sets, at most 2, ~1 in 20', () => {
    let sets = 0;
    for (let s = 0; s < 4000; s++) {
      const d = decide(s);
      expect(['ws-f1', 'ws-f2']).toContain(d.socketIds[0]);
      if (d.handler === 'single') expect(d.socketIds.every((ws) => ws.startsWith('ws-f'))).toBe(true);
      else { sets++; expect(d.socketIds.filter((ws) => ws.startsWith('ws-s')).length).toBeLessThanOrEqual(2); }
    }
    expect(sets / 4000).toBeGreaterThan(0.03); expect(sets / 4000).toBeLessThan(0.07);
  });
  test('slowSpotChecks off: slow nodes get nothing', () => {
    for (let s = 0; s < 4000; s++) expect(decide(s, 'eth_call', { slowSpotChecks: false }).socketIds.every((ws) => ws.startsWith('ws-f'))).toBe(true);
  });
  test('methods that skip comparison never reach slow nodes', () => {
    for (let s = 0; s < 1000; s++) expect(decide(s, 'eth_chainId').socketIds.every((ws) => ws.startsWith('ws-f'))).toBe(true);
  });
  test('all slow: light → -69000; getLogs → -32005; slow nodes are not "ready" for getLogs', () => {
    const slowOnly = poolOf(['s1', 's2'].map((id) => makeNode(id)));
    expect(decideBoth(slowOnly, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, timing, 1).pipeline.error.code).toBe(-69000);
    expect(decideBoth(slowOnly, getLogs({ fromBlock: 'latest' }), timing, 1).pipeline.error).toEqual(
      { code: -32005, message: 'eth_getLogs unavailable: no healthy nodes for this range, retry shortly' });
    setNodeTimingData(timing);
    expect(getHeavyStatus(slowOnly).readyNodes).toBe(0);
    expect(getHeavyStatus(poolOf(nodes)).readyNodes).toBe(2);
    setNodeTimingData(null);
  });
  test('M11: getLogs never uses the slow node; -32005 when the fast one is full', () => {
    const pool = poolOf([makeNode('fast'), makeNode('slow')]);
    const t = { slow: 0.5 };
    for (let s = 0; s < 200; s++) expect(decideBoth(pool, getLogs({ fromBlock: 'latest' }), t, s).pipeline.socketIds).toEqual(['ws-fast']);
    for (let j = 0; j < 4; j++) heavyInFlight.acquire('fast', 'ws-fast');
    expect(decideBoth(pool, getLogs({ fromBlock: 'latest' }), t, 1).pipeline.error.code).toBe(-32005);
    heavyInFlight.releaseSocket('ws-fast');
  });
});

// Fixed cases from the plan (3b tests).
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
