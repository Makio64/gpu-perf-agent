import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { autoInstrumentationSource } from "../src/browser/auto-instrument.js";
import { collectInPage } from "../src/injected.js";

// In-page evidence (L1b): GPU/API errors, counting, texture bytes, readiness, activity, heap bracket,
// per-sample deltas, churn sites, LoAF attribution, pooled frame deltas, network overlap and progress.
const PAGE_URL = "http://127.0.0.1:5173/src/app.js";

function mockSource() {
  return `
    clock = 0;
    heapBytes = 1000000;
    performance = { now: () => clock, get memory() { return { usedJSHeapSize: heapBytes, totalJSHeapSize: 2 * heapBytes, jsHeapSizeLimit: 1e9 }; } };
    rafQueue = [];
    requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
    cancelAnimationFrame = () => {};
    pump = (dt = 16) => { clock += dt; const queue = rafQueue; rafQueue = []; for (const callback of queue) callback(clock); };
    log = { stackCaptures: 0, progress: [] };
    class Emitter {
      addEventListener(type, listener) { ((this.listeners ||= {})[type] ||= []).push(listener); }
      emit(type, event) { for (const listener of this.listeners?.[type] || []) listener(event); }
    }
    class FakeView {}
    class FakeTexture { createView() { return new FakeView(); } destroy() {} }
    class FakePass { setPipeline() {} setBindGroup() {} draw() {} drawIndexed() {} drawIndirect() {} drawIndexedIndirect() {} executeBundles(list) { this.executed = list; } end() {} }
    class FakeBundleEncoder { setPipeline() {} draw() {} drawIndexed() {} drawIndirect() {} drawIndexedIndirect() {} finish() { return { bundle: true }; } }
    class FakeEncoder {
      beginRenderPass() { return new FakePass(); }
      beginComputePass() { return { setPipeline() {}, dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {} }; }
      finish() { return {}; }
    }
    class FakeDevice extends Emitter {
      constructor() { super(); this.queue = { submit() {}, writeBuffer() {}, writeTexture() {} }; this.lost = new Promise((resolve) => { this.loseDevice = resolve; }); }
      createBuffer() { return { destroy() {} }; }
      createTexture() { return new FakeTexture(); }
      createSampler() { return {}; }
      createBindGroup() { return {}; }
      createRenderBundleEncoder() { return new FakeBundleEncoder(); }
      createCommandEncoder() { return new FakeEncoder(); }
    }
    class FakeAdapter { constructor() { this.features = new Set(); } async requestDevice() { return new FakeDevice(); } }
    class FakeCanvasContext { getCurrentTexture() { return new FakeTexture(); } configure() {} }
    navigator = { gpu: { async requestAdapter() { return new FakeAdapter(); } }, userAgent: "mock" };
    class FakeGL {
      constructor(canvas) { this.canvas = canvas; }
      getExtension(name) { return name === "WEBGL_lose_context" ? { loseContext() {} } : null; }
      getContextAttributes() { return {}; } getSupportedExtensions() { return []; } getParameter() { return "mock"; }
      bindBuffer() {} bufferData() {} createBuffer() { return {}; } deleteBuffer() {}
      createTexture() { return {}; } deleteTexture() {} bindTexture() {} activeTexture() {}
      texImage2D() {} texImage3D() {} texStorage2D() {} texStorage3D() {} copyTexImage2D() {}
      compressedTexImage2D() {} compressedTexImage3D() {} compressedTexSubImage2D() {} compressedTexSubImage3D() {}
      createRenderbuffer() { return {}; } bindRenderbuffer() {} deleteRenderbuffer() {} renderbufferStorage() {} renderbufferStorageMultisample() {}
      drawArrays() {} drawElements() {} drawArraysInstanced() {} drawElementsInstanced() {} drawRangeElements() {} clear() {}
      getShaderParameter(shader) { return !shader.broken; } getProgramParameter(program) { return !program.broken; }
      getShaderInfoLog() { return "ERROR: 0:12: 'vUv' : undeclared identifier"; } getProgramInfoLog() { return "link failed"; }
      isContextLost() { return false; }
    }
    class HTMLCanvasElement extends Emitter {
      getContext(type) {
        if (type === "webgpu") return this.gpu ||= new FakeCanvasContext();
        return this.gl ||= new FakeGL(this);
      }
      transferControlToOffscreen() { return {}; }
    }
    globalThis.HTMLCanvasElement = HTMLCanvasElement;
    document = { createElement: () => new HTMLCanvasElement() };
    globalThis.Worker = class Worker { constructor(url) { this.url = url; } };
    globalThis.SharedWorker = class SharedWorker { constructor(url) { this.url = url; } };
    const format = (error, frames) => [String(error), ...frames.map((f) =>
      "    at " + (f.getFunctionName() ? f.getFunctionName() + " (" : "") + f.getFileName() + ":" + f.getLineNumber() + ":" + f.getColumnNumber() + (f.getFunctionName() ? ")" : ""))].join("\\n");
    Error.prepareStackTrace = (error, frames) => { log.stackCaptures += 1; return format(error, frames); };
  `;
}

