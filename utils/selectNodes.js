const { spotCheckOnlyThreshold, requestSetChance, slowSpotChecks, defaultMethodProfile, methodProfiles } = require('../config');
const { getNodeTimingData } = require('./nodeTimingUtils');
const nodeLoad = require('./nodeLoad');

// One selection function for every method (getLogs plan Phase 3b). select() is pure: it takes a
// snapshot of the pool and returns a decision without sending anything, so it can be tested
// with fake pools. Rules (3b-3):
//   - only fast nodes serve a request (D13); slow ones only join comparison sets as spot checks
//   - only nodes at the exact highest block among fast nodes (owner decision 2026-09-25)
//   - among those, power of two choices on weighted in-flight load (nodeLoad, 3b-2)

const TAGS_AT_HEAD = ['latest', 'safe', 'finalized']; // always above any node's receipt floor

function getProfile(method) {
  return { ...defaultMethodProfile, ...(methodProfiles[method] || {}) };
}

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

const MAX_RANGE_BLOCKS = 10000; // the edge's range cap (D1); reth rejects larger ranges anyway

// Block number for a range bound: tags at the head count as the head
function toBlockNumber(value, head) {
  if (value === undefined || TAGS_AT_HEAD.includes(value)) return head;
  if (value === 'earliest') return 0;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return parseInt(value, 16);
  return null;
}

/**
 * Weight of one request in a node's in-flight load (profile `cost`; Phase 3b-2).
 * 'range' (getLogs) = 1 + ceil(blocks / 1000), blocks capped at 10,000; a blockHash or an
 * unreadable range counts as 1 block.
 */
function requestCost(rpcRequest, profile, head) {
  if (profile.cost !== 'range') return profile.cost;
  const { params } = rpcRequest;
  const filter = Array.isArray(params) ? params[0] : params?.filter;
  let blocks = 1;
  if (filter && typeof filter === 'object' && filter.blockHash === undefined && Number.isFinite(head)) {
    const from = toBlockNumber(filter.fromBlock, head);
    const to = toBlockNumber(filter.toBlock, head);
    if (from !== null && to !== null) blocks = Math.min(Math.max(to - from + 1, 1), MAX_RANGE_BLOCKS);
  }
  return 1 + Math.ceil(blocks / 1000);
}

function hasValidBlock(client) {
  const blockNum = client.block_number;
  return blockNum !== undefined && blockNum !== null && blockNum !== "N/A" && !isNaN(parseInt(blockNum));
}

// Checked-in rules as they were for each path before 3b (heavy didn't check null/undefined
// machine_id explicitly; truthiness already excludes them, so the two agree)
function isCheckedIn(client) {
  return client.id &&
         client.owner &&
         client.wsID &&
         client.machine_id &&
         client.machine_id !== "N/A" &&
         !client.suspicious;
}

const isReth = (c) => typeof c.execution_client === 'string' && c.execution_client.startsWith('reth');

function isFast(client, timing) {
  if (!timing || !client.id || client.id === "N/A") return true;
  const percentTimeout = timing[client.id];
  return percentTimeout === undefined || percentTimeout <= spotCheckOnlyThreshold;
}

/**
 * Power of two choices: draw two different candidates at random and keep the one with the lower
 * weighted load (ties keep the first drawn). Nearly as even as always taking the least-loaded
 * node, without sending everything to a node that fails instantly and so always looks idle.
 */
function powerOfTwo(candidates, loads, random) {
  if (candidates.length === 1) return candidates[0];
  const i = Math.floor(random() * candidates.length);
  let j = Math.floor(random() * (candidates.length - 1));
  if (j >= i) j++;
  const a = candidates[i];
  const b = candidates[j];
  return (loads[b.id] || 0) < (loads[a.id] || 0) ? b : a;
}

/**
 * Captures what select() needs from live state.
 * @param {Map<string, Object>} poolMap
 */
function takeSnapshot(poolMap) {
  const nodes = Array.from(poolMap.values());
  const heavyCounts = {};
  const loads = {};
  for (const c of nodes) {
    if (!c.id) continue;
    heavyCounts[c.id] = nodeLoad.heavyCount(c.id);
    loads[c.id] = nodeLoad.load(c.id);
  }
  return { nodes, timing: getNodeTimingData(), heavyCounts, loads };
}

/**
 * Decides which node(s) serve a request.
 * @param {Object} rpcRequest
 * @param {{ nodes: Object[], timing: Object|null, heavyCounts: Object, loads?: Object, random?: Function }} snapshot
 * @returns {{ error: Object, reason: string } |
 *           { socketIds: string[], handler: 'single'|'set', heavy: Object|null, cost: number, reason: string }}
 */
