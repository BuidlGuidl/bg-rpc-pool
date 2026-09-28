// Phase 3c (getLogs plan): history-aware routing for light methods, and the history retry.
// Run: npx jest test/history.test.js
const { select, getProfile } = require('../utils/selectNodes');
const { historyNeed, nodeFloor, covers, isHistoryMiss } = require('../utils/history');

const HEAD = 26000000;
const hex = (n) => '0x' + n.toString(16);
const HASH = '0x' + 'ab'.repeat(32);

function makeNode(id, overrides = {}) {
  return { id, owner: 'o', wsID: `ws-${id}`, machine_id: id, execution_client: 'reth v2.5.0',
    receipt_floor: 25800000, block_number: String(HEAD), suspicious: false, ...overrides };
}
const archive = makeNode('archive', { receipt_floor: 0 });
const pruned1 = makeNode('pruned1');
const pruned2 = makeNode('pruned2');
const geth = makeNode('geth', { execution_client: 'geth v1.16.0', receipt_floor: undefined });

const req = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
const need = (method, params) => historyNeed(req(method, params), getProfile(method));
const snap = (nodes, extra = {}) => ({ nodes, timing: null, heavyCounts: {}, loads: {}, random: () => 0.5, ...extra });
const pickedIds = (decision, nodes) => decision.socketIds.map((ws) => nodes.find((n) => n.wsID === ws).id);

// Every node a request can land on, over many draws
function reachable(rpcRequest, nodes, extra = {}) {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    let x = i;
    const random = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
    const d = select(rpcRequest, snap(nodes, { random, ...extra }));
    if (d.error) return d;
    pickedIds(d, nodes).forEach((id) => seen.add(id));
  }
  return [...seen].sort();
}

describe('historyNeed', () => {
  test('block params: hex, tags, earliest, missing, hash, EIP-1898', () => {
    expect(need('eth_getBlockReceipts', [hex(20000000)])).toEqual({ kind: 'receipts', block: 20000000 });
    expect(need('eth_getBlockReceipts', ['latest'])).toEqual({ kind: 'receipts', head: true });
    expect(need('eth_getBlockReceipts', [HASH])).toEqual({ kind: 'receipts', byHash: true });
    expect(need('eth_getBlockByNumber', ['earliest', false])).toEqual({ kind: 'bodies', block: 0 });
    expect(need('eth_call', [{ to: '0x1' }])).toEqual({ kind: 'state', head: true });
    expect(need('eth_call', [{ to: '0x1' }, 'finalized'])).toEqual({ kind: 'state', head: true });
    expect(need('eth_getStorageAt', ['0x1', '0x0', hex(5)])).toEqual({ kind: 'state', block: 5 });
    expect(need('eth_call', [{}, { blockNumber: hex(7) }])).toEqual({ kind: 'state', block: 7 });
    expect(need('eth_call', [{}, { blockHash: HASH }])).toEqual({ kind: 'state', byHash: true });
    expect(need('eth_getTransactionReceipt', [HASH])).toEqual({ kind: 'receipts', byHash: true });
    expect(need('eth_getTransactionByHash', [HASH])).toEqual({ kind: 'bodies', byHash: true });
  });
  test('getLogs: only a blockHash filter is a lookup; methods without history: null', () => {
    expect(need('eth_getLogs', [{ blockHash: HASH }])).toEqual({ kind: 'receipts', byHash: true });
    expect(need('eth_getLogs', [{ fromBlock: hex(1) }])).toBeNull();
    expect(need('eth_blockNumber', [])).toBeNull();
    expect(need('eth_sendRawTransaction', ['0x00'])).toBeNull();
  });
});

describe('nodeFloor', () => {
  test('pruned reth: receipts at its floor, bodies at 15.5M, state ~10k blocks', () => {
    expect(nodeFloor(pruned1, 'receipts')).toBe(25800000);
    expect(nodeFloor(pruned1, 'bodies')).toBe(15500000);
    expect(nodeFloor(pruned1, 'state')).toBe(HEAD - 10000);
  });
  test('archive reth (floor 0): everything from genesis', () => {
    ['receipts', 'bodies', 'state'].forEach((k) => expect(nodeFloor(archive, k)).toBe(0));
  });
  test('other clients: post-merge bodies and receipts, 128 blocks of state', () => {
    expect(nodeFloor(geth, 'receipts')).toBe(15537394);
    expect(nodeFloor(geth, 'bodies')).toBe(15537394);
    expect(nodeFloor(geth, 'state')).toBe(HEAD - 128);
  });
});

