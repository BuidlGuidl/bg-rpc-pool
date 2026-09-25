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
const defaultMethodProfile = { timeout: nodeDefaultTimeout, retry: true, compare: true };

// Constant or node-specific answers, or "latest" state that legitimately differs between
// nodes on different blocks: never compared
const noCompare = { compare: false };

// Filter ("ticket") methods are disabled (getLogs plan D15): a filter id only exists on the
// node that created it, and with several nodes the follow-up call usually lands elsewhere.
// Their routing settings are kept, so deleting `disabled` re-enables them as before.
const methodProfiles = {
  eth_getBlockReceipts:      { timeout: 2000 },
  eth_getBlockByNumber:      { timeout: 1500 },
  eth_getBlockByHash:        { timeout: 1500 },
  eth_getTransactionReceipt: { timeout: 2000 },

  // Constant network information
  eth_chainId:               noCompare,
  net_version:               noCompare,
  eth_protocolVersion:       noCompare,
  // Node-specific state (not consensus data)
  eth_accounts:              noCompare,
  eth_syncing:               noCompare,
  eth_mining:                noCompare,
  eth_hashrate:              noCompare,
  eth_coinbase:              noCompare,
  net_listening:             noCompare,
  net_peerCount:             noCompare,
  web3_clientVersion:        noCompare,
  web3_sha3:                 noCompare, // Pure function, not state
  // Time-sensitive "latest" state
  eth_blockNumber:           noCompare,
  eth_gasPrice:              noCompare,
  eth_maxPriorityFeePerGas:  noCompare,
  eth_feeHistory:            noCompare,
  // Mempool (inherently node-specific)
  eth_pendingTransactions:   noCompare,
  txpool_status:             noCompare,
  txpool_content:            noCompare,
  txpool_inspect:            noCompare,

  // Range queries
  eth_getLogs:               { timeout: 5000, retry: false, compare: false, heavy: { maxPerNode: 4 } },

  // Filter methods (disabled, D15)
  eth_getFilterLogs:         { timeout: 5000, retry: false, compare: false, heavy: { maxPerNode: 4 }, disabled: true },
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

const heavyInFlightMaxAge = 120000; // Drop in-flight entries whose response never came back (ms)

const pointUpdateInterval = 10000;
// const requestSetChance = 5; // 1 in n requests will be a set request
const requestSetChance = 20; // 1 in n requests will be a set request
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
  spotCheckOnlyThreshold,
  nodeTimingFetchInterval,
  poolNodeStaleThreshold,

  poolNodeLogPath,
  compareResultsLogPath,
  methodsToSkipComparison,
  cacheableMethods,
};