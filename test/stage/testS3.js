// Deferred tests M4 and M12 (part 1): need 3+ nodes at the same head.
// M4:  60+ getLogs never use the 3-node comparison (handleRequestSet) and log nothing to poolCompareResults.log
// M12: normal methods unchanged: 1-in-20 comparison still happens for eth_call; per-node distribution recorded
const https = require('https');
const fs = require('fs');

const HOST = 'stage.rpc.buidlguidl.com';
const POOL_OUT = '/home/ubuntu/.pm2/logs/pool-out.log';
const NODES_LOG = '/home/ubuntu/shared/poolNodes.log';
const COMPARE_LOG = '/home/ubuntu/shared/poolCompareResults.log';
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const hex = (n) => '0x' + n.toString(16);

const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const since = (f, offset) => { try { const b = fs.readFileSync(f); return b.subarray(offset).toString(); } catch { return ''; } };

function rpc(method, params, id = 1) {
  return new Promise((resolve) => {
    const d = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const r = https.request({ hostname: HOST, port: 48544, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve({ error: { message: t.slice(0, 80) } }); } });
    });
    r.on('error', (e) => resolve({ error: { message: e.message } }));
    r.end(d);
  });
}

// Run tasks with limited concurrency
async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}

let failures = 0;
const report = (pass, name, detail) => { if (!pass) failures++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
const byNode = (text, method) => {
  const m = {};
  for (const line of text.split('\n')) {
    const f = line.split('|');
    if (f[4] === method) { const id = f[2].split('-')[0]; m[id] = (m[id] || 0) + 1; }
  }
  return m;
};

(async () => {
  const head = parseInt((await rpc('eth_blockNumber', [])).result, 16);
  const fb0 = size(FALLBACK_LOG);

  // ---- M4: 80 getLogs, distinct small recent ranges (not cacheable anyway), 4 at a time
  let o = { out: size(POOL_OUT), nodes: size(NODES_LOG), cmp: size(COMPARE_LOG) };
  const logsTasks = Array.from({ length: 80 }, (_, i) => () =>
    rpc('eth_getLogs', [{ address: USDC, fromBlock: hex(head - 30 - i), toBlock: hex(head - 25 - i) }], i));
  const logsRes = await pool(logsTasks, 4);
  await new Promise((r) => setTimeout(r, 1500));
  let out = since(POOL_OUT, o.out);
  const setLines = (out.match(/Randomly selected handleRequestSet/g) || []).length;
  const heavyLines = (out.match(/🏋️ eth_getLogs/g) || []).length;
  const cmpGetLogs = (since(COMPARE_LOG, o.cmp).match(/eth_getLogs/g) || []).length;
  const ok = logsRes.filter((r) => Array.isArray(r.result)).length;
  const dist4 = byNode(since(NODES_LOG, o.nodes), 'eth_getLogs');
  report(ok === 80 && setLines === 0 && cmpGetLogs === 0 && heavyLines === 80,
    'M4: 80 getLogs never use the 3-node comparison',
    `${ok}/80 served; heavy-path decision lines ${heavyLines}; handleRequestSet lines ${setLines}; getLogs in poolCompareResults.log ${cmpGetLogs}; served by ${JSON.stringify(dist4)}`);

  // ---- M12 part 1: 400 unique eth_call (balanceOf random addresses at latest) so the cache can't answer
  o = { out: size(POOL_OUT), nodes: size(NODES_LOG), cmp: size(COMPARE_LOG) };
  const callTasks = Array.from({ length: 400 }, (_, i) => () => {
    const addr = require('crypto').randomBytes(20).toString('hex');
    return rpc('eth_call', [{ to: USDC, data: '0x70a08231' + addr.padStart(64, '0') }, 'latest'], i);
  });
  const callRes = await pool(callTasks, 8);
  await new Promise((r) => setTimeout(r, 1500));
  out = since(POOL_OUT, o.out);
  const sets = (out.match(/Randomly selected handleRequestSet/g) || []).length;
  const singles = (out.match(/Randomly selected handleRequestSingle/g) || []).length;
  const under3 = (out.match(/Selected clients: [^\n,]*(,[^\n,]*)?\n/g) || []).length;
  const okCalls = callRes.filter((r) => typeof r.result === 'string').length;
  const cmpLines = since(COMPARE_LOG, o.cmp).split('\n').filter(Boolean).length;
  const dist12 = byNode(since(NODES_LOG, o.nodes), 'eth_call');
  report(okCalls === 400 && sets > 0 && sets < 50,
    'M12 (part 1): eth_call still gets the 1-in-20 comparison',
    `${okCalls}/400 served; comparison (set) ${sets}, single ${singles} (expected ~${Math.round((sets + singles) / 20)} sets for ${sets + singles} 3-node selections); ` +
    `selections with <3 nodes ${under3}; poolCompareResults.log lines +${cmpLines}; node attempts ${JSON.stringify(dist12)}`);

  const fb = size(FALLBACK_LOG) - fb0;
  report(fb === 0, 'no fallback during the run', `fallback log grew by ${fb} bytes`);
  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
})();
