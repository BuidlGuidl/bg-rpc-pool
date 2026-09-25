/**
 * Handles a JSON-RPC request by sending it to multiple randomly selected clients
 * and returning the first successful response
 * 
 * @param {Object} rpcRequest - The JSON-RPC request object
 * @param {Array} selectedSocketIds - Array of socket IDs to send the request to
 * @param {Map} poolMap - Map containing all connected clients 
 * @param {Object} io - Socket.IO instance
 * @param {number} [cost=1] - weight of this request in each node's in-flight load (Phase 3b-2)
 * @returns {Promise<Object>} - Promise resolving to the result of the RPC request
 */
const { logNode } = require('./logNode');
const { compareResults } = require('./compareResults');
const { logCompareResults } = require('./logCompareResults');
const { ignoredErrorCodes } = require('../../shared/ignoredErrorCodes');

const { nodeDefaultTimeout, nodeMethodSpecificTimeouts } = require('../config');
const nodeLoad = require('./nodeLoad');

async function handleRequestSet(rpcRequest, selectedSocketIds, poolMap, io, cost = 1) {
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

  // Map to store responses from each client
  const responseMap = new Map();
  // Map to track if a response (timeout or actual) has been received for each client
  const receivedResponseMap = new Map();

  // Create a promise that will resolve with the fastest successful response or error if all timeout
  return new Promise((resolve, reject) => {
    let hasResolved = false;  // Flag to track if we've resolved with a response
    let pendingResponses = selectedSocketIds.length;  // Track remaining responses

    // Determine timeout based on RPC method
    const timeout = nodeMethodSpecificTimeouts[rpcRequest.method] || nodeDefaultTimeout;

    selectedSocketIds.forEach(clientId => {
      const client = poolMap.get(clientId);
      const socket = io.sockets.sockets.get(client.wsID);

      // Validate socket exists and is connected
      if (!socket || socket.disconnected) {
        console.log(`Socket validation failed for client ${clientId}: socket ${socket ? 'disconnected' : 'not found'}`);
        pendingResponses--;
        responseMap.set(clientId, { status: 'socket_error', time: 0 });
        receivedResponseMap.set(clientId, true);
        
        // Log socket error
        logNode(
          { body: rpcRequest },
          startTime,
          utcTimestamp,
          0,
          'socket_error',
          client.id || 'unknown',
          client.owner || 'unknown'
        );

        // If all responses have failed and we haven't resolved yet, resolve with an error
        if (pendingResponses === 0 && !hasResolved) {
          hasResolved = true;
          console.error('All RPC sockets failed validation:', JSON.stringify(Object.fromEntries(responseMap), null, 2));
          resolve({ 
            status: 'error', 
            data: {
              code: -69007,
              message: "All nodes have invalid sockets"
            }
          });
        }
        return; // Skip this client
      }

      // Counts against the node until it answers (even late) or disconnects (Phase 3b-2)
      const loadToken = nodeLoad.acquire(client.id, client.wsID, { cost });

      // Set up timeout for each client
      const timeoutId = setTimeout(() => {
        if (!receivedResponseMap.get(clientId)) {  // Only timeout if we haven't received a response
          pendingResponses--;
          responseMap.set(clientId, { status: 'timeout', time: Date.now() - startTime });
          receivedResponseMap.set(clientId, true);
          
          // Log timeout error
          logNode(
            { body: rpcRequest },
            startTime,
            utcTimestamp,
            Date.now() - startTime,
            'timeout_error',
            client.id || 'unknown',
            client.owner || 'unknown'
          );

          // Do not remove global 'rpc_request' listeners; ack callbacks are cleaned up automatically
          // socket.removeAllListeners('rpc_request'); // removed to prevent interfering with other in-flight requests

          // If all responses have timed out and we haven't resolved yet, resolve with an error
          if (pendingResponses === 0 && !hasResolved) {
            hasResolved = true;
            console.error('All RPC responses timed out:', JSON.stringify(Object.fromEntries(responseMap), null, 2));
            resolve({ 
              status: 'error', 
              data: {
                code: -69006,
                message: "All nodes timed out"
              }
            });
          }
        }
      }, timeout);

      // Send the request to each client
      socket.emit('rpc_request', rpcRequest, async (response) => {
        nodeLoad.release(client.id, loadToken);

        if (receivedResponseMap.get(clientId)) {
          // This is a late response after timeout, ignore it
          return;
        }
        receivedResponseMap.set(clientId, true);
        clearTimeout(timeoutId);
        pendingResponses--;

        // Now process the response
        const responseTime = Date.now() - startTime;

        // Validate response format first
        if (!response || typeof response !== 'object' || response.jsonrpc !== '2.0') {
          console.error(`Invalid JSON-RPC response format from node ${client.id}:`, response);
          responseMap.set(clientId, { status: 'invalid', time: responseTime });
          logNode(
            { body: rpcRequest },
            startTime,
            utcTimestamp,
            responseTime,
            'invalid_format',
            client.id || 'unknown',
            client.owner || 'unknown'
          );
        } else if (response.error) {
          responseMap.set(clientId, { 
            status: 'error',
            response: response,
            time: responseTime 
          });
          logNode(
            { body: rpcRequest },
            startTime,
            utcTimestamp,
            responseTime,
            response.error,
            client.id || 'unknown',
            client.owner || 'unknown'
          );
          // If error code is in ignoredErrorCodes, resolve immediately with this error
          if (response.error && ignoredErrorCodes.includes(response.error.code)) {
            if (!hasResolved) {
              hasResolved = true;
              resolve({ status: 'error', data: response.error });
            }
            // Do not return here; continue to process for points, etc.
          }
        } else if (response.result !== undefined) {
          responseMap.set(clientId, { 
            status: 'success',
            response: response,
            time: responseTime 
          });
          logNode(
            { body: rpcRequest },
            startTime,
            utcTimestamp,
            responseTime,
            'success',
            client.id || 'unknown',
            client.owner || 'unknown'
          );
          // Resolve with the first successful response if we haven't already
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
          responseMap.set(clientId, { status: 'invalid', time: responseTime });
          logNode(
            { body: rpcRequest },
            startTime,
            utcTimestamp,
            responseTime,
            'invalid_response',
            client.id || 'unknown',
            client.owner || 'unknown'
          );
        }

        // If this was the last pending response, log all responses and resolve if we haven't already
        if (pendingResponses === 0) {
          console.log('👍 All responses received');

          const { resultsMatch, mismatchedNode, mismatchedOwner, mismatchedResults } = compareResults(responseMap, poolMap, rpcRequest.method);
          console.log('Results match:', resultsMatch);
          console.log('Mismatched node:', mismatchedNode);
          console.log('Mismatched owner:', mismatchedOwner);
          
          logCompareResults(resultsMatch, mismatchedNode, mismatchedOwner, mismatchedResults, responseMap, poolMap, rpcRequest.method, rpcRequest.params);
          
          if (!hasResolved) {
            // If we get here and haven't resolved, it means all responses were errors
            hasResolved = true;
            resolve({ 
              status: 'error', 
              data: {
                code: -69003,
                message: "All nodes failed to respond successfully"
              }
            });
          }
        }
      });
    });
  });
}

module.exports = { handleRequestSet }; 