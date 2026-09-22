import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateWebGLTextureBytes,
  estimateWebGPUTextureBytes,
  trackWebGL2Context,
  trackWebGPUDevice,
  webGPUFormatLayout
} from "../src/browser/allocation-tracker.js";

test("WebGPU texture estimates handle mips, arrays, samples, and 3D depth", () => {
  assert.equal(estimateWebGPUTextureBytes({
    format: "rgba8unorm",
    mipLevelCount: 2,
    size: [4, 4, 1]
  }), 80);
  assert.equal(estimateWebGPUTextureBytes({
    format: "rgba16float",
    sampleCount: 4,
    size: { depthOrArrayLayers: 2, height: 8, width: 8 }
  }), 4096);
  assert.equal(estimateWebGPUTextureBytes({
    dimension: "3d",
    format: "r8unorm",
    mipLevelCount: 3,
    size: [8, 8, 8]
  }), 584);
});

test("WebGPU compressed texture estimates use block dimensions", () => {
  assert.deepEqual(webGPUFormatLayout("bc1-rgba-unorm"), {
    blockHeight: 4,
    blockWidth: 4,
    bytesPerBlock: 8
  });
  assert.equal(estimateWebGPUTextureBytes({ format: "bc1-rgba-unorm", size: [5, 5, 1] }), 32);
  assert.equal(estimateWebGPUTextureBytes({ format: "astc-8x8-unorm", size: [9, 9, 1] }), 64);
});

test("trackWebGPUDevice tracks and releases buffers and textures", () => {
  const created = [];
  const device = {
    createBuffer(descriptor) {
      const value = { descriptor, destroy() {} };
      created.push(value);
      return value;
    },
    createTexture(descriptor) {
      const value = { descriptor, destroy() {} };
      created.push(value);
      return value;
    }
  };
  const tracker = trackWebGPUDevice(device);
  const buffer = device.createBuffer({ size: 1024 });
  device.createTexture({ format: "rgba8unorm", size: [4, 4] });
  assert.equal(tracker.snapshot().totalBytes, 1088);
  assert.equal(tracker.snapshot().byKind.texture.count, 1);
  buffer.destroy();
  buffer.destroy();
  assert.equal(tracker.snapshot().totalBytes, 64);
});

test("trackWebGL2Context handles typed buffer data and both texImage2D overloads", () => {
  const gl = mockWebGL2();
  const tracker = trackWebGL2Context(gl);
  const buffer = gl.createBuffer();
  gl.bindBuffer(0x8892, buffer);
  gl.bufferData(0x8892, new Float32Array(16), 0x88e4);
  const texture = gl.createTexture();
  gl.bindTexture(0x0de1, texture);
  gl.texImage2D(0x0de1, 0, 0x8058, 8, 4, 0, 0x1908, 0x1401, null);
  assert.equal(tracker.snapshot().byKind.buffer.bytes, 64);
  assert.equal(tracker.snapshot().byKind.texture.bytes, 128);
  gl.texImage2D(0x0de1, 0, 0x8058, 0x1908, 0x1401, { width: 2, height: 3 });
  assert.equal(tracker.snapshot().byKind.texture.bytes, 24);
  gl.deleteTexture(texture);
  assert.equal(tracker.snapshot().byKind.texture, undefined);
});

test("WebGL texture estimates understand sized formats and mips", () => {
  assert.equal(estimateWebGLTextureBytes(4, 4, 0x8814, 0x1406, 1), 256);
  assert.equal(estimateWebGLTextureBytes(4, 4, 0x8058, 0x1401, 3), 84);
});

function mockWebGL2() {
  return {
    bindBuffer() {},
    bindTexture() {},
    bufferData() {},
    createBuffer() { return {}; },
    createTexture() { return {}; },
    deleteBuffer() {},
    deleteTexture() {},
    texImage2D() {},
    texStorage2D() {}
  };
}

test('manual tracker maintains totals across updates and does not expose mutable internals', async()=>{
  const {createTracker}=await import('../src/browser/allocation-tracker.js');
  const tracker=createTracker('test',{includeResources:true,history:true,historyLimit:3});
  const object={};
  const id=tracker.attach(object,{bytes:8,kind:'buffer',descriptor:{size:8}});
  assert.equal(tracker.attach(object,{bytes:16,kind:'buffer',descriptor:{size:16}}),id);
  assert.equal(tracker.attach(null,{bytes:0,kind:'buffer'}),null);
  const before=tracker.snapshot();
  before.byKind.buffer.bytes=999;
  before.liveResources[0].bytes=999;
  before.liveResources[0].descriptor.size=999;
  before.history[1].patch.bytes=999;
  assert.equal(tracker.snapshot().totalBytes,16);
  assert.equal(tracker.snapshot().liveResources[0].descriptor.size,16);
  assert.equal(tracker.snapshot().history[1].patch.bytes,16);
  tracker.update(id,{bytes:32,kind:'texture'});
  assert.deepEqual(tracker.snapshot().byKind,{texture:{bytes:32,count:1}});
  tracker.releaseAttached(object);tracker.release(id);
  assert.equal(tracker.snapshot().totalBytes,0);
  assert.equal(tracker.snapshot().totalResources,0);
  assert.deepEqual(tracker.snapshot().history.map(e=>e.type),['update','update','release']);
});

test('manual tracker caps resource detail and supports cheap summary snapshots',async()=>{
  const {createTracker}=await import('../src/browser/allocation-tracker.js');
  const tracker=createTracker('test',{includeResources:true,resourceLimit:2,history:true,historyLimit:0});
  for(let i=0;i<10;i++)tracker.track({bytes:8,kind:'buffer'});
  const detailed=tracker.snapshot();
  assert.equal(detailed.totalBytes,80);assert.equal(detailed.liveResources.length,2);assert.equal(detailed.truncatedResources,8);
  assert.equal(detailed.history.length,0);
  const compact=tracker.snapshot({includeResources:false,includeHistory:false});
  assert.equal(compact.totalResources,10);assert.equal(compact.liveResources.length,0);assert.equal(compact.history,undefined);
  assert.throws(()=>tracker.update(1,{bytes:NaN}),/finite/);
  assert.equal(tracker.snapshot().totalBytes,80);
});

test('WebGL buffer range overloads are forwarded and counted in elements',()=>{
  const gl=mockWebGL2();let args;
  gl.bufferData=(...values)=>{args=values;};
  const tracker=trackWebGL2Context(gl);
  const buffer=gl.createBuffer();gl.bindBuffer(0x8892,buffer);
  const data=new Float32Array(20);
  gl.bufferData(0x8892,data,0x88e4,4,6);
  assert.equal(args.length,5);assert.equal(args[3],4);assert.equal(args[4],6);
  assert.equal(tracker.snapshot().totalBytes,24);
  gl.bufferData(0x8892,data,0x88e4,4,0);
  assert.equal(tracker.snapshot().totalBytes,64);
});

test('rectangular texture mips preserve bytes per pixel down to 1x1',()=>{
  assert.equal(estimateWebGLTextureBytes(8,1,0x8058,0x1401,4),60);
  assert.equal(estimateWebGLTextureBytes(3,5,0x8058,0x1401,3),72);
  assert.equal(estimateWebGLTextureBytes(0,5,0x8058,0x1401,1),0);
});
