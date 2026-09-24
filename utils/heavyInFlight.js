const { heavyInFlightMaxAge } = require('../config');

// In-flight heavy requests per node, keyed by node id (stable across reconnects).
// nodeId -> Map<token, { wsID, startedAt }>
// Released when the node responds (including after the pool's timeout: the node keeps
// working after a timeout, so it stays counted until it answers) or when the socket it
// was sent on disconnects. Entries older than heavyInFlightMaxAge are dropped as a backstop.
const inFlight = new Map();
let nextToken = 1;

function acquire(nodeId, wsID) {
  const token = nextToken++;
  if (!inFlight.has(nodeId)) inFlight.set(nodeId, new Map());
  inFlight.get(nodeId).set(token, { wsID, startedAt: Date.now() });
  return token;
}

function release(nodeId, token) {
  const entries = inFlight.get(nodeId);
  if (!entries) return;
  entries.delete(token);
  if (entries.size === 0) inFlight.delete(nodeId);
}

function releaseSocket(wsID) {
  for (const [nodeId, entries] of inFlight) {
    for (const [token, entry] of entries) {
      if (entry.wsID === wsID) entries.delete(token);
    }
    if (entries.size === 0) inFlight.delete(nodeId);
  }
}

function sweepStale() {
  const cutoff = Date.now() - heavyInFlightMaxAge;
  for (const [nodeId, entries] of inFlight) {
    for (const [token, entry] of entries) {
      if (entry.startedAt < cutoff) {
        console.warn(`🧹 Dropping stale heavy in-flight entry for node ${nodeId}`);
        entries.delete(token);
      }
    }
    if (entries.size === 0) inFlight.delete(nodeId);
  }
}

function count(nodeId) {
  sweepStale();
  return inFlight.get(nodeId)?.size || 0;
}

function total() {
  sweepStale();
  let sum = 0;
  for (const entries of inFlight.values()) sum += entries.size;
  return sum;
}

module.exports = { acquire, release, releaseSocket, count, total };