describe('nodeFloor: reported body_floor and state_history (2c) win over the defaults', () => {
  test('reported values', () => {
    const n = makeNode('r', { body_floor: 15000000, state_history: { mode: 'distance', blocks: 20000 } });
    expect(nodeFloor(n, 'bodies')).toBe(15000000);
    expect(nodeFloor(n, 'state')).toBe(HEAD - 20000);
    expect(nodeFloor(makeNode('b', { state_history: { mode: 'before', block: 25000000 } }), 'state')).toBe(25000000);
    // a pruned-receipts node that still keeps all state
    expect(nodeFloor(makeNode('f', { state_history: { mode: 'full' } }), 'state')).toBe(0);
    // archive with the fields: same answers as before
    const a = makeNode('a', { receipt_floor: 0, body_floor: 0, state_history: { mode: 'full' } });
    ['receipts', 'bodies', 'state'].forEach((k) => expect(nodeFloor(a, k)).toBe(0));
  });
  test('null, missing or unfamiliar values fall back to the defaults', () => {
    const n = makeNode('n', { body_floor: null, state_history: null });
    expect(nodeFloor(n, 'bodies')).toBe(15500000);
    expect(nodeFloor(n, 'state')).toBe(HEAD - 10000);
    expect(nodeFloor(makeNode('u', { state_history: { mode: 'weird' } }), 'state')).toBe(HEAD - 10000);
    expect(nodeFloor(makeNode('d', { state_history: { mode: 'distance' } }), 'state')).toBe(HEAD - 10000);
  });
  test('an archive-receipts node that reports pruned state is kept out of old state', () => {
    const odd = makeNode('odd', { receipt_floor: 0, body_floor: 0, state_history: { mode: 'distance', blocks: 10064 } });
    expect(reachable(req('eth_call', [{}, hex(HEAD - 50000)]), [odd, archive])).toEqual(['archive']);
    expect(reachable(req('eth_getBlockReceipts', [hex(20000000)]), [odd, archive])).toEqual(['archive', 'odd']);
  });
});

describe('reth node with an unknown receipt floor (old client, or floor not read yet)', () => {
  const noFloor = makeNode('nofloor', { receipt_floor: null });
  test('never counted as holding old receipts; bodies and state use the reth defaults', () => {
    expect(nodeFloor(noFloor, 'receipts')).toBe(Infinity);
    expect(nodeFloor(noFloor, 'bodies')).toBe(15500000);
    expect(nodeFloor(noFloor, 'state')).toBe(HEAD - 10000);
    expect(nodeFloor(makeNode('old', { receipt_floor: undefined }), 'receipts')).toBe(Infinity);
  });
  test('old receipts by number skip it; head tags and hash lookups still reach it', () => {
    expect(reachable(req('eth_getBlockReceipts', [hex(20000000)]), [noFloor, archive])).toEqual(['archive']);
    expect(reachable(req('eth_getBlockReceipts', [hex(HEAD - 5)]), [noFloor, archive])).toEqual(['archive']);
    expect(reachable(req('eth_getBlockReceipts', ['latest']), [noFloor, archive])).toEqual(['archive', 'nofloor']);
    expect(reachable(req('eth_getTransactionReceipt', [HASH]), [noFloor, archive])).toEqual(['archive', 'nofloor']);
  });
  test('its null on a lookup by hash is a miss retried on a node with a known floor', () => {
    expect(isHistoryMiss({ kind: 'receipts', byHash: true }, { status: 'success', data: null }, noFloor)).toBe(true);
    const d = select(req('eth_getTransactionReceipt', [HASH]),
      snap([noFloor, archive], { exclude: ['nofloor'], retry: true, deeperThan: nodeFloor(noFloor, 'receipts') }));
    expect(d.socketIds).toEqual([archive.wsID]);
  });
  test('alone in the pool: routing as before', () => {
    expect(reachable(req('eth_getBlockReceipts', [hex(20000000)]), [noFloor])).toEqual(['nofloor']);
  });
});

