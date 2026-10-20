import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { autoInstrumentationSource, installAutoInstrumentation } from "../src/browser/auto-instrument.js";

test("autoInstrumentationSource is a self-contained browser script", async () => {
  const context = vm.createContext({ console, performance });
  vm.runInContext(mockBrowserSource(), context);
  vm.runInContext(autoInstrumentationSource({ includeResources: true }), context);
  const result = await vm.runInContext(`(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const buffer = device.createBuffer({ label: "vertices", size: 256 });
    device.createTexture({ format: "rgba8unorm", size: [4, 4, 1] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({});
    pass.draw(3);
    device.queue.submit([encoder.finish()]);
    const gl = new HTMLCanvasElement().getContext("webgl2");
    const glBuffer = gl.createBuffer();
    gl.bindBuffer(0x8892, glBuffer);
    gl.bufferData(0x8892, 128, 0x88e4);
    gl.drawArrays(4, 0, 3);
    const beforeDestroy = __gpuReportInstrumentation.snapshot();
    buffer.destroy();
    return { beforeDestroy, afterDestroy: __gpuReportInstrumentation.snapshot() };
  })()`, context);

  assert.equal(result.beforeDestroy.resources.totalBytes, 448);
  assert.equal(result.beforeDestroy.resources.byKind.buffer.count, 2);
  assert.equal(result.beforeDestroy.counters["webgpu.drawCalls"], 1);
  assert.equal(result.beforeDestroy.counters["webgpu.queueSubmits"], 1);
  assert.equal(result.beforeDestroy.counters["webgl2.drawCalls"], 1);
  assert.equal(result.afterDestroy.resources.totalBytes, 192);
});

test("installAutoInstrumentation is idempotent", () => {
  const original = globalThis.__gpuPerfAutoInstrumentation;
  const marker = { version: 2 };
  globalThis.__gpuPerfAutoInstrumentation = marker;
  try {
    assert.equal(installAutoInstrumentation(), marker);
  } finally {
    if (original === undefined) {
      delete globalThis.__gpuPerfAutoInstrumentation;
    } else {
      globalThis.__gpuPerfAutoInstrumentation = original;
    }
  }
});

function mockBrowserSource() {
  return `
    class FakePass {
      draw() {}
      drawIndexed() {}
      drawIndirect() {}
      drawIndexedIndirect() {}
      executeBundles() {}
    }
    class FakeEncoder {
      beginRenderPass() { return new FakePass(); }
      beginComputePass() { return { dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {} }; }
      finish() { return {}; }
    }
    class FakeDevice {
      constructor() { this.queue = { submit() {}, writeBuffer() {}, writeTexture() {} }; }
      createBuffer() { return { destroy() {} }; }
      createTexture() { return { destroy() {} }; }
      createCommandEncoder() { return new FakeEncoder(); }
    }
    class FakeAdapter { async requestDevice() { return new FakeDevice(); } }
    class FakeGPU { async requestAdapter() { return new FakeAdapter(); } }
    navigator = { gpu: new FakeGPU() };
    const fakeGL = {
      bindBuffer() {}, bindTexture() {}, bufferData() {},
      createBuffer() { return {}; }, createTexture() { return {}; }, createRenderbuffer() { return {}; },
      deleteBuffer() {}, deleteTexture() {}, deleteRenderbuffer() {}, drawArrays() {}, drawElements() {},
      drawArraysInstanced() {}, drawElementsInstanced() {}, drawRangeElements() {},
      renderbufferStorage() {}, renderbufferStorageMultisample() {}, bindRenderbuffer() {},
      texImage2D() {}, texImage3D() {}, texStorage2D() {}, texStorage3D() {}
    };
    class HTMLCanvasElement { getContext() { return fakeGL; } }
    globalThis.HTMLCanvasElement = HTMLCanvasElement;
  `;
}

test('resource totals handle reallocations and release; history is bounded and ordered', async () => {
  const context = vm.createContext({ performance });
  vm.runInContext(mockBrowserSource(), context);
  vm.runInContext(autoInstrumentationSource({ historyLimit: 3, includeResources: true }), context);
  const result = await vm.runInContext(`(async () => {
    const gl = new HTMLCanvasElement().getContext('webgl2');
    const b = gl.createBuffer();
    gl.bindBuffer(0x8892, b);
    gl.bufferData(0x8892, 64, 0x88e4);
    const initial = __gpuReportInstrumentation.snapshot();
    initial.resources.byKind.buffer.bytes = 999;
    initial.resources.liveResources[0].bytes = 999;
    gl.bufferData(0x8892, 128, 0x88e4);
    const resized = __gpuReportInstrumentation.snapshot({ includeHistory: false, includeResources: false });
    gl.deleteBuffer(b);
    gl.deleteBuffer(b);
    return { resized, final: __gpuReportInstrumentation.snapshot() };
  })()`, context);
  assert.equal(result.resized.resources.totalBytes, 128);
  assert.equal(result.resized.resources.byKind.buffer.bytes, 128);
  assert.equal(result.resized.resources.history.length, 0);
  assert.equal(result.resized.resources.liveResources.length, 0);
  assert.equal(result.final.resources.totalBytes, 0);
  assert.equal(result.final.resources.totalResources, 0);
  assert.deepEqual(Array.from(result.final.resources.history, e => e.type), ['update', 'update', 'release']);
});

test('historyLimit zero disables history retention', async () => {
  const context = vm.createContext({ performance });
  vm.runInContext(mockBrowserSource(), context);
  vm.runInContext(autoInstrumentationSource({ historyLimit: 0 }), context);
  const result = await vm.runInContext(`(async () => {
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    for (let i=0; i<100; i++) device.createBuffer({size:16});
    return __gpuReportInstrumentation.snapshot();
  })()`, context);
  assert.equal(result.resources.totalBytes, 1600);
  assert.equal(result.resources.history.length, 0);
});

test('encoders and passes share wrappers across frames without owning closures', async () => {
  const context = vm.createContext({ performance });
  vm.runInContext(mockBrowserSource(), context);
  vm.runInContext(autoInstrumentationSource(), context);
  const result = await vm.runInContext(`(async () => {
    const d = await (await navigator.gpu.requestAdapter()).requestDevice();
    const a = d.createCommandEncoder(), b = d.createCommandEncoder();
    const p = a.beginRenderPass({}), q = b.beginRenderPass({});
    p.draw(3); q.drawIndexed(6);
    return { encoderOwn: Object.hasOwn(a, 'beginRenderPass'), passOwn: Object.hasOwn(p, 'draw'),
      same: p.draw === q.draw, counters: __gpuReportInstrumentation.snapshot().counters };
  })()`, context);
  assert.equal(result.encoderOwn, false);
  assert.equal(result.passOwn, false);
  assert.equal(result.same, true);
  assert.equal(result.counters['webgpu.drawCalls'], 2);
});

