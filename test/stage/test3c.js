// Phase 3c: history-aware routing for light methods. Needs an archive reth node (receipt_floor 0)
// next to pruned ones (setup S8). Sends to the pool (3003 /requestPool) directly, because
// bg-rpc-proxy caches repeated requests and would hide which node answered (plan M23).
// Old receipts, blocks, transactions and state must come back real every time; recent requests
// still spread over all nodes; nothing falls back.
const https = require('https');
const fs = require('fs');

const HOST = 'stage.rpc.buidlguidl.com';
const NODES_LOG = '/home/ubuntu/shared/poolNodes.log';
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const EOA = '0x28C6c06298d514Db089934071355E5743bf21d60';
const N = 10;
const hex = (n) => '0x' + n.toString(16);

const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const since = (f, offset) => { try { return fs.readFileSync(f).subarray(offset).toString(); } catch { return ''; } };

function rpc(method, params) {
  return new Promise((resolve) => {
    const d = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = https.request({ hostname: HOST, port: 3003, path: '/requestPool', method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve({ error: { message: t.slice(0, 80) } }); } });
    });
    r.on('error', (e) => resolve({ error: { message: e.message } }));
    r.end(d);
  });
}

let failures = 0;
const report = (pass, name, detail) => { if (!pass) failures++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
const real = (r) => !r.error && r.result !== null && r.result !== undefined;

(async () => {
  const head = parseInt((await rpc('eth_blockNumber', [])).result, 16);
  const b10 = (await rpc('eth_getBlockByNumber', [hex(10000000), false])).result;
  const b20 = (await rpc('eth_getBlockByNumber', [hex(20000000), false])).result;
  if (!b10 || !b20) { console.log('FAIL  setup: blocks 10M / 20M not served (no archive node?)'); process.exit(1); }
  const call = { to: USDC, data: '0x18160ddd' };

  const old = [
    ['receipts by number (20M)', 'eth_getBlockReceipts', [hex(20000000)]],
    ['receipts by block hash (20M)', 'eth_getBlockReceipts', [b20.hash]],
    ['tx receipt (20M)', 'eth_getTransactionReceipt', [b20.transactions[0]]],
    ['tx receipt (10M, pre-merge)', 'eth_getTransactionReceipt', [b10.transactions[0]]],
    ['tx by hash (10M)', 'eth_getTransactionByHash', [b10.transactions[0]]],
    ['block by number (10M)', 'eth_getBlockByNumber', [hex(10000000), true]],
    ['block by hash (10M)', 'eth_getBlockByHash', [b10.hash, false]],
    ['eth_call at head - 50,000', 'eth_call', [call, hex(head - 50000)]],
    ['eth_call at an EIP-1898 block hash (20M)', 'eth_call', [call, { blockHash: b20.hash }]],
    ['eth_getBalance (15M)', 'eth_getBalance', [EOA, hex(15000000)]],
  ];
  const offset = size(NODES_LOG);
  const fallbackOffset = size(FALLBACK_LOG);
  for (const [name, method, params] of old) {
    const results = [];
    for (let i = 0; i < N; i++) results.push(await rpc(method, params));
    const ok = results.filter(real).length;
    report(ok === N, `old history: ${name}`, `${ok}/${N} real answers` +
      (ok < N ? `; e.g. ${JSON.stringify(results.find((r) => !real(r))).slice(0, 120)}` : ''));
  }

  const logs = await Promise.all([1, 2, 3].map(() => rpc('eth_getLogs', [{ address: USDC, blockHash: b20.hash }])));
  report(logs.every((r) => Array.isArray(r.result)), 'getLogs by old blockHash (D11 miss retried on a deeper node)',
    logs.map((r) => (Array.isArray(r.result) ? `${r.result.length} logs` : JSON.stringify(r.error))).join(' | '));

  // Recent history: every node still serves it
  const recentOffset = size(NODES_LOG);
  for (let i = 0; i < 30; i++) await rpc('eth_getBlockReceipts', [hex(head - 5 - i)]);
  await new Promise((r) => setTimeout(r, 1500));
  const recentNodes = {};
  for (const line of since(NODES_LOG, recentOffset).split('\n')) {
    const f = line.split('|');
    if (f[4] === 'eth_getBlockReceipts') recentNodes[f[2].split('-')[0]] = (recentNodes[f[2].split('-')[0]] || 0) + 1;
  }
  report(Object.keys(recentNodes).length >= 2, 'recent receipts spread over the nodes', JSON.stringify(recentNodes));

  // Pending-style polling: unknown hash stays null (costs a retry when a pruned node answers first)
  const unknown = await rpc('eth_getTransactionReceipt', ['0x' + '12'.repeat(32)]);
  report(unknown.result === null, 'unknown tx hash -> null', JSON.stringify(unknown).slice(0, 80));

  await new Promise((r) => setTimeout(r, 1500));
  const attempts = since(NODES_LOG, offset).split('\n').filter((l) => l && l.split('|')[4] !== 'eth_blockNumber').length;
  console.log(`      node attempts for the whole run: ${attempts} (pool log lines)`);
  const fallback = since(FALLBACK_LOG, fallbackOffset).split('\n').filter(Boolean).length;
  report(fallback === 0, 'no fallback', `fallback lines added: ${fallback}`);

  console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`);
  process.exit(failures ? 1 : 0);
})();