// A context whose rAF callbacks run on a timer, one 16 ms frame at a time (as in a page), with the
// auto-instrumentation installed after the mocks.
function pageContext({ instrument = true, scheduler = true, setup = "" } = {}) {
  const context = vm.createContext({ console, queueMicrotask, clearTimeout, realSetTimeout: setTimeout, setTimeout });
  vm.runInContext(mockSource(), context);
  if (scheduler) {
    vm.runInContext(`
      let scheduled = false;
      stopFrames = false;
      requestAnimationFrame = (callback) => {
        rafQueue.push(callback);
        if (!scheduled && !stopFrames) { scheduled = true; realSetTimeout(() => { scheduled = false; pump(16); }, 0); }
        return rafQueue.length;
      };
      // Frames advance the clock by 16 ms each; wall-clock fallbacks (sample deadlines) stay well behind them.
      setTimeout = (callback, ms) => realSetTimeout(callback, ms >= 50 ? 500 : 0);
    `, context);
  }
  vm.runInContext(setup, context);
  if (instrument) vm.runInContext(autoInstrumentationSource(), context);
  return context;
}

function page(context, code) {
  return vm.runInContext(`(async () => { ${code} })()`, context, { filename: PAGE_URL });
}

async function collect(context, options) {
  try {
    return plain(await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify({ api: "webgpu", warmup: 0, samples: 3, durationMs: 100, ...options })})`, context));
  } finally {
    context.stopFrames = true;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const WEBGPU_LOOP = `
  const adapter = await navigator.gpu.requestAdapter();
  device = await adapter.requestDevice();
  canvasContext = new HTMLCanvasElement().getContext("webgpu");
  render = () => {
    const view = canvasContext.getCurrentTexture().createView();
    const e = device.createCommandEncoder();
    const pass = e.beginRenderPass({ colorAttachments: [{ view }] });
    pass.draw(3);
    pass.end();
    device.queue.submit([e.finish()]);
  };
`;

test("GPU/API errors: uncaptured errors by message, device loss, context loss and shader failures", async () => {
  const context = pageContext({ scheduler: false });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    for (let i = 0; i < 5; i++) device.emit("uncapturederror", { error: { message: "No bind group set at group index 0\\n - While encoding" } });
    device.emit("uncapturederror", { error: { message: "Invalid ShaderModule \\"main\\"" } });
    const destroyed = await (await navigator.gpu.requestAdapter()).requestDevice();
    destroyed.loseDevice({ reason: "destroyed", message: "Device was destroyed." });
    device.loseDevice({ reason: "unknown", message: "GPU process crashed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const canvas = new HTMLCanvasElement();
    const gl = canvas.getContext("webgl2");
    canvas.emit("webglcontextlost", {});
    const shader = { broken: true };
    gl.getShaderParameter(shader, 0x8b81);
    gl.getShaderParameter(shader, 0x8b81);
    gl.getShaderParameter({ broken: false }, 0x8b81);
    gl.getProgramParameter({ broken: true }, 0x8b82);
    gl.getProgramParameter({ broken: true }, 0x8b89);
    return __gpuPerfAutoInstrumentation.snapshot();
  `));
  assert.equal(result.counters["webgpu.uncapturedErrors"], 6);
  assert.deepEqual(result.gpuErrors.top, [
    { message: "No bind group set at group index 0", count: 5 },
    { message: "Invalid ShaderModule \"main\"", count: 1 }
  ]);
  assert.equal(result.gpuErrors.total, 6);
  assert.deepEqual(result.gpuErrors.deviceLost.map((entry) => entry.reason).sort(), ["destroyed", "unknown"]);
  assert.equal(result.counters["webgpu.deviceLost"], 1, "a destroyed device is not counted as lost");
  assert.equal(result.counters["webgl.contextLost"], 1);
  assert.equal(result.gpuErrors.contextLost, 1);
  assert.equal(result.counters["webgl.shaderCompileFailures"], 1, "one failing shader counts once");
  assert.equal(result.counters["webgl.programLinkFailures"], 1);
  assert.deepEqual(result.gpuErrors.shaderFailures, [
    { type: "shader", log: "ERROR: 0:12: 'vUv' : undeclared identifier" },
    { type: "program", log: "link failed" }
  ]);
  assert.deepEqual(result.errors, []);
});

