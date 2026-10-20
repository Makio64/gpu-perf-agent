import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { collectInPage } from '../src/injected.js';

async function probe(api, {adapterError = false, glError = false, frames = true, hook = true, samplingMode} = {}) {
  const context = vm.createContext({queueMicrotask, setTimeout, clearTimeout});
  vm.runInContext(`
    clock = 0;
    performance = {now: () => clock};
    calls = {adapter:0, contexts:[], releases:0};
    cancelAnimationFrame = () => {};
    requestAnimationFrame = callback => queueMicrotask(() => callback(clock += 16));
    class Limits {
      get maxTextureDimension2D() { return 16384; }
      get maxBufferSize() { return 1073741824; }
      get unavailable() { throw new Error('optional attribute not supported'); }
    }
    class AdapterInfo {
      get vendor() { return 'fixture-vendor'; }
      get architecture() { return ''; }
      get isFallbackAdapter() { return false; }
    }
    navigator = {gpu:{async requestAdapter() {
      calls.adapter++;
      if (${adapterError}) throw new Error('adapter unavailable');
      return {limits: new Limits(), info: new AdapterInfo(), features:new Set(['timestamp-query'])};
    }}};
    document = {createElement: () => ({getContext(api) {
      calls.contexts.push(api);
      return {
        getContextAttributes: () => ({}),
        getSupportedExtensions() {if (${glError}) throw new Error('GL query failed'); return [];},
        getParameter: () => 'fixture-renderer',
        getExtension: name => name === 'WEBGL_lose_context' ? {loseContext() {calls.releases++;}} : null
      };
    }})};
    __gpuReportBench = ${hook ? '() => ({gpuMs:1})' : 'undefined'};
  `, context);
  if (!frames) {
    context.performance = performance;
    context.requestAnimationFrame = () => 1;
  }
  const report = await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify({api, samples:1, warmup:0, durationMs:20, samplingMode})})`, context);
  return JSON.parse(JSON.stringify({support:report.apiSupport, calls:context.calls, report}));
}

test('WebGPU capability capture includes inherited WebIDL attributes and skips unrelated GL probing', async () => {
  const {support, calls} = await probe('webgpu');
  assert.deepEqual(support.webgpu.limits, {maxTextureDimension2D:16384, maxBufferSize:1073741824});
  assert.deepEqual(support.webgpu.adapter, {vendor:'fixture-vendor', architecture:'', isFallbackAdapter:false});
  assert.deepEqual(calls.contexts, []);
  assert.equal(calls.adapter, 1);
  assert.deepEqual(support.webgl2, {available:null, skipped:true, error:null});
});

test('GL probes honor the requested API and release their context even on failed queries', async () => {
  for (const api of ['webgl', 'webgl2']) {
    const {support, calls} = await probe(api);
    assert.deepEqual(calls.contexts, [api]);
    assert.equal(calls.adapter, 0);
    assert.equal(calls.releases, 1);
    assert.equal(support[api].available, true);
  }
  const {support, calls} = await probe('webgl2', {glError:true});
  assert.equal(support.webgl2.available, false);
  assert.equal(calls.releases, 1);
  assert.match(support.webgl2.error.message, /GL query failed/);
});

test('auto mode retains both capability probes; failed adapter requests are unavailable', async () => {
  const {support, calls} = await probe('auto');
  assert.equal(support.webgpu.available, true);
  assert.equal(support.webgl2.available, true);
  assert.equal(calls.adapter, 1);
  assert.equal(calls.releases, 1);
  const failed = await probe('webgpu', {adapterError:true});
  assert.equal(failed.support.webgpu.available, false);
  assert.match(failed.support.webgpu.error.message, /adapter unavailable/);
});

test('missing animation callbacks finish with absent frame metrics instead of a stalled capture', async () => {
  const started = performance.now();
  const {report} = await probe('webgpu', {frames:false});
  assert.ok(performance.now() - started < 1500);
  const observed = report.samples[0].measurement.observedFrames;
  assert.equal(observed.frameCount, 0);
  assert.equal(observed.fps, null);
  assert.equal(observed.frameTimeMs, null);
  assert.ok(observed.observationWindowMs >= 15);
  assert.equal(report.samples[0].measurement.gpuMs, 1);
  assert.match(report.warnings[0], /Frame settling/);
  const {finalizeReport} = await import('../src/analysis.js');
  const finalized = finalizeReport({inPage: report});
  assert.equal(finalized.diagnostics.validity.valid, true);
  assert.ok(finalized.summary.warnings.some(warning => warning.code === 'limited-frame-signal'));
  const empty = await probe('webgpu', {frames:false, hook:false});
  assert.equal(finalizeReport({inPage:empty.report}).diagnostics.validity.valid, false);
});

test('adaptive sampling requires three finite stable samples; fixed and unstable sampling retain the budget', async () => {
  const { reportValidity } = await import('../src/validity.js');
  async function capture(adaptive, rates) {
    const context = vm.createContext({queueMicrotask, setTimeout, clearTimeout});
    vm.runInContext(`
      clock = 0; performance = {now: () => clock}; navigator = {}; document = {};
      cancelAnimationFrame = () => {};
      requestAnimationFrame = callback => queueMicrotask(() => callback(clock += 1000/120));
      __gpuReportBench = ({sampleIndex}) => ({fps: ${JSON.stringify(rates)}[sampleIndex], gpuTimeNs: 1000});
    `, context);
    const options = {api:'webgpu', adaptive, samples:5, warmup:0, durationMs:100};
    const inPage = JSON.parse(JSON.stringify(await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify(options)})`, context)));
    return {options: {...options, api:'auto'}, inPage};
  }
  const adaptive = await capture(true, [60, 60, 60, 60, 60]);
  assert.equal(adaptive.inPage.samples.length, 3);
  assert.equal(adaptive.inPage.sampling.stoppedEarly, true);
  assert.equal(reportValidity(adaptive).valid, true);
  assert.equal(adaptive.inPage.summary.cadence.hz, 120);
  assert.equal(adaptive.inPage.summary.gpuTimeNs.mean, 1000);
  assert.ok(adaptive.inPage.summary.frameTimeMsP99_9.mean > 0);
  assert.equal(reportValidity({...adaptive, options:{...adaptive.options, adaptive:false}}).valid, false);
  assert.equal((await capture(false, [60, 60, 60, 60, 60])).inPage.samples.length, 5);
  assert.equal((await capture(true, [30, 60, 30, 60, 30])).inPage.samples.length, 5);
});

