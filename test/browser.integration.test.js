import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReport } from "../src/index.js";

const enabled = process.env.GPU_PERF_BROWSER_TESTS === "1";

test("profiles an external-style sibling project with auto-instrumentation", { skip: !enabled }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-browser-"));
  const fixtureRoot = path.resolve("fixtures/sibling-project");
  const screenshotPath = path.join(temporary, "fixture.png");
  try {
    const report = await runReport({
      autoInstrument: true,
      durationMs: 200,
      file: path.join(fixtureRoot, "index.html"),
      fileRoot: fixtureRoot,
      samples: 3,
      screenshotPath,
      slowFrameThresholdMs: 25,
      warmup: 1,
      waitUntil: "load"
    });
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.diagnostics.validity.valid, true, JSON.stringify(report.diagnostics.validity));
    assert.equal(report.options.autoInstrument, true);
    assert.equal(report.inPage.hook.found, true);
    assert.ok(report.summary.observedFrameCount > 0);
    assert.ok(report.summary.trackedVram.totalMiB > 0);
    assert.ok(report.inPage.summary.instrumentationCounters["webgl2.drawCalls"] > 0);
    assert.ok(["excellent", "good", "needs-work", "poor"].includes(report.summary.verdict));
    assert.ok((await stat(screenshotPath)).size > 100);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test('persistent Chrome survives failed jobs, tracing and concurrent callers without listener growth', { skip: !enabled, timeout: 30000 }, async () => {
  const { FastCDPHarness } = await import('../src/fast-cdp-runner.js');
  const { createServer } = await import('node:http');
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/stall') return;
    res.writeHead(200, {'content-type':'text/html'});
    if (req.url === '/hang') res.end('<script>__gpuReportBench = () => new Promise(() => {});</script>');
    else res.end('<!doctype html><img src="/stall"><script>__gpuReportBench = () => ({fps:60});</script>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const harness = await FastCDPHarness.launch({ autoInstrument: true, warmup: 0, samples: 1, durationMs: 100 });
  const listenerCount = () => [...harness.browserSession.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  try {
    const initial = listenerCount();
    const report = await harness.run({ url, waitUntil: 'domcontentloaded', timeoutMs: 3000 });
    assert.ok(report.summary.observedFrameCount > 1);
    assert.equal(listenerCount(), initial);
    await assert.rejects(harness.run({ url, waitUntil: 'load', timeoutMs: 200 }), /Timed out/);
    assert.equal(listenerCount(), initial);
    await assert.rejects(harness.run({ url: `${url}/hang`, waitUntil: 'load', trace: true, timeoutMs: 200 }), /timed out|timeout|terminated/i);
    assert.equal(listenerCount(), initial);
    const options = { file: path.resolve('fixtures/sibling-project/index.html'), fileRoot: path.resolve('fixtures/sibling-project'), waitUntil: 'load', timeoutMs: 3000 };
    const [first, second] = await Promise.all([harness.run({ ...options, trace: true }), harness.run(options)]);
    assert.equal(first.trace.captured, true);
    assert.ok(first.trace.summary.eventCount > 0);
    assert.ok(second.summary.trackedVram.totalMiB > 0);
    assert.equal(first.options.autoInstrument, true);
    assert.equal(listenerCount(), initial);
    const targets = await harness.browserSession.send('Target.getTargets');
    assert.equal(targets.targetInfos.filter(t => t.type === 'page').length, 1); // launcher's about:blank only
  } finally {
    await harness.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('waitForHook handles async startup and preserves observed percentiles with partial hook stats', { skip: !enabled, timeout: 15000 }, async () => {
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-readiness-'));
  const file = path.join(directory, 'index.html');
  await writeFile(file, `<script>
    setTimeout(() => { __gpuReportBench = () => ({ fps:60, frameTimeMs:{mean:16.67} }); }, 300);
  </script>`);
  try {
    const report = await runReport({ file, samples:1, warmup:0, durationMs:100, waitUntil:'load', waitForHook:true, timeoutMs:3000 });
    assert.equal(report.inPage.hook.found, true);
    assert.ok(report.summary.frameTimeMsP95 > 0);
    assert.equal(report.summary.frameTimeMsMean, 16.67);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('real GPU timers can be reused without validation errors or leaked batch buffers', {skip:!enabled,timeout:20000},async t=>{
  const report=await runReport({file:path.resolve('fixtures/timing/index.html'),fileRoot:process.cwd(),waitForHook:true,waitUntil:'load',autoInstrument:true,samples:2,warmup:0,durationMs:100,timeoutMs:10000});
  const first=report.inPage.samples[0];
  if(first.measurement?.unsupported){t.skip(first.measurement.unsupported);return;}
  for(const sample of report.inPage.samples){
    assert.equal(sample.error,null,JSON.stringify(sample.error));
    assert.equal(sample.measurement.frames,3);
    assert.ok(sample.measurement.gpuNs>=0);
    if(sample.measurement.glAvailable) assert.ok(Number.isFinite(sample.measurement.glNs) && sample.measurement.glNs>=0);
    assert.equal(sample.measurement.trackedBytesAfterDestroy,0);
    assert.deepEqual(sample.measurement.validationErrors,[]);
  }
});

test('CLI saves failed benchmark evidence and exits 2; A/B preserves failed rounds', {skip:!enabled, timeout:20000}, async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { runABComparison } = await import('../src/ab-runner.js');
  const { comparisonExitCode } = await import('../src/output.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-failed-workload-'));
  const good = path.join(directory, 'good.html');
  const bad = path.join(directory, 'bad.html');
  const out = path.join(directory, 'report.json');
  try {
    await writeFile(good, '<script>__gpuReportBench = () => ({gpuMs:4})</script>');
    await writeFile(bad, '<script>__gpuReportBench = () => { throw new Error("draw failed") }</script>');
    await assert.rejects(promisify(execFile)(process.execPath, [path.resolve('src/cli.js'), 'run', '--file', bad, '--samples', '3', '--warmup', '0', '--duration-ms', '20', '--wait-until', 'load', '--out', out, '--json']), error => {
      assert.equal(error.code, 2);
      const output = JSON.parse(error.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.out, out);
      assert.ok(output.diagnostics.validity.issues.some(issue => issue.code === 'sample-errors'));
      return true;
    });
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.inPage.samples[0].error.message, 'draw failed');
    const ab = await runABComparison({base: {file:good}, candidate:{file:bad}, rounds:2, samples:1, warmup:0, durationMs:80, waitUntil:'load'});
    assert.equal(ab.base.validity.valid, true);
    assert.equal(ab.candidate.validity.valid, false);
    assert.equal(ab.comparison.validity.valid, false);
    assert.equal(comparisonExitCode(ab.comparison), 2);
    assert.equal(ab.runs.length, 4);
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('persistent jobs isolate storage by default, allow explicit shared state, and clean up popups', {skip:!enabled, timeout:20000}, async () => {
  const { createServer } = await import('node:http');
  const { FastCDPHarness } = await import('../src/fast-cdp-runner.js');
  const server = createServer((req, res) => {
    res.writeHead(200, {'content-type':'text/html'});
    res.end(`<script>
      const visits = Number(localStorage.visits || 0) + 1;
      const previousCookie = Number((document.cookie.match(/visits=(\\d+)/) || [])[1] || 0);
      localStorage.visits = visits; document.cookie = 'visits=' + visits;
      let popup;
      __gpuReportBench = async () => {
        const cache = await caches.open('fixture');
        const previous = await cache.match('/counter');
        const cacheVisits = Number(previous ? await previous.text() : 0) + 1;
        await cache.put('/counter', new Response(String(cacheVisits)));
        popup = window.open('about:blank');
        return {visits, previousCookie, cacheVisits, popupOpened: Boolean(popup), gpuMs:1};
      };
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const harness = await FastCDPHarness.launch({samples:1, warmup:0, durationMs:80, waitUntil:'load', timeoutMs:3000, chromiumArgs:['--disable-popup-blocking']});
  try {
    for (const [contextMode, visits] of [['isolated',1], ['isolated',1], ['shared',1], ['shared',2], ['isolated',1]]) {
      const report = await harness.run({url, contextMode, api:'webgpu'});
      const measurement = report.inPage.samples[0].measurement;
      assert.equal(measurement.visits, visits);
      assert.equal(measurement.cacheVisits, visits);
      assert.equal(measurement.previousCookie, visits - 1);
      assert.equal(measurement.popupOpened, true);
      assert.equal(report.options.contextMode, contextMode);
      assert.equal(report.options.frameObservation, 'wall-clock');
      assert.equal(report.inPage.apiSupport.webgl2.skipped, true);
      if (report.inPage.apiSupport.webgpu.available) {
        assert.ok(report.inPage.apiSupport.webgpu.limits.maxTextureDimension2D > 0);
        assert.equal(typeof report.inPage.apiSupport.webgpu.adapter.vendor, 'string');
      }
      const targets = await harness.browserSession.send('Target.getTargets');
      assert.equal(targets.targetInfos.filter(target => target.type === 'page').length, 1);
      const contexts = await harness.browserSession.send('Target.getBrowserContexts');
      assert.equal(contexts.browserContextIds.length, harness.sharedContextId ? 1 : 0);
      assert.equal(harness.browserSession.pending.size, 0);
      assert.equal(harness.browserSession.sessions.size, 0);
    }
  } finally {
    await harness.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('CDP attachment preserves the external browser and cleans up owned contexts', {skip:!enabled,timeout:20000}, async () => {
  const { FastCDPHarness } = await import('../src/fast-cdp-runner.js');
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-attach-'));
  const file = path.join(directory, 'index.html');
  await writeFile(file, `<script type="module">
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({code:'@compute @workgroup_size(1) fn main() {}'});
    await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    globalThis.__gpuReportBench = () => ({fps:60});
  </script>`);
  const owner = await FastCDPHarness.launch();
  let attached;
  try {
    attached = await FastCDPHarness.launch({cdpUrl:owner.launch.webSocketUrl, contextMode:'shared'});
    const report = await attached.run({file,waitUntil:'load',waitCondition:'typeof __gpuReportBench === "function"',waitConditionTimeoutMs:3000,screenshot:true,autoInstrument:true,samples:1,warmup:0,durationMs:100});
    assert.equal(report.diagnostics.validity.valid, true, JSON.stringify(report.diagnostics.validity));
    assert.equal(report.options.cdpAttached, true);
    assert.ok(report.screenshotSize > 100);
    assert.ok(report.summary.pipelines.syncCount + report.summary.pipelines.asyncCount > 0);
    await assert.rejects(attached.run({cdpUrl:'9223',url:'http://localhost'}), /launch option/);
    await attached.close();
    const contexts = await owner.browserSession.send('Target.getBrowserContexts');
    assert.equal(contexts.browserContextIds.length, 0);
    const targets = await owner.browserSession.send('Target.getTargets');
    assert.equal(targets.targetInfos.filter(target => target.type === 'page').length, 1);
  } finally { await attached?.close(); await owner.close(); await rm(directory,{recursive:true,force:true}); }
});

test('CLI emits clean JSON with HTML artifacts and MCP profiles through the fast runner', {skip:!enabled,timeout:20000}, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { PassThrough } = await import('node:stream');
  const { runMcpServer } = await import('../src/agent.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-release-'));
  const input = new PassThrough();
  const output = new PassThrough();
  let server;
  try {
    const file = path.join(directory, 'page.html');
    await writeFile(file, '<script>__gpuReportBench = () => ({fps:60,gpuTimeNs:1000000});</script>');
    const out = path.join(directory,'report.json');
    const result = await promisify(execFile)(process.execPath,[path.resolve('src/cli.js'),'run','--file',file,'--samples','5','--adaptive','--duration-ms','40','--warmup','0','--wait-until','load','--html','--out',out,'--json']);
    const compact = JSON.parse(result.stdout);
    assert.equal(compact.ok,true);
    assert.match(await readFile(compact.htmlPath,'utf8'),/<!doctype html>/i);
    assert.equal(JSON.parse(await readFile(out,'utf8')).inPage.samples.length,3);
    server = await runMcpServer({input,output});
    const response = new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('MCP profile timed out')),10000);
      output.once('data',chunk => {clearTimeout(timer);resolve(JSON.parse(chunk.toString()));});
    });
    input.write(JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'profile_webgpu',arguments:{file,samples:1,durationMs:40,autoInstrument:true}}})+'\n');
    const message = await response;
    assert.equal(message.id,7);
    assert.equal(message.result.isError,false,JSON.stringify(message));
    assert.equal(message.result.report.options.runner,'fast-cdp');
    assert.equal(message.result.report.diagnostics.validity.valid,true);
  } finally { server?.close(); input.destroy(); output.destroy(); await rm(directory,{recursive:true,force:true}); }
});
