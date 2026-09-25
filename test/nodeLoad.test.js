// Phase 3b-2 (getLogs plan): in-flight load tracking for every request.
// Run: npx jest test/nodeLoad.test.js
// logNode / compareResults / logCompareResults are mocked: they write to the real stage logs and
// compareResults can send Telegram alerts.
jest.mock('../utils/logNode', () => ({ logNode: jest.fn() }));
jest.mock('../utils/compareResults', () => ({ compareResults: jest.fn(() => ({ status: 'match' })) }));
jest.mock('../utils/logCompareResults', () => ({ logCompareResults: jest.fn() }));

const nodeLoad = require('../utils/nodeLoad');
const { requestCost, getProfile, select } = require('../utils/selectNodes');
const { handleRequestSingle } = require('../utils/handleRequestSingle');
const { handleRequestSet } = require('../utils/handleRequestSet');
const { nodeDefaultTimeout, heavyInFlightMaxAge } = require('../config');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const hex = (n) => '0x' + n.toString(16);
const HEAD = 26056000;

describe('nodeLoad', () => {
  afterEach(() => ['ws-a', 'ws-a2', 'ws-b'].forEach(nodeLoad.releaseSocket));

  test('weighted load, heavy count and count; release by token', () => {
    const t1 = nodeLoad.acquire('a', 'ws-a', { cost: 1 });
    nodeLoad.acquire('a', 'ws-a', { cost: 11, heavy: true });
    nodeLoad.acquire('b', 'ws-b', { cost: 2 });
    expect([nodeLoad.load('a'), nodeLoad.heavyCount('a'), nodeLoad.count('a')]).toEqual([12, 1, 2]);
    expect([nodeLoad.load('b'), nodeLoad.heavyTotal()]).toEqual([2, 1]);
    nodeLoad.release('a', t1);
    nodeLoad.release('a', t1); // idempotent
    expect([nodeLoad.load('a'), nodeLoad.count('a')]).toEqual([11, 1]);
  });

  test('a disconnect releases only that socket\'s requests (node id is stable across reconnects)', () => {
    nodeLoad.acquire('a', 'ws-a', { cost: 3 });
    nodeLoad.acquire('a', 'ws-a2', { cost: 5 }); // same node, new socket after a reconnect
    nodeLoad.releaseSocket('ws-a');
    expect(nodeLoad.load('a')).toBe(5);
  });

  test('entries older than heavyInFlightMaxAge are dropped', () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    nodeLoad.acquire('a', 'ws-a', { cost: 4 });
    spy.mockReturnValue(now + heavyInFlightMaxAge + 1);
    expect(nodeLoad.load('a')).toBe(0);
    spy.mockRestore();
  });
});

describe('requestCost (proposed weights: default 1, receipts 2, getLogs 1 + ceil(blocks/1000))', () => {
  const cost = (method, params) => requestCost({ method, params }, getProfile(method), HEAD);
  test.each([
    ['eth_call', [], 1],
    ['eth_getBalance', [], 1],
    ['eth_getBlockReceipts', ['0x1'], 2],
    ['eth_getLogs', [{ fromBlock: hex(HEAD - 99), toBlock: hex(HEAD) }], 2],           // 100 blocks
    ['eth_getLogs', [{ fromBlock: hex(HEAD - 1000), toBlock: hex(HEAD) }], 3],         // 1,001 blocks
    ['eth_getLogs', [{ fromBlock: hex(HEAD - 9999), toBlock: hex(HEAD) }], 11],        // 10,000 blocks
    ['eth_getLogs', [{ fromBlock: hex(HEAD - 49999), toBlock: hex(HEAD) }], 11],       // capped at 10k
    ['eth_getLogs', [{ fromBlock: hex(HEAD - 99) }], 2],                               // toBlock = latest
    ['eth_getLogs', [{ fromBlock: 'latest' }], 2],                                     // 1 block
    ['eth_getLogs', [{}], 2],
    ['eth_getLogs', [{ blockHash: '0xabc' }], 2],
    ['eth_getLogs', { filter: { fromBlock: hex(HEAD - 4999), toBlock: hex(HEAD) } }, 6], // by-name
    ['eth_getLogs', [{ fromBlock: 'earliest' }], 11],
    ['eth_getLogs', [{ fromBlock: hex(HEAD), toBlock: hex(HEAD - 10) }], 2],            // from > to: reth rejects
    ['eth_getLogs', [{ fromBlock: 'garbage' }], 2],
    ['eth_getLogs', 'garbage', 2],
  ])('%s %j → %i', (method, params, expected) => expect(cost(method, params)).toBe(expected));

  test('select() puts the cost on the decision', () => {
    const node = { id: 'r', owner: 'o', wsID: 'ws-r', machine_id: 'r', execution_client: 'reth v2.5.0',
      receipt_floor: 25300000, block_number: String(HEAD) };
    const snap = { nodes: [node], timing: null, heavyCounts: {}, loads: {} };
    expect(select({ method: 'eth_getLogs', params: [{ fromBlock: hex(HEAD - 9999) }] }, snap).cost).toBe(11);
    expect(select({ method: 'eth_getBlockReceipts', params: ['latest'] }, snap).cost).toBe(2);
    expect(select({ method: 'eth_call', params: [] }, snap).cost).toBe(1);
  });
});

// Fake Socket.IO: emit() keeps the ack so the test decides when (or whether) the node answers
function fakeIo(wsIDs) {
  const sockets = new Map();
  const pending = {};
  for (const ws of wsIDs) {
    pending[ws] = [];
    sockets.set(ws, { disconnected: false, emit: (event, req, ack) => pending[ws].push(ack) });
  }
  return { io: { sockets: { sockets } }, pending };
}
const poolOf = (ids) => new Map(ids.map((id) => [`ws-${id}`, { id, owner: 'o', wsID: `ws-${id}` }]));
const answer = (ack) => ack({ jsonrpc: '2.0', id: 1, result: '0x1' });

