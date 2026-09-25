const { filterFastNodes } = require('./nodeTimingUtils');
const heavyInFlight = require('./heavyInFlight');

const TAGS_AT_HEAD = ['latest', 'safe', 'finalized']; // always above any node's receipt floor

/**
 * Works out the lowest block a heavy request needs receipts for.
 * @returns {{ fromBlock: number|null } | { error: Object }} fromBlock null = no floor check needed
 */
function resolveFromBlock(rpcRequest) {
  const { method, params } = rpcRequest;
  // Filter follow-ups carry only a filter id; the range was checked when the filter was created
  if (method !== 'eth_getLogs' && method !== 'eth_newFilter') return { fromBlock: null };

  // Positional ([filter]) or by-name ({ filter }) params; reth accepts both
  const filter = Array.isArray(params) ? params[0] : params?.filter;
  // Malformed: let reth reject it with its own -32602
  if (!filter || typeof filter !== 'object') return { fromBlock: null };
  // blockHash (D11): reth answers a hash below its floor with -32001, never a silent []
  if (filter.blockHash !== undefined) return { fromBlock: null };

  const from = filter.fromBlock ?? 'latest';
  const to = filter.toBlock ?? 'latest';
  if (from === 'pending' || to === 'pending') {
    return { error: { code: -32602, message: `"pending" is not supported for ${method}` } };
  }
  if (TAGS_AT_HEAD.includes(from)) return { fromBlock: null };
  if (from === 'earliest') return { fromBlock: 0 };
  if (typeof from === 'string' && /^0x[0-9a-fA-F]+$/.test(from)) return { fromBlock: parseInt(from, 16) };
  return { fromBlock: null }; // Malformed: reth rejects it
}

function isCheckedIn(client) {
  const blockNum = client.block_number;
  return client.id &&
         client.owner &&
         client.wsID &&
         client.machine_id &&
         client.machine_id !== "N/A" &&
         !client.suspicious &&
         blockNum !== undefined &&
         blockNum !== null &&
         blockNum !== "N/A" &&
         !isNaN(parseInt(blockNum));
}

/**
 * Picks one node for a heavy method (getLogs, filters). Eligibility is applied before the
 * head-block step so a reth-only set can't come up empty because a geth node is ahead.
 * @param {Map<string, Object>} poolMap
 * @param {Object} rpcRequest
 * @param {Object} heavyConfig - entry from config.heavyMethods
 * @returns {{ socketId: string } | { error: Object }}
 */
function selectHeavyClient(poolMap, rpcRequest, heavyConfig) {
  const resolved = resolveFromBlock(rpcRequest);
  if (resolved.error) {
    console.log(`🏋️ ${rpcRequest.method}: rejected (${resolved.error.message})`);
    return { error: resolved.error };
  }
  const { fromBlock } = resolved;

  const checkedIn = Array.from(poolMap.values()).filter(isCheckedIn);
  const reth = checkedIn.filter(c => typeof c.execution_client === 'string' && c.execution_client.startsWith('reth'));
  const floorKnown = reth.filter(c => Number.isFinite(c.receipt_floor));
  const coversRange = fromBlock === null ? floorKnown : floorKnown.filter(c => c.receipt_floor <= fromBlock);
  const withCapacity = coversRange.filter(c => heavyInFlight.count(c.id) < heavyConfig.maxPerNode);

  // Preferences, not requirements: fast nodes first, then those at the highest block
  const fast = filterFastNodes(withCapacity);
  const preferred = fast.length > 0 ? fast : withCapacity;
  const targetBlock = preferred.length > 0 ? Math.max(...preferred.map(c => parseInt(c.block_number))) : null;
  const atHead = preferred.filter(c => parseInt(c.block_number) === targetBlock);
  const picked = atHead.length > 0 ? atHead[Math.floor(Math.random() * atHead.length)] : null;

  // Freshness data for the 3b-3 decision (exact highest block vs within 1 block)
  if (preferred.length > 0) {
    const within1 = preferred.filter(c => parseInt(c.block_number) >= targetBlock - 1).length;
    console.log(`🧭 heavy ${rpcRequest.method}: target ${targetBlock}, candidates ${preferred.length}, ` +
      `at target ${atHead.length}, within 1 ${within1}, blocks [${preferred.map(c => targetBlock - parseInt(c.block_number)).sort((a, b) => a - b).join(',')}]`);
  }

  console.log(
    `🏋️ ${rpcRequest.method} from ${fromBlock === null ? 'n/a' : fromBlock}: ` +
    `${checkedIn.length} → ${reth.length} reth → ${floorKnown.length} floor known → ` +
    `${coversRange.length} covers range → ${withCapacity.length} with capacity → ` +
    (picked ? `picked ${picked.id}` : 'none')
  );

  if (picked) return { socketId: picked.wsID };

  if (floorKnown.length === 0) {
    return { error: { code: -32005, message: `${rpcRequest.method} unavailable: no ready nodes, retry shortly` } };
  }
  if (coversRange.length === 0) {
    // Retrying won't help, so this is not -32005
    const lowestFloor = Math.min(...floorKnown.map(c => c.receipt_floor));
    return { error: { code: -32602, message: `Logs older than block ${lowestFloor} are not available on this endpoint` } };
  }
  return { error: { code: -32005, message: `${rpcRequest.method} capacity exhausted, retry shortly` } };
}

/**
 * Readiness summary for /getlogsStatus: a ready node is a checked-in reth node with a known
 * receipt floor. receiptFloor is the LOWEST floor among them: the oldest block any ready node
 * can serve. The edge rejects only ranges below it; selection then keeps just the nodes whose
 * floor covers each request (D14). receiptFloorAll is the highest floor: history every ready
 * node can serve.
 */
function getHeavyStatus(poolMap) {
  const ready = Array.from(poolMap.values()).filter(c =>
    isCheckedIn(c) &&
    typeof c.execution_client === 'string' && c.execution_client.startsWith('reth') &&
    Number.isFinite(c.receipt_floor));
  return {
    readyNodes: ready.length,
    receiptFloor: ready.length > 0 ? Math.min(...ready.map(c => c.receipt_floor)) : null,
    receiptFloorAll: ready.length > 0 ? Math.max(...ready.map(c => c.receipt_floor)) : null,
    inFlight: heavyInFlight.total(),
  };
}

module.exports = { selectHeavyClient, getHeavyStatus, resolveFromBlock };
