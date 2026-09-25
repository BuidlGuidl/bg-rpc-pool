// D15: filter ("ticket") methods. Usage: node testfilters.js
const https = require('https'); const fs = require('fs');
const post = (method, params) => new Promise((r) => { const d = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const q = https.request({ hostname: 'stage.rpc.buidlguidl.com', port: 48544, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (s) => { let x = ''; s.on('data', (c) => (x += c)).on('end', () => r(JSON.parse(x))); }); q.end(d); });
const show = (j) => j.error ? `ERR ${j.error.code} ${j.error.message}` : `ok ${JSON.stringify(j.result).slice(0, 40)}`;
const fbSize = () => fs.statSync('/home/ubuntu/shared/fallbackRequests.log').size;
(async () => {
  const fb0 = fbSize();
  const f = await post('eth_newFilter', [{ address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }]);
  console.log('eth_newFilter              ', show(f));
  const id = f.result || '0x1';
  for (let i = 0; i < 6; i++) console.log('eth_getFilterChanges #' + (i + 1) + '     ', show(await post('eth_getFilterChanges', [id])));
  for (const [m, p] of [['eth_getFilterLogs', [id]], ['eth_uninstallFilter', [id]], ['eth_newBlockFilter', []], ['eth_newPendingTransactionFilter', []]])
    console.log(m.padEnd(27), show(await post(m, p)));
  const logs = await post('eth_getLogs', [{ address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }]);
  console.log('eth_getLogs (still works)  ', show(logs));
  console.log('fallback bytes added:', fbSize() - fb0);
})();
