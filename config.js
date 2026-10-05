const portPoolPublic = 48546;
const poolPort = 3003;
const wsHeartbeatInterval = 30000; // 30 seconds
const nodeDefaultTimeout = 3000;

// Which routing code handles /requestPool: 'pipeline' (utils/selectNodes.js, one selection
// function for every method, getLogs plan Phase 3b) or 'legacy' (selectRandomClients +
// selectHeavyClient, as before 3b). Rollback switch; remove 'legacy' once 3b has run clean.
const routingMode = 'pipeline';

// Routing profile per method: the one place that says how each method is handled.
// Anything not listed gets defaultMethodProfile.
//   timeout  ms to wait for a node
//   retry    try a second node after a timeout
//   compare  may take part in the 1-in-requestSetChance 3-node comparison
//   heavy    reth-only routing with a receipt-floor check and a per-node in-flight cap
//            ({ maxPerNode }); timeouts are logged as `timeout_error_heavy`, so they don't
//            count against node ratings in bg-rpc-logs
//   disabled answer -32601 without touching a node
//   cost     weight of one request in a node's in-flight load (Phase 3b-2), from the shared
//            request cost table (getLogs plan D17; the edge's rate limiter and keyed metering use
//            the same units): a number, or 'range' = 1 + ceil(blocks / 1000) for getLogs
//            (10k blocks = 11), 'feeHistory' = 1 + ceil(blockCount / 100) (1,024 = 12),
//            'proofKeys' = 1 + ceil(storageKeys / 10)
//   history  history-aware routing (Phase 3c, utils/history.js): { kind, block }. kind is the
//            history the answer needs: 'receipts', 'bodies' (blocks, headers, transactions) or
//            'state'. block is the param index of the block number / tag / EIP-1898 object,
//            'hash' for lookups by hash or other lookups whose block isn't known up front
//            (retried on a deeper node after a miss), 'filter' for getLogs (only a blockHash
//            filter is a lookup), or 'feeHistory' (rewards need receipts back to newest - count + 1)
//   clients  execution clients that implement the method (prefixes of execution_client, e.g.
//            ['reth']); other nodes are skipped when a fast matching node exists. A node that
//            still answers -32601 is retried once on a node of another client (pool.js)
const defaultMethodProfile = { timeout: nodeDefaultTimeout, retry: true, compare: true, cost: 1 };

// Constant or node-specific answers, or "latest" state that legitimately differs between
// nodes on different blocks: never compared
const noCompare = { compare: false };

// Filter ("ticket") methods are disabled (getLogs plan D15): a filter id only exists on the
// node that created it, and with several nodes the follow-up call usually lands elsewhere.
// Their routing settings are kept, so deleting `disabled` re-enables them as before.
const receipts = (block) => ({ kind: 'receipts', block });
const bodies = (block) => ({ kind: 'bodies', block });
const state = (block) => ({ kind: 'state', block });