function select(rpcRequest, snapshot) {
  const profile = getProfile(rpcRequest.method);
  const random = snapshot.random || Math.random;

  if (profile.disabled) {
    return {
      error: { code: -32601, message: `${rpcRequest.method} is not supported on this endpoint; use eth_getLogs` },
      reason: 'disabled',
    };
  }
  const decision = profile.heavy
    ? selectHeavy(rpcRequest, profile, snapshot, random)
    : selectLight(rpcRequest, profile, snapshot, random);
  if (!decision.error) {
    const heads = snapshot.nodes.filter(c => isCheckedIn(c) && hasValidBlock(c)).map(c => parseInt(c.block_number));
    decision.cost = requestCost(rpcRequest, profile, heads.length > 0 ? Math.max(...heads) : null);
  }
  return decision;
}

// getLogs: one node that is reth, knows its floor, covers the range and has capacity
function selectHeavy(rpcRequest, profile, snapshot, random) {
  const resolved = resolveFromBlock(rpcRequest);
  if (resolved.error) {
    console.log(`🏋️ ${rpcRequest.method}: rejected (${resolved.error.message})`);
    return { error: resolved.error, reason: 'invalid range' };
  }
  const { fromBlock } = resolved;

  const checkedIn = snapshot.nodes.filter(c => isCheckedIn(c) && hasValidBlock(c));
  const reth = checkedIn.filter(isReth);
  const floorKnown = reth.filter(c => Number.isFinite(c.receipt_floor));
  const coversRange = fromBlock === null ? floorKnown : floorKnown.filter(c => c.receipt_floor <= fromBlock);
  // Only fast nodes serve (D13), then capacity, then the exact highest block, then power of two
  const fastCovering = coversRange.filter(c => isFast(c, snapshot.timing));
  const withCapacity = fastCovering.filter(c => (snapshot.heavyCounts[c.id] || 0) < profile.heavy.maxPerNode);
  const loads = snapshot.loads || {};
  const targetBlock = withCapacity.length > 0 ? Math.max(...withCapacity.map(c => parseInt(c.block_number))) : null;
  const atHead = withCapacity.filter(c => parseInt(c.block_number) === targetBlock);
  const picked = atHead.length > 0 ? powerOfTwo(atHead, loads, random) : null;

  if (withCapacity.length > 0) {
    const within1 = withCapacity.filter(c => parseInt(c.block_number) >= targetBlock - 1).length;
    console.log(`🧭 heavy ${rpcRequest.method}: target ${targetBlock}, candidates ${withCapacity.length}, ` +
      `at target ${atHead.length}, within 1 ${within1}, blocks [${withCapacity.map(c => targetBlock - parseInt(c.block_number)).sort((a, b) => a - b).join(',')}]`);
  }
  console.log(
    `🏋️ ${rpcRequest.method} from ${fromBlock === null ? 'n/a' : fromBlock}: ` +
    `${checkedIn.length} → ${reth.length} reth → ${floorKnown.length} floor known → ` +
    `${coversRange.length} covers range → ${fastCovering.length} fast → ${withCapacity.length} with capacity → ` +
    `${atHead.length} at block ${targetBlock} → ` +
    (picked ? `picked ${picked.id} (load ${loads[picked.id] || 0}; loads [${atHead.map(c => loads[c.id] || 0).join(',')}])` : 'none')
  );

  const heavy = { timeout: profile.timeout, retry: profile.retry, maxPerNode: profile.heavy.maxPerNode };
  if (picked) return { socketIds: [picked.wsID], handler: 'single', heavy, reason: 'heavy' };

  if (floorKnown.length === 0) {
    return { error: { code: -32005, message: `${rpcRequest.method} unavailable: no ready nodes, retry shortly` }, reason: 'no ready nodes' };
  }
  if (coversRange.length === 0) {
    // Retrying won't help, so this is not -32005
    const lowestFloor = Math.min(...floorKnown.map(c => c.receipt_floor));
    return { error: { code: -32602, message: `Logs older than block ${lowestFloor} are not available on this endpoint` }, reason: 'below floor' };
  }
  if (fastCovering.length === 0) {
    return { error: { code: -32005, message: `${rpcRequest.method} unavailable: no healthy nodes for this range, retry shortly` }, reason: 'only slow nodes' };
  }
  return { error: { code: -32005, message: `${rpcRequest.method} capacity exhausted, retry shortly` }, reason: 'no capacity' };
}

