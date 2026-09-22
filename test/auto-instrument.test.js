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
  const marker = { version: 1 };
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