test("uncaptured error messages are bounded at 16 keys with an exact total", async () => {
  const context = pageContext({ scheduler: false });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    for (let i = 0; i < 40; i++) device.emit("uncapturederror", { error: { message: "error " + i + "\\nsecond line" } });
    return __gpuPerfAutoInstrumentation.snapshot().gpuErrors;
  `));
  assert.equal(result.total, 40);
  assert.equal(result.top.length, 3);
  assert.ok(result.top.every((entry) => !entry.message.includes("\n")));
});

test("counting: clears, bundle draws executed, canvas contexts, views, workers and offscreen transfers; probes excluded", async () => {
  const context = pageContext({ scheduler: false });
  const counters = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const bundleEncoder = device.createRenderBundleEncoder({ colorFormats: ["rgba8unorm"] });
    for (let i = 0; i < 3; i++) bundleEncoder.draw(3);
    bundleEncoder.drawIndexed(6);
    const bundle = bundleEncoder.finish();
    executed = [];
    const canvas = new HTMLCanvasElement();
    const gpuContext = canvas.getContext("webgpu");
    canvas.getContext("webgpu");
    for (let frame = 0; frame < 2; frame++) {
      const view = gpuContext.getCurrentTexture().createView();
      const e = device.createCommandEncoder();
      const pass = e.beginRenderPass({ colorAttachments: [{ view }] });
      // A one-shot iterable: the page's own call must still receive both bundles.
      pass.executeBundles((function* () { yield bundle; yield bundle; })());
      executed.push(pass.executed.length);
      pass.draw(3);
      pass.end();
      device.queue.submit([e.finish()]);
    }
    device.createTexture({ size: [4, 4], format: "rgba8unorm" }).createView();
    const gl = new HTMLCanvasElement().getContext("webgl2");
    gl.clear(0x4000);
    gl.clear(0x4000);
    gl.drawArrays(4, 0, 3);
    const probe = new HTMLCanvasElement();
    probe.__gpuPerfAgentProbe = true;
    probe.getContext("webgl2").clear(0x4000);
    probe.getContext("webgpu");
    new Worker("a.js");
    new SharedWorker("b.js");
    new HTMLCanvasElement().transferControlToOffscreen();
    return __gpuPerfAutoInstrumentation.counters();
  `));
  assert.equal(counters["webgpu.bundleDrawCalls"], 4);
  assert.equal(counters["webgpu.bundleDrawsExecuted"], 16, "2 frames x 2 executions x 4 draws");
  assert.equal(counters["webgpu.renderBundles"], 4);
  assert.deepEqual(plain(context.executed), [2, 2]);
  assert.equal(counters["webgpu.drawCalls"], 2, "bundle draws are not API draws");
  assert.equal(counters["webgpu.draw"], 2);
  assert.equal(counters["webgpu.canvasContexts"], 1);
  assert.equal(counters["webgpu.createView"], 3);
  assert.equal(counters["webgpu.createTexture"], 1);
  assert.equal(counters["webgl2.clearCalls"], 2);
  assert.equal(counters["webgl2.drawCalls"], 1);
  assert.equal(counters["webgl2.contexts"], 1, "the probe context is neither patched nor counted");
  assert.equal(counters["page.workers"], 2);
  assert.equal(counters["page.offscreenTransfers"], 1);
  assert.equal(context.Worker.name, "Worker");
  assert.ok(vm.runInContext("new Worker('c.js') instanceof Worker", context));
});