// Everything else: a fast node at the exact highest block chosen by power of two, plus a second
// fast node as the retry target; 1-in-requestSetChance a comparison set of 3 (the chosen node,
// other fast nodes and, as spot checks, up to 2 slow nodes) unless the profile says not to compare
function selectLight(rpcRequest, profile, snapshot, random) {
  const { timing } = snapshot;
  const loads = snapshot.loads || {};
  const spotChecks = snapshot.slowSpotChecks ?? slowSpotChecks;
  const noClients = { error: { code: -69000, message: "No clients connected to pool" }, reason: 'no clients' };

  const clientsWithBlocks = snapshot.nodes.filter(c => isCheckedIn(c) && hasValidBlock(c));
  if (clientsWithBlocks.length === 0) return noClients;
  const fastNodes = clientsWithBlocks.filter(c => isFast(c, timing));
  if (fastNodes.length === 0) return { ...noClients, reason: 'only slow nodes' }; // D13

  // Exact highest block among fast nodes
  const targetBlock = Math.max(...fastNodes.map(c => parseInt(c.block_number)));
  const candidates = fastNodes.filter(c => parseInt(c.block_number) === targetBlock);
  const slowAtTarget = clientsWithBlocks.filter(c => !isFast(c, timing) && parseInt(c.block_number) === targetBlock);

  const within1 = clientsWithBlocks.filter(c => parseInt(c.block_number) >= targetBlock - 1).length;
  console.log(`🧭 light: target ${targetBlock}, candidates ${clientsWithBlocks.length}, ` +
    `at target ${candidates.length + slowAtTarget.length}, within 1 ${within1}, ` +
    `blocks [${clientsWithBlocks.map(c => targetBlock - parseInt(c.block_number)).sort((a, b) => a - b).join(',')}]`);

  const primary = powerOfTwo(candidates, loads, random);
  const otherFast = candidates.filter(c => c !== primary);

  // Comparison set: the chosen node plus 2 drawn from the other fast nodes and up to 2 slow ones
  let handler = 'single';
  let reason;
  let picked;
  const spot = [];
  if (spotChecks && slowAtTarget.length > 0) {
    const availableSlow = [...slowAtTarget];
    while (spot.length < 2 && availableSlow.length > 0) {
      spot.push(availableSlow.splice(Math.floor(random() * availableSlow.length), 1)[0]);
    }
  }
  const setPool = [...otherFast, ...spot];
  if (!profile.compare) {
    reason = 'skips comparison';
  } else if (setPool.length < 2) {
    reason = 'fewer than 3 nodes';
  } else if (Math.floor(random() * requestSetChance) === 0) {
    handler = 'set';
    reason = 'random set';
    const others = [];
    const available = [...setPool];
    while (others.length < 2) others.push(available.splice(Math.floor(random() * available.length), 1)[0]);
    picked = [primary, ...others];
  } else {
    reason = 'random single';
  }
  if (handler === 'single') {
    // Retry target: another fast node at the highest block (never a slow one, D13)
    picked = otherFast.length > 0 ? [primary, powerOfTwo(otherFast, loads, random)] : [primary];
  }

  const socketIds = picked.map(c => c.wsID);
  const slowPicked = picked.filter(c => !isFast(c, timing)).length;
  console.log(`🔀 ${rpcRequest.method}: ${snapshot.nodes.length} → ${clientsWithBlocks.length} checked in → ` +
    `${fastNodes.length} fast → ${candidates.length} at block ${targetBlock} → picked ${primary.id} ` +
    `(load ${loads[primary.id] || 0}; loads [${candidates.map(c => loads[c.id] || 0).join(',')}]), ` +
    `${handler} (${reason}), ${socketIds.length} node(s)${slowPicked ? `, ${slowPicked} slow spot check(s)` : ''}`);
  return { socketIds, handler, heavy: null, reason };
}

/**
 * Readiness summary for /getlogsStatus: a ready node is a checked-in reth node with a known
 * receipt floor. receiptFloor is the LOWEST floor among them: the oldest block any ready node
 * can serve. The edge rejects only ranges below it; selection then keeps just the nodes whose
 * floor covers each request (D14). receiptFloorAll is the highest floor: history every ready
 * node can serve.
 */
function getHeavyStatus(poolMap) {
  // Slow nodes never serve getLogs (D13), so they don't count as ready
  const timing = getNodeTimingData();
  const ready = Array.from(poolMap.values()).filter(c =>
    isCheckedIn(c) && hasValidBlock(c) && isReth(c) && Number.isFinite(c.receipt_floor) && isFast(c, timing));
  return {
    readyNodes: ready.length,
    receiptFloor: ready.length > 0 ? Math.min(...ready.map(c => c.receipt_floor)) : null,
    receiptFloorAll: ready.length > 0 ? Math.max(...ready.map(c => c.receipt_floor)) : null,
    inFlight: nodeLoad.heavyTotal(),
  };
}

module.exports = { select, takeSnapshot, getProfile, resolveFromBlock, requestCost, powerOfTwo, getHeavyStatus };
