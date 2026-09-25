// Phase 1c tests through bg-rpc-proxy (48544).
// Usage: node test1c.js [batch|all]   ("batch" = only the harmless batch-size checks)
const https = require('https');
const fs = require('fs');

const HOST = 'stage.rpc.buidlguidl.com';
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// chunked=true sends the body without Content-Length (Transfer-Encoding: chunked)
function post(body, { chunked = false, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', ...headers };
    if (!chunked) h['Content-Length'] = Buffer.byteLength(data);
    const t0 = Date.now();
    const r = https.request({ hostname: HOST, port: 48544, path: '/', method: 'POST', headers: h, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), ms: Date.now() - t0 }));
    });
    r.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    r.on('timeout', () => r.destroy(new Error('client timeout 60s')));
    if (chunked) { r.write(data.slice(0, 10)); r.write(data.slice(10)); } else r.write(data);
    r.end();
  });
}

const fallbackCount = () => { try { return fs.readFileSync(FALLBACK_LOG, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const call = (id, method, params = []) => ({ jsonrpc: '2.0', id, method, params });
let failures = 0;

async function check(name, body, opts, expect) {
  const fb0 = fallbackCount();
  const r = await post(body, opts);
  await new Promise((res) => setTimeout(res, 500));
  const fb = fallbackCount() - fb0;
  let j; try { j = JSON.parse(r.text); } catch { j = null; }
  const verdict = expect(j, fb, r);
  if (!verdict.pass) failures++;
  console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${name}  (${r.ms} ms, fallback lines +${fb})`);
  console.log(`      ${verdict.detail}`);
}

const errOf = (j) => (j && j.error ? `${j.error.code} ${j.error.message}${j.error.data ? ' / ' + j.error.data : ''}` : null);

(async () => {
  const onlyBatch = process.argv[2] === 'batch';

  const batch = (n) => Array.from({ length: n }, (_, i) => call(i + 1, 'eth_blockNumber'));
  await check('batch of 50 is served', batch(50), {}, (j) =>
    ({ pass: Array.isArray(j) && j.length === 50 && j.every((x) => x.result), detail: Array.isArray(j) ? `${j.length} responses` : errOf(j) }));
  await check('batch of 51 is rejected with -32600', batch(51), {}, (j) =>
    ({ pass: !!j && !Array.isArray(j) && j.error?.code === -32600, detail: Array.isArray(j) ? `accepted: ${j.length} responses` : errOf(j) }));
  if (onlyBatch) return;

  await check('chunked POST reaches the pool (header allowlist)', call(1, 'eth_call', [{ to: USDC, data: '0x18160ddd' }, 'latest']), { chunked: true }, (j, fb) =>
    ({ pass: !!j?.result && fb === 0, detail: j?.result ? `result ${j.result.slice(0, 20)}…` : errOf(j) }));
  await check('extra caller headers are harmless', call(1, 'eth_call', [{ to: USDC, data: '0x18160ddd' }, 'latest']),
    { headers: { 'X-Test-Header': '1', 'Accept-Encoding': 'identity', 'X-Api-Key': 'bg_test_not_real' } }, (j, fb) =>
    ({ pass: !!j?.result && fb === 0, detail: j?.result ? 'ok' : errOf(j) }));

  // Pool/node failure on a heavy method: must come back as an error with no fallback line
  await check('failing eth_getFilterChanges does not fall back', call(1, 'eth_getFilterChanges', ['0xdeadbeef']), {}, (j, fb) =>
    ({ pass: !!j?.error && fb === 0, detail: errOf(j) || 'unexpected result' }));
  await check('failing eth_getFilterLogs does not fall back', call(1, 'eth_getFilterLogs', ['0xdeadbeef']), {}, (j, fb) =>
    ({ pass: !!j?.error && fb === 0, detail: errOf(j) || 'unexpected result' }));

  // Regression: normal methods still work through the pool
  await check('eth_call still served by the pool', call(1, 'eth_call', [{ to: USDC, data: '0x18160ddd' }, 'latest']), {}, (j, fb) =>
    ({ pass: !!j?.result && fb === 0, detail: j?.result ? 'ok' : errOf(j) }));

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
})();