test('automatic upload counters respect source offsets and element lengths',async()=>{
  const context=vm.createContext({performance});
  vm.runInContext(mockBrowserSource(),context);
  vm.runInContext(autoInstrumentationSource({includeResources:true}),context);
  const result=await vm.runInContext(`(async()=>{
    const device=await(await navigator.gpu.requestAdapter()).requestDevice();
    const buffer=device.createBuffer({size:128});
    device.queue.writeBuffer(buffer,0,new Float32Array(20),2,4);
    device.queue.writeBuffer(buffer,0,new Uint16Array(20),2);
    const gl=new HTMLCanvasElement().getContext('webgl2');
    gl.bindBuffer(0x8892,gl.createBuffer());
    gl.bufferData(0x8892,new Float32Array(20),0x88e4,4,6);
    return __gpuReportInstrumentation.snapshot();
  })()`,context);
  assert.equal(result.counters['webgpu.writeBufferBytes'],52);
  assert.equal(result.resources.byApi.webgl2.bytes,24);
  assert.equal(result.resources.liveResources.find(r=>r.api==='webgl2').descriptor.usage,0x88e4);
});

// ---- Automatic GPU timing (frame ledger, WebGPU pass timer, WebGL frame timer) ----

import { existsSync, readFileSync } from "node:fs";
import { collectInPage } from "../src/injected.js";

const PAGE_URL = "http://127.0.0.1:5173/src/app.js";

// A WebGPU/WebGL mock that executes timestampWrites, resolveQuerySet and copyBufferToBuffer on submit,
// with a manually pumped requestAnimationFrame. `schedule(passIndex, descriptor)` returns [beginNs, endNs].
function timingMockSource() {
  return `
    clock = 0;
    performance = { now: () => clock };
    rafQueue = [];
    glTicks = 0;
    requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
    cancelAnimationFrame = () => {};
    pump = (dt = 16) => { clock += dt; glTicks += 1; const queue = rafQueue; rafQueue = []; for (const callback of queue) callback(clock); };
    GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 0x200 };
    GPUMapMode = { READ: 1 };
    gpuLog = { buffers: [], querySets: [], requested: [], mapCalls: 0, stackCaptures: 0 };
    mapBehavior = () => "resolve";
    nextTimestamp = 1000;
    schedule = (passIndex) => { const begin = nextTimestamp; nextTimestamp += 2000; return [begin, begin + 1000]; };
    class FakeQuerySet { constructor(d) { Object.assign(this, d); this.values = new BigUint64Array(d.count); gpuLog.querySets.push(this); } destroy() {} }
    class FakeBuffer {
      constructor(d) { Object.assign(this, d); this.data = new BigUint64Array(Math.ceil(d.size / 8)); this.maps = 0; this.copiesInto = 0; gpuLog.buffers.push(this); }
      mapAsync() {
        gpuLog.mapCalls += 1; this.maps += 1;
        const behavior = mapBehavior(this);
        if (behavior === "hold") return new Promise(() => {});
        if (behavior === "reject") return Promise.reject(new Error("map failed"));
        return Promise.resolve();
      }
      getMappedRange(offset = 0, size) { return this.data.buffer.slice(offset, offset + (size ?? this.data.byteLength)); }
      unmap() {}
      destroy() {}
    }
    class FakeRenderPass { setPipeline(p) {} setBindGroup() {} draw() {} drawIndexed() {} drawIndirect() {} drawIndexedIndirect() {} executeBundles() {} end() {} }
    class FakeComputePass { setPipeline(p) {} setBindGroup() {} dispatchWorkgroups() {} dispatchWorkgroupsIndirect() {} end() {} }
    class FakeEncoder {
      constructor() { this.commands = []; }
      beginRenderPass(d) { this.commands.push({ type: "pass", d }); return new FakeRenderPass(); }
      beginComputePass(d) { this.commands.push({ type: "pass", d }); return new FakeComputePass(); }
      resolveQuerySet(qs, first, count, dst, offset) { this.commands.push({ type: "resolve", qs, first, count, dst, offset }); }
      copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) { this.commands.push({ type: "copy", src, srcOffset, dst, dstOffset, size }); }
      clearBuffer() {} copyBufferToTexture() {} copyTextureToBuffer() {} copyTextureToTexture() {} writeTimestamp() {}
      finish() { return { commands: this.commands }; }
    }
    class FakeQueue {
      constructor() { this.passIndex = 0; this.submitted = 0; }
      submit(list) {
        for (const cb of list) {
          this.submitted += 1;
          // A failed submit (validation error) executes nothing.
          if (cb.fail) continue;
          for (const c of cb.commands) {
            if (c.type === "pass" && c.d?.timestampWrites) {
              const w = c.d.timestampWrites;
              const [begin, end] = schedule(this.passIndex++, c.d);
              w.querySet.values[w.beginningOfPassWriteIndex] = BigInt(begin);
              w.querySet.values[w.endOfPassWriteIndex] = BigInt(end);
            } else if (c.type === "resolve") {
              for (let i = 0; i < c.count; i++) c.dst.data[c.offset / 8 + i] = c.qs.values[c.first + i];
            } else if (c.type === "copy") {
              c.dst.copiesInto += 1;
              for (let i = 0; i < c.size / 8; i++) c.dst.data[c.dstOffset / 8 + i] = c.src.data[c.srcOffset / 8 + i];
            }
          }
        }
      }
      writeBuffer() {} writeTexture() {}
    }
    class FakeDevice {
      constructor(features) { this.features = new Set(features); this.queue = new FakeQueue(); }
      createBuffer(d) { return new FakeBuffer(d); }
      createTexture() { return { destroy() {} }; }
      createQuerySet(d) { return new FakeQuerySet(d); }
      createCommandEncoder() { return new FakeEncoder(); }
      createRenderPipeline(d) { return { label: d.label ?? "" }; }
      createComputePipeline(d) { return { label: d.label ?? "" }; }
      async createRenderPipelineAsync(d) { return { label: d.label ?? "" }; }
      createShaderModule(d) { return { label: d.label ?? "" }; }
      createBindGroupLayout(d) { return { label: d.label ?? "" }; }
      createBindGroup() { return {}; }
    }
    adapterFeatures = ["timestamp-query"];
    class FakeAdapter {
      constructor() { this.features = new Set(adapterFeatures); }
      async requestDevice(d) { gpuLog.requested.push(d); return new FakeDevice(d?.requiredFeatures || []); }
    }
    navigator = { gpu: { async requestAdapter() { return new FakeAdapter(); } }, userAgent: "mock" };
    queryId = 0;
    class FakeGL {
      constructor() { this.active = null; this.disjoint = false; this.lost = false; this.nextResult = 5000; this.resultDelay = 1; this.begins = 0; this.noExt = false; }
      getExtension(name) {
        if (name === "EXT_disjoint_timer_query_webgl2" && !this.noExt) return { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
        if (name === "WEBGL_lose_context") return { loseContext: () => { this.lost = true; } };
        return null;
      }
      createQuery() { return { id: ++queryId }; }
      deleteQuery(q) { q.deleted = true; }
      beginQuery(target, q) { if (this.active) throw new Error("INVALID_OPERATION: a query is active"); this.active = q; q.ended = false; this.begins += 1; }
      endQuery() { if (!this.active) throw new Error("INVALID_OPERATION: no active query"); const q = this.active; q.ended = true; q.endedAt = glTicks; q.result = this.nextResult; this.active = null; }
      getQuery() { return this.active; }
      getQueryParameter(q, pname) { return pname === 0x8867 ? q.ended && glTicks - q.endedAt >= this.resultDelay : q.result; }
      getParameter(pname) { return pname === 0x8fbb ? this.disjoint : "mock"; }
      isContextLost() { return this.lost; }
      getContextAttributes() { return {}; } getSupportedExtensions() { return []; }
      bindBuffer() {} bindTexture() {} bufferData() {} createBuffer() { return {}; } createTexture() { return {}; }
      createRenderbuffer() { return {}; } deleteBuffer() {} deleteTexture() {} deleteRenderbuffer() {} bindRenderbuffer() {}
      drawArrays() {} drawElements() {} drawArraysInstanced() {} drawElementsInstanced() {} drawRangeElements() {} clear() {}
      renderbufferStorage() {} renderbufferStorageMultisample() {} texImage2D() {} texImage3D() {} texStorage2D() {} texStorage3D() {}
    }
    // Forces the batched timestamp resolve, then lets the mapAsync promises settle.
    drain = async () => { await __gpuPerfAutoInstrumentation.frames.flush(0); await new Promise((resolve) => setTimeout(resolve, 0)); };
    globalThis.HTMLCanvasElement = class HTMLCanvasElement { getContext() { return this.gl ||= new FakeGL(); } };
    document = { createElement: () => new HTMLCanvasElement() };
  `;
}

