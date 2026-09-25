// Phase 3 tests through bg-rpc-proxy (48544) -> pool -> reth. Stage floor is 25,300,000.
// Usage: node test3.js
const https = require('https');
const fs = require('fs');

const HOST = 'stage.rpc.buidlguidl.com';
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// Low-volume contract (ENS registry): a 10k-block range scans every block but stays far under the log cap
const QUIET = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const hex = (n) => '0x' + n.toString(16);

function request(port, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const t0 = Date.now();
    const r = https.request({ hostname: HOST, port, path, method: body ? 'POST' : 'GET', headers, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, ms: Date.now() - t0 });
      });
    });
    r.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    r.on('timeout', () => r.destroy(new Error('client timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const rpc = (method, params) => request(48544, '/', { jsonrpc: '2.0', id: 1, method, params });
const getLogs = (filter) => rpc('eth_getLogs', [filter]);
const fallbackCount = () => { try { return fs.readFileSync(FALLBACK_LOG, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const show = (r) => r.error ? `transport ${r.error}` : r.json?.error ? `ERROR ${r.json.error.code} ${r.json.error.message}` :
  Array.isArray(r.json?.result) ? `${r.json.result.length} logs` : `result ${JSON.stringify(r.json?.result)?.slice(0, 40)}`;

let failures = 0;
function report(pass, name, detail) {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

(async () => {
  const fb0 = fallbackCount();
  const head = parseInt((await rpc('eth_blockNumber', [])).json.result, 16);
  console.log(`head ${head}\n`);

  let r = await getLogs({ address: USDC, fromBlock: hex(head - 50), toBlock: hex(head - 10) });
  report(Array.isArray(r.json?.result) && r.json.result.length > 0, 'happy path: USDC, 40 recent blocks', `${show(r)} in ${r.ms} ms`);

  r = await getLogs({ address: USDC, fromBlock: hex(25000000), toBlock: hex(25000010) });
  report(r.json?.error?.code === -32602 && /older than block/.test(r.json.error.message), 'below floor (25,000,000) is an error, not []', show(r));

  for (const [name, filter, expectError] of [
    ['fromBlock latest', { address: USDC, fromBlock: 'latest' }, false],
    ['fromBlock safe', { address: USDC, fromBlock: 'safe', toBlock: 'safe' }, false],
    ['fromBlock finalized', { address: USDC, fromBlock: 'finalized', toBlock: 'finalized' }, false],
    ['fromBlock omitted', { address: USDC }, false],
    ['fromBlock earliest', { address: USDC, fromBlock: 'earliest', toBlock: hex(10) }, true],
    ['toBlock pending', { address: USDC, fromBlock: 'latest', toBlock: 'pending' }, true],
  ]) {
    r = await getLogs(filter);
    report(expectError ? r.json?.error?.code === -32602 : Array.isArray(r.json?.result), `tag: ${name}`, show(r));
  }

  const oldBlock = (await rpc('eth_getBlockByNumber', [hex(25000000), false])).json.result;
  r = await getLogs({ address: USDC, blockHash: oldBlock.hash });
  report(r.json?.error?.code === -32001, 'blockHash below floor -> -32001 (D11)', show(r));
  const recent = (await rpc('eth_getBlockByNumber', [hex(head - 20), false])).json.result;
  r = await getLogs({ address: USDC, blockHash: recent.hash });
  report(Array.isArray(r.json?.result), 'blockHash recent -> logs', show(r));

  // Capacity: 4 per ready node (maxPerNode) + 1 concurrent slow queries -> exactly one -32005
  const ready = (await request(3003, '/getlogsStatus')).json.readyNodes;
  const total = 4 * ready + 1;
  const slow = { address: QUIET, fromBlock: hex(head - 10009), toBlock: hex(head - 10) };
  r = await getLogs(slow);
  console.log(`\n(single 10k-block quiet query: ${show(r)} in ${r.ms} ms; ${ready} ready nodes -> ${total} concurrent)`);
  const results = await Promise.all(Array.from({ length: total }, (_, i) => new Promise((res) => setTimeout(res, i * 20)).then(() => getLogs(slow))));
  const busy = results.filter((x) => x.json?.error?.code === -32005);
  const ok = results.filter((x) => Array.isArray(x.json?.result));
  report(busy.length === 1 && ok.length === total - 1, `${total} concurrent -> ${total - 1} served, 1 gets -32005`,
    results.map((x) => `${show(x)} (${x.ms} ms)`).join(' | '));

  await new Promise((res) => setTimeout(res, 1000));
  for (const [port, label] of [[3003, 'pool'], [48544, 'bg-rpc-proxy']]) {
    r = await request(port, '/getlogsStatus');
    report(r.json?.readyNodes >= 1 && r.json?.receiptFloor === 25300000 && r.json?.receiptFloorAll >= 25300000 && r.json?.inFlight === 0,
      `/getlogsStatus on ${label} (${port})`, `HTTP ${r.status} ${r.text?.slice(0, 120)}`);
  }

  r = await rpc('eth_call', [{ to: USDC, data: '0x18160ddd' }, 'latest']);
  report(!!r.json?.result, 'regression: eth_call', show(r));
  r = await rpc('eth_getBlockByNumber', [hex(head - 5), false]);
  report(!!r.json?.result, 'regression: eth_getBlockByNumber', r.json?.result ? 'ok' : show(r));

  const fb = fallbackCount() - fb0;
  report(fb === 0, 'no fallback lines during the run', `+${fb}`);
  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
})();
