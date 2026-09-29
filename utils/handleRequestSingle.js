/**
 * Handles a single JSON-RPC request by sending it to one client, with retry on timeout
 * @param {Object} rpcRequest - The JSON-RPC request object
 * @param {Array} selectedSocketIds - Array of socket IDs to send the request to (up to 3)
 * @param {Map} poolMap - Map containing all connected clients 
 * @param {Object} io - Socket.IO instance
 * @param {Object} [heavyConfig] - config.heavyMethods entry for getLogs/filter methods: own
 *   timeout, retry only if heavyConfig.retry, per-node in-flight counting, and timeouts logged
 *   as 'timeout_error_heavy' (kept out of node ratings)
 * @param {number} [cost=1] - weight of this request in the node's in-flight load (Phase 3b-2)
 * @param {Function} [selectRetry] - (triedNodeIds) => socket id or null. When given, a timed-out
 *   request is retried on the node it picks at that moment (Phase 3b-4); without it (legacy
 *   routing) the retry goes to selectedSocketIds[1]
 * @returns {Promise<Object>} - Promise resolving to the result of the RPC request
 */
const { logNode } = require('./logNode');
const nodeLoad = require('./nodeLoad');

const { nodeDefaultTimeout, nodeMethodSpecificTimeouts } = require('../config');

// buidlguidl-client answers -70000 "Internal node error" when its own execution client didn't
// answer (unreachable, crashed, or erroring): a failure of the node, like a timeout. bg-rpc-logs
// counts these in the node's rating too (utils/metricsCalculators.js)
function isNodeFailure(result) {
  return result.status === 'error' && result.data?.code === -70000;
}

async function handleRequestSingle(rpcRequest, selectedSocketIds, poolMap, io, heavyConfig = null, cost = 1, selectRetry = null) {
  const startTime = Date.now();
  const utcTimestamp = new Date().toISOString();

  if (!Array.isArray(selectedSocketIds) || selectedSocketIds.length === 0) {
    return { 
      status: 'error', 
      data: {
        code: -69000,
        message: "No clients selected"
      }
    };
  }

  // Try first node
  const firstResult = await tryNode(rpcRequest, selectedSocketIds[0], poolMap, io, startTime, utcTimestamp, heavyConfig, cost);
  
  // Success, or the node's own answer to the request (a caller's mistake, a revert...): return
  // it. A timeout, or the client's -70000 "Internal node error" (its local execution client
  // didn't answer: a broken node, not a bad request), is the node failing: try another node
  // (plan M15: an instantly failing node's errors reached callers instead of being retried)
  if (firstResult.status === 'success' || !(firstResult.data.code === -69005 || isNodeFailure(firstResult))) {
    return firstResult;
  }

  if (heavyConfig && !heavyConfig.retry) {
    console.log(`❌ Node ${firstResult.data.code === -69005 ? 'timed out' : 'failed'} on ${rpcRequest.method}; heavy methods are not retried`);
    return firstResult;
  }
  
  // First node timed out - check if we have a second node to try
  const firstNodeId = poolMap.get(selectedSocketIds[0])?.id;
  const retrySocketId = selectRetry ? selectRetry([firstNodeId]) : selectedSocketIds[1];
  if (retrySocketId) {
    console.log(`🔄 First node ${firstResult.data.code === -69005 ? 'timed out' : 'failed (' + firstResult.data.message + ')'}, retrying with second node...`);
    const secondResult = await tryNode(rpcRequest, retrySocketId, poolMap, io, startTime, utcTimestamp, heavyConfig, cost);
    return secondResult;
  }
  
  // No second node available, return the timeout error
  console.log(`❌ First node timed out and no second node available`);
  return firstResult;
}

/**
 * Attempts to send an RPC request to a single node
 * @param {Object} rpcRequest - The JSON-RPC request object
 * @param {string} clientId - Socket ID of the client to send the request to
 * @param {Map} poolMap - Map containing all connected clients 
 * @param {Object} io - Socket.IO instance
 * @param {number} startTime - Timestamp when the overall request started (for UTC timestamp)
 * @param {string} utcTimestamp - UTC timestamp string
 * @param {Object|null} heavyConfig - see handleRequestSingle
 * @param {number} cost - see handleRequestSingle
 * @returns {Promise<Object>} - Promise resolving to the result of the RPC request
 */