function timingContext(options = {}) {
  const context = vm.createContext({ console, queueMicrotask, setTimeout, clearTimeout });
  vm.runInContext(timingMockSource(), context);
  vm.runInContext(autoInstrumentationSource(options), context);
  return context;
}

// Runs page code with a realistic script URL so call sites parse like Chrome's.
function page(context, code) {
  return vm.runInContext(`(async () => { ${code} })()`, context, { filename: PAGE_URL });
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("auto GPU timing: union, exclusive time and pass keys for overlapping passes", async () => {
  const context = timingContext();
  await page(context, `
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    // The compute pass really takes ~45 ns, but its end timestamp lands after the render pass began.
    schedule = (i) => (i % 2 === 0 ? [base + 1000, base + 9000] : [base + 1050, base + 9050]);
    base = 100000;
    frame = () => {
      const encoder = device.createCommandEncoder();
      const sim = encoder.beginComputePass({ label: "sim" });
      sim.setPipeline(device.createComputePipeline({ label: "sim-pipeline" }));
      sim.end();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      base += 1e6;
    };
  `);
  context.pump();
  for (let index = 0; index < 10; index += 1) {
    vm.runInContext("frame()", context);
    context.pump();
    await settle();
  }
  const result = plain(await page(context, `
    await drain();
    return __gpuPerfAutoInstrumentation.frames.window(0, clock);
  `));
  const gpu = result.autoGpu;
  assert.equal(gpu.status, "ok");
  assert.equal(gpu.source, "webgpu-timestamp");
  assert.equal(gpu.timedFrames, 10);
  assert.equal(gpu.frameNs.p50, 8050);
  assert.ok(gpu.frameNs.p50 < gpu.sumNs.p50);
  assert.equal(gpu.sumNs.p50, 16000);
  assert.equal(gpu.spanNs.p50, 8050);
  const sim = gpu.passes.find((pass) => pass.key === "sim");
  const render = gpu.passes.find((pass) => pass.key === "render#0");
  assert.equal(sim.exclusiveP50Ns, 50);
  assert.equal(sim.durationP50Ns, 8000);
  assert.equal(sim.overlapped, true);
  assert.equal(sim.pipeline, "sim-pipeline");
  assert.equal(sim.label, "sim");
  assert.equal(render.label, null);
  assert.equal(render.count, 10);
  assert.match(render.site, /src\/app\.js:\d+$/);
  assert.equal(result.activity.ticks, 11);
  assert.equal(result.activity.activeTicks, 10);
  // resolve/copy go through the unwrapped methods: page counters stay exact.
  const counters = vm.runInContext("__gpuPerfAutoInstrumentation.counters()", context);
  assert.equal(counters["webgpu.resolveQuerySet"], undefined);
  assert.equal(counters["webgpu.copyBufferToBuffer"], undefined);
  assert.equal(counters["webgpu.renderPasses"], 10);
});

test("auto GPU timing: sequential passes give union = sum and exclusive = duration", async () => {
  const context = timingContext();
  await page(context, `
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    frame = () => {
      const encoder = device.createCommandEncoder();
      for (let i = 0; i < 3; i++) encoder.beginRenderPass({}).end();
      device.queue.submit([encoder.finish()]);
    };
  `);
  context.pump();
  for (let index = 0; index < 4; index += 1) {
    vm.runInContext("frame()", context);
    context.pump();
    await settle();
  }
  await page(context, "await drain();");
  const gpu = plain(vm.runInContext("__gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu", context));
  assert.equal(gpu.frameNs.p50, 3000);
  assert.equal(gpu.sumNs.p50, 3000);
  assert.equal(gpu.spanNs.p50, 5000);
  assert.equal(gpu.overlapRatio, 1);
  assert.equal(gpu.idleGapRatio, 1.667);
  assert.deepEqual(gpu.passes.map((pass) => [pass.key, pass.exclusiveP50Ns, pass.overlapped]), [
    ["render#0", 1000, false], ["render#1", 1000, false], ["render#2", 1000, false]
  ]);
});

test("auto GPU timing: resolves are batched in one tool command buffer per 30 ticks, outside page counters", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const submitted = () => device.queue.submitted;
    pump();
    const trace = [];
    for (let i = 0; i < 31; i++) {
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      const cb = e.finish();
      trace.push(cb.commands.length);
      device.queue.submit([cb]);
      pump();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { pageCommands: Array.from(new Set(trace)), submitted: submitted(), maps: gpuLog.mapCalls,
      gpu: __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu, counters: __gpuPerfAutoInstrumentation.counters() };
  `));
  // The page's command buffers hold only their own pass; the tool adds one submit for the batch.
  assert.deepEqual(result.pageCommands, [1]);
  assert.equal(result.submitted, 32);
  assert.equal(result.maps, 1);
  assert.equal(result.gpu.timedFrames, 31);
  assert.equal(result.gpu.pending, 0);
  assert.equal(result.counters["webgpu.queueSubmits"], 31);
  assert.equal(result.counters["webgpu.commandEncoders"], 31);
});

test("auto GPU timing: page-supplied timestampWrites are kept and mark the frame partial", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const own = device.createQuerySet({ type: "timestamp", count: 2 });
    const pageWrites = { querySet: own, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    const descriptor = { label: "page-timed", timestampWrites: pageWrites };
    pump();
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass(descriptor).end();
    encoder.beginRenderPass({ label: "tool-timed" }).end();
    const cb = encoder.finish();
    device.queue.submit([cb]);
    pump();
    await drain();
    const pagePass = cb.commands[0].d;
    return {
      sameDescriptor: pagePass === descriptor, sameWrites: pagePass.timestampWrites === pageWrites,
      pageValues: Array.from(own.values, String),
      gpu: __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu
    };
  `));
  assert.equal(result.sameDescriptor, true);
  assert.equal(result.sameWrites, true);
  assert.notDeepEqual(result.pageValues, ["0", "0"]);
  assert.equal(result.gpu.partialFrames, 1);
  assert.equal(result.gpu.partialReasons["page-timed-pass"], 1);
  assert.equal(result.gpu.frameNs, null);
  assert.equal(result.gpu.status, "no-frames");
  // The tool-timed pass of a partial frame keeps its per-pass data.
  assert.deepEqual(result.gpu.passes.map((pass) => pass.key), ["tool-timed"]);
});

