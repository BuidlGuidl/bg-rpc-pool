// Deferred tests M5, M6, M7 (2+ reth nodes with different receipt floors), through bg-rpc-proxy 48544.
// Stage on 2026-09-25: bgnode7 floor 25,300,000; NUC11PHi7 and bgnodetest3 floor 25,800,000.
const https = require('https');
const fs = require('fs');

const HOST = 'stage.rpc.buidlguidl.com';
const NODES_LOG = '/home/ubuntu/shared/poolNodes.log';
const FALLBACK_LOG = '/home/ubuntu/shared/fallbackRequests.log';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const QUIET = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e'; // ENS registry: 10k blocks ≈ 1 s, far under the log cap
const hex = (n) => '0x' + n.toString(16);
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const since = (f, o) => fs.readFileSync(f).subarray(o).toString();

function request(port, path, body, id = 1) {
  return new Promise((resolve) => {
    const d = body ? JSON.stringify({ jsonrpc: '2.0', id, ...body }) : null;
    const t0 = Date.now();
    const r = https.request({ hostname: HOST, port, path, method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } : {} }, (res) => {
      let t = ''; res.on('data', (c) => (t += c));
      res.on('end', () => { let j; try { j = JSON.parse(t); } catch { j = { error: { message: t.slice(0, 80) } }; } resolve({ ...j, ms: Date.now() - t0 }); });
    });
    r.on('error', (e) => resolve({ error: { message: e.message }, ms: Date.now() - t0 }));
    r.end(d || undefined);
  });
}
const getLogs = (filter, id) => request(48544, '/', { method: 'eth_getLogs', params: [filter] }, id);
const show = (r) => r.error ? `ERR ${r.error.code} ${r.error.message}` : `${r.result.length} logs`;
const short = (id) => id.split('-')[0];
// node that served each getLogs in the window, in log order
const servedBy = (o) => since(NODES_LOG, o).split('\n').filter((l) => l.split('|')[4] === 'eth_getLogs')
  .map((l) => ({ node: short(l.split('|')[2]), status: l.split('|').pop() }));
const count = (arr) => arr.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});

let failures = 0;
const report = (pass, name, detail) => { if (!pass) failures++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };

