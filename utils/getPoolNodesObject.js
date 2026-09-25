const nodeLoad = require('./nodeLoad');

/**
 * Creates an array of node information objects from the pool map
 * @param {Map<string, Object>} poolMap - Map of client IDs to their node information
 * @returns {Array<Object>} Array of node information objects containing:
 *   - Node identification (id, version)
 *   - Client information (execution_client, consensus_client)
 *   - System metrics (cpu_usage, memory_usage, storage_usage)
 *   - Blockchain state (block_number, block_hash)
 *   - Network information (execution_peers, consensus_peers)
 *   - Version control info (git_branch, last_commit, commit_hash)
 *   - Network addresses (enode, peerid, enr)
 *   - Port configuration (consensus_tcp_port, consensus_udp_port)
 *   - getLogs readiness (receipt_floor; reth nodes only, null if not reported)
 *   - Current load (in_flight requests, weighted load)
 *   - Connection info (socket_id)
 *   - Ownership (owner)
 */
function getPoolNodesObject(poolMap) {
  const poolNodes = Array.from(poolMap.values()).map(client => {
    return {
      id: client.id || '',
      node_version: client.node_version || '',
      execution_client: client.execution_client || '',
      consensus_client: client.consensus_client || '',
      cpu_usage: client.cpu_usage || '',
      memory_usage: client.memory_usage || '',
      storage_usage: client.storage_usage || '',
      block_number: client.block_number || '',
      block_hash: client.block_hash || '',
      execution_peers: client.execution_peers || '',
      consensus_peers: client.consensus_peers || '',
      git_branch: client.git_branch || '',
      last_commit: client.last_commit || '',
      commit_hash: client.commit_hash || '',
      enode: client.enode || '',
      peerid: client.peerid || '',
      enr: client.enr || '',
      consensus_tcp_port: client.consensus_tcp_port || '',
      consensus_udp_port: client.consensus_udp_port || '',
      // Lowest block with receipts (reth only). null = not reported; 0 is a valid floor, so no `||`
      receipt_floor: client.receipt_floor ?? null,
      // Requests in flight on this node now, and their weighted load (getLogs plan 3b-2)
      in_flight: client.id ? nodeLoad.count(client.id) : 0,
      load: client.id ? nodeLoad.load(client.id) : 0,
      socket_id: {
        id: client.wsID || ''
      },
      owner: client.owner || ''
    };
  });

  return poolNodes;
}

module.exports = { getPoolNodesObject };