test("auto GPU timing: frozen descriptors work and are never mutated", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const features = Object.freeze(["depth-clip-control"]);
    const deviceDescriptor = Object.freeze({ requiredFeatures: features });
    const device = await (await navigator.gpu.requestAdapter()).requestDevice(deviceDescriptor);
    const pipelineDescriptor = Object.freeze({ layout: "auto", vertex: Object.freeze({}) });
    const makePipeline = () => device.createRenderPipeline(pipelineDescriptor);
    const pipeline = makePipeline();
    const shader = device.createShaderModule(Object.freeze({ code: "" }));
    const labelled = device.createRenderPipeline(Object.freeze({ label: "mine" }));
    const asyncPipeline = await device.createRenderPipelineAsync(Object.freeze({}));
    const passDescriptor = Object.freeze({ colorAttachments: Object.freeze([]) });
    pump();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass(passDescriptor);
    pass.setPipeline(pipeline);
    pass.end();
    const cb = encoder.finish();
    device.queue.submit([cb]);
    return {
      requested: gpuLog.requested[0], sameRequest: gpuLog.requested[0] === deviceDescriptor,
      features: Array.from(features), deviceDescriptorKeys: Object.keys(deviceDescriptor),
      passDescriptorKeys: Object.keys(passDescriptor), pipelineDescriptorKeys: Object.keys(pipelineDescriptor),
      pipelineLabel: pipeline.label, shaderLabel: shader.label, labelled: labelled.label, asyncLabel: asyncPipeline.label,
      timedCopy: cb.commands[0].d !== passDescriptor && Boolean(cb.commands[0].d.timestampWrites)
    };
  `));
  assert.equal(result.sameRequest, false);
  assert.deepEqual(new Set(result.requested.requiredFeatures), new Set(["depth-clip-control", "timestamp-query"]));
  assert.deepEqual(result.features, ["depth-clip-control"]);
  assert.deepEqual(result.deviceDescriptorKeys, ["requiredFeatures"]);
  assert.deepEqual(result.passDescriptorKeys, ["colorAttachments"]);
  assert.deepEqual(result.pipelineDescriptorKeys, ["layout", "vertex"]);
  assert.match(result.pipelineLabel, /^pipeline@makePipeline src\/app\.js:\d+$/);
  assert.match(result.shaderLabel, /^shader@src\/app\.js:\d+$/);
  assert.equal(result.labelled, "mine");
  assert.match(result.asyncLabel, /^pipeline@/);
  assert.equal(result.timedCopy, true);
});

test("auto GPU timing: tool buffers and query sets never count as page VRAM", async () => {
  const context = timingContext({ includeResources: true });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const afterDevice = __gpuReportInstrumentation.snapshot().resources.totalBytes;
    device.createBuffer({ size: 256 });
    mapBehavior = () => "hold";
    pump();
    // 40 timed command buffers in one frame exhaust the first 32-slot set and force an extra one.
    for (let i = 0; i < 40; i++) {
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({}).end();
      device.queue.submit([encoder.finish()]);
    }
    const snapshot = __gpuReportInstrumentation.snapshot();
    return { afterDevice, total: snapshot.resources.totalBytes, buffers: snapshot.resources.byKind.buffer.count,
      querySets: gpuLog.querySets.length, created: gpuLog.buffers.length };
  `));
  assert.equal(result.afterDevice, 0);
  assert.equal(result.total, 256);
  assert.equal(result.buffers, 1);
  assert.equal(result.querySets, 2);
  // One page buffer, one resolve buffer per slot set and one pooled readback buffer (32-slot batch).
  assert.equal(result.created, 1 + 2 + 1);
});

