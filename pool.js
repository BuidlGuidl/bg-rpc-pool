const { Server } = require('socket.io');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');

const { updateLocationTable } = require('./database_scripts/updateLocationTable');
const { getOwnerPoints } = require('./database_scripts/getOwnerPoints');
const { getOwnerPendingBread } = require('./database_scripts/getOwnerPendingBread');
const { getEnsNamesByAddress } = require('./database_scripts/getEnsNamesByAddress');
const { getEnodesObject } = require('./utils/getEnodesObject');
const { getPeerIdsObject } = require('./utils/getPeerIdsObject');
const { getConsensusPeerAddrObject } = require('./utils/getConsensusPeerAddrObject');
const { getPoolNodesObject } = require('./utils/getPoolNodesObject');
const { constructNodeContinentsObject, getNodeContinentsObject } = require('./utils/getNodeContinentsObject');
const { getRpcSiteStatsObject } = require('./utils/getRpcSiteStatsObject');
const { getYourNodesObject } = require('./utils/getYourNodesObject');
const { select, takeSnapshot, getHeavyStatus } = require('./utils/selectNodes');
const { decideLegacy } = require('./utils/routeLegacy');
const nodeLoad = require('./utils/nodeLoad');
const { fetchNodeTimingData } = require('./utils/nodeTimingUtils');
const { handleRequestSingle } = require('./utils/handleRequestSingle');
const { handleRequestSet } = require('./utils/handleRequestSet');
const { updateCache } = require('./utils/updateCache');
const { broadcastUpdate } = require('./utils/updateCache');
const { processNodesForBread } = require('./utils/processNodesForBread');
const { mintBread } = require('./utils/mintBread');
const { getBlockNumberMode } = require('./utils/getBlockNumberMode');
const { sendTelegramAlert } = require('./utils/telegramUtils');
const { isMachineIdSuspicious, extractMacAddressFromMachineId, getSuspiciousMacAddresses, reloadSuspiciousMacAddresses } = require('./utils/suspiciousMacChecker');

const { portPoolPublic, poolPort, wsHeartbeatInterval, requestSetChance, nodeTimingFetchInterval, poolNodeStaleThreshold, cacheableMethods, routingMode } = require('./config');

const poolMap = new Map();

// Counter to track processNodesForBread calls
let breadProcessingCounter = 0;

const seenNodes = new Set(); // Track nodes we've already processed
const suspiciousNodes = new Set(); // Track nodes reporting suspicious block numbers

// Fetch node timeout data immediately on startup
fetchNodeTimingData().catch(error => {
  console.error('Error in initial fetchNodeTimingData:', error.message);
});

// Set up hourly fetch of node timeout data
setInterval(() => {
  fetchNodeTimingData().catch(error => {
    console.error('Error in hourly fetchNodeTimingData:', error.message);
  });
}, nodeTimingFetchInterval);

// Set up periodic cleanup of stale connections
setInterval(() => {
  const now = Date.now();
  
  for (const [socketId, client] of poolMap.entries()) {
    let shouldRemove = false;
    let reason = '';
    
    // Check if the client has a lastSeen timestamp and if it's stale
    if (client.lastSeen && (now - client.lastSeen) > poolNodeStaleThreshold) {
      shouldRemove = true;
      reason = `stale (last seen: ${new Date(client.lastSeen).toISOString()})`;
    }
    
    // Check if the socket is disconnected
    if (client.socket && client.socket.disconnected) {
      shouldRemove = true;
      reason = 'socket disconnected';
    }
    
    if (shouldRemove) {
      console.log(`Removing ${reason} connection: socket ${socketId}, machine_id: ${client.machine_id || 'unknown'}`);
      poolMap.delete(socketId);
      suspiciousNodes.delete(socketId);
    }
  }
  
  // Clean up suspicious nodes that are no longer in the pool
  for (const suspiciousSocketId of suspiciousNodes) {
    if (!poolMap.has(suspiciousSocketId)) {
      console.log(`Removing disconnected node from suspicious list: ${suspiciousSocketId}`);
      suspiciousNodes.delete(suspiciousSocketId);
    }
  }
}, 60000); // Run every minute

