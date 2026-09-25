const nodeLoad = require('./nodeLoad');

// Pre-3b API over nodeLoad (getLogs plan Phase 3b-2), kept for the frozen legacy routing code
// (selectHeavyClient.js) and the parity tests. New code uses nodeLoad directly.
module.exports = {
  acquire: (nodeId, wsID) => nodeLoad.acquire(nodeId, wsID, { cost: 1, heavy: true }),
  release: nodeLoad.release,
  releaseSocket: nodeLoad.releaseSocket,
  count: nodeLoad.heavyCount,
  total: nodeLoad.heavyTotal,
};