// Not listed on purpose: methods the edge refuses (bg-rpc-docs EDGE_METHOD_BLOCKLIST_PLAN.md D2:
// trace_*, txpool_*, the proof-of-work and account methods...). A method without a profile
// isn't retried on another client after a -32601 (utils/clientRetry.js).
// Methods outside eth_/net_ go only to nodes reporting their namespace in rpc_modules
// (utils/selectNodes.js; bg-rpc-docs NAMESPACE_ROUTING_PLAN.md).
const methodProfiles = {
  // Receipts
  eth_getBlockReceipts:      { timeout: 2000, cost: 2, history: receipts(0) },
  eth_getTransactionReceipt: { timeout: 2000, history: receipts('hash') },
  eth_feeHistory:            { compare: false, cost: 'feeHistory', history: receipts('feeHistory') },
  // Blocks, headers and transactions
  eth_getBlockByNumber:      { timeout: 1500, cost: 2, history: bodies(0) },
  eth_getBlockByHash:        { timeout: 1500, cost: 2, history: bodies('hash') },
  eth_getHeaderByNumber:                    { history: bodies(0) },
  eth_getHeaderByHash:                      { history: bodies('hash') },
  eth_getBlockTransactionCountByNumber:     { history: bodies(0) },
  eth_getBlockTransactionCountByHash:       { history: bodies('hash') },
  eth_getTransactionByHash:                 { history: bodies('hash') },
  eth_getTransactionByBlockNumberAndIndex:  { history: bodies(0) },
  eth_getTransactionByBlockHashAndIndex:    { history: bodies('hash') },
  eth_getRawTransactionByHash:              { history: bodies('hash') },
  eth_getRawTransactionByBlockNumberAndIndex: { history: bodies(0) },
  eth_getRawTransactionByBlockHashAndIndex: { history: bodies('hash') },
  eth_getUncleCountByBlockNumber:           { history: bodies(0) },
  eth_getUncleCountByBlockHash:             { history: bodies('hash') },
  eth_getUncleByBlockNumberAndIndex:        { history: bodies(0) },
  eth_getUncleByBlockHashAndIndex:          { history: bodies('hash') },
  // State at a block
  eth_getBalance:            { history: state(1) },
  eth_getCode:               { history: state(1) },
  eth_getTransactionCount:   { history: state(1) },
  eth_getStorageAt:          { history: state(2) },
  eth_call:                  { history: state(1) },
  eth_estimateGas:           { history: state(1) },
  eth_createAccessList:      { history: state(1) },
  eth_getProof:              { cost: 'proofKeys', history: state(2) },
  eth_simulateV1:            { history: state(1) },
  // reth: state at the block where the sender used that nonce, found by the node
  eth_getTransactionBySenderAndNonce: { history: state('hash'), clients: ['reth'] },
  // reth-only (geth v1.17.4: -32601 "does not exist/is not available")
  eth_getAccount:            { history: state(1), clients: ['reth'] },
  eth_getAccountInfo:        { history: state(1), clients: ['reth'] },
  eth_callMany:              { clients: ['reth'] },

  // Constant network information
  eth_chainId:               noCompare,
  net_version:               noCompare,
  eth_protocolVersion:       noCompare,
  // Node-specific state (not consensus data)
  eth_accounts:              noCompare,
  eth_syncing:               noCompare,
  net_listening:             noCompare,
  net_peerCount:             noCompare,
  // Time-sensitive "latest" state
  eth_blockNumber:           noCompare,
  eth_gasPrice:              noCompare,
  eth_maxPriorityFeePerGas:  noCompare,
  // Mempool (inherently node-specific)
  eth_pendingTransactions:   noCompare,
  // web3 namespace (NAMESPACE_ROUTING_PLAN.md): the edge still refuses web3_* (EDGE_METHOD_BLOCKLIST_PLAN.md D4)
  web3_clientVersion:        noCompare, // differs per node
  web3_sha3:                 noCompare, // same everywhere; comparing adds nothing

  // Range queries
  eth_getLogs:               { timeout: 5000, retry: false, compare: false, heavy: { maxPerNode: 4 }, cost: 'range', history: receipts('filter') },

  // Filter methods (disabled, D15)
  eth_getFilterLogs:         { timeout: 5000, retry: false, compare: false, heavy: { maxPerNode: 4 }, cost: 'range', disabled: true },
  eth_newFilter:             { timeout: 3000, retry: false, compare: false, heavy: { maxPerNode: 4 }, disabled: true },
  eth_getFilterChanges:      { timeout: 3000, retry: false, compare: false, heavy: { maxPerNode: 4 }, disabled: true },
  eth_newBlockFilter:        { compare: false, disabled: true },
  eth_newPendingTransactionFilter: { compare: false, disabled: true },
  eth_uninstallFilter:       { compare: false, disabled: true },
};

// Views of methodProfiles in the shape older code reads (handleRequestSingle/Set, legacy routing)
const profileEntries = Object.entries(methodProfiles).map(([method, p]) => [method, { ...defaultMethodProfile, ...p }]);
const nodeMethodSpecificTimeouts = Object.fromEntries(
  profileEntries.filter(([, p]) => p.timeout !== nodeDefaultTimeout).map(([method, p]) => [method, p.timeout]));
const methodsToSkipComparison = profileEntries.filter(([, p]) => !p.compare).map(([method]) => method);
const heavyMethods = Object.fromEntries(profileEntries.filter(([, p]) => p.heavy)
  .map(([method, p]) => [method, { timeout: p.timeout, retry: p.retry, maxPerNode: p.heavy.maxPerNode }]));
const disabledMethods = profileEntries.filter(([, p]) => p.disabled).map(([method]) => method);

