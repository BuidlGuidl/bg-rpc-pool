const { getNodeTimingData, filterFastNodes, filterSlowNodes, spotCheckOnlyThreshold } = require('./nodeTimingUtils');

/**
 * Checks if a node has both a socket ID and a valid node ID
 * @param {Object} client - The client object from poolMap
 * @returns {boolean} True if the node has both IDs
 */
function hasValidNodeId(client) {
  return client && 
         client.wsID && 
         client.id && 
         client.id !== "N/A" && 
         client.id !== null && 
         client.id !== undefined;
}

/**
 * Selects up to 3 random clients from the pool that are at the highest block number
 * @param {Map<string, Object>} poolMap - Map of client IDs to their node information
 * @returns {Array<string>} Array of selected client socket IDs (can range in length from 0 to 3 depending on the number of clients at the highest block)
 * @description
 * The function:
 * 1. Filters clients that have properly checked in (have required properties)
 * 2. Filters clients with valid block numbers
 * 3. Identifies the highest block number among all clients
 * 4. Selects only clients at the highest block
 * 5. Randomly chooses up to 3 clients from those at the highest block
 */
function selectRandomClients(poolMap) {
  console.log('Starting selectRandomClients with pool size:', poolMap.size);
  
  // Get current timeout percentage data
  const nodeTimingLastWeek = getNodeTimingData();
  
  // Log the timeout data if available
  // if (nodeTimingLastWeek) {
  //   console.log('Node timeout percentage data:');
  //   Object.entries(nodeTimingLastWeek).forEach(([key, value]) => {
  //     console.log(`  ${key}: ${value}`);
  //   });
  // }

  // Get all clients and filter those that have properly checked in
  const clients = Array.from(poolMap.values());
  console.log('Total clients in pool:', clients.length);
  
  const checkedInClients = clients.filter(client => {
    const hasRequiredProps = client.id && 
                           client.owner && 
                           client.wsID && 
                           client.machine_id &&
                           client.machine_id !== "N/A" &&
                           client.machine_id !== null &&
                           client.machine_id !== undefined &&
                           !client.suspicious; // Exclude suspicious nodes
    if (!hasRequiredProps) {
      if (client.suspicious) {
        console.log(`Client ${client.wsID} skipped: marked as suspicious`);
      } else {
        console.log(`Client ${client.wsID} skipped: missing required properties`);
      }
    }
    return hasRequiredProps;
  });
  
  console.log('Clients properly checked in:', checkedInClients.length);
  
  // If no clients have checked in properly, return empty array
  if (checkedInClients.length === 0) {
    console.log('No properly checked-in clients found');
    return [];
  }
  
  const clientsWithBlocks = checkedInClients.filter(client => {
    const blockNum = client.block_number;
    const isValid = blockNum !== undefined && 
           blockNum !== null && 
           blockNum !== "N/A" && 
           !isNaN(parseInt(blockNum));
    console.log(`Client ${client.wsID} block number: ${blockNum}, valid: ${isValid}`);
    return isValid;
  });
  
  console.log('Clients with valid blocks:', clientsWithBlocks.length);
  
  // If no clients have valid block numbers, return empty array
  if (clientsWithBlocks.length === 0) {
    console.log('No clients with valid block numbers found');
    return [];
  }

  // Determine highest block from fast nodes only (if timeout data is available)
  let targetBlock;
  let fastClientsWithBlocks = clientsWithBlocks;
  
  if (nodeTimingLastWeek) {
    // Separate fast and slow nodes based on timeout percentage
    fastClientsWithBlocks = filterFastNodes(clientsWithBlocks);
    const slowClientsWithBlocks = filterSlowNodes(clientsWithBlocks);
    
    // Log node classification
    console.log(`Node classification - Fast: ${fastClientsWithBlocks.length}, Slow: ${slowClientsWithBlocks.length}`);
    fastClientsWithBlocks.forEach(client => {
      const timeout = nodeTimingLastWeek[client.id];
      console.log(`  Fast: ${client.id} (timeout: ${timeout !== undefined ? timeout.toFixed(3) : 'N/A'})`);
    });
    slowClientsWithBlocks.forEach(client => {
      const timeout = nodeTimingLastWeek[client.id];
      console.log(`  Slow: ${client.id} (timeout: ${timeout !== undefined ? timeout.toFixed(3) : 'N/A'})`);
    });
    
    // If we have fast nodes, use their highest block as target
    if (fastClientsWithBlocks.length > 0) {
      targetBlock = Math.max(...fastClientsWithBlocks.map(client => parseInt(client.block_number)));
      console.log('Highest block number from fast nodes:', targetBlock);
    } else {
      // No fast nodes available, fall back to all nodes
      console.log('No fast nodes available, using highest block from all nodes');
      targetBlock = Math.max(...clientsWithBlocks.map(client => parseInt(client.block_number)));
      console.log('Highest block number from all nodes:', targetBlock);
    }
  } else {
    // No timeout data available, use highest block from all nodes
    targetBlock = Math.max(...clientsWithBlocks.map(client => parseInt(client.block_number)));
    console.log('Highest block number (no timeout data):', targetBlock);
  }

  // Filter clients at the target block
  const highestBlockClients = clientsWithBlocks.filter(
    client => parseInt(client.block_number) === targetBlock
  );
  console.log('Clients at target block:', highestBlockClients.length);

  // Freshness data for the 3b-3 decision (exact highest block vs within 1 block)
  const within1 = clientsWithBlocks.filter(client => parseInt(client.block_number) >= targetBlock - 1).length;
  console.log(`🧭 light: target ${targetBlock}, candidates ${clientsWithBlocks.length}, ` +
    `at target ${highestBlockClients.length}, within 1 ${within1}, ` +
    `blocks [${clientsWithBlocks.map(client => targetBlock - parseInt(client.block_number)).sort((a, b) => a - b).join(',')}]`);

  // If no clients at target block, return empty array
  if (highestBlockClients.length === 0) {
    console.log('No clients at target block');
    return [];
  }

  // Create the selection pool
  let selectionPool = [...highestBlockClients];
  console.log('Initial selection pool size:', selectionPool.length);
  
  if (nodeTimingLastWeek) {
    // Check if all nodes are slow
    const fastNodes = filterFastNodes(highestBlockClients);
    const slowNodes = filterSlowNodes(highestBlockClients);

    if (fastNodes.length === 0) {
      console.log('All nodes are slow, returning empty array');
      return [];
    }

    console.log('Fast nodes count:', fastNodes.length);
    console.log('Slow nodes count:', slowNodes.length);

    // Create selection pool starting with fast nodes
    selectionPool = [...fastNodes];
    console.log('Selection pool after adding fast nodes:', selectionPool.length);

    // If we have more than 2 slow nodes, randomly select 2 to add to the pool
    if (slowNodes.length > 2) {
      const availableSlowNodes = [...slowNodes];
      for (let i = 0; i < 2; i++) {
        const randomIndex = Math.floor(Math.random() * availableSlowNodes.length);
        selectionPool.push(availableSlowNodes[randomIndex]);
        availableSlowNodes.splice(randomIndex, 1);
      }
    } else {
      // If 2 or fewer slow nodes, add them all
      selectionPool.push(...slowNodes);
    }
    console.log('Final selection pool size:', selectionPool.length);
  }

  // If we have no nodes in the selection pool, return empty array
  if (selectionPool.length === 0) {
    console.log('Selection pool is empty');
    return [];
  }

  // Select up to 3 random nodes from the pool
  const numToSelect = Math.min(3, selectionPool.length);
  console.log('Number of clients to select:', numToSelect);
  
  const selectedNodes = [];
  const availableNodes = [...selectionPool];
  
  // Randomly select nodes
  for (let i = 0; i < numToSelect; i++) {
    const randomIndex = Math.floor(Math.random() * availableNodes.length);
    selectedNodes.push(availableNodes[randomIndex]);
    availableNodes.splice(randomIndex, 1);
  }

  // Rearrange selected nodes to ensure a fast node is first
  if (nodeTimingLastWeek) {
    // Find first fast node
    const fastNodeIndex = selectedNodes.findIndex(node => filterFastNodes([node]).length > 0);

    if (fastNodeIndex !== -1) {
      // Move fast node to front
      const fastNode = selectedNodes[fastNodeIndex];
      selectedNodes.splice(fastNodeIndex, 1);
      selectedNodes.unshift(fastNode);
    }
  }

  return selectedNodes.map(node => node.wsID);
}

module.exports = { selectRandomClients }; 