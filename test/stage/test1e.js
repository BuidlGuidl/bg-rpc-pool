// Phase 1e tests: compression on bg-rpc-proxy's public port (48544).
const https = require('https'), zlib = require('zlib'), fs = require('fs');
const HOST = 'stage.rpc.buidlguidl.com';
function post(body, acceptEncoding) {
  return new Promise((resolve) => {
    const d = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) };
    if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;
    const t0 = Date.now();
    const r = https.request({ hostname: HOST, port: 48544, method: 'POST', headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const wire = Buffer.concat(chunks); const enc = res.headers['content-encoding'];
        const body = enc === 'br' ? zlib.brotliDecompressSync(wire) : enc === 'gzip' ? zlib.gunzipSync(wire) : enc === 'deflate' ? zlib.inflateSync(wire) : wire;
        resolve({ enc: enc || 'none', wire: wire.length, body, ms: Date.now() - t0 });
      });
    });
    r.end(d);
  });
}
let failures = 0;
const report = (pass, name, detail) => { if (!pass) failures++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
(async () => {
  const req = fs.readFileSync(__dirname + '/getlogs60.json', 'utf8');  // fixed past range: same answer every time
  const plain = await post(req, null);
  report(plain.enc === 'none', 'no Accept-Encoding -> uncompressed', `${plain.enc}, ${(plain.wire / 1e6).toFixed(2)} MB, ${plain.ms} ms`);
  for (const ae of ['gzip', 'br', 'gzip, deflate, br', 'deflate']) {
    const r = await post(req, ae);
    const expected = ae === 'deflate' ? 'deflate' : ae.includes('br') ? 'br' : 'gzip';
    report(r.enc === expected && r.body.equals(plain.body), `Accept-Encoding: ${ae} -> ${expected}, identical body`,
      `${r.enc}, ${(r.wire / 1e3).toFixed(0)} KB on the wire (${(plain.wire / r.wire).toFixed(1)}x), ${r.ms} ms, body ${r.body.equals(plain.body) ? 'identical' : 'DIFFERENT'}`);
  }
  const small = await post({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 'gzip, br');
  report(small.enc === 'none', 'eth_blockNumber (<1 KB) not compressed', `${small.enc}, ${small.wire} bytes`);
  const err = await post({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x17d7840', toBlock: '0x17d7841' }] }, 'gzip, br');
  report(err.enc === 'none' && /older than block/.test(err.body.toString()), 'small error response not compressed', `${err.enc}: ${err.body.toString().slice(0, 100)}`);
  const batch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_blockNumber', params: [] }));
  const b = await post(batch, 'gzip');
  report(b.enc === 'gzip' && JSON.parse(b.body).length === 50, 'batch of 50 (>1 KB) compressed and parses', `${b.enc}, ${b.wire} bytes on the wire`);
  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
})();
