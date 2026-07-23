import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, runPool, createHttpProbe, createWebSocketProbe, runTransportDiagnostics } from '../web/transport-diagnostics.js';

test('percentile uses nearest-rank semantics', () => {
  assert.equal(percentile([1,2,3,4], .5), 2);
  assert.equal(percentile([1,2,3,4], .95), 4);
  assert.equal(percentile([], .5), null);
});

test('summarize filters non-finite values and calculates stable percentiles', () => {
  assert.deepEqual(summarize([4, 1, NaN, 3, 2, Infinity]), {count:4,min_ms:1,mean_ms:2.5,p50_ms:2,p95_ms:4,p99_ms:4,max_ms:4});
});

test('runPool caps concurrency and collects failures without aborting', async () => {
  let active = 0, maxActive = 0;
  const out = await runPool(8, 3, async i => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 2));
    active--;
    if (i === 3) throw new Error('boom');
    return i;
  });
  assert.ok(maxActive <= 3);
  assert.equal(out.values.length, 7);
  assert.deepEqual(out.errors, ['boom']);
});

test('HTTP probe measures complete response and rejects non-2xx', async () => {
  let t = 10;
  const now = () => (t += 5);
  const ok = createHttpProbe({url:'/api/version', now, fetchImpl:async()=>({ok:true,text:async()=>''})});
  assert.equal(await ok(), 5);
  const bad = createHttpProbe({url:'/api/version', now, fetchImpl:async()=>({ok:false,status:503,text:async()=>''})});
  await assert.rejects(bad, /HTTP 503/);
});

test('WebSocket probe measures open time and closes socket', async () => {
  let closed = false, t = 0;
  class FakeWS { constructor(){this.listeners={};queueMicrotask(()=>this.listeners.open());} addEventListener(n,fn){this.listeners[n]=fn;} close(){closed=true;} }
  const probe = createWebSocketProbe({url:'ws://norns:5555',WebSocketImpl:FakeWS,now:()=>++t,timeoutMs:50});
  assert.equal(await probe(), 1);
  assert.equal(closed, true);
});

test('diagnostics returns JSON-safe summaries and progress order', async () => {
  const stages=[];
  const report = await runTransportDiagnostics({samples:10,concurrency:2,httpUrl:'http://x',wsUrl:'ws://x',httpProbe:async()=>4,wsProbe:async()=>7,onProgress:s=>stages.push(s)});
  assert.equal(report.benchmark_version, 2);
  assert.equal(report.http_serial.latency.count, 10);
  assert.equal(report.http_concurrent.latency.p95_ms, 4);
  assert.equal(report.websocket_connect.latency.count, 10);
  assert.deepEqual(stages, ['http_serial','http_concurrent','websocket_connect','done']);
});