// SSL configuration for Socket.IO server
const wsServer = https.createServer({
  key: fs.readFileSync('/home/ubuntu/shared/server.key'),
  cert: fs.readFileSync('/home/ubuntu/shared/server.cert')
}, async (req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Handle /yourpoints endpoint
  if (req.url.startsWith('/yourpoints')) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const owner = url.searchParams.get('owner');
    
    if (owner) {
      try {
        const points = await getOwnerPoints(owner);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ owner, points }));
      } catch (error) {
        console.error('Error retrieving points:', error);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ owner, points: 0 }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ owner: '', points: 0 }));
    }
    return;
  }

  // Handle /yourpendingbread endpoint
  if (req.url.startsWith('/yourpendingbread')) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const owner = url.searchParams.get('owner');
    
    if (owner) {
      try {
        const bread = await getOwnerPendingBread(owner);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ owner, bread }));
      } catch (error) {
        console.error('Error retrieving bread:', error);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ owner, bread: 0 }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ owner: '', bread: 0 }));
    }
    return;
  }

  if (req.url === '/enodes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getEnodesObject(poolMap)));
    return;
  }

  // /watchdog endpoint for health checks
  if (req.url === '/watchdog') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/peerids') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPeerIdsObject(poolMap)));
    return;
  }

  if (req.url === '/consensuspeeraddr') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConsensusPeerAddrObject(poolMap)));
    return;
  }
  
  // For any other endpoints, return 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Initialize Socket.IO with CORS and ping configurations
const io = new Server(wsServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: wsHeartbeatInterval,
  pingTimeout: wsHeartbeatInterval * 2,
  // Per-message ceiling (default 1 MB); exceeding it disconnects the node. Must stay
  // above the node client's 32 MB maxContentLength so oversized responses surface
  // there as a JSON-RPC error instead. Applies to the uncompressed size.
  maxHttpBufferSize: 64e6,
  // Node clients already offer permessage-deflate; ~10x on logs and receipts
  perMessageDeflate: { threshold: 1024 }
});

