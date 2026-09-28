// Request audit: every JSON-RPC method type Alchemy (and similar providers) serve on Ethereum
// mainnet, in each "flavor" (block tags, recent, mid and far history, archive-only, lookups by
// hash, protocol edge cases), sent through the stage edge like a real caller would.
// Findings: bg-rpc-docs/REQUEST_AUDIT.md.
//
// Gentle on stage (2 pruned reth nodes + 1 archive node): one request at a time with a pause,
// and a budget in the edge's rate-limit units (anonymous IP: 1,000 per rolling hour; getLogs
// counts 100, blocks by number/hash 2, everything else 1). The run stops before the budget.
//
// Run: node test/stage/requestAudit.js [out.json]
//   EDGE_URL (default https://stage.mainnet.rpc.buidlguidl.com), AUDIT_BUDGET (default 800),
//   AUDIT_PAUSE_MS (default 300), AUDIT_GROUPS (comma list, e.g. "state,send"; default all)
const fs = require('fs');

const EDGE = process.env.EDGE_URL || 'https://stage.mainnet.rpc.buidlguidl.com';
const BUDGET = Number(process.env.AUDIT_BUDGET || 800);
const PAUSE = Number(process.env.AUDIT_PAUSE_MS || 300);
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const OUT = process.argv[2];
const GROUPS = process.env.AUDIT_GROUPS ? process.env.AUDIT_GROUPS.split(',') : null;

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ENS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const EOA = '0x28C6c06298d514Db089934071355E5743bf21d60'; // busy exchange account
const TOTAL_SUPPLY = '0x18160ddd';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const UNKNOWN_HASH = '0x' + '12'.repeat(32);
const hex = (n) => '0x' + n.toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEIGHTS = { eth_getLogs: 100, eth_getBlockByNumber: 2, eth_getBlockByHash: 2 };
const weightOf = (body) => (Array.isArray(body) ? body : [body])
  .reduce((s, r) => s + (r && WEIGHTS[r.method] ? WEIGHTS[r.method] : 1), 0);
let spent = 0;

