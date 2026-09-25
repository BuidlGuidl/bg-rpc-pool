const { spotCheckOnlyThreshold, requestSetChance, defaultMethodProfile, methodProfiles } = require('../config');
const { getNodeTimingData } = require('./nodeTimingUtils');
const heavyInFlight = require('./heavyInFlight');

// One selection function for every method (getLogs plan Phase 3b). select() is pure: it takes a
// snapshot of the pool and returns a decision without sending anything, so it can be tested
// with fake pools. Step 3b-1 reproduces the pre-3b behavior exactly, including the order in
// which random numbers are drawn; later steps change behavior in one place here.

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
 * Captures what select() needs from live state.
 * @param {Map<string, Object>} poolMap
 */
function takeSnapshot(poolMap) {
  const nodes = Array.from(poolMap.values());
  const heavyCounts = {};
  for (const c of nodes) if (c.id) heavyCounts[c.id] = heavyInFlight.count(c.id);
  return { nodes, timing: getNodeTimingData(), heavyCounts };
}

/**
 * Decides which node(s) serve a request.
 * @param {Object} rpcRequest
 * @param {{ nodes: Object[], timing: Object|null, heavyCounts: Object, random?: Function }} snapshot
 * @returns {{ error: Object, reason: string } |
 *           { socketIds: string[], handler: 'single'|'set', heavy: Object|null, reason: string }}
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
  return profile.heavy
    ? selectHeavy(rpcRequest, profile, snapshot, random)
    : selectLight(rpcRequest, profile, snapshot, random);
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
  const withCapacity = coversRange.filter(c => (snapshot.heavyCounts[c.id] || 0) < profile.heavy.maxPerNode);

  // Preferences, not requirements: fast nodes first, then those at the highest block
  const fast = withCapacity.filter(c => isFast(c, snapshot.timing));
  const preferred = fast.length > 0 ? fast : withCapacity;
  const targetBlock = preferred.length > 0 ? Math.max(...preferred.map(c => parseInt(c.block_number))) : null;
  const atHead = preferred.filter(c => parseInt(c.block_number) === targetBlock);
  const picked = atHead.length > 0 ? atHead[Math.floor(random() * atHead.length)] : null;

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
  return { error: { code: -32005, message: `${rpcRequest.method} capacity exhausted, retry shortly` }, reason: 'no capacity' };
}

// Everything else: up to 3 nodes at the highest block, fast first; slow nodes as spot checks;
// 1-in-requestSetChance comparison across 3 nodes unless the profile says not to compare
function selectLight(rpcRequest, profile, snapshot, random) {
  const { timing } = snapshot;
  const noClients = { error: { code: -69000, message: "No clients connected to pool" }, reason: 'no clients' };

  const clientsWithBlocks = snapshot.nodes.filter(c => isCheckedIn(c) && hasValidBlock(c));
  if (clientsWithBlocks.length === 0) return noClients;

  // Highest block among fast nodes (all nodes if none is fast or there's no timing data)
  const fastWithBlocks = timing ? clientsWithBlocks.filter(c => isFast(c, timing)) : clientsWithBlocks;
  const blockSource = fastWithBlocks.length > 0 ? fastWithBlocks : clientsWithBlocks;
  const targetBlock = Math.max(...blockSource.map(c => parseInt(c.block_number)));
  const highestBlockClients = clientsWithBlocks.filter(c => parseInt(c.block_number) === targetBlock);

  const within1 = clientsWithBlocks.filter(c => parseInt(c.block_number) >= targetBlock - 1).length;
  console.log(`🧭 light: target ${targetBlock}, candidates ${clientsWithBlocks.length}, ` +
    `at target ${highestBlockClients.length}, within 1 ${within1}, ` +
    `blocks [${clientsWithBlocks.map(c => targetBlock - parseInt(c.block_number)).sort((a, b) => a - b).join(',')}]`);

  if (highestBlockClients.length === 0) return noClients;

  let selectionPool = [...highestBlockClients];
  let slowCount = 0;
  if (timing) {
    const fastNodes = highestBlockClients.filter(c => isFast(c, timing));
    const slowNodes = highestBlockClients.filter(c => !isFast(c, timing));
    if (fastNodes.length === 0) return noClients; // all nodes slow

    selectionPool = [...fastNodes];
    // Spot checks: up to 2 random slow nodes join the pool
    if (slowNodes.length > 2) {
      const availableSlowNodes = [...slowNodes];
      for (let i = 0; i < 2; i++) {
        const randomIndex = Math.floor(random() * availableSlowNodes.length);
        selectionPool.push(availableSlowNodes[randomIndex]);
        availableSlowNodes.splice(randomIndex, 1);
      }
      slowCount = 2;
    } else {
      selectionPool.push(...slowNodes);
      slowCount = slowNodes.length;
    }
  }

  // Up to 3 random nodes from the pool
  const numToSelect = Math.min(3, selectionPool.length);
  const selectedNodes = [];
  const availableNodes = [...selectionPool];
  for (let i = 0; i < numToSelect; i++) {
    const randomIndex = Math.floor(random() * availableNodes.length);
    selectedNodes.push(availableNodes[randomIndex]);
    availableNodes.splice(randomIndex, 1);
  }

  // A fast node goes first (it serves single requests; the second is the retry target)
  if (timing) {
    const fastNodeIndex = selectedNodes.findIndex(c => isFast(c, timing));
    if (fastNodeIndex !== -1) {
      const [fastNode] = selectedNodes.splice(fastNodeIndex, 1);
      selectedNodes.unshift(fastNode);
    }
  }

  const socketIds = selectedNodes.map(c => c.wsID);
  let handler = 'single';
  let reason;
  if (socketIds.length < 3) {
    reason = 'fewer than 3 nodes';
  } else if (!profile.compare) {
    reason = 'skips comparison';
  } else if (Math.floor(random() * requestSetChance) === 0) {
    handler = 'set';
    reason = 'random set';
  } else {
    reason = 'random single';
  }

  console.log(`🔀 ${rpcRequest.method}: ${snapshot.nodes.length} → ${clientsWithBlocks.length} checked in → ` +
    `${highestBlockClients.length} at block ${targetBlock} → pool ${selectionPool.length} (${slowCount} slow) → ` +
    `${socketIds.length} picked, ${handler} (${reason})`);
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
  const ready = Array.from(poolMap.values()).filter(c =>
    isCheckedIn(c) && hasValidBlock(c) && isReth(c) && Number.isFinite(c.receipt_floor));
  return {
    readyNodes: ready.length,
    receiptFloor: ready.length > 0 ? Math.min(...ready.map(c => c.receipt_floor)) : null,
    receiptFloorAll: ready.length > 0 ? Math.max(...ready.map(c => c.receipt_floor)) : null,
    inFlight: heavyInFlight.total(),
  };
}

module.exports = { select, takeSnapshot, getProfile, resolveFromBlock, getHeavyStatus };