describe('dispatch counts load from send until the node answers or disconnects', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); ['ws-a', 'ws-b', 'ws-c'].forEach(nodeLoad.releaseSocket); });

  test('handleRequestSingle: counted while in flight, released on the answer', async () => {
    const { io, pending } = fakeIo(['ws-a']);
    const p = handleRequestSingle({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, ['ws-a'], poolOf(['a']), io, null, 1);
    expect(nodeLoad.load('a')).toBe(1);
    answer(pending['ws-a'][0]);
    await expect(p).resolves.toMatchObject({ status: 'success' });
    expect(nodeLoad.load('a')).toBe(0);
  });

  test('timeout does NOT release; the late answer does; the retry node is counted separately', async () => {
    const { io, pending } = fakeIo(['ws-a', 'ws-b']);
    const p = handleRequestSingle({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, ['ws-a', 'ws-b'], poolOf(['a', 'b']), io, null, 1);
    jest.advanceTimersByTime(nodeDefaultTimeout + 1);             // a times out → retry on b
    for (let i = 0; i < 20 && pending['ws-b'].length === 0; i++) await Promise.resolve();
    expect(pending['ws-b'].length).toBe(1);
    expect([nodeLoad.load('a'), nodeLoad.load('b')]).toEqual([1, 1]);
    answer(pending['ws-b'][0]);
    await expect(p).resolves.toMatchObject({ status: 'success' });
    expect([nodeLoad.load('a'), nodeLoad.load('b')]).toEqual([1, 0]); // a still working
    answer(pending['ws-a'][0]);                                    // late answer from a
    expect(nodeLoad.load('a')).toBe(0);
  });

  test('3b-4: after a timeout the retry goes to the node chosen at that moment, not the pre-picked one', async () => {
    const { io, pending } = fakeIo(['ws-a', 'ws-b', 'ws-c']);
    const selectRetry = jest.fn(() => 'ws-c');
    const p = handleRequestSingle({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, ['ws-a', 'ws-b'],
      poolOf(['a', 'b', 'c']), io, null, 1, selectRetry);
    jest.advanceTimersByTime(nodeDefaultTimeout + 1);
    for (let i = 0; i < 20 && pending['ws-c'].length === 0; i++) await Promise.resolve();
    expect(selectRetry).toHaveBeenCalledWith(['a']);
    expect([pending['ws-b'].length, pending['ws-c'].length]).toEqual([0, 1]);
    answer(pending['ws-c'][0]);
    await expect(p).resolves.toMatchObject({ status: 'success' });
  });

  test('3b-4: no node for the retry → no retry, the timeout goes back to bg-rpc-proxy', async () => {
    const { io, pending } = fakeIo(['ws-a', 'ws-b']);
    const selectRetry = jest.fn(() => null);
    const p = handleRequestSingle({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, ['ws-a'],
      poolOf(['a', 'b']), io, null, 1, selectRetry);
    jest.advanceTimersByTime(nodeDefaultTimeout + 1);
    await expect(p).resolves.toMatchObject({ status: 'error', data: { code: -69005 } });
    expect(selectRetry).toHaveBeenCalledTimes(1);
    expect(pending['ws-b'].length).toBe(0);
  });

  test('3b-4: no retry selection when the first node answers', async () => {
    const { io, pending } = fakeIo(['ws-a']);
    const selectRetry = jest.fn(() => 'ws-x');
    const p = handleRequestSingle({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, ['ws-a'], poolOf(['a']), io, null, 1, selectRetry);
    answer(pending['ws-a'][0]);
    await expect(p).resolves.toMatchObject({ status: 'success' });
    expect(selectRetry).not.toHaveBeenCalled();
  });

  test('heavy request: weighted, counts toward the heavy cap, released on disconnect', async () => {
    const { io } = fakeIo(['ws-a']);
    const heavy = { timeout: 5000, retry: false, maxPerNode: 4 };
    const p = handleRequestSingle({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{}] }, ['ws-a'], poolOf(['a']), io, heavy, 11);
    expect([nodeLoad.load('a'), nodeLoad.heavyCount('a')]).toEqual([11, 1]);
    jest.advanceTimersByTime(5001);
    await expect(p).resolves.toMatchObject({ status: 'error', data: { code: -69005 } });
    expect(nodeLoad.load('a')).toBe(11);                           // node still working
    nodeLoad.releaseSocket('ws-a');                                // node disconnects
    expect([nodeLoad.load('a'), nodeLoad.heavyCount('a')]).toEqual([0, 0]);
  });

  test('handleRequestSet: each node counted until it answers, late answers included', async () => {
    const { io, pending } = fakeIo(['ws-a', 'ws-b', 'ws-c']);
    const p = handleRequestSet({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, ['ws-a', 'ws-b', 'ws-c'], poolOf(['a', 'b', 'c']), io, 1);
    expect(['a', 'b', 'c'].map(nodeLoad.load)).toEqual([1, 1, 1]);
    answer(pending['ws-b'][0]);
    expect(['a', 'b', 'c'].map(nodeLoad.load)).toEqual([1, 0, 1]);
    jest.advanceTimersByTime(nodeDefaultTimeout + 1);             // a and c time out
    await p;
    expect(['a', 'b', 'c'].map(nodeLoad.load)).toEqual([1, 0, 1]); // still working
    answer(pending['ws-a'][0]); answer(pending['ws-c'][0]);        // late answers
    expect(['a', 'b', 'c'].map(nodeLoad.load)).toEqual([0, 0, 0]);
  });
});