async function send(body, { raw = false, contentType = 'application/json', method = 'POST' } = {}) {
  const w = raw ? 1 : weightOf(body);
  if (spent + w > BUDGET) throw new Error(`budget: ${spent} + ${w} > ${BUDGET}`);
  spent += w;
  await sleep(PAUSE);
  const t = Date.now();
  try {
    const res = await fetch(EDGE, {
      method,
      headers: { 'content-type': contentType, 'user-agent': 'bg-request-audit' },
      body: method === 'POST' ? (raw ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { http: res.status, ms: Date.now() - t, json, text: json ? null : text.slice(0, 120), retryAfter: res.headers.get('retry-after') };
  } catch (e) {
    return { http: 0, ms: Date.now() - t, json: null, text: e.message };
  }
}
const rpc = (method, params) => send({ jsonrpc: '2.0', id: 1, method, params });

// ---- expectations -------------------------------------------------------------------------
// Each check gets the response and returns [verdict, note]; verdicts:
//   ok        served correctly
//   expected  refused on purpose (policy or reth limit we accept), with a clear error
//   gap       Alchemy serves it and we don't (clear error, but a missing feature)
//   PROBLEM   wrong answer, unclear error, slow or broken
const SLOW_MS = 5000;
const err = (r) => r.json && r.json.error;
const res = (r) => r.json && r.json.result;
const errText = (r) => (err(r) ? `${err(r).code} ${String(err(r).message).slice(0, 90)}` : r.http === 200 ? '' : `HTTP ${r.http} ${r.text || ''}`);

const is = {
  result: (pred, what) => (r) => {
    if (err(r) || r.http !== 200) return ['PROBLEM', errText(r)];
    const v = res(r);
    if (v === null || v === undefined) return ['PROBLEM', 'null result'];
    const p = pred ? pred(v) : true;
    return p === true ? ['ok', what ? what(v) : summarize(v)] : ['PROBLEM', `unexpected result: ${p || summarize(v)}`];
  },
  nullResult: (r) => (r.http === 200 && !err(r) && res(r) === null ? ['ok', 'null (correct)'] : ['PROBLEM', err(r) ? errText(r) : summarize(res(r))]),
  error: (verdict, pattern) => (r) => {
    if (!err(r)) return ['PROBLEM', `expected an error, got ${summarize(res(r))}`];
    const text = errText(r);
    if (err(r).code === -70000) return ['PROBLEM', `sent to the fallback provider: ${text}`];
    if (pattern && !pattern.test(text)) return ['PROBLEM', `unexpected error: ${text}`];
    return [verdict, text];
  },
  // A method only some providers support: fine either way, report which
  either: (r) => (err(r) ? ['gap', errText(r)] : r.http === 200 ? ['ok', summarize(res(r))] : ['PROBLEM', errText(r)]),
};

function summarize(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') {
    if ('transactions' in v) return `block #${parseInt(v.number, 16)}, ${v.transactions.length} txs`;
    if ('logs' in v && 'status' in v) return `receipt, block #${parseInt(v.blockNumber, 16)}`;
    if ('input' in v && 'hash' in v) return `tx, block #${v.blockNumber === null ? 'pending' : parseInt(v.blockNumber, 16)}`;
    if ('accountProof' in v) return `proof, ${v.storageProof.length} storage`;
    if ('accessList' in v) return `access list, ${v.accessList.length} entries`;
    if ('baseFeePerGas' in v && 'oldestBlock' in v) return `fee history from #${parseInt(v.oldestBlock, 16)}${v.reward ? ', rewards' : ''}`;
    return `object {${Object.keys(v).slice(0, 4).join(',')}}`;
  }
  const s = String(v);
  return s.length > 42 ? s.slice(0, 40) + '…' : s;
}

// ---- run ------------------------------------------------------------------------------------
const results = [];
async function test(group, name, flavor, body, check, opts) {
  if (GROUPS && !GROUPS.includes(group)) return null;
  const r = await send(body, opts);
  const [verdict, note] = r.http === 429 ? ['PROBLEM', `rate limited (Retry-After ${r.retryAfter})`] : check(r);
  const slow = r.ms > SLOW_MS ? ` (slow: ${r.ms} ms)` : '';
  results.push({ group, name, flavor, verdict: slow && verdict === 'ok' ? 'PROBLEM' : verdict, note: note + slow, ms: r.ms, http: r.http });
  console.log(`${(slow && verdict === 'ok' ? 'PROBLEM' : verdict).padEnd(8)} ${group.padEnd(10)} ${name.padEnd(42)} ${flavor.padEnd(26)} ${String(r.ms).padStart(5)} ms  ${note}${slow}`);
  if (r.http === 429) throw new Error('rate limited: stopping');
  return r;
}
const call = (group, method, flavor, params, check) => test(group, method, flavor, { jsonrpc: '2.0', id: 1, method, params }, check);

(async () => {
  const fallbackStart = (() => { try { return fs.statSync(FALLBACK_LOG).size; } catch { return 0; } })();
  console.log(`edge ${EDGE}, budget ${BUDGET} units, pause ${PAUSE} ms\n`);

  // Fixtures: blocks at each depth, with their hashes and first transactions
  const head = parseInt(res(await rpc('eth_blockNumber', [])), 16);
  const depths = {
    'recent (head-5)': head - 5,
    'state window (head-5k)': head - 5000,
    'old state (head-50k)': head - 50000,
    'old receipts (20M)': 20000000,
    'pre-merge (10M)': 10000000,
    'first tx (46,147)': 46147,
  };
  const blocks = {};
  for (const [label, n] of Object.entries(depths)) {
    const b = res(await rpc('eth_getBlockByNumber', [hex(n), false]));
    if (!b) throw new Error(`fixture: block ${n} not served`);
    blocks[label] = { n, hash: b.hash, tx: b.transactions[0], txCount: b.transactions.length };
  }
  // A pre-merge block with an uncle
  let uncleBlock = null;
  for (let n = 10000000; n < 10000012 && !uncleBlock; n++) {
    const c = parseInt(res(await rpc('eth_getUncleCountByBlockNumber', [hex(n)])), 16);
    if (c > 0) uncleBlock = n;
  }
  const oldRaw = res(await rpc('eth_getRawTransactionByHash', [blocks['old receipts (20M)'].tx]));
  console.log(`head ${head}; fixtures: ${Object.entries(blocks).map(([k, b]) => `${k}=${b.n} (${b.txCount} txs)`).join(', ')}; uncle block ${uncleBlock}\n`);

  const tagFlavors = [['latest', 'latest'], ['pending', 'pending'], ['safe', 'safe'], ['finalized', 'finalized'], ['earliest', 'earliest']];
  const depthFlavors = Object.entries(blocks);

  // ---------------------------------------------------------------- chain / node info
  const G1 = 'info';
  await call(G1, 'eth_chainId', '', [], is.result((v) => v === '0x1' || v));
  await call(G1, 'net_version', '', [], is.result((v) => v === '1' || v));
  await call(G1, 'eth_blockNumber', '', [], is.result((v) => Math.abs(parseInt(v, 16) - head) < 20 || `far from head ${head}`));
  await call(G1, 'eth_syncing', '', [], (r) => (res(r) === false ? ['ok', 'false'] : is.result()(r)));
  await call(G1, 'net_listening', '', [], is.result());
  await call(G1, 'net_peerCount', '', [], is.result());
  // web3_* are standard; reth serves them only with `web3` in --http.api
  await call(G1, 'web3_clientVersion', '', [], (r) => (err(r) ? ['gap', errText(r)] : is.result()(r)));
  await call(G1, 'web3_sha3', '', ['0x68656c6c6f'], (r) => (err(r) ? ['gap', errText(r)] : is.result((v) => v === '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8' || 'wrong hash')(r)));
  await call(G1, 'eth_protocolVersion', '', [], is.either);
  await call(G1, 'eth_accounts', '', [], (r) => (Array.isArray(res(r)) && res(r).length === 0 ? ['ok', '[] (no accounts)'] : is.either(r)));
  await call(G1, 'eth_coinbase', '', [], is.either);
  await call(G1, 'eth_mining', '', [], is.either);
  await call(G1, 'eth_hashrate', '', [], is.either);
  await call(G1, 'eth_config', '', [], is.either);

  // ---------------------------------------------------------------- gas and fees
  const G2 = 'fees';
  await call(G2, 'eth_gasPrice', '', [], is.result());
  await call(G2, 'eth_maxPriorityFeePerGas', '', [], is.result());
  await call(G2, 'eth_blobBaseFee', '', [], is.result());
  await call(G2, 'eth_feeHistory', 'latest, 5 blocks, rewards', [5, 'latest', [25, 75]], is.result((v) => (v.reward ? true : 'no rewards')));
  await call(G2, 'eth_feeHistory', 'latest, 1024 blocks', [1024, 'latest', []], is.result());
  await call(G2, 'eth_feeHistory', 'old (20M), rewards', [4, hex(20000000), [50]], is.result((v) => (v.reward ? true : 'no rewards')));
  await call(G2, 'eth_feeHistory', 'pre-merge (10M), no rewards', [4, hex(10000000), []], is.result());

  // ---------------------------------------------------------------- blocks and headers
  const G3 = 'blocks';
  for (const [flavor, tag] of tagFlavors) {
    await call(G3, 'eth_getBlockByNumber', `tag ${flavor}`, [tag, false], is.result());
  }
  for (const [flavor, b] of depthFlavors) {
    await call(G3, 'eth_getBlockByNumber', flavor, [hex(b.n), false], is.result((v) => parseInt(v.number, 16) === b.n || 'wrong block'));
  }
  await call(G3, 'eth_getBlockByNumber', 'full txs, old receipts (20M)', [hex(20000000), true],
    is.result((v) => (typeof v.transactions[0] === 'object' ? true : 'hashes, not objects')));
  await call(G3, 'eth_getBlockByNumber', 'genesis (0)', ['0x0', false], is.result((v) => parseInt(v.number, 16) === 0 || 'wrong block'));
  await call(G3, 'eth_getBlockByNumber', 'future (head+1000)', [hex(head + 1000), false], is.nullResult);
  for (const [flavor, b] of depthFlavors.filter(([k]) => !k.startsWith('state'))) {
    await call(G3, 'eth_getBlockByHash', flavor, [b.hash, false], is.result((v) => v.hash === b.hash || 'wrong block'));
  }
  await call(G3, 'eth_getBlockByHash', 'unknown hash', [UNKNOWN_HASH, false], is.nullResult);
  for (const [flavor, b] of [depthFlavors[0], depthFlavors[3], depthFlavors[4]]) {
    await call(G3, 'eth_getBlockTransactionCountByNumber', flavor, [hex(b.n)], is.result((v) => parseInt(v, 16) === b.txCount || `count ${parseInt(v, 16)} != ${b.txCount}`));
    await call(G3, 'eth_getBlockTransactionCountByHash', flavor, [b.hash], is.result((v) => parseInt(v, 16) === b.txCount || 'wrong count'));
    await call(G3, 'eth_getHeaderByNumber', flavor, [hex(b.n)], is.either);
  }
  await call(G3, 'eth_getHeaderByHash', 'pre-merge (10M)', [blocks['pre-merge (10M)'].hash], is.either);
  if (uncleBlock) {
    await call(G3, 'eth_getUncleCountByBlockNumber', `pre-merge (${uncleBlock})`, [hex(uncleBlock)], is.result((v) => parseInt(v, 16) > 0 || 'no uncles'));
    await call(G3, 'eth_getUncleByBlockNumberAndIndex', `pre-merge (${uncleBlock})`, [hex(uncleBlock), '0x0'], is.result());
  }
  await call(G3, 'eth_getUncleCountByBlockHash', 'recent (post-merge: 0)', [blocks['recent (head-5)'].hash], is.result((v) => v === '0x0' || v));

  // ---------------------------------------------------------------- transactions and receipts
  const G4 = 'txs';
  for (const [flavor, b] of depthFlavors.filter(([k]) => !k.startsWith('state'))) {
    await call(G4, 'eth_getTransactionByHash', flavor, [b.tx], is.result((v) => v.hash === b.tx || 'wrong tx'));
    await call(G4, 'eth_getTransactionReceipt', flavor, [b.tx], is.result((v) => v.transactionHash === b.tx || 'wrong receipt'));
  }
  await call(G4, 'eth_getTransactionByHash', 'unknown hash', [UNKNOWN_HASH], is.nullResult);
  await call(G4, 'eth_getTransactionReceipt', 'unknown hash (pending poll)', [UNKNOWN_HASH], is.nullResult);
  for (const [flavor, b] of [depthFlavors[0], depthFlavors[3], depthFlavors[4]]) {
    await call(G4, 'eth_getTransactionByBlockNumberAndIndex', flavor, [hex(b.n), '0x0'], is.result((v) => v.hash === b.tx || 'wrong tx'));
    await call(G4, 'eth_getTransactionByBlockHashAndIndex', flavor, [b.hash, '0x0'], is.result((v) => v.hash === b.tx || 'wrong tx'));
    await call(G4, 'eth_getRawTransactionByHash', flavor, [b.tx], is.either);
  }
  await call(G4, 'eth_getRawTransactionByBlockNumberAndIndex', 'old receipts (20M)', [hex(20000000), '0x0'], is.either);
  await call(G4, 'eth_getTransactionBySenderAndNonce', 'old nonce', [EOA, '0x1'], is.either);
  for (const [flavor, tag] of [['latest', 'latest'], ['finalized', 'finalized']]) {
    await call(G4, 'eth_getBlockReceipts', `tag ${flavor}`, [tag], is.result((v) => Array.isArray(v) || 'not a list'));
  }
  for (const [flavor, b] of depthFlavors.filter(([k]) => !k.startsWith('state'))) {
    await call(G4, 'eth_getBlockReceipts', flavor, [hex(b.n)], is.result((v) => v.length === b.txCount || `${v.length} receipts != ${b.txCount} txs`));
  }
  await call(G4, 'eth_getBlockReceipts', 'by block hash (20M)', [blocks['old receipts (20M)'].hash], is.result((v) => v.length === blocks['old receipts (20M)'].txCount || 'wrong count'));
  await call(G4, 'eth_getBlockReceipts', 'EIP-1898 {blockNumber} (20M)', [{ blockNumber: hex(20000000) }], is.result());
  await call(G4, 'eth_getBlockReceipts', 'future (head+1000)', [hex(head + 1000)], is.nullResult);

  // ---------------------------------------------------------------- state
  const G5 = 'state';
  const stateFlavors = [...tagFlavors.filter(([f]) => f !== 'earliest'), ...depthFlavors.filter(([k]) => !k.startsWith('first'))];
  const blockParam = (x) => (typeof x === 'string' ? x : hex(x.n));
  for (const [flavor, x] of stateFlavors) {
    await call(G5, 'eth_getBalance', flavor, [EOA, blockParam(x)], is.result());
    await call(G5, 'eth_call', flavor, [{ to: USDC, data: TOTAL_SUPPLY }, blockParam(x)], is.result((v) => v.length === 66 || `returned ${v}`));
  }
  await call(G5, 'eth_getBalance', 'first tx (46,147)', [EOA, hex(46147)], is.result());
  await call(G5, 'eth_getBalance', 'earliest', [EOA, 'earliest'], is.result());
  for (const [flavor, x] of [['latest', 'latest'], ...depthFlavors.slice(2, 5)]) {
    await call(G5, 'eth_getCode', flavor, [USDC, blockParam(x)], is.result((v) => v.length > 2 || 'empty code'));
    await call(G5, 'eth_getStorageAt', flavor, [USDC, '0x0', blockParam(x)], is.result());
    await call(G5, 'eth_getTransactionCount', flavor, [EOA, blockParam(x)], is.result());
  }
  await call(G5, 'eth_getTransactionCount', 'pending', [EOA, 'pending'], is.result());
  await call(G5, 'eth_call', 'EIP-1898 {blockHash} (20M)', [{ to: USDC, data: TOTAL_SUPPLY }, { blockHash: blocks['old receipts (20M)'].hash }], is.result());
  // EIP-1898: requireCanonical goes with blockHash (with blockNumber it is invalid params)
  await call(G5, 'eth_call', 'EIP-1898 {blockHash, requireCanonical}', [{ to: USDC, data: TOTAL_SUPPLY }, { blockHash: blocks['old receipts (20M)'].hash, requireCanonical: true }], is.result());
  await call(G5, 'eth_call', 'state override (code)', [{ to: '0x' + '42'.repeat(20), data: '0x' }, 'latest', { ['0x' + '42'.repeat(20)]: { code: '0x600160005260206000f3' } }],
    is.result((v) => /01$/.test(v) || `returned ${v}`));
  await call(G5, 'eth_call', 'revert (error passthrough)', [{ to: USDC, data: '0xa9059cbb' }, 'latest'], (r) => (err(r) ? ['ok', `error: ${errText(r)}`] : ['PROBLEM', 'expected a revert']));
  await call(G5, 'eth_estimateGas', 'latest', [{ from: EOA, to: EOA, value: '0x0' }], is.result((v) => parseInt(v, 16) >= 21000 || v));
  // Caller mistakes: the node's own error should reach the caller, not the fallback provider
  await call(G5, 'eth_estimateGas', 'caller error: insufficient funds', [{ from: '0x' + '11'.repeat(20), to: USDC, value: '0xffffffffffffffffffff' }], is.error('expected'));
  await call(G5, 'eth_call', 'caller error: future block', [{ to: USDC, data: TOTAL_SUPPLY }, hex(head + 1000)], is.error('expected'));
  await call(G5, 'eth_getBalance', 'caller error: future block', [EOA, hex(head + 1000)], is.error('expected'));
  await call(G5, 'eth_estimateGas', 'old state (head-50k)', [{ from: EOA, to: EOA, value: '0x0' }, hex(head - 50000)], is.result());
  await call(G5, 'eth_createAccessList', 'latest', [{ from: EOA, to: USDC, data: TOTAL_SUPPLY }, 'latest'], is.result());
  await call(G5, 'eth_createAccessList', 'old receipts (20M)', [{ from: EOA, to: USDC, data: TOTAL_SUPPLY }, hex(20000000)], is.result());
  await call(G5, 'eth_simulateV1', 'latest', [{ blockStateCalls: [{ calls: [{ to: USDC, data: TOTAL_SUPPLY }] }] }, 'latest'], is.result());
  await call(G5, 'eth_simulateV1', 'old receipts (20M)', [{ blockStateCalls: [{ calls: [{ to: USDC, data: TOTAL_SUPPLY }] }] }, hex(20000000)], is.result());
  await call(G5, 'eth_getProof', 'latest', [USDC, ['0x0'], 'latest'], is.result());
  await call(G5, 'eth_getProof', 'head-100 (historical)', [USDC, ['0x0'], hex(head - 100)], is.error('expected', /proof window/));
  await call(G5, 'eth_getAccount', 'latest', [USDC, 'latest'], is.either);
  await call(G5, 'eth_getAccount', 'old (20M, historical)', [USDC, hex(20000000)], is.error('expected', /proof window/));
  await call(G5, 'eth_getAccountInfo', 'latest', [USDC, 'latest'], is.either);
  await call(G5, 'eth_callMany', 'latest', [[{ transactions: [{ to: USDC, data: TOTAL_SUPPLY }] }], { blockNumber: 'latest' }], is.either);

  // ---------------------------------------------------------------- logs (100 units each)
  const G6 = 'logs';
  await call(G6, 'eth_getLogs', 'recent 100 blocks, USDC Transfer', [{ address: USDC, topics: [TRANSFER_TOPIC], fromBlock: hex(head - 100), toBlock: 'latest' }], is.result((v) => Array.isArray(v) || 'not a list'));
  await call(G6, 'eth_getLogs', 'archive range (12.0M, 10k blocks), ENS', [{ address: ENS, fromBlock: hex(12000000), toBlock: hex(12009999) }], is.result((v) => Array.isArray(v) || 'not a list'));
  await call(G6, 'eth_getLogs', 'blockHash (20M), USDC', [{ address: USDC, blockHash: blocks['old receipts (20M)'].hash }], is.result((v) => Array.isArray(v) || 'not a list'));

  // ---------------------------------------------------------------- filters (disabled, D15)
  const G7 = 'filters';
  for (const [m, p] of [['eth_newFilter', [{ address: USDC }]], ['eth_newBlockFilter', []], ['eth_newPendingTransactionFilter', []],
    ['eth_getFilterChanges', ['0x1']], ['eth_getFilterLogs', ['0x1']], ['eth_uninstallFilter', ['0x1']]]) {
    await call(G7, m, '', p, is.error('expected', /-32601/));
  }

  // ---------------------------------------------------------------- sending transactions
  const G8 = 'send';
  await call(G8, 'eth_sendRawTransaction', 'malformed bytes', ['0xdeadbeef'], is.error('expected'));
  if (oldRaw) await call(G8, 'eth_sendRawTransaction', 'replay of a mined tx (20M)', [oldRaw], is.error('expected', /nonce|known|already/i));
  await call(G8, 'eth_sendTransaction', 'no unlocked accounts', [{ from: EOA, to: EOA }], is.error('expected'));
  await call(G8, 'eth_sign', 'no unlocked accounts', [EOA, '0x00'], is.error('expected'));
  await call(G8, 'eth_signTransaction', 'no unlocked accounts', [{ from: EOA, to: EOA }], is.error('expected'));
  await call(G8, 'eth_fillTransaction', '', [{ from: EOA, to: EOA, value: '0x0' }], is.either);
  await call(G8, 'eth_submitWork', 'no mining (PoS)', ['0x0000000000000001', '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)], is.either);

  // ---------------------------------------------------------------- other namespaces
  const G9 = 'namespaces';
  const txOld = blocks['old receipts (20M)'].tx;
  for (const [m, p] of [
    ['debug_traceTransaction', [txOld]], ['debug_traceCall', [{ to: USDC, data: TOTAL_SUPPLY }, 'latest']],
    ['debug_traceBlockByNumber', ['latest']], ['debug_getRawBlock', ['latest']], ['debug_getRawReceipts', ['latest']],
    ['admin_nodeInfo', []], ['admin_peers', []], ['personal_listAccounts', []], ['miner_start', []], ['engine_exchangeCapabilities', [[]]],
  ]) {
    await call(G9, m, 'blocked at the edge', p, is.error('expected', /-32601/));
  }
  for (const [m, p] of [
    ['trace_transaction', [txOld]], ['trace_block', ['latest']], ['trace_call', [{ to: USDC, data: TOTAL_SUPPLY }, ['trace'], 'latest']],
    ['trace_filter', [{ fromBlock: hex(head - 10), toBlock: 'latest', toAddress: [USDC] }]], ['trace_replayTransaction', [txOld, ['trace']]],
    ['txpool_status', []], ['txpool_content', []], ['txpool_inspect', []],
    ['erigon_getHeaderByNumber', [hex(head - 5)]], ['erigon_forks', []],
    ['eth_callBundle', [{ txs: [], blockNumber: hex(head), stateBlockNumber: 'latest' }]],
    ['alchemy_getTokenBalances', [EOA, 'erc20']], ['alchemy_getAssetTransfers', [{ fromBlock: hex(head - 10), category: ['erc20'] }]],
    ['alchemy_getTokenMetadata', [USDC]], ['alchemy_getTransactionReceipts', [{ blockNumber: hex(head - 5) }]],
    ['eth_subscribe', ['newHeads']], ['eth_unsubscribe', ['0x1']],
  ]) {
    await call(G9, m, 'provider extra', p, is.either);
  }
  await call(G9, 'not_a_method', 'unknown method', [], is.error('expected', /-32601/));

  // ---------------------------------------------------------------- protocol flavors
  const G10 = 'protocol';
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
    { jsonrpc: '2.0', id: 'two', method: 'eth_getBalance', params: [EOA, 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBlockReceipts', params: [hex(20000000)] },
    { jsonrpc: '2.0', id: 4, method: 'eth_newFilter', params: [{}] },
    { jsonrpc: '2.0', id: 5, method: 'eth_call', params: [{ to: USDC, data: TOTAL_SUPPLY }, hex(head - 50000)] },
  ];
  await test(G10, 'batch', '5 mixed (incl. old history, a disabled method)', batch, (r) => {
    const a = r.json;
    if (!Array.isArray(a) || a.length !== 5) return ['PROBLEM', `expected 5 answers, got ${JSON.stringify(a).slice(0, 80)}`];
    const byId = Object.fromEntries(a.map((x) => [x.id, x]));
    const ok = byId[1]?.result && byId.two?.result && Array.isArray(byId[3]?.result) && byId[4]?.error?.code === -32601 && byId[5]?.result;
    return ok ? ['ok', '5 answers matched by id (string id kept, filter -32601)'] : ['PROBLEM', JSON.stringify(a).slice(0, 160)];
  });
  await test(G10, 'batch', 'empty []', [], (r) => (err(r) || r.http >= 400 ? ['ok', errText(r) || `HTTP ${r.http}`] : ['PROBLEM', JSON.stringify(r.json).slice(0, 80)]));
  await test(G10, 'batch', 'one invalid item', [{ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, { id: 2 }],
    (r) => ['expected', r.json ? JSON.stringify(r.json).slice(0, 110) : `HTTP ${r.http}`]);
  await test(G10, 'id', 'string id', { jsonrpc: '2.0', id: 'abc', method: 'eth_chainId', params: [] }, (r) => (r.json?.id === 'abc' && res(r) ? ['ok', 'id echoed'] : ['PROBLEM', JSON.stringify(r.json)]));
  await test(G10, 'id', 'null id', { jsonrpc: '2.0', id: null, method: 'eth_chainId', params: [] }, (r) => (res(r) ? ['ok', `id ${JSON.stringify(r.json.id)}`] : ['expected', errText(r)]));
  await test(G10, 'id', 'large numeric id', { jsonrpc: '2.0', id: 9007199254740991, method: 'eth_chainId', params: [] }, (r) => (r.json?.id === 9007199254740991 ? ['ok', 'id echoed'] : ['PROBLEM', JSON.stringify(r.json)]));
  await test(G10, 'notification', 'no id', { jsonrpc: '2.0', method: 'eth_chainId', params: [] }, (r) => ['expected', errText(r) || JSON.stringify(r.json)]);
  await test(G10, 'params', 'omitted', { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }, is.result());
  await test(G10, 'params', 'by name (object)', { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: { address: EOA, block: 'latest' } }, (r) => (res(r) ? ['ok', summarize(res(r))] : ['expected', errText(r)]));
  await test(G10, 'params', 'wrong type', { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['nope', 'latest'] }, is.error('expected'));
  await test(G10, 'jsonrpc', 'version "1.0"', { jsonrpc: '1.0', id: 1, method: 'eth_chainId', params: [] }, (r) => ['expected', errText(r)]);
  // JSON-RPC says -32700 Parse error, as JSON; an HTML error page breaks clients' error handling
  await test(G10, 'body', 'invalid JSON', '{"jsonrpc":"2.0",', (r) => (err(r)?.code === -32700 ? ['ok', errText(r)] : ['PROBLEM', `HTTP ${r.http}, not a JSON-RPC -32700: ${(r.text || '').slice(0, 40)}`]), { raw: true });
  await test(G10, 'body', 'Content-Type text/plain', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    (r) => (res(r) ? ['ok', 'served'] : ['gap', errText(r) || `HTTP ${r.http} ${r.text || ''}`]), { raw: true, contentType: 'text/plain' });
  await test(G10, 'size', 'large response (full block, 20M)', { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [hex(20000000), true] }, is.result());

  // ---------------------------------------------------------------- summary
  await sleep(2000);
  let fallback = [];
  try { fallback = fs.readFileSync(FALLBACK_LOG).subarray(fallbackStart).toString().split('\n').filter(Boolean); } catch { /* not on this box */ }
  const counts = results.reduce((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] || 0) + 1 }), {});
  console.log(`\n${results.length} requests, ${spent} rate-limit units; ${JSON.stringify(counts)}; fallback lines during the run: ${fallback.length}`);
  fallback.forEach((l) => console.log(`  fallback: ${l.split('|').slice(0, 6).join('|').slice(0, 160)}`));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ edge: EDGE, head, date: new Date().toISOString(), spent, counts, fallback, results }, null, 2));
  process.exit(counts.PROBLEM ? 1 : 0);
})().catch((e) => {
  console.error(`\nstopped: ${e.message} (spent ${spent} units, ${results.length} results)`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ edge: EDGE, stopped: e.message, spent, results }, null, 2));
  process.exit(2);
});
