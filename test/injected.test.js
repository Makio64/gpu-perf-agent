import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { collectInPage } from '../src/injected.js';

async function probe(api, {adapterError = false, glError = false, frames = true, hook = true} = {}) {
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
  const report = await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify({api, samples:1, warmup:0, durationMs:20})})`, context);
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
