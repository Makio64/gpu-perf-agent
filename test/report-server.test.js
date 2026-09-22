import assert from 'node:assert/strict';
import test from 'node:test';
import { FastCDPHarness } from '../src/fast-cdp-runner.js';
import { startReportServer } from '../src/report-server.js';
const enabled = process.env.GPU_PERF_NETWORK_TESTS === '1' || process.env.GPU_PERF_BROWSER_TESTS === '1';

test('HTTP API validates requests, bounds its queue and exposes compact output', {skip: !enabled}, async t => {
  let release;
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let closed = false;
  t.mock.method(FastCDPHarness, 'launch', async () => ({
    async run(options) {
      called(options); await gate;
      return { summary: {verdict:'good'}, diagnostics: {warnings:[]}, options,
        inPage: {samples: Array.from({length: options.samples}, () => ({measurement: {fps:60}, ...(options.url.endsWith('/fail') ? {error: {message:'draw failed'}} : {})}))} };
    },
    async close() { closed = true; }
  }));
  const server = await startReportServer({maxQueue:1});
  const post = body => fetch(`${server.url}/run?format=compact`, { method:'POST', body: JSON.stringify(body) });
  try {
    assert.equal((await post([])).status, 400);
    assert.equal((await post({url:'http://localhost',samples:0})).status, 400);
    assert.equal((await post({value:'x'.repeat(65536)})).status, 413);
    const first = post({url:'http://localhost',preset:'quick'});
    const options = await started;
    assert.equal(options.samples, 6);
    assert.equal((await post({url:'http://localhost'})).status, 429);
    assert.equal((await (await fetch(`${server.url}/health`)).json()).pending, 1);
    release();
    const result = await (await first).json();
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'good');
    assert.equal(result.options, undefined);
    const health = await (await fetch(`${server.url}/health`)).json();
    assert.equal(health.completed, 1);
    assert.equal(health.failed, 3);
    assert.equal(health.pending, 0);
    const invalid = await (await post({url:'http://localhost/fail'})).json();
    assert.equal(invalid.ok, false);
    assert.equal(invalid.diagnostics.validity.valid, false);
    assert.equal((await (await fetch(`${server.url}/health`)).json()).failed, 4);
  } finally { release(); await server.close(); }
  assert.equal(closed, true);
});

test('server releases Chrome if the requested port is already occupied', {skip: !enabled}, async t => {
  let closed = 0;
  t.mock.method(FastCDPHarness, 'launch', async () => ({close:async()=>{closed++;}}));
  const first = await startReportServer();
  try {
    await assert.rejects(startReportServer({port:first.port}), /EADDRINUSE/);
    assert.equal(closed, 1);
  } finally { await first.close(); }
});

test('a harness with failed cleanup reports unavailable and rejects jobs before queuing', {skip:!enabled}, async t => {
  const harness = {close: async()=>{}, run: async()=>{throw new Error('must not run');}};
  t.mock.method(FastCDPHarness, 'launch', async () => harness);
  const server = await startReportServer();
  try {
    harness.cleanupError = new Error('Close and restart the harness.');
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 503);
    const status = await health.json();
    assert.equal(status.ok, false);
    assert.equal(status.error.code, 'CAPTURE_CLEANUP_FAILED');
    const run = await fetch(`${server.url}/run`, {method:'POST', body:JSON.stringify({url:'http://localhost'})});
    assert.equal(run.status, 503);
    assert.equal((await run.json()).error.code, 'CAPTURE_CLEANUP_FAILED');
  } finally {await server.close();}
});