describe('selection', () => {
  const nodes = [archive, pruned1, pruned2];

  test('old receipts, bodies and state go only to the archive node', () => {
    expect(reachable(req('eth_getBlockReceipts', [hex(20000000)]), nodes)).toEqual(['archive']);
    expect(reachable(req('eth_getBlockByNumber', [hex(10000000), true]), nodes)).toEqual(['archive']);
    expect(reachable(req('eth_call', [{ to: '0x1' }, hex(HEAD - 50000)]), nodes)).toEqual(['archive']);
    expect(reachable(req('eth_getBalance', ['0x1', 'earliest']), nodes)).toEqual(['archive']);
  });

  test('history every node holds, head tags and lookups by hash use every node', () => {
    const all = ['archive', 'pruned1', 'pruned2'];
    expect(reachable(req('eth_getBlockReceipts', [hex(25900000)]), nodes)).toEqual(all);
    expect(reachable(req('eth_getBlockByNumber', [hex(20000000), false]), nodes)).toEqual(all);
    expect(reachable(req('eth_call', [{ to: '0x1' }, hex(HEAD - 5000)]), nodes)).toEqual(all);
    expect(reachable(req('eth_call', [{ to: '0x1' }, 'latest']), nodes)).toEqual(all);
    expect(reachable(req('eth_getTransactionReceipt', [HASH]), nodes)).toEqual(all);
  });

  test('comparison sets for old blocks hold only covering nodes', () => {
    const many = [archive, makeNode('archive2', { receipt_floor: 0 }), makeNode('archive3', { receipt_floor: 0 }), pruned1, pruned2];
    for (let i = 0; i < 100; i++) {
      const random = () => ((i * 37 + 11) % 100) / 100;
      const d = select(req('eth_getBlockReceipts', [hex(20000000)]), snap(many, { random }));
      pickedIds(d, many).forEach((id) => expect(id).toMatch(/^archive/));
    }
  });

  test('covering node slow: only-fast rule wins, routing as before (node answers what it has)', () => {
    const timing = { archive: 0.5 };
    expect(reachable(req('eth_getBlockReceipts', [hex(20000000)]), nodes, { timing, slowSpotChecks: false })).toEqual(['pruned1', 'pruned2']);
    // and a history retry finds no fast deeper node
    const r = req('eth_getTransactionReceipt', [HASH]);
    expect(select(r, snap(nodes, { timing, exclude: ['pruned1'], retry: true, deeperThan: 25800000 })).error).toBeDefined();
  });

  test('covering node one block behind still serves old history', () => {
    const behind = makeNode('archive', { receipt_floor: 0, block_number: String(HEAD - 1) });
    expect(reachable(req('eth_getBlockReceipts', [hex(20000000)]), [behind, pruned1, pruned2])).toEqual(['archive']);
  });

  test('geth is kept out of old state, but serves recent state', () => {
    expect(reachable(req('eth_call', [{}, hex(HEAD - 1000)]), [pruned1, geth])).toEqual(['pruned1']);
    expect(reachable(req('eth_call', [{}, hex(HEAD - 10)]), [pruned1, geth])).toEqual(['geth', 'pruned1']);
  });
});

describe('history retry (deeperThan)', () => {
  const nodes = [archive, pruned1, pruned2];

  test('after a miss on a pruned node, only a node with deeper history is picked', () => {
    const r = req('eth_getTransactionReceipt', [HASH]);
    expect(reachable(r, nodes, { exclude: ['pruned1'], retry: true, deeperThan: 25800000 })).toEqual(['archive']);
  });

  test('no deeper node: error, so the first answer stands', () => {
    const r = req('eth_getTransactionReceipt', [HASH]);
    const d = select(r, snap(nodes, { exclude: ['archive'], retry: true, deeperThan: 0 }));
    expect(d.error).toBeDefined();
    expect(d.reason).toBe('no deeper history');
  });

  test('getLogs by blockHash: heavy retry on a reth node with a lower floor', () => {
    const r = req('eth_getLogs', [{ blockHash: HASH }]);
    const d = select(r, snap(nodes, { exclude: ['pruned1'], deeperThan: 25800000 }));
    expect(pickedIds(d, nodes)).toEqual(['archive']);
    expect(d.heavy).toBeTruthy();
  });
});

describe('isHistoryMiss', () => {
  const byHash = { kind: 'receipts', byHash: true };
  test('null on a lookup by hash, and "pruned" errors, are misses', () => {
    expect(isHistoryMiss(byHash, { status: 'success', data: null }, pruned1)).toBe(true);
    expect(isHistoryMiss({ kind: 'state', byHash: true },
      { status: 'error', data: { code: -32603, message: 'state at block #20000001 is pruned' } }, pruned1)).toBe(true);
    expect(isHistoryMiss({ kind: 'bodies', byHash: true },
      { status: 'error', data: { code: 4444, message: 'pruned history unavailable: requested 1, earliest available 15500000' } }, pruned1)).toBe(true);
    expect(isHistoryMiss(byHash, { status: 'error', data: { code: -32001, message: 'block not found' } }, pruned1)).toBe(true);
  });
  test('real answers, other errors, and nulls for blocks the node covers are not', () => {
    expect(isHistoryMiss(byHash, { status: 'success', data: { status: '0x1' } }, pruned1)).toBe(false);
    expect(isHistoryMiss(byHash, { status: 'error', data: { code: 3, message: 'execution reverted' } }, pruned1)).toBe(false);
    expect(isHistoryMiss({ kind: 'bodies', block: HEAD + 5 }, { status: 'success', data: null }, pruned1)).toBe(false);
    expect(isHistoryMiss({ kind: 'receipts', block: 20000000 }, { status: 'success', data: null }, pruned1)).toBe(true);
    expect(isHistoryMiss(null, { status: 'success', data: null }, pruned1)).toBe(false);
  });
});
