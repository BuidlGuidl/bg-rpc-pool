// Run: npx jest test/cachePolicy.test.js
const { notCacheableReason } = require('../utils/cachePolicy');

test('pending transaction (blockHash / blockNumber null) is not cached', () => {
  expect(notCacheableReason({ hash: '0x1', blockHash: null, blockNumber: null, input: '0x' })).toBeTruthy();
  expect(notCacheableReason({ hash: '0x1', blockHash: '0xab', blockNumber: null })).toBeTruthy();
});
test('mined transaction, receipts, blocks, values are cacheable', () => {
  expect(notCacheableReason({ hash: '0x1', blockHash: '0xab', blockNumber: '0x10', input: '0x' })).toBeNull();
  expect(notCacheableReason({ transactionHash: '0x1', blockHash: '0xab', blockNumber: '0x10', logs: [] })).toBeNull();
  expect(notCacheableReason({ hash: '0xab', number: '0x10', transactions: [] })).toBeNull();
  expect(notCacheableReason('0x5')).toBeNull();
  expect(notCacheableReason([{ blockNumber: '0x1' }])).toBeNull();
});
test('null is never cached', () => {
  expect(notCacheableReason(null)).toBeTruthy();
});
