// handleRequestSet (1-in-20 comparison sets): what it resolves with when no node succeeds.
// Run: npx jest test/handleRequestSet.test.js
jest.mock('../utils/logNode', () => ({ logNode: jest.fn() }));
jest.mock('../utils/logCompareResults', () => ({ logCompareResults: jest.fn() }));
const { handleRequestSet } = require('../utils/handleRequestSet');

const req = { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x1', '0x18df142'] };

// answers: per node, a JSON-RPC response object, or 'silent' (never answers → timeout)
function fakePool(answers) {
  const poolMap = new Map();
  const sockets = new Map();
  answers.forEach((answer, i) => {
    const id = `ws${i}`;
    poolMap.set(id, { id: `node${i}`, owner: 'o', wsID: id });
    sockets.set(id, {
      disconnected: false,
      emit: (event, body, cb) => { if (answer !== 'silent') setTimeout(() => cb(answer), 5); },
    });
  });
  return { poolMap, io: { sockets: { sockets } }, ids: [...poolMap.keys()] };
}
const nodeError = (code, message) => ({ jsonrpc: '2.0', id: 1, error: { code, message } });

test('every node answers the same non-ignored error: that error, not -69003', async () => {
  const e = nodeError(-32001, 'block not found: 0x18df142');
  const { poolMap, io, ids } = fakePool([e, e, e]);
  const r = await handleRequestSet(req, ids, poolMap, io, 1);
  expect(r.status).toBe('error');
  expect(r.data).toEqual({ code: -32001, message: 'block not found: 0x18df142' });
  expect(ids).toContain(r.respondingClientId);
});

test('one success wins over errors', async () => {
  const { poolMap, io, ids } = fakePool([nodeError(-32001, 'x'), { jsonrpc: '2.0', id: 1, result: '0x5' }, nodeError(-32001, 'x')]);
  const r = await handleRequestSet(req, ids, poolMap, io, 1);
  expect(r).toMatchObject({ status: 'success', data: '0x5' });
});

test('errors plus a timeout: the node error, not "All nodes timed out"', async () => {
  const { poolMap, io, ids } = fakePool([nodeError(-32000, 'nonce too low'), 'silent', nodeError(-32000, 'nonce too low')]);
  const r = await handleRequestSet(req, ids, poolMap, io, 1);
  expect(r.data).toEqual({ code: -32000, message: 'nonce too low' });
}, 10000);

test('no node answers at all: still a pool code (our failure, may fall back)', async () => {
  const { poolMap, io, ids } = fakePool(['silent', 'silent', 'silent']);
  const r = await handleRequestSet(req, ids, poolMap, io, 1);
  expect(r.data.code).toBeLessThanOrEqual(-69000);
}, 10000);