async function tryNode(rpcRequest, clientId, poolMap, io, startTime, utcTimestamp, heavyConfig, cost) {
  // Track this specific node attempt's start time for accurate duration logging
  const nodeStartTime = Date.now();
  
  // Create a promise that will resolve with the response or error if it times out
  return new Promise((resolve, reject) => {
    let hasResolved = false; // Flag to track if we've resolved with a response
    const client = poolMap.get(clientId);
    const socket = io.sockets.sockets.get(client.wsID);
    let hasReceivedResponse = false; // Track if the client has responded

    // Validate socket exists and is connected
    if (!socket || socket.disconnected) {
      console.log(`Socket validation failed for client ${clientId}: socket ${socket ? 'disconnected' : 'not found'}`);
      
      // Log socket error
      logNode(
        { body: rpcRequest },
        nodeStartTime,
        utcTimestamp,
        0,
        'socket_error',
        client.id || 'unknown',
        client.owner || 'unknown'
      );

      // Resolve with socket error immediately
      resolve({ 
        status: 'error', 
        data: {
          code: -69007,
          message: "Node has invalid socket"
        }
      });
      return;
    }

    // Determine timeout based on RPC method
    const timeout = heavyConfig
      ? heavyConfig.timeout
      : (nodeMethodSpecificTimeouts[rpcRequest.method] || nodeDefaultTimeout);

    // Counts against the node until it answers or the socket disconnects, not until the
    // timeout: the node keeps working after we stop waiting
    const loadToken = nodeLoad.acquire(client.id, client.wsID, { cost, heavy: !!heavyConfig });

    // Set up timeout for the client
    const timeoutId = setTimeout(() => {
      if (!hasReceivedResponse) { // Only timeout if we haven't received a response
        // Log timeout error
        logNode(
          { body: rpcRequest },
          nodeStartTime,
          utcTimestamp,
          Date.now() - nodeStartTime,
          heavyConfig ? 'timeout_error_heavy' : 'timeout_error',
          client.id || 'unknown',
          client.owner || 'unknown'
        );

        // Do not remove global 'rpc_request' listeners; ack callbacks are cleaned up automatically
        // socket.removeAllListeners('rpc_request'); // removed to prevent interfering with other in-flight requests

        // Resolve with a timeout error
        hasResolved = true;
        console.error('RPC response timed out for client:', clientId);
        resolve({ 
          status: 'error', 
          data: {
            code: -69005,
            message: "Node timed out"
          }
        });
      }
    }, timeout);

    // Send the request to the client
    socket.emit('rpc_request', rpcRequest, async (response) => {
      nodeLoad.release(client.id, loadToken);

      if (hasResolved) { // If already resolved (e.g., by timeout), ignore this response
        console.warn(`Ignoring response from node ${client.id} as the request already timed out.`);
        return;
      }

      if (hasReceivedResponse) {
        console.error(`Ignoring duplicate response from node ${client.id}`);
        return;
      }

      // Mark as received immediately to prevent race conditions
      hasReceivedResponse = true;
      clearTimeout(timeoutId);

      // Now process the response - use nodeStartTime for accurate duration
      const responseTime = Date.now() - nodeStartTime;

      // Validate response format first
      if (!response || typeof response !== 'object' || response.jsonrpc !== '2.0') {
        console.error(`Invalid JSON-RPC response format from node ${client.id}:`, response);
        logNode(
          { body: rpcRequest },
          nodeStartTime,
          utcTimestamp,
          responseTime,
          'invalid_format',
          client.id || 'unknown',
          client.owner || 'unknown'
        );
        
        if (!hasResolved) {
          hasResolved = true;
          resolve({ 
            status: 'error', 
            data: {
              code: -69007,
              message: "Invalid response format from node"
            }
          });
        }
      } else if (response.error) {
        logNode(
          { body: rpcRequest },
          nodeStartTime,
          utcTimestamp,
          responseTime,
          response.error,
          client.id || 'unknown',
          client.owner || 'unknown'
        );
        
        if (!hasResolved) {
          hasResolved = true;
          resolve({ 
            status: 'error', 
            data: response.error,
            respondingClientId: clientId // The history retry (3c) needs to know which node said "pruned"
          });
        }
      } else if (response.result !== undefined) {
        logNode(
          { body: rpcRequest },
          nodeStartTime,
          utcTimestamp,
          responseTime,
          'success',
          client.id || 'unknown',
          client.owner || 'unknown'
        );
        
        // Resolve with the successful response
        if (!hasResolved) {
          hasResolved = true;

          resolve({ 
            status: 'success', 
            data: response.result,
            respondingClientId: clientId // Include the responding client ID for cache validation
          });
        }
      } else {
        // Handle case where response is valid JSON-RPC but missing both error and result
        console.error(`Invalid JSON-RPC response from node ${client.id}: neither error nor result present:`, response);
        logNode(
          { body: rpcRequest },
          nodeStartTime,
          utcTimestamp,
          responseTime,
          'invalid_response',
          client.id || 'unknown',
          client.owner || 'unknown'
        );
        
        if (!hasResolved) {
          hasResolved = true;
          resolve({ 
            status: 'error', 
            data: {
              code: -70002,
              message: "Invalid response from node (missing result and error)"
            }
          });
        }
      }
      
      console.log('👍 Response received from single node');
    });
  });
}

module.exports = { handleRequestSingle, isNodeFailure }; 