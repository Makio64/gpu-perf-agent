import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FastCDPHarness } from '../src/fast-cdp-runner.js';
import { confineArtifactPaths, startReportServer } from '../src/report-server.js';
const enabled = process.env.GPU_PERF_NETWORK_TESTS === '1' || process.env.GPU_PERF_BROWSER_TESTS === '1';
const http = createRequire(import.meta.url)('node:http');

// Raw node:http so tests can set Host/Origin/Content-Type exactly as a browser would.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (url, body, headers = {}) => request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

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
  const server = await startReportServer({maxQueue:1, port:0});
  const run = body => post(`${server.url}/run?format=compact`, body);
  try {
    assert.equal((await run([])).status, 400);
    assert.equal((await run({url:'http://localhost',samples:0})).status, 400);
    assert.equal((await run({value:'x'.repeat(65536)})).status, 413);
    const first = run({url:'http://localhost',preset:'quick'});
    const options = await started;
    assert.equal(options.samples, 6);
    assert.equal((await run({url:'http://localhost'})).status, 429);
    assert.equal((await request(`${server.url}/health`)).json.pending, 1);
    release();
    const result = (await first).json;
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'good');
    assert.equal(result.options, undefined);
    const health = (await request(`${server.url}/health`)).json;
    assert.equal(health.completed, 1);
    assert.equal(health.failed, 3);
    assert.equal(health.pending, 0);
    const invalid = (await run({url:'http://localhost/fail'})).json;
    assert.equal(invalid.ok, false);
    assert.equal(invalid.diagnostics.validity.valid, false);
    assert.equal((await request(`${server.url}/health`)).json.failed, 4);
  } finally { release(); await server.close(); }
  assert.equal(closed, true);
});

test('server releases Chrome if the requested port is already occupied', {skip: !enabled}, async t => {
  let closed = 0;
  t.mock.method(FastCDPHarness, 'launch', async () => ({close:async()=>{closed++;}}));
  const first = await startReportServer({port:0});
  try {
    await assert.rejects(startReportServer({port:first.port}), /EADDRINUSE/);
    assert.equal(closed, 1);
  } finally { await first.close(); }
});

test('a harness with failed cleanup reports unavailable and rejects jobs before queuing', {skip:!enabled}, async t => {
  const harness = {close: async()=>{}, run: async()=>{throw new Error('must not run');}};
  t.mock.method(FastCDPHarness, 'launch', async () => harness);
  const server = await startReportServer({port:0});
  try {
    harness.cleanupError = new Error('Close and restart the harness.');
    const health = await request(`${server.url}/health`);
    assert.equal(health.status, 503);
    assert.equal(health.json.ok, false);
    assert.equal(health.json.error.code, 'CAPTURE_CLEANUP_FAILED');
    const run = await post(`${server.url}/run`, {url:'http://localhost'});
    assert.equal(run.status, 503);
    assert.equal(run.json.error.code, 'CAPTURE_CLEANUP_FAILED');
  } finally {await server.close();}
});