test("auto GPU timing: begin=0 and end<begin invalidate the command buffer", async () => {
  for (const pair of [[0, 500], [9000, 8000]]) {
    const context = timingContext();
    const gpu = plain(await page(context, `
      const device = await (await navigator.gpu.requestAdapter()).requestDevice();
      schedule = () => ${JSON.stringify(pair)};
      pump();
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({}).end();
      device.queue.submit([encoder.finish()]);
      pump();
      await drain();
      return __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu;
    `));
    assert.equal(gpu.partialReasons["invalid-timestamps"], 1, String(pair));
    assert.equal(gpu.timedFrames, 0);
    assert.equal(gpu.frameNs, null);
    assert.deepEqual(gpu.passes, []);
  }
});

test("auto GPU timing: a failed submit leaves stale timestamps, which are invalid", async () => {
  const context = timingContext();
  const gpu = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    schedule = () => [5000, 6000];
    pump();
    const submit = (fail) => {
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({}).end();
      const cb = encoder.finish();
      cb.fail = fail;
      device.queue.submit([cb]);
    };
    submit(false);
    pump();
    await drain();
    // Cycle the other 31 slots (finished, never submitted) so the next encoder reuses the first slot.
    for (let i = 0; i < 31; i++) { const e = device.createCommandEncoder(); e.beginRenderPass({}).end(); e.finish(); }
    pump();
    submit(true);
    pump();
    await drain();
    return __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu;
  `));
  assert.equal(gpu.timedFrames, 1);
  assert.equal(gpu.partialReasons["invalid-timestamps"], 1);
});

test("auto GPU timing: frames without a submit are no-work frames, never partial", async () => {
  const context = timingContext();
  await page(context, `
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    frame = () => { const e = device.createCommandEncoder(); e.beginRenderPass({}).end(); device.queue.submit([e.finish()]); };
  `);
  context.pump();
  for (let index = 0; index < 12; index += 1) {
    if (index % 2 === 0) vm.runInContext("frame()", context);
    context.pump();
    await settle();
  }
  await page(context, "await drain();");
  const result = plain(vm.runInContext("__gpuPerfAutoInstrumentation.frames.window(0, clock)", context));
  assert.equal(result.autoGpu.frames, 13);
  assert.equal(result.autoGpu.workFrames, 6);
  assert.equal(result.autoGpu.noWorkFrames, 7);
  assert.equal(result.autoGpu.timedFrames, 6);
  assert.equal(result.autoGpu.partialFrames, 0);
  assert.equal(result.autoGpu.frameNs.count, 6);
  assert.equal(result.activity.activeFrameRatio, 0.462);
  assert.equal(vm.runInContext("__gpuPerfAutoInstrumentation.frames.sawGpuWork()", context), true);
});

test("auto GPU timing: a reading slot is never reclaimed; abandoned recording slots are", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    let first = true;
    mapBehavior = () => { const held = first; first = false; return held ? "hold" : "resolve"; };
    pump();
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({}).end();
    const heldCommandBuffer = encoder.finish();
    const heldWrites = heldCommandBuffer.commands[0].d.timestampWrites;
    device.queue.submit([heldCommandBuffer]);
    await __gpuPerfAutoInstrumentation.frames.flush(0);
    const heldBuffer = gpuLog.buffers.at(-1);
    // 500 ticks of normal frames: each takes a slot, is resolved in a batch, read and freed.
    for (let i = 0; i < 500; i++) {
      pump();
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      device.queue.submit([e.finish()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await drain();
    // Abandon every free slot (recording, never finished), then age them past 120 ticks.
    const abandoned = [];
    for (let i = 0; i < 32 * 5 - 1; i++) {
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      abandoned.push(e);
    }
    const abandonedTimed = abandoned.filter((e) => e.commands[0].d.timestampWrites).length;
    for (let i = 0; i < 121; i++) pump();
    const reclaimStart = clock;
    const late = device.createCommandEncoder();
    late.beginRenderPass({}).end();
    const lateWrites = late.finish().commands[0].d.timestampWrites;
    // Exactly one abandoned owner lost its slot; its late submit marks the frame partial.
    device.queue.submit(abandoned.map((e) => e.finish()));
    pump();
    await drain();
    const flushed = await __gpuPerfAutoInstrumentation.frames.flush(0);
    return {
      heldMaps: heldBuffer.maps, flushed, abandonedTimed,
      lateReusesHeld: lateWrites.querySet === heldWrites.querySet && lateWrites.beginningOfPassWriteIndex === heldWrites.beginningOfPassWriteIndex,
      all: __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu,
      reclaimed: __gpuPerfAutoInstrumentation.frames.window(reclaimStart, clock).autoGpu,
      errors: __gpuReportInstrumentation.snapshot().errors
    };
  `));
  assert.equal(result.heldMaps, 1);
  assert.equal(result.abandonedTimed, 159);
  assert.equal(result.lateReusesHeld, false);
  assert.equal(result.flushed, false);
  assert.equal(result.all.pending, 1);
  assert.equal(result.reclaimed.partialReasons["slot-reclaimed"], 1);
  assert.deepEqual(result.errors, []);
});

test("auto GPU timing: a rejected mapAsync is a timer-error, never an instrumentation error", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    mapBehavior = () => "reject";
    pump();
    for (let i = 0; i < 3; i++) {
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      device.queue.submit([e.finish()]);
      pump();
    }
    await drain();
    return { gpu: __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu, errors: __gpuReportInstrumentation.snapshot().errors };
  `));
  assert.equal(result.gpu.partialReasons["timer-error"], 3);
  assert.equal(result.gpu.status, "no-frames");
  assert.deepEqual(result.errors, []);
});

test("auto GPU timing: a pass key captures its call site once, not per pass", async () => {
  const context = timingContext();
  vm.runInContext(`
    const format = (error, frames) => [String(error), ...frames.map((f) =>
      "    at " + (f.getFunctionName() ? f.getFunctionName() + " (" : "") + f.getFileName() + ":" + f.getLineNumber() + ":" + f.getColumnNumber() + (f.getFunctionName() ? ")" : ""))].join("\\n");
    Error.prepareStackTrace = (error, frames) => { gpuLog.stackCaptures += 1; return format(error, frames); };
  `, context);
  const captures = await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const before = gpuLog.stackCaptures;
    for (let i = 0; i < 20; i++) {
      pump();
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      e.beginComputePass({ label: "sim" }).end();
      device.queue.submit([e.finish()]);
    }
    return gpuLog.stackCaptures - before;
  `);
  assert.equal(captures, 2);
});

