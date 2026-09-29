// handleRequestSingle: which node answers get a retry on another node.
// Run: npx jest test/handleRequestSingle.test.js
jest.mock('../utils/logNode', () => ({ logNode: jest.fn() }));
const { handleRequestSingle } = require('../utils/handleRequestSingle');

const req = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x1' }, 'latest'] };
// answers: per node, a JSON-RPC response, or 'silent' (never answers → timeout)
function fakePool(answers) {
  const poolMap = new Map(); const sockets = new Map();
  answers.forEach((answer, i) => {
    const id = `ws${i}`;
    poolMap.set(id, { id: `node${i}`, owner: 'o', wsID: id });
    sockets.set(id, { disconnected: false, emit: (e, body, cb) => { if (answer !== 'silent') setTimeout(() => cb(answer), 5); } });
  });
  return { poolMap, io: { sockets: { sockets } } };
}
const err = (code, message) => ({ jsonrpc: '2.0', id: 1, error: { code, message } });
const ok = { jsonrpc: '2.0', id: 1, result: '0x5' };
const retryTo = (ws) => (tried) => ws; // selectRetry stub: the node chosen at retry time

test('node failure (-70000 Internal node error) is retried on another node', async () => {
  const { poolMap, io } = fakePool([err(-70000, 'Internal node error'), ok]);
  const r = await handleRequestSingle(req, ['ws0'], poolMap, io, null, 1, retryTo('ws1'));
  expect(r).toMatchObject({ status: 'success', data: '0x5', respondingClientId: 'ws1' });
});

test("the node's own answer to the request is not retried (revert, invalid params, nonce too low)", async () => {
  for (const e of [err(3, 'execution reverted'), err(-32602, 'Invalid params'), err(-32000, 'nonce too low')]) {
    const { poolMap, io } = fakePool([e, ok]);
    const r = await handleRequestSingle(req, ['ws0'], poolMap, io, null, 1, retryTo('ws1'));
    expect(r.status).toBe('error');
    expect(r.data.code).toBe(e.error.code);
  }
});

test('node failure with no other node: the -70000 stands (bg-rpc-proxy may fall back)', async () => {
  const { poolMap, io } = fakePool([err(-70000, 'Internal node error')]);
  const r = await handleRequestSingle(req, ['ws0'], poolMap, io, null, 1, () => null);
  expect(r.data.code).toBe(-70000);
});

test('heavy methods are still never retried', async () => {
  const { poolMap, io } = fakePool([err(-70000, 'Internal node error'), ok]);
  const heavy = { timeout: 5000, retry: false, maxPerNode: 4 };
  const r = await handleRequestSingle({ ...req, method: 'eth_getLogs' }, ['ws0'], poolMap, io, heavy, 2, retryTo('ws1'));
  expect(r.data.code).toBe(-70000);
});

test('timeouts are still retried', async () => {
  const { poolMap, io } = fakePool(['silent', ok]);
  const r = await handleRequestSingle(req, ['ws0'], poolMap, io, null, 1, retryTo('ws1'));
  expect(r).toMatchObject({ status: 'success', data: '0x5' });
}, 10000);