test("hot counters: fixed-shape fields under dotted names, derived totals and reset", async () => {
  const context = pageContext({ scheduler: false });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const e = device.createCommandEncoder();
    const pass = e.beginRenderPass({});
    pass.draw(3); pass.drawIndexed(3); pass.drawIndirect({}, 0); pass.drawIndexedIndirect({}, 0);
    const compute = e.beginComputePass({});
    compute.dispatchWorkgroups(1); compute.dispatchWorkgroupsIndirect({}, 0);
    device.queue.submit([e.finish()]);
    device.queue.writeBuffer({}, 0, new Float32Array(4));
    const before = __gpuPerfAutoInstrumentation.counters();
    __gpuPerfAutoInstrumentation.resetCounters();
    return { before, after: __gpuPerfAutoInstrumentation.counters() };
  `));
  assert.equal(result.before["webgpu.drawCalls"], 4);
  assert.equal(result.before["webgpu.drawIndexed"], 1);
  assert.equal(result.before["webgpu.dispatchCalls"], 2);
  assert.equal(result.before["webgpu.queueSubmits"], 1);
  assert.equal(result.before["webgpu.commandBuffersSubmitted"], 1);
  assert.equal(result.before["webgpu.writeBufferBytes"], 16);
  assert.equal(result.before["webgpu.renderPasses"], 1);
  assert.equal(result.before["webgpu.computePasses"], 1);
  for (const key of ["webgpu.drawCalls", "webgpu.queueSubmits", "webgpu.devices", "webgpu.uncapturedErrors"]) {
    assert.equal(result.after[key], 0, key);
  }
  // Wrappers increment literal fields; the source never builds a counter name per draw.
  assert.doesNotMatch(autoInstrumentationSource(), /increment\(`\$\{api\}\.\$\{method\}`\)|increment\(`webgpu\.\$\{method\}`\)/);
});

test("WebGL texture bytes: texture units, cube faces, compressed blocks and accumulating mips", async () => {
  const context = pageContext({ scheduler: false });
  const result = plain(await page(context, `
    const bytes = () => __gpuPerfAutoInstrumentation.snapshot().resources.byKind.texture?.bytes ?? 0;
    const gl = new HTMLCanvasElement().getContext("webgl2");
    // texunits.html: bind A on unit 0 and B on unit 1, then upload to each without re-binding.
    const A = gl.createTexture(), B = gl.createTexture();
    gl.activeTexture(0x84c0); gl.bindTexture(0x0de1, A);
    gl.activeTexture(0x84c1); gl.bindTexture(0x0de1, B);
    gl.activeTexture(0x84c0);
    gl.texImage2D(0x0de1, 0, 0x8058, 1024, 1024, 0, 0x1908, 0x1401, null);
    gl.activeTexture(0x84c1);
    gl.texImage2D(0x0de1, 0, 0x8058, 4, 4, 0, 0x1908, 0x1401, null);
    const texunits = bytes();
    gl.deleteTexture(A); gl.deleteTexture(B);
    const cube = gl.createTexture();
    gl.bindTexture(0x8513, cube);
    for (let face = 0; face < 6; face++) gl.texImage2D(0x8515 + face, 0, 0x8058, 512, 512, 0, 0x1908, 0x1401, null);
    const cubeBytes = bytes();
    gl.deleteTexture(cube);
    const astc = gl.createTexture();
    gl.bindTexture(0x0de1, astc);
    gl.texStorage2D(0x0de1, 1, 0x93b0, 1024, 1024);
    const astcBytes = bytes();
    gl.compressedTexSubImage2D(0x0de1, 0, 0, 0, 1024, 1024, 0x93b0, new Uint8Array(16));
    const astcAfterSub = bytes();
    gl.deleteTexture(astc);
    const mips = gl.createTexture();
    gl.bindTexture(0x0de1, mips);
    gl.texImage2D(0x0de1, 0, 0x8058, 256, 256, 0, 0x1908, 0x1401, null);
    gl.texImage2D(0x0de1, 1, 0x8058, 128, 128, 0, 0x1908, 0x1401, null);
    gl.texImage2D(0x0de1, 1, 0x8058, 128, 128, 0, 0x1908, 0x1401, null);
    const mipBytes = bytes();
    gl.deleteTexture(mips);
    const dxt = gl.createTexture();
    gl.bindTexture(0x0de1, dxt);
    gl.compressedTexImage2D(0x0de1, 0, 0x83f3, 256, 256, 0, new Uint8Array(65536));
    const dxtBytes = bytes();
    gl.copyTexImage2D(0x0de1, 1, 0x8058, 0, 0, 128, 128, 0);
    const copied = bytes();
    gl.deleteTexture(dxt);
    const array = gl.createTexture();
    gl.bindTexture(0x8c1a, array);
    gl.texStorage3D(0x8c1a, 2, 0x8058, 64, 64, 4);
    const arrayBytes = bytes();
    return { texunits, cubeBytes, astcBytes, astcAfterSub, mipBytes, dxtBytes, copied, arrayBytes };
  `));
  assert.equal(result.texunits, 4194368);
  assert.equal(result.cubeBytes, 6291456);
  assert.equal(result.astcBytes, 1048576);
  assert.equal(result.astcAfterSub, 1048576, "sub-image uploads never change the allocation");
  assert.equal(result.mipBytes, 262144 + 65536, "levels accumulate; re-uploading a level replaces it");
  assert.equal(result.dxtBytes, 65536);
  assert.equal(result.copied, 65536 + 65536);
  assert.equal(result.arrayBytes, (64 * 64 + 32 * 32) * 4 * 4, "array layers do not halve per level");
});

test("readiness: waits for GPU work, then settles; records ready.reason and waitedMs", async () => {
  const context = pageContext();
  await page(context, `${WEBGPU_LOOP}
    let frames = 0;
    const loop = () => { if (++frames > 60) render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const inPage = await collect(context, { readyTimeoutMs: 3000 });
  assert.equal(inPage.ready.reason, "gpu-work");
  assert.ok(inPage.ready.waitedMs >= 900 && inPage.ready.waitedMs <= 1100, String(inPage.ready.waitedMs));
  assert.equal(inPage.hook.found, false);
  assert.ok(inPage.samples.every((sample) => sample.instrumentation.delta["webgpu.drawCalls"] > 0));
  assert.equal(inPage.summary.perFrame.drawCalls, 1);
});

test("readiness: a hook installed late is found after the gate; timeout and disabled are recorded", async () => {
  const late = pageContext();
  await page(late, `
    let frames = 0;
    const loop = () => { if (++frames === 30) globalThis.__gpuReportBench = async () => ({ gpuMs: 1 }); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const found = await collect(late, { readyTimeoutMs: 3000, samples: 1 });
  assert.equal(found.ready.reason, "hook");
  assert.deepEqual(found.hook, { found: true, foundAfterReady: true, name: "__gpuReportBench" });
  assert.equal(found.samples[0].measurement.gpuMs, 1);
  assert.ok(!found.warnings.some((warning) => /No __gpuReportBench hook/.test(warning)));

  const idle = pageContext();
  const timeout = await collect(idle, { readyTimeoutMs: 200, samples: 1 });
  assert.equal(timeout.ready.reason, "timeout");
  assert.ok(timeout.ready.waitedMs >= 200);

  const disabled = await collect(pageContext(), { readyTimeoutMs: 0, samples: 1 });
  assert.equal(disabled.ready.reason, "disabled");

  const plainPage = await collect(pageContext({ instrument: false }), { readyTimeoutMs: 3000, samples: 1 });
  assert.equal(plainPage.ready.reason, "no-instrumentation");
  assert.equal(plainPage.ready.waitedMs, 0);
});

test("idle samples are marked and excluded; activity, perFrame and frame deltas pool the rest", async () => {
  const context = pageContext({ setup: `globalThis.__gpuPerfProgress = (json) => log.progress.push(JSON.parse(json));` });
  await page(context, `${WEBGPU_LOOP}
    paused = false;
    const loop = () => { if (!paused) render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const relay = globalThis.__gpuPerfProgress;
    globalThis.__gpuPerfProgress = (json) => { const event = JSON.parse(json); if (event.stage === "sample-start") paused = event.index === 1; relay(json); };
  `);
  const inPage = await collect(context, { samples: 3, warmup: 1, progress: true });
  assert.deepEqual(inPage.samples.map((sample) => sample.idle), [false, true, false],
    JSON.stringify(inPage.samples.map((sample) => [sample.activity, sample.instrumentation.delta["webgpu.queueSubmits"]])) + JSON.stringify(context.log.progress));
  assert.deepEqual(inPage.summary.activity.idleSampleIndices, [1]);
  // The mock's frames have no duration, so a sample window shares its first frame with the previous one.
  assert.ok(inPage.summary.activity.activeFrameRatio > 0.9, String(inPage.summary.activity.activeFrameRatio));
  assert.equal(inPage.summary.activity.pageFps.count, 2);
  assert.equal(inPage.summary.fps.count, 2, "frame statistics exclude the idle sample");
  assert.equal(inPage.summary.perFrame.drawCalls, 1);
  assert.equal(inPage.summary.perFrame.createView, 1);
  const deltas = inPage.summary.frameDeltasMs;
  const expected = [0, 2].reduce((total, index) => total + inPage.samples[index].measurement.frameTimeMs.count, 0);
  assert.equal(deltas.length, expected);
  assert.ok(deltas.every((delta) => delta === 16));
  const stages = context.log.progress.map((event) => event.index === undefined ? event.stage : `${event.stage}:${event.index}`);
  assert.deepEqual(plain(stages), ["ready", "warmup:0", "sample-start:0", "sample-end:0", "sample-start:1", "sample-end:1",
    "sample-start:2", "sample-end:2", "done"]);
  assert.ok(context.log.progress.every((event) => typeof event.t === "number"));
});

test("samples keep only deltas; the sample key set matches the v3 fixture", async () => {
  const context = pageContext();
  await page(context, `${WEBGPU_LOOP}
    const loop = () => { render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const inPage = await collect(context, { samples: 2 });
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/v3/sample-webgpu.json", import.meta.url), "utf8"));
  const sample = inPage.samples[0];
  const keys = (value) => Object.keys(value).sort();
  // The fixture's sample has no auto GPU timing branch differences here: autoGpu requires timestamp-query.
  assert.deepEqual(keys(sample).filter((key) => key !== "autoGpu"), keys(fixture).filter((key) => key !== "autoGpu"));
  assert.deepEqual(keys(sample.instrumentation), ["delta"]);
  assert.deepEqual(keys(sample.memory), keys(fixture.memory));
  assert.deepEqual(keys(sample.activity), keys(fixture.activity));
  for (const key of Object.keys(fixture.instrumentation.delta)) {
    assert.ok(key in sample.instrumentation.delta, `delta key ${key}`);
  }
  assert.equal(sample.memory.trackedGpuTotalBytes, 0);
  const report = readFileSync(new URL("./fixtures/v3/report-capture.json", import.meta.url), "utf8");
  const fixtureInPage = JSON.parse(report).inPage;
  for (const key of ["ready", "hook", "warmup", "memory", "instrumentation"]) {
    assert.deepEqual(keys(inPage[key]), keys(fixtureInPage[key]), key);
  }
  for (const key of ["activity", "perFrame", "churnSites", "gpuErrors", "offMainThread", "appGpuContexts", "frameDeltasMs"]) {
    assert.ok(key in inPage.summary, key);
  }
  assert.deepEqual(keys(inPage.summary.perFrame), keys(fixtureInPage.summary.perFrame));
  assert.deepEqual(keys(inPage.summary.gpuErrors), keys(fixtureInPage.summary.gpuErrors));
  assert.deepEqual(inPage.summary.appGpuContexts, { webgpuDevices: 1, webgpuCanvasContexts: 1, webgl2: 0, webgl: 0 });
  assert.deepEqual(inPage.summary.offMainThread, { workers: 0, offscreenTransfers: 0 });
  assert.deepEqual(inPage.instrumentation.errors, []);
  assert.deepEqual(keys(inPage.config), keys(fixtureInPage.config));
});

test("errors in the warmup+sampling window are separated from earlier ones", async () => {
  const context = pageContext();
  await page(context, `${WEBGPU_LOOP}
    device.emit("uncapturederror", { error: { message: "startup error" } });
    let frames = 0;
    const loop = () => { render(); if (++frames === 20) device.emit("uncapturederror", { error: { message: "frame error" } }); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const inPage = await collect(context, { samples: 3, warmup: 1 });
  const errors = inPage.summary.gpuErrors;
  assert.equal(errors.total, 2);
  assert.equal(errors.inWindow, 1);
  assert.equal(inPage.instrumentation.warmupStartCounters["webgpu.uncapturedErrors"], 1);
  assert.deepEqual(errors.top.map((entry) => entry.message).sort(), ["frame error", "startup error"]);
});

test("retained heap: gc() twice on both ends of the sampling window, outside the timed samples", async () => {
  const context = pageContext({ setup: `gcCalls = 0; gc = () => { gcCalls += 1; };` });
  await page(context, `${WEBGPU_LOOP}
    const loop = () => { render(); heapBytes += 100; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const inPage = await collect(context, { samples: 2 });
  const retained = inPage.memory.retained;
  assert.equal(retained.available, true);
  assert.equal(retained.method, "gc-bracket");
  assert.equal(retained.deltaBytes, retained.afterBytes - retained.beforeBytes);
  assert.ok(retained.deltaBytes > 0 && retained.windowMs > 0);
  assert.equal(context.gcCalls, 4);
  const without = await collect(pageContext(), { samples: 1 });
  assert.deepEqual(without.memory.retained, { available: false, method: "unavailable", reason: "gc-unavailable" });
});

test("churn: steady-state creations get per-frame rates and sampled call sites; setup creations do not", async () => {
  const churning = pageContext();
  await page(churning, `${WEBGPU_LOOP}
    for (let i = 0; i < 25; i++) device.createBindGroup({});
    function makeFrameBindGroups() { for (let i = 0; i < 20; i++) device.createBindGroup({}); }
    const loop = () => { makeFrameBindGroups(); render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const inPage = await collect(churning, { samples: 3, warmup: 1 });
  assert.equal(inPage.summary.perFrame.createBindGroup, 20);
  assert.equal(inPage.summary.perFrame.nonZeroSamples.createBindGroup, 3);
  const sites = inPage.summary.churnSites.createBindGroup;
  assert.match(sites[0].site, /^makeFrameBindGroups src\/app\.js:\d+$/);
  assert.ok(sites[0].count > 0);

  const steady = pageContext();
  await page(steady, `${WEBGPU_LOOP}
    for (let i = 0; i < 25; i++) device.createBindGroup({});
    const loop = () => { render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const clean = await collect(steady, { samples: 3, warmup: 1 });
  assert.equal(clean.summary.perFrame.createBindGroup, 0);
  assert.equal(clean.summary.perFrame.nonZeroSamples.createBindGroup, 0);
  assert.equal(clean.summary.churnSites.createBindGroup, undefined);
});

test("churn sampling stays within 16 stack captures per frame at 1000 creations per frame", async () => {
  const context = pageContext({ scheduler: false });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    __gpuPerfAutoInstrumentation.beginSteadyState();
    const perFrame = [];
    function churn() { for (let i = 0; i < 1000; i++) device.createBindGroup({}); }
    for (let frame = 0; frame < 40; frame++) {
      const before = log.stackCaptures;
      churn();
      perFrame.push(log.stackCaptures - before);
      pump();
    }
    return { perFrame, sites: __gpuPerfAutoInstrumentation.snapshot().churnSites };
  `));
  assert.ok(Math.max(...result.perFrame) <= 16, JSON.stringify(result.perFrame));
  const estimate = result.sites.createBindGroup[0].count;
  assert.ok(estimate > 40000 * 0.5 && estimate < 40000 * 1.5, `scaled count ${estimate} for 40000 calls`);
});

test("LoAF: slow frames get the overlapping long-animation-frame entry without tool scripts", async () => {
  const context = pageContext({ setup: `
    class PerformanceObserver {
      static supportedEntryTypes = ["long-animation-frame"];
      constructor(callback) { this.callback = callback; this.pending = []; loafObserver = this; }
      observe(options) { this.type = options.type; }
      takeRecords() { const records = this.pending; this.pending = []; return records; }
      disconnect() { this.disconnected = true; }
    }
    globalThis.PerformanceObserver = PerformanceObserver;
    loafObserver = null;
  ` });
  await page(context, `${WEBGPU_LOOP}
    let frames = 0;
    function frame() {
      render();
      if (++frames === 20) {
        const start = clock;
        clock += 64;
        loafObserver?.pending.push({ startTime: start - 2, duration: 70, blockingDuration: 21, styleAndLayoutStart: start + 67.6,
          scripts: [
            { sourceURL: "gpu-perf-agent/collect.js", sourceFunctionName: "frame", duration: 69 },
            { sourceURL: "${PAGE_URL}", sourceFunctionName: "frame", sourceCharPosition: 2037, duration: 52 }
          ] });
        loafObserver?.pending.push({ startTime: start + 400, duration: 55, blockingDuration: 5, scripts: [] });
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  `);
  const inPage = await collect(context, { samples: 3, slowFrameThresholdMs: 20 });
  const slow = inPage.slowFrames.find((entry) => entry.frameDurationMs > 60);
  assert.ok(slow, JSON.stringify(inPage.slowFrames));
  assert.deepEqual(slow.loaf, {
    durationMs: 70, blockingMs: 21, styleLayoutMs: 0.4,
    scripts: [{ fn: "frame", url: PAGE_URL, charPosition: 2037, durationMs: 52 }]
  });
  assert.ok(inPage.slowFrames.every((entry) => !entry.loaf || entry.loaf.scripts.every((script) => !script.url?.startsWith("gpu-perf-agent/"))));
  assert.equal(context.loafObserver.disconnected, true);
});

test("network overlap: warmup continues until the runner's idle flag, bounded by a page-side hard cap", async () => {
  const context = pageContext();
  await page(context, `${WEBGPU_LOOP}
    let frames = 0;
    const loop = () => { render(); if (++frames === 50) globalThis.__gpuPerfNetworkIdle = true; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const inPage = await collect(context, { samples: 1, warmup: 1, durationMs: 100, waitNetworkIdle: true, networkIdleBudgetMs: 10000 });
  assert.equal(inPage.warmup.networkIdle, "overlapped");
  assert.ok(inPage.warmup.extendedForNetworkMs > 0);
  assert.ok(inPage.warmup.durationMs >= 600, String(inPage.warmup.durationMs));

  const capped = pageContext();
  await page(capped, `${WEBGPU_LOOP}
    const loop = () => { render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const cap = await collect(capped, { samples: 1, warmup: 0, waitNetworkIdle: true, networkIdleBudgetMs: 200 });
  assert.equal(cap.warmup.networkIdle, "page-cap");
  assert.ok(cap.warmup.extendedForNetworkMs <= 1300, String(cap.warmup.extendedForNetworkMs));

  const early = pageContext({ setup: `globalThis.__gpuPerfNetworkIdle = "budget-exceeded";` });
  await page(early, `${WEBGPU_LOOP}
    const loop = () => { render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  `);
  const exceeded = await collect(early, { samples: 1, warmup: 1, waitNetworkIdle: true });
  assert.equal(exceeded.warmup.networkIdle, "budget-exceeded");
  assert.equal(exceeded.warmup.extendedForNetworkMs, 0);

  const off = await collect(early, { samples: 1, warmup: 1 });
  assert.equal(off.warmup.networkIdle, "not-requested");
});