test("auto GPU timing: sample output key set matches the v3 fixture", async () => {
  const context = timingContext();
  await page(context, `
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    frame = () => { const e = device.createCommandEncoder(); e.beginRenderPass({}).end(); device.queue.submit([e.finish()]); };
  `);
  context.pump();
  for (let index = 0; index < 3; index += 1) {
    vm.runInContext("frame()", context);
    context.pump();
    await settle();
  }
  await page(context, "await drain();");
  const result = plain(vm.runInContext("__gpuPerfAutoInstrumentation.frames.window(0, clock)", context));
  const fixturePath = new URL("./fixtures/v3/sample-webgpu.json", import.meta.url);
  const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : null;
  const expected = fixture?.autoGpu ?? {
    status: 0, source: 0, frames: 0, workFrames: 0, noWorkFrames: 0, timedFrames: 0, partialFrames: 0, pending: 0,
    partialReasons: { "page-timed-pass": 0, "no-slot": 0, "slot-reclaimed": 0, "invalid-timestamps": 0, disjoint: 0, unresolved: 0, "timer-error": 0 },
    frameNs: { count: 0, p50: 0, p95: 0, mean: 0, min: 0, max: 0 }, sumNs: { p50: 0, p95: 0 }, spanNs: { p50: 0, p95: 0 },
    overlapRatio: 0, idleGapRatio: 0,
    passes: [{ key: 0, type: 0, label: 0, count: 0, exclusiveP50Ns: 0, durationP50Ns: 0, overlapped: 0, site: 0, appSite: 0, pipeline: 0 }]
  };
  const keys = (value) => Object.keys(value).sort();
  assert.deepEqual(keys(result.autoGpu), keys(expected));
  for (const field of ["partialReasons", "frameNs", "sumNs", "spanNs"]) {
    assert.deepEqual(keys(result.autoGpu[field]), keys(expected[field]), field);
  }
  assert.deepEqual(keys(result.autoGpu.passes[0]), keys(expected.passes[0]));
  if (fixture?.activity) assert.deepEqual(keys(result.activity), keys(fixture.activity));
});

test("auto GPU timing: gpuTiming false skips the feature, timestampWrites, GL queries and autoGpu", async () => {
  const context = timingContext({ gpuTiming: false });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice({});
    pump();
    const e = device.createCommandEncoder();
    e.beginRenderPass({}).end();
    const cb = e.finish();
    device.queue.submit([cb]);
    const gl = new HTMLCanvasElement().getContext("webgl2");
    gl.drawArrays(4, 0, 3);
    pump();
    gl.clear(0x4000);
    pump();
    return { requested: gpuLog.requested[0], writes: Boolean(cb.commands[0].d.timestampWrites), glBegins: gl.begins,
      window: __gpuPerfAutoInstrumentation.frames.window(0, clock) };
  `));
  assert.deepEqual(result.requested, {});
  assert.equal(result.writes, false);
  assert.equal(result.glBegins, 0);
  assert.equal(result.window.autoGpu, null);
  assert.equal(result.window.activity.activeTicks, 2);
});

test("auto GPU timing: unsupported adapters report status unsupported", async () => {
  const context = timingContext();
  context.adapterFeatures = [];
  const gpu = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    pump();
    const e = device.createCommandEncoder();
    e.beginRenderPass({}).end();
    device.queue.submit([e.finish()]);
    pump();
    return __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu;
  `));
  assert.equal(gpu.status, "unsupported");
  assert.equal(gpu.workFrames, 1);
});

test("WebGL frame timer: per-frame TIME_ELAPSED, no-work discard, disjoint, page queries and probes", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const probe = new HTMLCanvasElement();
    probe.__gpuPerfAgentProbe = true;
    const probeGL = probe.getContext("webgl2");
    const gl = new HTMLCanvasElement().getContext("webgl2");
    pump();
    for (let i = 0; i < 6; i++) {
      gl.nextResult = 8000 + i;
      if (i % 3 !== 2) gl.drawArrays(4, 0, 3);
      pump();
    }
    pump(); pump();
    const clean = __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu;
    const cleanEnd = clock;
    gl.drawArrays(4, 0, 3);
    pump();
    gl.disjoint = true;
    gl.clear(0x4000);
    pump();
    gl.disjoint = false;
    pump(); pump();
    const disjoint = __gpuPerfAutoInstrumentation.frames.window(cleanEnd, clock).autoGpu;
    const pageStart = clock;
    const own = gl.createQuery();
    gl.drawArrays(4, 0, 3);
    gl.beginQuery(0x88bf, own);
    const current = gl.getQuery(0x88bf, 0x8865);
    gl.endQuery(0x88bf);
    pump();
    gl.drawArrays(4, 0, 3);
    pump(); pump();
    return {
      clean, disjoint, page: __gpuPerfAutoInstrumentation.frames.window(pageStart, clock).autoGpu,
      currentIsPage: current === own, probeBegins: probeGL.begins,
      counters: __gpuPerfAutoInstrumentation.counters()
    };
  `));
  assert.equal(result.clean.source, "webgl-time-elapsed");
  assert.equal(result.clean.workFrames, 4);
  assert.equal(result.clean.timedFrames, 4);
  assert.equal(result.clean.pending, 0);
  assert.deepEqual([result.clean.frameNs.min, result.clean.frameNs.max], [8000, 8004]);
  assert.deepEqual(result.clean.passes.map((pass) => pass.key), ["gl-frame#0"]);
  assert.equal(result.disjoint.partialReasons.disjoint, 2);
  assert.equal(result.page.partialReasons["page-timed-pass"], 2);
  assert.equal(result.currentIsPage, true);
  assert.equal(result.probeBegins, 0);
  assert.equal(result.counters["webgl2.contexts"], 1);
  assert.equal(result.counters["webgl2.clearCalls"], 1);
});

test("collectInPage attaches per-sample autoGpu/activity beside measurement and pools summary.autoGpu", async () => {
  const context = vm.createContext({ console, queueMicrotask, clearTimeout });
  vm.runInContext(timingMockSource(), context);
  // A frame scheduler: rAF callbacks run on a timer, one 16 ms frame at a time.
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
  `, Object.assign(context, { realSetTimeout: setTimeout }));
  vm.runInContext(autoInstrumentationSource(), context);
  await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const loop = () => {
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      e.beginComputePass({ label: "sim" }).end();
      device.queue.submit([e.finish()]);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  `);
  const inPage = plain(await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify({ api: "webgpu", samples: 2, warmup: 0, durationMs: 100 })})`, context));
  context.stopFrames = true;
  for (const sample of inPage.samples) {
    assert.equal(sample.autoGpu.status, "ok");
    assert.ok(sample.autoGpu.timedFrames >= 4);
    assert.equal(sample.autoGpu.frameNs.p50, 2000);
    assert.ok(sample.activity.ticks >= 4);
    assert.equal(sample.measurement.autoGpu, undefined);
    assert.equal(sample.measurement.gpuTimeNs, undefined);
  }
  const summary = inPage.summary.autoGpu;
  assert.deepEqual(Object.keys(summary), ["status", "source", "frames", "workFrames", "noWorkFrames", "timedFrames",
    "partialFrames", "frameNs", "perSampleP50Ns", "overlapRatio", "idleGapRatio", "passes"]);
  assert.deepEqual(summary.perSampleP50Ns, [2000, 2000]);
  assert.equal(summary.timedFrames, inPage.samples[0].autoGpu.timedFrames + inPage.samples[1].autoGpu.timedFrames);
  assert.deepEqual(summary.passes.map((pass) => pass.key).sort(), ["render#0", "sim"]);
  assert.deepEqual(inPage.instrumentation.after.errors, []);
});

