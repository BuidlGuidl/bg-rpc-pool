// Deferred test M14 (getLogs plan, Phase 3b-3): a loaded node gets clearly fewer light requests.
// Keeps bgnode7 busy with old-range getLogs that only it covers (floor 25.3M; the others are 25.8M),
// sends light eth_calls at the same time, and counts which node served each eth_call.
// Usage: node test/stage/testM14.js            (baseline without load, then with load)
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const HOST = 'stage.rpc.buidlguidl.com';
const NODES_LOG = '/home/ubuntu/shared/poolNodes.log';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ENS = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const LOADED = 'bgnode7';
const hex = (n) => '0x' + n.toString(16);
const size = (f) => fs.statSync(f).size;
const since = (f, o) => fs.readFileSync(f).subarray(o).toString();

function rpc(method, params) {
  return new Promise((resolve) => {
    const d = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = https.request({ hostname: HOST, port: 48544, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve({}); } });
    });
    r.on('error', () => resolve({}));
    r.end(d);
  });
}
const call = () => rpc('eth_call', [{ to: USDC, data: '0x70a08231' + crypto.randomBytes(20).toString('hex').padStart(64, '0') }, 'latest']);

async function lightRun(n) {
  const o = size(NODES_LOG);
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i++ < n) await call(); }));
  await new Promise((r) => setTimeout(r, 1000));
  const served = {};
  for (const line of since(NODES_LOG, o).split('\n')) {
    const f = line.split('|');
    if (f[4] === 'eth_call') { const node = f[2].split('-')[0]; served[node] = (served[node] || 0) + 1; }
  }
  return served;
}
const share = (m) => { const t = Object.values(m).reduce((a, b) => a + b, 0); return Object.entries(m).map(([k, v]) => `${k} ${v} (${Math.round((100 * v) / t)}%)`).join(', '); };

(async () => {
  console.log('baseline, no load:   ', share(await lightRun(200)));

  // Keep 4 old-range 10k-block getLogs in flight on bgnode7 (cost 11 each) until the light run ends
  let loading = true;
  const heavyLoop = async () => { while (loading) await rpc('eth_getLogs', [{ address: ENS, fromBlock: hex(25500000), toBlock: hex(25509999) }]); };
  const loops = Array.from({ length: 4 }, heavyLoop);
  await new Promise((r) => setTimeout(r, 500));
  const loaded = await lightRun(200);
  loading = false;
  await Promise.all(loops);
  const s = share(loaded);
  console.log(`${LOADED} under load:  `, s);
  const total = Object.values(loaded).reduce((a, b) => a + b, 0);
  const pct = (100 * (loaded[LOADED] || 0)) / total;
  console.log(`${pct < 15 ? 'PASS' : 'FAIL'}  M14: the loaded node got ${pct.toFixed(1)}% of light requests (even split would be ~33%)`);
})();