function hookFixture({ hookCode, options = {}, setup = '' } = {}) {
  const context = vm.createContext({});
  vm.runInContext(`
    clock = 0;
    counters = {raf:0, timers:0, gc:0, snapshots:[], memorySnapshots:[], deepMemory:0, hooks:[], active:0, maxActive:0};
    workload = {heap:1000, bytes:1024, draws:0};
    performance = {now: () => clock,
      get memory() {return {usedJSHeapSize: workload.heap, totalJSHeapSize: 10000, jsHeapSizeLimit: 100000};},
      async measureUserAgentSpecificMemory() {counters.deepMemory++; return {bytes:workload.heap};}
    };
    navigator = {userAgent:'test-hook', gpu:{async requestAdapter() {return {features:[],limits:{}};}}};
    requestAnimationFrame = () => {counters.raf++; throw new Error('Unexpected requestAnimationFrame');};
    cancelAnimationFrame = () => {throw new Error('Unexpected cancelAnimationFrame');};
    setTimeout = () => {counters.timers++; throw new Error('Unexpected sampling timer');};
    clearTimeout = () => {};
    gc = () => {counters.gc++; workload.heap--;};
    __gpuMemoryTracker = {snapshot(options) {counters.memorySnapshots.push(options); return {totalBytes:workload.bytes};}};
    __gpuReportInstrumentation = {snapshot(options) {counters.snapshots.push(options); return {counters:{'webgpu.drawCalls':workload.draws},errors:[]};}};
    __gpuReportBench = ${hookCode || `async config => {
      counters.hooks.push(config); counters.active++; counters.maxActive = Math.max(counters.maxActive, counters.active);
      await Promise.resolve();
      workload.heap += 10; workload.bytes += 32; workload.draws += 2; clock += 3;
      counters.active--;
      return {gpuTimeNs: 2000 + config.sampleIndex};
    }`};
    ${setup}
  `, context);
  const captureOptions = {api:'webgpu', samplingMode:'hook', samples:4, warmup:2, durationMs:1234, ...options};
  return {
    context,
    options: captureOptions,
    run: async () => JSON.parse(JSON.stringify(await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify(captureOptions)})`, context)))
  };
}

test('hook sampling awaits every warmup and sample without scheduling animation callbacks or timers', async () => {
  const { context, run } = hookFixture({options:{gc:true,deepMemory:true}});
  const report = await run();
  const counters = JSON.parse(JSON.stringify(context.counters));
  assert.equal(counters.raf, 0);
  assert.equal(counters.timers, 0);
  assert.equal(counters.gc, 4);
  assert.equal(counters.maxActive, 1);
  assert.deepEqual(counters.hooks.map(call => [call.phase, call.sampleIndex]), [['warmup',0],['warmup',1],['sample',0],['sample',1],['sample',2],['sample',3]]);
  assert.ok(counters.hooks.every(call => call.durationMs === 1234 && call.samples === 4 && call.warmup === 2));
  assert.equal(report.config.samplingMode, 'hook');
  assert.equal(report.sampling.mode, 'hook');
  assert.equal(report.sampling.stoppedEarly, false);
  assert.equal(report.samples.length, 4);
  assert.equal(report.summary.gpuTimeNs.mean, 2001.5);
  assert.equal(report.summary.fps, null);
  assert.equal(report.summary.frameTimeMsMean, null);
  assert.equal(report.summary.frameTimeMsP95, null);
  assert.equal(report.summary.frameTimeMsMax, null);
  assert.equal(report.summary.cadence, null);
  assert.equal(report.summary.observedFrameCount, 0);
  assert.deepEqual(report.slowFrames, []);
  assert.equal(report.warmup.settled, null);
  assert.equal(report.warmup.lagSpikeMs, null);
  assert.equal(report.warmup.durationMs, 6);
  assert.equal(counters.snapshots.length, 10);
  assert.equal(counters.memorySnapshots.length, 10);
  assert.equal(counters.deepMemory, 10);
  assert.deepEqual(counters.snapshots.at(-1), {includeHistory:true,includeResources:true});
  for (const sample of report.samples) {
    assert.equal(sample.elapsedMs, 3);
    assert.equal(sample.error, null);
    assert.equal(Object.hasOwn(sample.measurement, 'observedFrames'), false);
    assert.equal(sample.memory.delta.performanceMemory.usedJSHeapSize, 10);
    assert.equal(sample.memory.delta.trackedGpuMemoryBytes, 32);
    assert.equal(sample.memory.delta.userAgentSpecificMemoryBytes, 10);
    assert.equal(sample.instrumentation.delta['webgpu.drawCalls'], 2);
  }
});

test('hook sampling retains app-provided metrics and frames without injecting observations', async () => {
  const fixture = hookFixture({hookCode:`async () => ({fps:144, frameTimeMs:{mean:7,p95:8,max:9}, observedFrames:{source:'application',frameCount:7}})`,options:{samples:2,warmup:1}});
  const report = await fixture.run();
  assert.equal(report.summary.fps.mean, 144);
  assert.equal(report.summary.frameTimeMsMean.mean, 7);
  assert.equal(report.summary.observedFrameCount, 14);
  assert.equal(report.warmup.lagSpikeMs, 9);
  assert.deepEqual(report.samples[0].measurement.observedFrames, {source:'application',frameCount:7});
  assert.equal(fixture.context.counters.raf, 0);
});

test('hook sampling wraps primitive and array results without losing zero or adding frame metrics', async () => {
  for (const [expression, expected] of [['0',0],['[0,2]',[0,2]]]) {
    const fixture = hookFixture({hookCode:`async () => (${expression})`,options:{samples:1,warmup:0}});
    const report = await fixture.run();
    assert.deepEqual(report.samples[0].measurement, {value:expected});
    assert.equal(report.summary.fps, null);
    assert.equal(fixture.context.counters.raf, 0);
  }
});

test('hook sampling requires the named hook and rejects incompatible direct options without fallback', async () => {
  const missing = hookFixture({options:{hookName:'runCompute'}});
  await assert.rejects(missing.run(), /samplingMode hook requires benchmark hook runCompute/);
  assert.equal(missing.context.counters.hooks.length, 0);
  assert.equal(missing.context.counters.raf, 0);
  const adaptive = hookFixture({options:{adaptive:true}});
  await assert.rejects(adaptive.run(), /hook.*adaptive/);
  assert.equal(adaptive.context.counters.hooks.length, 0);
  for (const samplingMode of ['fast', '', true, 1]) {
    await assert.rejects(hookFixture({options:{samplingMode}}).run(), /samplingMode.*frames.*hook/);
  }
});

test('hook sampling preserves a failed sample and its memory evidence then stops', async () => {
  const fixture = hookFixture({options:{warmup:0},hookCode:`async config => {
    counters.hooks.push(config); await Promise.resolve(); workload.heap += 10; workload.bytes += 32; workload.draws += 2; clock += 3;
    if (config.sampleIndex === 1) throw new Error('compute dispatch failed');
    return {gpuTimeNs:2000};
  }`});
  const report = await fixture.run();
  assert.equal(report.samples.length, 2);
  assert.equal(fixture.context.counters.hooks.length, 2);
  assert.equal(fixture.context.counters.raf, 0);
  assert.equal(report.samples[1].measurement, null);
  assert.match(report.samples[1].error.message, /compute dispatch failed/);
  assert.equal(report.samples[1].memory.delta.performanceMemory.usedJSHeapSize, 10);
  assert.equal(report.samples[1].instrumentation.delta['webgpu.drawCalls'], 2);
  const { reportValidity } = await import('../src/validity.js');
  const validity = reportValidity({options:fixture.options,inPage:report});
  assert.equal(validity.valid, false);
  assert.ok(validity.issues.some(issue => issue.code === 'sample-errors'));
  assert.ok(validity.issues.some(issue => issue.code === 'incomplete-samples'));
});

test('hook disappearance during warmup is an explicit sample error, never a frames fallback', async () => {
  const fixture = hookFixture({options:{warmup:1,samples:2},hookCode:`async config => {
    counters.hooks.push(config); __gpuReportBench = undefined; return {gpuTimeNs:2000};
  }`});
  const report = await fixture.run();
  assert.equal(report.samples.length, 1);
  assert.match(report.samples[0].error.message, /samplingMode hook requires benchmark hook __gpuReportBench/);
  assert.equal(report.samples[0].measurement, null);
  assert.equal(fixture.context.counters.raf, 0);
});

test('failed warmups abort hook capture and empty hook measurements remain invalid', async () => {
  const failedWarmup = hookFixture({hookCode:`async () => {throw new Error('warmup failed');}`});
  await assert.rejects(failedWarmup.run(), /warmup failed/);
  assert.equal(failedWarmup.context.counters.raf, 0);
  const empty = hookFixture({hookCode:'async () => null',options:{samples:1,warmup:0}});
  const report = await empty.run();
  const { reportValidity } = await import('../src/validity.js');
  assert.equal(reportValidity({options:empty.options,inPage:report}).valid, false);
  assert.equal(report.summary.fps, null);
  assert.equal(empty.context.counters.raf, 0);
});

test('explicit frames mode preserves default capture behavior', async () => {
  assert.deepEqual(await probe('webgpu'), await probe('webgpu',{samplingMode:'frames'}));
});