test("autoInstrumentationSource and collectInPageExpression carry tool sourceURLs", async () => {
  const { collectInPageExpression } = await import("../src/injected.js");
  assert.match(autoInstrumentationSource({ gpuTiming: false }), /\n\/\/# sourceURL=gpu-perf-agent\/instrument\.js$/);
  assert.match(collectInPageExpression({ samples: 1 }), /^\(async function collectInPage[\s\S]*\(\{"samples":1\}\)\n\/\/# sourceURL=gpu-perf-agent\/collect\.js$/);
});

test("auto GPU timing: page wrappers of createBuffer, submit and encoder methods never see the tool", async () => {
  const context = timingContext({ includeResources: true });
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    let pageBytes = 0;
    let pageSubmits = 0;
    let pageResolves = 0;
    // Like allocation-tracker.js and a submit hook: instance wrappers installed after requestDevice.
    const create = device.createBuffer.bind(device);
    device.createBuffer = (descriptor) => { pageBytes += descriptor.size; return create(descriptor); };
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (list) => { pageSubmits += 1; return submit(list); };
    // A prototype wrapper installed after the tool wrapped the encoder prototype.
    const prototype = Object.getPrototypeOf(device.createCommandEncoder());
    const resolve = prototype.resolveQuerySet;
    prototype.resolveQuerySet = function (...args) { pageResolves += 1; return resolve.apply(this, args); };
    device.createBuffer({ size: 256 });
    pump();
    for (let i = 0; i < 31; i++) {
      if (i % 2 === 0) {
        const e = device.createCommandEncoder();
        e.beginRenderPass({}).end();
        device.queue.submit([e.finish()]);
      }
      pump();
      await new Promise((r) => setTimeout(r, 0));
    }
    await drain();
    const counters = __gpuPerfAutoInstrumentation.counters();
    return { pageBytes, pageSubmits, pageResolves, tracked: __gpuReportInstrumentation.snapshot().resources.totalBytes,
      submits: counters["webgpu.queueSubmits"], resolves: counters["webgpu.resolveQuerySet"], mapCalls: gpuLog.mapCalls,
      gpu: __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu };
  `));
  assert.equal(result.pageBytes, 256);
  assert.equal(result.tracked, 256);
  assert.equal(result.pageSubmits, 16);
  assert.equal(result.submits, 16);
  assert.equal(result.pageResolves, 0);
  assert.equal(result.resolves, undefined);
  assert.equal(result.mapCalls, 1);
  assert.equal(result.gpu.timedFrames, 16);
  assert.equal(result.gpu.partialFrames, 0);
});

test("auto GPU timing: page code called from collect.js keeps its own call sites and labels", async () => {
  const context = timingContext();
  await page(context, `
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    globalThis.benchmarkHook = function appHook() {
      const pipeline = device.createRenderPipeline({ layout: "auto" });
      const e = device.createCommandEncoder();
      const pass = e.beginRenderPass({});
      pass.setPipeline(pipeline);
      pass.end();
      device.queue.submit([e.finish()]);
      return pipeline.label;
    };
  `);
  context.pump();
  // The benchmark hook is called by collectInPage, whose frames carry the tool's sourceURL.
  const label = vm.runInContext("(function collectInPage() { return benchmarkHook(); })()", context, { filename: "gpu-perf-agent/collect.js" });
  context.pump();
  await page(context, "await drain();");
  const [pass] = plain(vm.runInContext("__gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu.passes", context));
  assert.match(label, /^pipeline@appHook src\/app\.js:\d+$/);
  assert.match(pass.site, /^appHook src\/app\.js:\d+$/);
  assert.equal(pass.appSite, pass.site);
  assert.equal(pass.pipeline, label);
});

test("auto GPU timing: retained windows outlive the pass rings and the ledger; lost frames are flagged truncated", async () => {
  const context = timingContext();
  await page(context, `
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    frame = () => { const e = device.createCommandEncoder(); e.beginRenderPass({ label: "main" }).end(); device.queue.submit([e.finish()]); };
    run = async (count) => {
      const start = clock;
      for (let i = 0; i < count; i++) {
        frame();
        pump();
        if (i % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await drain();
      return [start, clock];
    };
  `);
  context.pump();
  const result = plain(await page(context, `
    const frames = __gpuPerfAutoInstrumentation.frames;
    const kept = await run(16);
    const keptNow = frames.window(kept[0], kept[1], true).autoGpu;
    const lost = await run(16);
    const early = frames.framesSince(kept[0]);
    await run(4200);
    const late = await run(16);
    return { keptNow, early, capacity: frames.capacity,
      kept: frames.window(kept[0], kept[1]).autoGpu, lost: frames.window(lost[0], lost[1]).autoGpu,
      pooled: frames.windows([kept, late]).autoGpu };
  `));
  assert.equal(result.early, 32);
  assert.equal(result.capacity, 1024);
  assert.equal(result.kept.status, "ok");
  assert.equal(result.kept.timedFrames, 16);
  assert.deepEqual(result.kept.passes.map((pass) => [pass.key, pass.count]), [["main", 16]]);
  assert.equal(result.kept.truncated, undefined);
  assert.deepEqual(result.kept, result.keptNow);
  assert.equal(result.lost.truncated, true);
  assert.equal(result.lost.timedFrames, 0);
  assert.equal(result.pooled.timedFrames, 32);
  assert.equal(result.pooled.passes[0].count, 32);
  assert.equal(result.pooled.truncated, undefined);
});

test("collectInPage retains sample windows mid-run when a fixed run outgrows the pass rings", async () => {
  const context = vm.createContext({ console, queueMicrotask, clearTimeout });
  vm.runInContext(timingMockSource(), context);
  vm.runInContext(`
    let scheduled = false;
    stopFrames = false;
    requestAnimationFrame = (callback) => {
      rafQueue.push(callback);
      if (!scheduled && !stopFrames) { scheduled = true; realSetTimeout(() => { scheduled = false; pump(16); }, 0); }
      return rafQueue.length;
    };
    setTimeout = (callback, ms) => realSetTimeout(callback, ms >= 50 ? 2000 : 0);
  `, Object.assign(context, { realSetTimeout: setTimeout }));
  vm.runInContext(autoInstrumentationSource(), context);
  await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const loop = () => {
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      e.beginComputePass({ label: "sim" }).end();
      device.queue.submit([e.finish()]);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  `);
  // 3 x ~375 frames: the first sample's frames leave the 1024-frame pass rings before the loop ends.
  const inPage = plain(await vm.runInContext(`(${collectInPage.toString()})(${JSON.stringify({ api: "webgpu", samples: 3, warmup: 0, durationMs: 6000 })})`, context));
  context.stopFrames = true;
  for (const sample of inPage.samples) {
    assert.equal(sample.autoGpu.status, "ok");
    assert.equal(sample.autoGpu.truncated, undefined);
    assert.ok(sample.autoGpu.timedFrames >= 300, String(sample.autoGpu.timedFrames));
    assert.deepEqual(sample.autoGpu.passes.map((pass) => pass.key).sort(), ["render#0", "sim"]);
  }
  const summary = inPage.summary.autoGpu;
  assert.equal(summary.timedFrames, inPage.samples.reduce((total, sample) => total + sample.autoGpu.timedFrames, 0));
  assert.equal(summary.passes.find((pass) => pass.key === "sim").count, summary.timedFrames);
  assert.equal(summary.truncated, undefined);
});

test("auto GPU timing: an encoder whose slot was reclaimed cannot write into the new owner's slot", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    pump();
    const stale = device.createCommandEncoder();
    stale.beginRenderPass({}).end();
    const others = [];
    for (let i = 0; i < 32 * 5 - 1; i++) {
      const e = device.createCommandEncoder();
      e.beginRenderPass({}).end();
      others.push(e);
    }
    for (let i = 0; i < 121; i++) pump();
    const ownerStart = clock;
    const owner = device.createCommandEncoder();
    owner.beginRenderPass({}).end();
    const ownerWrites = owner.commands[0].d.timestampWrites;
    const staleWrites = stale.commands[0].d.timestampWrites;
    // The stale encoder starts another pass after losing its slot to the owner.
    stale.beginRenderPass({}).end();
    device.queue.submit([owner.finish()]);
    pump();
    const ownerEnd = clock;
    device.queue.submit([stale.finish()]);
    pump();
    await drain();
    const frames = __gpuPerfAutoInstrumentation.frames;
    return {
      sameSlot: ownerWrites.querySet === staleWrites.querySet && ownerWrites.beginningOfPassWriteIndex === staleWrites.beginningOfPassWriteIndex,
      staleSecondTimed: Boolean(stale.commands[1].d.timestampWrites),
      owner: frames.window(ownerStart, ownerEnd).autoGpu, stale: frames.window(ownerEnd, clock).autoGpu
    };
  `));
  assert.equal(result.sameSlot, true);
  assert.equal(result.staleSecondTimed, false);
  assert.equal(result.owner.timedFrames, 1);
  assert.equal(result.owner.sumNs.p50, 1000);
  assert.deepEqual(result.owner.passes.map((pass) => pass.count), [1]);
  assert.equal(result.stale.partialReasons["slot-reclaimed"], 1);
});

test("auto GPU timing: untimed work beside timed work is partial; a lost GL context is no longer timed", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const gl1 = new HTMLCanvasElement().getContext("webgl");
    pump();
    const e = device.createCommandEncoder();
    e.beginRenderPass({}).end();
    device.queue.submit([e.finish()]);
    gl1.drawArrays(4, 0, 3);
    pump();
    await drain();
    const mixed = __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu;
    const gl = new HTMLCanvasElement().getContext("webgl2");
    gl.lost = true;
    pump();
    gl.lost = false;
    const restoredStart = clock;
    for (let i = 0; i < 3; i++) { gl.drawArrays(4, 0, 3); pump(); }
    pump(); pump();
    return { mixed, restored: __gpuPerfAutoInstrumentation.frames.window(restoredStart, clock).autoGpu, begins: gl.begins };
  `));
  assert.equal(result.mixed.partialReasons.unresolved, 1);
  assert.equal(result.mixed.timedFrames, 0);
  assert.equal(result.mixed.frameNs, null);
  assert.equal(result.restored.workFrames, 3);
  assert.equal(result.restored.status, "unsupported");
  assert.equal(result.begins, 1);
});

test("WebGL frame timer: a context whose query methods cannot be patched stays untimed without instrumentation errors", async () => {
  const context = timingContext();
  const result = plain(await page(context, `
    const canvas = new HTMLCanvasElement();
    canvas.gl = new FakeGL();
    Object.defineProperty(canvas.gl, "beginQuery", { value: FakeGL.prototype.beginQuery, writable: false, configurable: false });
    const gl = canvas.getContext("webgl2");
    pump();
    gl.drawArrays(4, 0, 3);
    pump(); pump();
    return { errors: __gpuReportInstrumentation.snapshot().errors, begins: gl.begins,
      gpu: __gpuPerfAutoInstrumentation.frames.window(0, clock).autoGpu };
  `));
  assert.deepEqual(result.errors, []);
  assert.equal(result.begins, 0);
  assert.equal(result.gpu.status, "unsupported");
  assert.deepEqual(result.gpu.passes, []);
});
