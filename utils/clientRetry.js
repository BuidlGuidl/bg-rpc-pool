const { methodProfiles } = require('../config');

// When a node answers -32601 (method not found), should the pool try once more on a node running
// another execution client? Only for methods it routes on purpose (a profile in config.js
// methodProfiles), such as reth-only eth_getAccount, which geth answers -32601. A method without a
// profile keeps the first answer: retrying it shopped methods reth doesn't serve to whichever geth
// or nethermind node might (2026-10-01: txpool_status refused by reth, then served by nethermind),
// so the same request worked or failed by chance. (bg-rpc-docs EDGE_METHOD_BLOCKLIST_PLAN.md, Phase 2)
function shouldRetryOnOtherClient(rpcRequest, result) {
  return result.status === 'error'
    && result.data?.code === -32601
    && Boolean(result.respondingClientId)
    && Object.prototype.hasOwnProperty.call(methodProfiles, rpcRequest?.method);
}

module.exports = { shouldRetryOnOtherClient };
