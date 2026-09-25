// Phase 1a tests: large responses through bg-rpc-proxy (48544) -> pool -> node.
// Usage: node test1a.js
const https = require('https');
const fs = require('fs');

const HOST = 'stage.rpc.buidlguidl.com';
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function req(port, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const t0 = Date.now();
    const r = https.request({ hostname: HOST, port, path, method: body ? 'POST' : 'GET',
      // Explicit Content-Length: bg-rpc-proxy forwards caller headers to the pool, and a
      // chunked body plus axios's Content-Length makes the pool reset the connection.
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), ms: Date.now() - t0 }));
    });
    r.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    r.on('timeout', () => r.destroy(new Error('client timeout 60s')));
    if (data) r.write(data);
    r.end();
  });
}

const rpc = (method, params) => req(48544, '/', { jsonrpc: '2.0', id: 1, method, params });
const fallbackLines = () => { try { return fs.readFileSync(FALLBACK_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
async function sockets() {
  const r = await req(3003, '/poolNodes');
  try { return JSON.parse(r.text).map((n) => `${n.execution_client}:${n.socket_id.id}`).join(','); } catch { return `?(${r.error || r.status})`; }
}

async function run(name, method, params) {
  const fbBefore = fallbackLines().length;
  const sBefore = await sockets();
  const r = await rpc(method, params);
  await new Promise((res) => setTimeout(res, 3000)); // let a disconnect/reconnect show up
  const sAfter = await sockets();
  const newFb = fallbackLines().slice(fbBefore);
  let outcome;
  if (r.error) outcome = `transport error: ${r.error}`;
  else {
    try {
      const j = JSON.parse(r.text);
      outcome = j.error ? `rpc error ${j.error.code}: ${j.error.message}` : `ok, ${Array.isArray(j.result) ? j.result.length + ' items' : typeof j.result}`;
    } catch { outcome = `non-JSON (HTTP ${r.status}): ${r.text.slice(0, 80)}`; }
  }
  const bytes = r.text ? Buffer.byteLength(r.text) : 0;
  console.log(`\n[${name}] ${outcome}`);
  console.log(`  ${r.ms} ms, ${(bytes / 1e6).toFixed(2)} MB`);
  console.log(`  fallback lines added: ${newFb.length}${newFb.length ? '  <- served by Alchemy, not the pool' : ''}`);
  console.log(`  node socket: ${sBefore === sAfter ? 'unchanged' : `CHANGED ${sBefore} -> ${sAfter}`}`);
  return bytes;
}

(async () => {
  const head = parseInt(JSON.parse((await rpc('eth_blockNumber', [])).text).result, 16);
  console.log(`head ${head}, sockets ${await sockets()}`);

  await run('regression eth_blockNumber', 'eth_blockNumber', []);
  await run('regression eth_call (USDC totalSupply)', 'eth_call', [{ to: USDC, data: '0x18160ddd' }, 'latest']);

  // Find a block whose receipts exceed 1 MB via the proxy; stop at the first one tried if it's big.
  for (const n of [head - 10, head - 11, head - 12]) {
    const bytes = await run(`eth_getBlockReceipts ${n}`, 'eth_getBlockReceipts', ['0x' + n.toString(16)]);
    if (bytes > 1e6) break;
  }

  const from = head - 110;
  await run(`eth_getLogs USDC Transfer ${from}..${head - 10}`, 'eth_getLogs',
    [{ address: USDC, topics: [TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + (head - 10).toString(16) }]);
})();