test('cross-origin, foreign-Host and non-JSON requests are refused and write nothing', {skip:!enabled}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-serve-'));
  let runs = 0;
  t.mock.method(FastCDPHarness, 'launch', async () => ({ alive: true, close: async () => {}, run: async (options) => { runs++; return { options, summary: {}, inPage: { samples: [] } }; } }));
  const server = await startReportServer({ port: 0, reportDir: directory });
  const body = JSON.stringify({ url: 'http://localhost', screenshot: true, screenshotPath: 'csrf-written.png' });
  try {
    // The audited CSRF: a simple text/plain POST from a foreign page.
    const csrf = await request(`${server.url}/run`, { method: 'POST', body, headers: { 'content-type': 'text/plain', origin: 'https://evil.example' } });
    assert.equal(csrf.status, 403);
    assert.equal((await request(`${server.url}/run`, { method: 'POST', body, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post(`${server.url}/run`, body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(`${server.url}/run`, body, { origin: 'null' })).status, 403);
    assert.equal((await post(`${server.url}/run`, body, { host: `evil.example:${server.port}` })).status, 403);
    assert.equal((await request(`${server.url}/health`, { headers: { host: `rebind.example:${server.port}` } })).status, 403);
    assert.equal((await post(`${server.url}/close`, '', { 'content-type': 'text/plain' })).status, 415);
    assert.equal(runs, 0);
    await assert.rejects(stat(path.join(directory, 'csrf-written.png')), { code: 'ENOENT' });
    // Same-origin pages and localhost Host headers are accepted.
    assert.equal((await post(`${server.url}/run`, body, { origin: server.url, 'content-type': 'application/json; charset=utf-8' })).status, 200);
    assert.equal((await request(`${server.url}/health`, { headers: { host: `localhost:${server.port}` } })).status, 200);
    // Artifact paths must stay inside the report directory.
    const outside = await post(`${server.url}/run`, { url: 'http://localhost', screenshotPath: '../escape.png' });
    assert.equal(outside.status, 400);
    assert.match(outside.json.error.message, /report directory/);
    assert.equal((await post(`${server.url}/run`, { url: 'http://localhost', rawTracePath: '/etc/x.json' })).status, 400);
    assert.equal(runs, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('confineArtifactPaths resolves inside the report directory', () => {
  const root = path.resolve('/srv/reports');
  assert.equal(confineArtifactPaths({ screenshotPath: 'a/b.png' }, root).screenshotPath, path.join(root, 'a/b.png'));
  assert.equal(confineArtifactPaths({ screenshotOut: 'c.png' }, root).screenshotPath, path.join(root, 'c.png'));
  assert.equal(confineArtifactPaths({ screenshotJpegPath: path.join(root, 'x.jpg') }, root).screenshotJpegPath, path.join(root, 'x.jpg'));
  for (const bad of ['../x.png', '/tmp/x.png', '.', '']) {
    assert.throws(() => confineArtifactPaths({ rawTracePath: bad }, root), { code: 'invalid-options' });
  }
});

test('/health reports liveness and a dead browser is relaunched before the next job', {skip:!enabled}, async t => {
  const harnesses = [];
  t.mock.method(FastCDPHarness, 'launch', async () => {
    const harness = { alive: true, pid: 1000 + harnesses.length, launch: { executablePath: '/chrome' }, closed: 0,
      close: async () => { harness.closed++; }, run: async (options) => ({ options, pid: harness.pid, summary: {}, inPage: { samples: [] } }) };
    harnesses.push(harness);
    return harness;
  });
  const server = await startReportServer({ port: 0, autoInstrument: true });
  try {
    let health = await request(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.json.alive, true);
    assert.equal(health.json.pid, 1000);
    assert.equal(typeof health.json.version, 'string');
    assert.equal(health.json.launch.executablePath, '/chrome');
    assert.equal(health.json.defaults.autoInstrument, true);
    harnesses[0].alive = false;
    health = await request(`${server.url}/health`);
    assert.equal(health.status, 503);
    assert.equal(health.json.ok, false);
    const run = await post(`${server.url}/run`, { url: 'http://localhost' });
    assert.equal(run.status, 200);
    assert.equal(run.json.pid, 1001);
    assert.equal(harnesses[0].closed, 1);
    health = await request(`${server.url}/health`);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.relaunches, 1);
  } finally { await server.close(); }
});

test('a job whose browser died before sampling is retried once on a fresh browser', {skip:!enabled}, async t => {
  const harnesses = [];
  t.mock.method(FastCDPHarness, 'launch', async () => {
    const harness = { alive: true, close: async () => {}, run: async (options) => {
      if (harnesses.length === 1) { harness.alive = false; throw Object.assign(new Error('Chrome DevTools connection closed.'), { samplingStarted: false }); }
      return { options, summary: {}, inPage: { samples: [] } };
    } };
    harnesses.push(harness);
    return harness;
  });
  const server = await startReportServer({ port: 0 });
  try {
    const run = await post(`${server.url}/run`, { url: 'http://localhost' });
    assert.equal(run.status, 200);
    assert.equal(harnesses.length, 2);
  } finally { await server.close(); }
});

test('a job whose browser died during sampling is not retried; queued jobs aborted by the relaunch are', {skip:!enabled}, async t => {
  const harnesses = [];
  let runs = 0;
  let releaseFirst;
  const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
  t.mock.method(FastCDPHarness, 'launch', async () => {
    const harness = { alive: true, closed: false, queue: [],
      close: async () => {
        harness.closed = true;
        // Queued jobs on the closed harness are rejected the way FastCDPHarness does.
        for (const reject of harness.queue.splice(0)) reject(Object.assign(new Error('The profiler is shutting down.'), { code: 'aborted', reason: 'harness-closed', samplingStarted: false }));
      },
      run: (options) => {
        runs += 1;
        if (harnesses.length > 1) return Promise.resolve({ options, pid: harnesses.length, summary: {}, inPage: { samples: [] } });
        if (options.url.endsWith('/sampling')) {
          harness.alive = false;
          return Promise.reject(Object.assign(new Error('Chrome DevTools connection closed.'), { samplingStarted: true }));
        }
        releaseFirst();
        return new Promise((_, reject) => harness.queue.push(reject));
      } };
    harnesses.push(harness);
    return harness;
  });
  const server = await startReportServer({ port: 0 });
  try {
    const queued = post(`${server.url}/run`, { url: 'http://localhost/queued' });
    await firstStarted;
    const sampled = await post(`${server.url}/run`, { url: 'http://localhost/sampling' });
    assert.equal(sampled.status, 500);
    // The next request relaunches; the relaunch closes the dead harness, which rejects the
    // queued job with reason harness-closed, and that job is retried on the new browser.
    const next = await post(`${server.url}/run`, { url: 'http://localhost/next' });
    assert.equal(next.status, 200);
    const retried = await queued;
    assert.equal(retried.status, 200);
    assert.equal(harnesses.length, 2);
    assert.equal(runs, 4);
  } finally { await server.close(); }
});

test('idle servers close Chrome; the state file is written 0600 and removed on close', {skip:!enabled}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-state-'));
  let closed = 0;
  t.mock.method(FastCDPHarness, 'launch', async () => ({ alive: true, close: async () => { closed++; } }));
  const stateFile = path.join(directory, 'abc123.json');
  const server = await startReportServer({ port: 0, idleTimeoutMs: 150, stateFile });
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual([state.port, state.pid, state.key], [server.port, process.pid, 'abc123']);
    if (process.platform !== 'win32') assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(closed, 1);
    await assert.rejects(stat(stateFile), { code: 'ENOENT' });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