// History each node is assumed to hold where it doesn't report it (Phase 3c, utils/history.js).
// Reth nodes report receipt_floor; a floor of 0 is treated as an archive node (all bodies and
// state). Measured on stage 2026-09-28, reth v2.5.0 as buidlguidl-client runs it (results
// finding 16): pruned nodes keep bodies/headers from 15,500,000 (the static-file segment after
// pre-merge pruning) and state for ~10,070 blocks. Other clients report nothing: assume
// post-merge bodies and receipts (geth prunes pre-merge history by default) and 128 blocks of state.
// Since 2026-10-01 (bg-rpc-docs F13_HISTORY_ROUTING_PLAN.md, owner decision B) the post-merge
// assumption applies to geth only; other non-reporting clients (nethermind) get no by-number
// receipts or bodies (utils/history.js nodeFloor).
const historyDefaults = {
  rethBodyFloor: 15500000,
  rethStateWindow: 10000,
  unknownHistoryFloor: 15537394, // the Merge
  unknownStateWindow: 127, // geth v1.17.4 (stage, 2026-09-28): state at head - 127 served, head - 128 not
};

const heavyInFlightMaxAge = 120000; // Drop in-flight entries (all methods) whose response never came back (ms)

const pointUpdateInterval = 10000;
// const requestSetChance = 5; // 1 in n requests will be a set request
const requestSetChance = 20; // 1 in n requests will be a set request
// Slow nodes (timeout rate > spotCheckOnlyThreshold) never serve a request on their own
// (getLogs plan D13). With this on, up to 2 of them join a 1-in-requestSetChance comparison set
// next to a fast node, so a recovered node can earn its way back. Light methods only.
const slowSpotChecks = true;
const spotCheckOnlyThreshold = 0.05; // The timeout percentage threshold (0-1) that excludes nodes from handling single requests (e.g., 0.5 = 50% timeout rate)
const nodeTimingFetchInterval = 60 * 60 * 1000; // Interval for fetching node timeout data (1 hour)
const poolNodeStaleThreshold = 5 * 60 * 1000; // 5 minutes Timeout threshold for stale nodes in poolMap

const poolNodeLogPath = "/home/ubuntu/shared/poolNodes.log";
const compareResultsLogPath = "/home/ubuntu/shared/poolCompareResults.log";

// Map of RPC methods that can be cached with their block number parameter positions
const cacheableMethods = new Map([  
  // Methods with block number at position 0 (first parameter)
  ['eth_getBlockByNumber', 0],
  ['eth_getBlockTransactionCountByNumber', 0],
  ['eth_getUncleCountByBlockNumber', 0],
  ['eth_getUncleByBlockNumberAndIndex', 0],
  ['eth_getTransactionByBlockNumberAndIndex', 0],
  ['eth_getBlockReceipts', 0],
  
  // Methods with block number at position 1 (second parameter)
  ['eth_getBalance', 1],
  ['eth_getTransactionCount', 1],
  ['eth_getCode', 1],
  ['eth_call', 1],
  ['eth_estimateGas', 1],
  ['eth_feeHistory', 1],
  
  // Methods with block number at position 2 (third parameter)
  ['eth_getStorageAt', 2],
  
  // Methods with no block number parameter (hash-based or transaction-based)
  ['eth_getBlockByHash', null],
  ['eth_getBlockTransactionCountByHash', null],
  ['eth_getUncleCountByBlockHash', null],
  ['eth_getUncleByBlockHashAndIndex', null],
  ['eth_getTransactionByHash', null],
  ['eth_getTransactionByBlockHashAndIndex', null],
  ['eth_getTransactionReceipt', null],
]);

module.exports = {
  historyDefaults,
  portPoolPublic,
  poolPort,
  wsHeartbeatInterval,
  nodeDefaultTimeout,
  nodeMethodSpecificTimeouts,
  heavyMethods,
  disabledMethods,
  routingMode,
  defaultMethodProfile,
  methodProfiles,
  heavyInFlightMaxAge,
  pointUpdateInterval,
  requestSetChance,
  slowSpotChecks,
  spotCheckOnlyThreshold,
  nodeTimingFetchInterval,
  poolNodeStaleThreshold,

  poolNodeLogPath,
  compareResultsLogPath,
  methodsToSkipComparison,
  cacheableMethods,
};