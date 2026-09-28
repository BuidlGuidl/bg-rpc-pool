const { historyDefaults } = require('../config');

// History-aware routing for light methods (getLogs plan Phase 3c). Pruned nodes don't hold old
// receipts, block bodies or state; asked for them they answer `null` or a "pruned" error, while
// an archive node has the real answer (plan M23, results finding 16). Each node gets an
// effective floor per kind of history (the oldest block it can serve), selection prefers nodes
// whose floor covers the requested block, and a miss on a hash lookup (block unknown up front)
// is retried once on a node with deeper history.

const HEAD_TAGS = ['latest', 'pending', 'safe', 'finalized'];
const HEX = /^0x[0-9a-fA-F]+$/;
const isHash = (v) => typeof v === 'string' && v.length === 66 && HEX.test(v);

const isReth = (c) => typeof c.execution_client === 'string' && c.execution_client.startsWith('reth');

/**
 * What history a request needs.
 * @returns {null | { kind: string, block: number } | { kind: string, head: true } | { kind: string, byHash: true }}
 *   null = the method needs no history (or isn't history-routed); head = at or near the head
 */
function historyNeed(rpcRequest, profile) {
  const spec = profile.history;
  if (!spec) return null;
  const { params } = rpcRequest;
  const { kind } = spec;

  if (spec.block === 'hash') return { kind, byHash: true };
  if (spec.block === 'feeHistory') {
    // [blockCount, newestBlock, rewardPercentiles]: only rewards need receipts (headers alone
    // serve the rest on every node), for blocks newest - count + 1 .. newest
    const [count, newest, percentiles] = Array.isArray(params) ? params : [];
    if (!Array.isArray(percentiles) || percentiles.length === 0) return null;
    const n = typeof count === 'number' ? count : (typeof count === 'string' && HEX.test(count) ? parseInt(count, 16) : NaN);
    if (newest === undefined || HEAD_TAGS.includes(newest)) return { kind, head: true };
    if (!Number.isFinite(n) || typeof newest !== 'string' || !HEX.test(newest)) return null;
    return { kind, block: Math.max(parseInt(newest, 16) - n + 1, 0) };
  }
  if (spec.block === 'filter') {
    // getLogs: ranges are floor-checked by the heavy path; only a blockHash is a lookup (D11)
    const filter = Array.isArray(params) ? params[0] : params?.filter;
    return filter && typeof filter === 'object' && filter.blockHash !== undefined ? { kind, byHash: true } : null;
  }

  const value = Array.isArray(params) ? params[spec.block] : undefined;
  if (value === undefined || value === null || HEAD_TAGS.includes(value)) return { kind, head: true };
  if (value === 'earliest') return { kind, block: 0 };
  if (isHash(value)) return { kind, byHash: true };
  if (typeof value === 'string' && HEX.test(value)) return { kind, block: parseInt(value, 16) };
  if (typeof value === 'object') {
    // EIP-1898 block parameter
    if (value.blockHash !== undefined) return { kind, byHash: true };
    const n = value.blockNumber;
    if (n === undefined || HEAD_TAGS.includes(n)) return { kind, head: true };
    if (n === 'earliest') return { kind, block: 0 };
    if (typeof n === 'string' && HEX.test(n)) return { kind, block: parseInt(n, 16) };
  }
  return null; // Malformed: let the node reject it
}

// State floor from the check-in's `state_history` (plan 2c): null when absent or unfamiliar
function reportedStateFloor(stateHistory, head) {
  if (!stateHistory || typeof stateHistory !== 'object') return null;
  if (stateHistory.mode === 'full') return 0;
  if (stateHistory.mode === 'distance' && Number.isFinite(stateHistory.blocks)) return head - stateHistory.blocks;
  if (stateHistory.mode === 'before' && Number.isFinite(stateHistory.block)) return stateHistory.block;
  return null;
}

/**
 * Oldest block a node can serve for one kind of history. Reth nodes report `receipt_floor`, and
 * since 2c `body_floor` and `state_history` (read from reth's own files). Where a reth node
 * doesn't report bodies or state, they follow the reth defaults buidlguidl-client runs with (a
 * receipt floor of 0 means an archive node). Other clients report nothing and get conservative
 * defaults.
 */
function nodeFloor(client, kind) {
  const head = parseInt(client.block_number);
  const floor = client.receipt_floor;
  if (isReth(client)) {
    const floorKnown = Number.isFinite(floor);
    // Unknown receipt floor (old client, or not read yet): a snapshot-synced reth node's floor
    // can be anywhere up to ~100 days back, and below it it answers null, not an error. Never
    // count it as holding any receipts by number; head tags and hash lookups still reach it
    if (kind === 'receipts') return floorKnown ? floor : Infinity;
    if (kind === 'bodies') {
      if (Number.isFinite(client.body_floor)) return client.body_floor;
      return floorKnown ? Math.min(floor, historyDefaults.rethBodyFloor) : historyDefaults.rethBodyFloor;
    }
    if (kind === 'state') {
      const reported = reportedStateFloor(client.state_history, head);
      if (reported !== null) return reported;
      return floor === 0 ? 0 : head - historyDefaults.rethStateWindow;
    }
  }
  if (kind === 'state') return head - historyDefaults.unknownStateWindow;
  return historyDefaults.unknownHistoryFloor;
}

function covers(client, need) {
  return need.block === undefined || nodeFloor(client, need.kind) <= need.block;
}

/**
 * Whether a node's answer means "this node doesn't have that history". Only then is a node with
 * deeper history tried.
 * @param {Object} result - { status, data } from handleRequestSingle/Set
 * @param {Object} client - the node that answered
 * @returns {boolean}
 */
function isHistoryMiss(need, result, client) {
  if (!need || !client) return false;
  if (result.status === 'success') {
    if (result.data !== null) return false;
    // A lookup by hash can't be checked up front; a null for a known block is a miss only if
    // the node that answered doesn't cover it (legitimate nulls, e.g. a future block, stay)
    return need.byHash === true || (need.block !== undefined && !covers(client, need));
  }
  const error = result.data || {};
  if (need.kind === 'receipts' && need.byHash && error.code === -32001) return true; // getLogs blockHash (D11)
  // reth: "... is pruned", "pruned history unavailable"; geth: "historical state <root> is not
  // available", "missing trie node"
  return typeof error.message === 'string' && /pruned|historical state .*not available|missing trie node/i.test(error.message);
}

module.exports = { historyNeed, nodeFloor, covers, isHistoryMiss };