(async () => {
  const fb0 = size(FALLBACK_LOG);
  const head = parseInt((await request(48544, '/', { method: 'eth_blockNumber', params: [] })).result, 16);
  const status = await request(3003, '/getlogsStatus');
  console.log(`head ${head}; pool status ${JSON.stringify({ readyNodes: status.readyNodes, receiptFloor: status.receiptFloor, inFlight: status.inFlight })}\n`);

  // ---- M7: status with different floors
  const viaProxy = await request(48544, '/getlogsStatus');
  // D14: receiptFloor is the LOWEST floor (oldest block any node serves), receiptFloorAll the highest
  report(status.readyNodes === 3 && status.receiptFloor === 25300000 && status.receiptFloorAll === 25800000 &&
    viaProxy.receiptFloor === 25300000 && viaProxy.receiptFloorAll === 25800000 && viaProxy.readyNodes === 3,
    'M7: /getlogsStatus reports all ready nodes, the lowest floor and receiptFloorAll (D14)',
    `pool ${JSON.stringify({ readyNodes: status.readyNodes, receiptFloor: status.receiptFloor, receiptFloorAll: status.receiptFloorAll })}; via 48544 ${JSON.stringify({ readyNodes: viaProxy.readyNodes, receiptFloor: viaProxy.receiptFloor, receiptFloorAll: viaProxy.receiptFloorAll })}`);

  // ---- M5a: ranges only bgnode7 covers always go to bgnode7
  let o = size(NODES_LOG);
  const old = [];
  for (let i = 0; i < 12; i++) old.push(await getLogs({ address: USDC, fromBlock: hex(25500000 + i * 1000), toBlock: hex(25500000 + i * 1000 + 5) }, i));
  await new Promise((r) => setTimeout(r, 800));
  let served = count(servedBy(o).map((x) => x.node));
  report(old.every((r) => Array.isArray(r.result)) && Object.keys(served).length === 1 && served.bgnode7 === 12,
    'M5a: 12 getLogs from 25,500,000 (only bgnode7 covers) all go to bgnode7', `${old.map(show).slice(0, 3).join(', ')}…; served ${JSON.stringify(served)}`);

  // Below every floor still -32602
  const below = await getLogs({ address: USDC, fromBlock: hex(25000000), toBlock: hex(25000005) });
  report(below.error?.code === -32602 && /25300000/.test(below.error.message), 'M5b: below every floor -> -32602 naming the lowest floor', show(below));

  // ---- M5c: bgnode7 full (4 slow old-range queries) -> 5th old-range query gets -32005,
  // while `latest` queries in the same moment still go to the other nodes
  o = size(NODES_LOG);
  const slowOld = (i) => getLogs({ address: QUIET, fromBlock: hex(25500000), toBlock: hex(25509999) }, 100 + i);
  const oldP = [0, 1, 2, 3].map((i) => slowOld(i));
  await new Promise((r) => setTimeout(r, 250));                         // let the 4 reach bgnode7
  const fifth = await slowOld(4);
  const latestDuring = await Promise.all([0, 1, 2].map((i) => getLogs({ address: USDC, fromBlock: 'latest' }, 200 + i)));
  const oldRes = await Promise.all(oldP);
  await new Promise((r) => setTimeout(r, 800));
  const log5 = servedBy(o);
  const latestNodes = log5.slice(-3).map((x) => x.node);                // not exact: order in the log is by completion
  const byNode5 = count(log5.map((x) => x.node));
  report(oldRes.every((r) => Array.isArray(r.result)) && fifth.error?.code === -32005 && latestDuring.every((r) => Array.isArray(r.result)) &&
    (byNode5.bgnode7 === 4 || byNode5.bgnode7 === 4 + latestDuring.length - (byNode5.buidlguidl || 0) - (byNode5.bgnodetest3 || 0)),
    'M5c: bgnode7 full -> 5th old-range query gets -32005; latest still served by others',
    `4 old: ${oldRes.map((r) => `${show(r)} ${r.ms}ms`).join(' | ')}; 5th: ${show(fifth)} in ${fifth.ms} ms; latest ×3 during: ${latestDuring.map(show).join(', ')}; served ${JSON.stringify(byNode5)}`);

  // ---- M6: 13 concurrent slow recent queries over 3 nodes (cap 4 each = 12) -> 12 served (≤4 per node), 1 × -32005
  await new Promise((r) => setTimeout(r, 1500));
  o = size(NODES_LOG);
  const recent = { address: QUIET, fromBlock: hex(head - 10009), toBlock: hex(head - 10) };
  const ps = [];
  for (let i = 0; i < 13; i++) { ps.push(getLogs(recent, 300 + i)); await new Promise((r) => setTimeout(r, 20)); }
  const res6 = await Promise.all(ps);
  await new Promise((r) => setTimeout(r, 1000));
  const byNode6 = count(servedBy(o).map((x) => x.node));
  const busy = res6.filter((r) => r.error?.code === -32005).length;
  const ok6 = res6.filter((r) => Array.isArray(r.result)).length;
  report(ok6 === 12 && busy === 1 && Object.values(byNode6).every((n) => n <= 4) && Object.keys(byNode6).length === 3,
    'M6: 13 concurrent over 3 nodes -> 12 served (4 per node max), 13th gets -32005',
    `served ${ok6}, -32005 ×${busy}; per node ${JSON.stringify(byNode6)}; times ${res6.map((r) => r.ms).join(',')}`);

  await new Promise((r) => setTimeout(r, 1500));
  const after = await request(3003, '/getlogsStatus');
  report(after.inFlight === 0, 'in-flight back to 0', JSON.stringify({ inFlight: after.inFlight }));
  report(size(FALLBACK_LOG) === fb0, 'no fallback lines', `+${size(FALLBACK_LOG) - fb0} bytes`);
  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
})();
