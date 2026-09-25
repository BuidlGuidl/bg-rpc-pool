const axios = require('axios');
const { spotCheckOnlyThreshold } = require('../config');

const host = process.env.HOST;

// Module-level variable to store timeout percentage data
let nodeTimeoutData = null;
let lastFetchTime = null;

/**
 * Fetches node timeout percentage data from the API
 * @returns {Promise<void>}
 */
async function fetchNodeTimingData() {
  try {
    const response = await axios.get(`https://${host}:3001/nodeTimeoutPercentLastWeek`);
    // Convert array to object keyed by nodeId for faster lookup
    const dataArray = response.data;
    nodeTimeoutData = {};
    dataArray.forEach(node => {
      nodeTimeoutData[node.nodeId] = node.percentTimeout;
    });
    lastFetchTime = Date.now();
    // Log the timeout data
    console.log('Node timeout data fetched:');
    Object.entries(nodeTimeoutData).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  } catch (error) {
    console.error('Error fetching node timeout data:', error.message);
  }
}

/**
 * Gets the current node timeout data
 * @returns {Object|null} The timeout data object or null if not available
 */
function getNodeTimingData() {
  return nodeTimeoutData;
}

/**
 * Replaces the timeout data (tests only)
 * @param {Object|null} data - { nodeId: percentTimeout } or null
 */
function setNodeTimingData(data) {
  nodeTimeoutData = data;
}

/**
 * Determines if a node is considered "fast" based on timeout percentage
 * @param {Object} client - The client object with id property
 * @returns {boolean} True if the node is fast (percentTimeout undefined or <= threshold)
 */
function isFastNode(client) {
  if (!nodeTimeoutData || !client.id || client.id === "N/A") {
    return true; // Consider fast if no timeout data or no id
  }
  
  const percentTimeout = nodeTimeoutData[client.id];
  // Consider fast if percentTimeout is undefined or <= threshold
  return percentTimeout === undefined || percentTimeout <= spotCheckOnlyThreshold;
}

/**
 * Filters an array of clients to return only fast nodes
 * @param {Array} clients - Array of client objects
 * @returns {Array} Array of fast clients
 */
function filterFastNodes(clients) {
  return clients.filter(client => isFastNode(client));
}

/**
 * Filters an array of clients to return only slow nodes
 * @param {Array} clients - Array of client objects
 * @returns {Array} Array of slow clients
 */
function filterSlowNodes(clients) {
  return clients.filter(client => !isFastNode(client));
}

module.exports = {
  fetchNodeTimingData,
  getNodeTimingData,
  setNodeTimingData,
  isFastNode,
  filterFastNodes,
  filterSlowNodes,
  spotCheckOnlyThreshold
}; 