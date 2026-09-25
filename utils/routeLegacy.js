const { selectRandomClients } = require('./selectRandomClients');
const { selectHeavyClient } = require('./selectHeavyClient');
const { requestSetChance, methodsToSkipComparison, heavyMethods, disabledMethods } = require('../config');

/**
 * The /requestPool routing decision as it was before getLogs plan Phase 3b, unchanged, returning
 * the same decision shape as selectNodes.select(). Used when config.routingMode is 'legacy'
 * (rollback) and as the reference in the parity tests. Delete with selectHeavyClient.js once 3b
 * has run clean (selectRandomClients is still used by updateCache.js).
 * @returns {{ error: Object, reason: string } |
 *           { socketIds: string[], handler: 'single'|'set', heavy: Object|null, reason: string }}
 */
function decideLegacy(rpcRequest, poolMap) {
  if (disabledMethods.includes(rpcRequest.method)) {
    return {
      error: { code: -32601, message: `${rpcRequest.method} is not supported on this endpoint; use eth_getLogs` },
      reason: 'disabled',
    };
  }

  const heavyConfig = heavyMethods[rpcRequest.method];
  if (heavyConfig) {
    const selection = selectHeavyClient(poolMap, rpcRequest, heavyConfig);
    return selection.error
      ? { error: selection.error, reason: 'heavy' }
      : { socketIds: [selection.socketId], handler: 'single', heavy: heavyConfig, reason: 'heavy' };
  }

  const selectedClients = selectRandomClients(poolMap);
  if (selectedClients.length === 0) {
    return { error: { code: -69000, message: "No clients connected to pool" }, reason: 'no clients' };
  }
  if (selectedClients.length < 3) {
    return { socketIds: selectedClients, handler: 'single', heavy: null, reason: 'fewer than 3 nodes' };
  }
  if (methodsToSkipComparison.includes(rpcRequest.method)) {
    return { socketIds: selectedClients, handler: 'single', heavy: null, reason: 'skips comparison' };
  }
  const useSetHandler = Math.floor(Math.random() * requestSetChance) === 0;
  return { socketIds: selectedClients, handler: useSetHandler ? 'set' : 'single', heavy: null,
    reason: useSetHandler ? 'random set' : 'random single' };
}

module.exports = { decideLegacy };