// Create HTTP server for the API endpoint (no SSL)
const wsServerInternal = require('https').createServer(
  {
    key: fs.readFileSync('/home/ubuntu/shared/server.key'),
    cert: fs.readFileSync('/home/ubuntu/shared/server.cert'),
  },
  async (req, res) => {  
  // Add CORS headers and security headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  if (req.url === '/getlogsStatus' && req.method === 'GET') {
    const response = JSON.stringify(getHeavyStatus(poolMap));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(response)
    });
    res.end(response);
    return;
  }

  if (req.url === '/poolNodes' && req.method === 'GET') {
    try {      
      const poolNodes = getPoolNodesObject(poolMap);
      
      const response = JSON.stringify(poolNodes, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /poolNodes endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url === '/nodeContinents' && req.method === 'GET') {
    try {
      const continentsData = await getNodeContinentsObject(poolMap);
      
      const response = JSON.stringify(continentsData);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /nodeContinents endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url === '/rpcSiteStats' && req.method === 'GET') {
    try {
      const rpcSiteStatsData = getRpcSiteStatsObject(poolMap);
      
      const response = JSON.stringify(rpcSiteStatsData);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /rpcSiteStats endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url.startsWith('/yournodes') && req.method === 'GET') {
    try {
      // Parse query parameters
      const url = new URL(req.url, `https://${req.headers.host}`);
      const owner = url.searchParams.get('owner');
      
      if (!owner) {
        const errorResponse = JSON.stringify({
          error: 'Missing required parameter',
          message: 'Owner address is required'
        });
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(errorResponse)
        });
        res.end(errorResponse);
        return;
      }

      // Query ENS table to find all ENS names associated with this address
      const ensNames = await getEnsNamesByAddress(owner);
      console.log(`Found ${ensNames.length} ENS name(s) for address ${owner}:`, ensNames);

      // Get node data, matching by both address and ENS names
      const yourNodesData = getYourNodesObject(poolMap, owner, ensNames);
      
      const response = JSON.stringify(yourNodesData);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /yournodes endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url === '/suspiciousNodes' && req.method === 'GET') {
    try {
      const suspiciousNodesData = Array.from(suspiciousNodes).map(socketId => {
        const client = poolMap.get(socketId);
        const macAddress = client?.machine_id ? extractMacAddressFromMachineId(client.machine_id) : null;
        const isMacSuspicious = macAddress ? isMachineIdSuspicious(client.machine_id) : false;
        
        return {
          socketId,
          nodeId: client?.id || 'unknown',
          machineId: client?.machine_id || 'unknown',
          macAddress: macAddress || 'unknown',
          owner: client?.owner || 'unknown',
          blockNumber: client?.block_number || 'unknown',
          lastSeen: client?.lastSeen ? new Date(client.lastSeen).toISOString() : 'unknown',
          suspiciousReason: isMacSuspicious ? 'suspicious MAC address' : 'block number deviation'
        };
      });
      
      const response = JSON.stringify({
        suspiciousNodesCount: suspiciousNodes.size,
        suspiciousNodes: suspiciousNodesData
      }, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /suspiciousNodes endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url === '/suspiciousMacAddresses' && req.method === 'GET') {
    try {
      const macAddresses = getSuspiciousMacAddresses();
      
      const response = JSON.stringify({
        suspiciousMacAddresses: macAddresses,
        count: macAddresses.length
      }, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /suspiciousMacAddresses endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url === '/reloadSuspiciousMacAddresses' && req.method === 'POST') {
    try {
      reloadSuspiciousMacAddresses();
      
      const response = JSON.stringify({
        message: 'Suspicious MAC addresses reloaded successfully',
        suspiciousMacAddresses: getSuspiciousMacAddresses(),
        count: getSuspiciousMacAddresses().length
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    } catch (error) {
      console.error('Error in /reloadSuspiciousMacAddresses endpoint:', error);
      const errorResponse = JSON.stringify({
        error: 'Internal server error',
        message: error.message
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorResponse)
      });
      res.end(errorResponse);
    }
    return;
  }

  if (req.url === '/requestPool' && req.method === 'POST') {
    let body = '';
    
    // Handle request errors
    req.on('error', (err) => {
      console.error('Error in request:', err);
      res.statusCode = 500;
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -70001,
          message: "Internal Pool service error",
          data: err.message
        },
        id: null
      }));
    });

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const rpcRequest = JSON.parse(body);
        console.log("-----------------------------------------------------------------------------------------");
        const { jsonrpc, id, method } = rpcRequest;
        console.log('📡 Received RPC request:', { jsonrpc, id, method });

        try {
          let result;

          const decision = routingMode === 'legacy'
            ? decideLegacy(rpcRequest, poolMap)
            : select(rpcRequest, takeSnapshot(poolMap));

          if (decision.error) {
            console.log(`🚫 ${rpcRequest.method}: ${decision.error.message}`);
            res.statusCode = 500;
            res.end(JSON.stringify({ jsonrpc: "2.0", error: decision.error, id: rpcRequest.id }));
            return;
          }

          console.log(`Selected clients: ${decision.socketIds}`);
          if (decision.heavy) {
            // getLogs: one eligible reth node, no retry, no comparison
            result = await handleRequestSingle(rpcRequest, decision.socketIds, poolMap, io, decision.heavy, decision.cost ?? 1);
          } else if (decision.handler === 'set') {
            console.log(`🖖 Randomly selected handleRequestSet (1/${requestSetChance} probability)`);
            result = await handleRequestSet(rpcRequest, decision.socketIds, poolMap, io, decision.cost ?? 1);
          } else {
            if (decision.reason === 'skips comparison') {
              console.log(`Using handleRequestSingle for ${rpcRequest.method} (skips comparison)`);
            } else if (decision.reason === 'random single') {
              console.log(`☝️ Randomly selected handleRequestSingle (${requestSetChance-1}/${requestSetChance} probability)`);
            }
            result = await handleRequestSingle(rpcRequest, decision.socketIds, poolMap, io, null, decision.cost ?? 1);
          }
          
          if (result.status === 'success') {
            res.statusCode = 200;
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              result: result.data,
              id: rpcRequest.id
            }));

            // Check if the responding node is suspicious before caching
            let shouldCache = true;
            if (result.respondingClientId) {
              const respondingClient = poolMap.get(result.respondingClientId);
              if (respondingClient && respondingClient.suspicious) {
                console.log(`🚫 Not caching response from suspicious node: ${respondingClient.id || result.respondingClientId}`);
                shouldCache = false;
              }
            }

                      // Check if method is cacheable and block number is a hex value
          const method = rpcRequest.method;
          console.log(`🧮 Method: ${method}`);
          if (cacheableMethods.has(method) && shouldCache) {
            console.log(`💾 Is cacheable method and responding node is not suspicious`);
            
            // Don't cache if result is null
            if (result.data === null) {
              console.log(`🚫 Not caching null result for method: ${method}`);
            } else {
              const blockNumberPosition = cacheableMethods.get(method);
              const params = rpcRequest.params || [];
              
              // For methods with null blockNumberPosition (like eth_getBlockTransactionCountByHash),
              // we can cache without checking block number
              if (blockNumberPosition === null) {
                console.log(`💾 Method has no block number parameter, caching directly`);
                broadcastUpdate(wssCache, method, params, result.data);
              } else {
                const blockNumber = params[blockNumberPosition];
                console.log(`📍 Block number position: ${blockNumberPosition}`);
                console.log(`🎛️ Params: ${params}`);
                console.log(`🧱 Block number: ${blockNumber}`);
                
                // Check if blockNumber is a hex value (not a keyword)
                if (blockNumber && typeof blockNumber === 'string' && 
                    blockNumber.startsWith('0x') && 
                    !['latest', 'earliest', 'pending', 'safe', 'finalized'].includes(blockNumber)) {
                  // Broadcast cache update to proxy.js
                  broadcastUpdate(wssCache, method, params, result.data);
                }
              }
            }
          } else if (!shouldCache) {
            console.log(`🚫 Skipping cache for response from suspicious node`);
          }
          } else {
            res.statusCode = 500;
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: result.data,
              id: rpcRequest.id
            }));
          }
        } catch (error) {
          console.error('Error handling request:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -70001,
              message: error.message || "Internal Pool service error"
            },
            id: rpcRequest.id
          }));
        }
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error"
          },
          id: null
        }));
      }
    });
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message: "Method not found"
      },
      id: null
    }));
  }
});

