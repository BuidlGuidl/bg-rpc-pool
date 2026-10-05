// When a node answers -32601, the pool retries on another execution client only for methods it
// routes on purpose (bg-rpc-docs EDGE_METHOD_BLOCKLIST_PLAN.md, Phase 2).
// Run: npx jest test/clientRetry.test.js
const { shouldRetryOnOtherClient } = require('../utils/clientRetry');
const { methodProfiles } = require('../config');

const notFound = { status: 'error', data: { code: -32601, message: 'Method not found' }, respondingClientId: 'node-1' };

describe('shouldRetryOnOtherClient', () => {
  test('a profiled method one client lacks is retried on another client', () => {
    for (const method of ['eth_getAccount', 'eth_getAccountInfo', 'eth_callMany', 'eth_getTransactionBySenderAndNonce']) {
      expect(shouldRetryOnOtherClient({ method }, notFound)).toBe(true);
    }
  });

  test('a method without a profile keeps the first answer (not shopped to geth or nethermind)', () => {
    for (const method of ['txpool_status', 'trace_block', 'parity_netPeers', 'some_futureMethod', 'eth_coinbase']) {
      expect(shouldRetryOnOtherClient({ method }, notFound)).toBe(false);
    }
  });

  test('only a node -32601 is retried', () => {
    expect(shouldRetryOnOtherClient({ method: 'eth_getAccount' }, { status: 'success', data: '0x1', respondingClientId: 'n' })).toBe(false);
    expect(shouldRetryOnOtherClient({ method: 'eth_getAccount' }, { ...notFound, data: { code: -32602, message: 'invalid params' } })).toBe(false);
    expect(shouldRetryOnOtherClient({ method: 'eth_getAccount' }, { ...notFound, respondingClientId: undefined })).toBe(false);
    expect(shouldRetryOnOtherClient({}, notFound)).toBe(false);
    expect(shouldRetryOnOtherClient({ method: 'toString' }, notFound)).toBe(false); // not an own profile
  });

  test('methods the edge refuses have no profile', () => {
    for (const method of ['txpool_status', 'txpool_content', 'txpool_inspect', 'eth_mining', 'eth_coinbase', 'eth_hashrate']) {
      expect(Object.prototype.hasOwnProperty.call(methodProfiles, method)).toBe(false);
    }
  });

  test('web3_* has a profile (namespace routing, NAMESPACE_ROUTING_PLAN.md): a node -32601 is retried', () => {
    for (const method of ['web3_clientVersion', 'web3_sha3']) {
      expect(shouldRetryOnOtherClient({ method }, notFound)).toBe(true);
    }
  });
});
