// Whether a successful answer may be cached (bg-rpc-proxy serves cache hits for up to 2 h).
//
// An answer that describes something not yet in a block can still change. A transaction read
// while pending comes back with blockHash / blockNumber null; caching it kept answering
// "pending" for hours after it was mined (independent audit HB2: 12 of 12). So any object
// answer that carries a blockHash or blockNumber field set to null is not cached. Answers
// without those fields (balances, code, blocks by hash) are unaffected; null answers were
// never cached.

function notCacheableReason(result) {
  if (result === null || result === undefined) return 'null result';
  if (typeof result === 'object' && !Array.isArray(result)) {
    if (('blockHash' in result && result.blockHash === null) || ('blockNumber' in result && result.blockNumber === null)) {
      return 'not in a block yet (pending)';
    }
  }
  return null;
}

module.exports = { notCacheableReason };