// Create WebSocket server attached to the HTTPS server to send cache updates to proxy.js
const wssCache = new WebSocket.Server({ server: wsServerInternal });

// Handle WebSocket connections
wssCache.on('connection', (ws) => {
  console.log('Proxy.js WebSocket connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data);
      
      // Echo back the message for testing
      ws.send(JSON.stringify({
        type: 'response',
        data: data
      }));
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });

  // Send initial connection message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Successfully connected to WebSocket server'
  }));
});

console.log("----------------------------------------------------------------------------------------------------------------");
console.log("----------------------------------------------------------------------------------------------------------------");
wsServer.listen(portPoolPublic, () => {
  console.log(`Socket.IO server listening on port ${portPoolPublic}...`);
});

wsServerInternal.listen(poolPort, () => {
  console.log(`WS server (poolPort) listening on port ${poolPort}...`);
});

io.on('connection', (socket) => {
  console.log(`Socket.IO client ${socket.id} connected`);

  const client = { socket, wsID: socket.id, lastSeen: Date.now() };
  poolMap.set(socket.id, client);
  socket.emit('init', { id: socket.id });
  
  // Handle checkin messages
  socket.on('checkin', async (message) => {
    try {
      // Handle both old and new format
      const params = message.params || message;
      const existingClient = poolMap.get(socket.id);
      
      // Extract machine ID from the node ID if it's in the format "bgnodeX-..."
      // TODO: Figure out why this is needed. Seems weird.
      let machineId = params.id;
      if (params.id && typeof params.id === 'string' && params.id.startsWith('bgnode')) {
        machineId = params.id;
      }
      
      // Clean up any existing entries for the same machine ID (from previous connections)
      if (machineId && machineId !== "N/A" && machineId !== null && machineId !== undefined) {
        for (const [socketId, client] of poolMap.entries()) {
          if (socketId !== socket.id && client.machine_id === machineId) {
            console.log(`Removing duplicate entry for machine_id ${machineId} (socket ${socketId})`);
            poolMap.delete(socketId);
            suspiciousNodes.delete(socketId);
          }
        }
      }
      
      // Calculate the mode before updating the pool to check for suspicious activity
      const mode = getBlockNumberMode(poolMap);
      let isSuspicious = false;
      let suspiciousReason = '';
      
      // Check if MAC address is in the suspicious list
      if (machineId && isMachineIdSuspicious(machineId)) {
        const macAddress = extractMacAddressFromMachineId(machineId);
        console.log(`🚨 Node with suspicious MAC address detected: ${params.id || socket.id} (MAC: ${macAddress})`);
        // Don't delete this
        // sendTelegramAlert(`\n------------------------------------------\n🚨 Node with suspicious MAC address detected: ${params.id || socket.id} (MAC: ${macAddress}). Node marked as suspicious and excluded from routing.`);
        suspiciousNodes.add(socket.id);
        isSuspicious = true;
        suspiciousReason = 'suspicious MAC address';
      }
      
      // Check for significant block number deviation and mark as suspicious (only if not already suspicious)
      // Only perform this check after at least 5 nodes with valid block numbers have checked in
      const validBlockNumberCount = Array.from(poolMap.values())
        .filter(client => !client.suspicious && client.block_number && client.block_number !== 'SUSPICIOUS')
        .length;
      
      if (!isSuspicious && params.block_number && mode && validBlockNumberCount >= 5) {
        const blockDiff = parseInt(params.block_number) - parseInt(mode);
        if (blockDiff > 2) {
          console.log(`🚨 Suspicious node detected: ${params.id || socket.id} reported block number ${params.block_number} which is ${blockDiff} blocks ahead of the mode (${mode})`);
          // sendTelegramAlert(`\n------------------------------------------\n🚨 Suspicious node detected: ${params.id || socket.id} reported block number ${params.block_number} which is ${blockDiff} blocks ahead of the mode (${mode}). Node marked as suspicious and excluded from routing.`);
          suspiciousNodes.add(socket.id);
          isSuspicious = true;
          suspiciousReason = 'block number deviation';
        } else {
          // Remove from suspicious list if block number is now reasonable (but only if not suspicious for MAC address)
          if (suspiciousNodes.has(socket.id) && !isMachineIdSuspicious(machineId)) {
            console.log(`✅ Node ${params.id || socket.id} block number ${params.block_number} is now within acceptable range. Removing from suspicious list.`);
            suspiciousNodes.delete(socket.id);
          }
        }
      } else if (!isSuspicious && params.block_number && validBlockNumberCount < 5) {
        console.log(`⏳ Skipping block number deviation check for ${params.id || socket.id} - only ${validBlockNumberCount} valid nodes, need at least 5`);
      }
      
      // Update pool map with client info, but mark suspicious nodes
      const clientData = { 
        ...existingClient, 
        ...params,
        machine_id: machineId, // Set the machine_id field
        lastSeen: Date.now(), // Add timestamp for stale connection cleanup
        suspicious: isSuspicious // Mark if node is suspicious
      };
      
      // If the node is suspicious, don't update their block number in the pool
      // This prevents them from influencing routing decisions
      if (isSuspicious) {
        clientData.block_number = 'SUSPICIOUS';
        console.log(`⚠️ Not updating block number for suspicious node ${params.id || socket.id}`);
      }
      
      poolMap.set(socket.id, clientData);
      console.log(`🛜 Updated node ${socket.id}, id: ${params.id}, block_number: ${isSuspicious ? 'SUSPICIOUS' : params.block_number}, suspicious: ${isSuspicious}${suspiciousReason ? ` (reason: ${suspiciousReason})` : ''}`);
      
      // Update cache immediately when a non-suspicious node checks in with new block number.
      if (params.block_number && !isSuspicious) {
        updateCache(wssCache, poolMap, io).catch(error => {
          console.error('Error updating cache after checkin:', error.message);
        });
      }
      
      // Only call updateLocationTable for new nodes
      if (params.enode && !seenNodes.has(params.enode)) {
        seenNodes.add(params.enode);
        // Run updateLocationTable in the background without blocking
        updateLocationTable(params.enode).catch(err => {
          console.error('Error in background updateLocationTable:', err);
        });

        // If this is the first checkin for a node, update the continents data
        constructNodeContinentsObject(poolMap).catch(err => {
          console.error('Error updating node continents:', err);
        });
      }
    } catch (error) {
      console.error('Error processing checkin message:', error, message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket.IO client ${socket.id} disconnected`);
    const client = poolMap.get(socket.id);
    if (client && client.machine_id) {
      console.log(`Removing socket ${socket.id} for machine_id: ${client.machine_id}`);
    }
    poolMap.delete(socket.id);
    suspiciousNodes.delete(socket.id);
    nodeLoad.releaseSocket(socket.id);
  });
});

// Track last processed times to ensure we don't miss or duplicate events
let lastProcessedHour = -1;
let lastProcessedDay = -1;

// New interval function that uses the system clock for scheduling
// don't delete this
// setInterval(async () => {
//   const now = new Date();
//   const hours = now.getHours();
//   const minutes = now.getMinutes();
//   const seconds = now.getSeconds();
//   const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));

//   // At the top of every hour (minutes === 0 and within first 3 seconds for safety)
//   if (minutes === 0 && seconds <= 2 && lastProcessedHour !== hours) {
//     lastProcessedHour = hours;
//     await processNodesForBread(poolMap);
//     console.log(`🍞 Bread processing at top of hour: ${now.toISOString()}`);

//     // At the start of each day (hours === 0)
//     if (hours === 0 && lastProcessedDay !== dayOfYear) {
//       lastProcessedDay = dayOfYear;
//       console.log('🍞 Start of day, calling mintBread()');
//       try {
//         await mintBread();
//       } catch (error) {
//         console.error('Error in mintBread:', error);
//       }
//     }
//   }
// }, 1000);