const { heavyInFlightMaxAge } = require('../config');

// In-flight requests per node (getLogs plan Phase 3b-2), keyed by node id (stable across
// reconnects). Every request sent to a node is counted with its cost (methodProfiles) and
// whether it's heavy. Released when the node responds, including after the pool's timeout (the
// node keeps working after a timeout, so it stays counted until it answers), or when the socket
// it was sent on disconnects. Entries older than heavyInFlightMaxAge are dropped as a backstop.
//
// nodeId -> Map<token, { wsID, startedAt, cost, heavy }>
const inFlight = new Map();
let nextToken = 1;

function acquire(nodeId, wsID, { cost = 1, heavy = false } = {}) {
  const token = nextToken++;
  if (!inFlight.has(nodeId)) inFlight.set(nodeId, new Map());
  inFlight.get(nodeId).set(token, { wsID, startedAt: Date.now(), cost, heavy });
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
        console.warn(`🧹 Dropping stale in-flight entry for node ${nodeId}`);
        entries.delete(token);
      }
    }
    if (entries.size === 0) inFlight.delete(nodeId);
  }
}

function sumOf(nodeId, fn) {
  sweepStale();
  let sum = 0;
  for (const entry of inFlight.get(nodeId)?.values() || []) sum += fn(entry);
  return sum;
}

// Heavy requests in flight on a node (for the per-node heavy cap)
const heavyCount = (nodeId) => sumOf(nodeId, (e) => (e.heavy ? 1 : 0));
// Weighted load on a node: sum of the costs of everything in flight
const load = (nodeId) => sumOf(nodeId, (e) => e.cost);
// Requests in flight on a node, unweighted
const count = (nodeId) => sumOf(nodeId, () => 1);

function heavyTotal() {
  sweepStale();
  let sum = 0;
  for (const entries of inFlight.values()) for (const e of entries.values()) if (e.heavy) sum++;
  return sum;
}

module.exports = { acquire, release, releaseSocket, heavyCount, load, count, heavyTotal };
