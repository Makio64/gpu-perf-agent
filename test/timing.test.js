import assert from "node:assert/strict";
import test from "node:test";
import { createBatchedWebGPUTimer, createWebGPUTimer, requestTimedWebGPUDevice } from "../src/browser/timing.js";

test("requestTimedWebGPUDevice requests timestamp-query when available", async () => {
  let requested;
  const adapter = {
    features: new Set(["timestamp-query"]),
    async requestDevice(descriptor) {
      requested = descriptor;
      return timestampDevice();
    }
  };
  const result = await withGPUConstants(() => requestTimedWebGPUDevice(adapter, { requiredFeatures: ["depth-clip-control"] }));
  assert.equal(result.timestampQueryAvailable, true);
  assert.deepEqual(new Set(requested.requiredFeatures), new Set(["depth-clip-control", "timestamp-query"]));
  assert.ok(result.timer);
});

test("createBatchedWebGPUTimer assigns query pairs and reads once", async () => {
  const device = timestampDevice([100n, 160n, 200n, 350n]);
  const timer = await withGPUConstants(() => createBatchedWebGPUTimer(device, { capacity: 2 }));
  assert.deepEqual(timer.timestampWrites("shadow"), {
    beginningOfPassWriteIndex: 0,
    endOfPassWriteIndex: 1,
    querySet: device.querySet
  });
  assert.equal(timer.timestampWrites("main").beginningOfPassWriteIndex, 2);
  assert.throws(() => timer.timestampWrites("overflow"), /capacity exceeded/);
  const encoder = commandEncoder();
  assert.equal(timer.resolve(encoder), 2);
  const measurements = await withGPUConstants(() => timer.read());
  assert.deepEqual(measurements.map((item) => ({ durationNs: item.durationNs, label: item.label })), [
    { durationNs: 60, label: "shadow" },
    { durationNs: 150, label: "main" }
  ]);
  assert.equal(timer.count, 0);
  assert.equal(encoder.resolved, 4);
  assert.equal(encoder.copiedBytes, 32);
});

test("createWebGPUTimer exposes batched timing and rejects unsupported devices", async () => {
  const unsupported = { features: new Set() };
  assert.equal(createWebGPUTimer(unsupported), null);
  const device = timestampDevice();
  const timer = await withGPUConstants(() => createWebGPUTimer(device));
  assert.equal(typeof timer.createBatch, "function");
});

function timestampDevice(values = [0n, 0n]) {
  const bytes = new BigUint64Array(values).buffer;
  const device = {
    features: new Set(["timestamp-query"]),
    queue: { onSubmittedWorkDone: async () => {}, submit() {} },
    createBuffer(descriptor) {
      if (descriptor.usage === 10) {
        return { destroy() {} };
      }
      return {
        async mapAsync() {},
        destroy() {},
        getMappedRange() { return bytes; },
        unmap() {}
      };
    },
    createCommandEncoder() { return commandEncoder(); },
    createQuerySet() {
      const querySet = { destroy() {} };
      device.querySet = querySet;
      return querySet;
    }
  };
  return device;
}

function commandEncoder() {
  return {
    copiedBytes: 0,
    resolved: 0,
    finish() { return {}; },
    beginRenderPass() { return {end(){}}; },
    beginComputePass() { return {end(){}}; },
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, bytes) {
      this.copiedBytes = bytes;
    },
    resolveQuerySet(querySet, first, count) {
      this.resolved = count;
    }
  };
}

async function withGPUConstants(callback) {
  const previousBufferUsage = globalThis.GPUBufferUsage;
  const previousMapMode = globalThis.GPUMapMode;
  globalThis.GPUBufferUsage = { COPY_DST: 1, COPY_SRC: 2, MAP_READ: 4, QUERY_RESOLVE: 8 };
  globalThis.GPUMapMode = { READ: 1 };
  try {
    return await callback();
  } finally {
    if (previousBufferUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = previousBufferUsage;
    if (previousMapMode === undefined) delete globalThis.GPUMapMode;
    else globalThis.GPUMapMode = previousMapMode;
  }
}

test('batched timers reject invalid capacities before allocating GPU resources', async () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 2049, '2']) {
    let allocated = false;
    const device = {features:new Set(['timestamp-query']),createQuerySet(){allocated=true;}};
    assert.throws(() => createBatchedWebGPUTimer(device, {capacity}), /capacity/);
    assert.equal(allocated, false);
  }
});

test('readback rejects overlapping use and reuses buffers only after unmapping', () => withGPUConstants(async () => {
  const device = observedDevice([10n, 40n]);
  let mapped;
  const timer = createBatchedWebGPUTimer(device, {capacity:1});
  const resultBuffer = device.buffers[1];
  resultBuffer.mapAsync = () => new Promise(resolve => { mapped = resolve; });
  timer.timestampWrites('one');
  await assert.rejects(timer.read(), /resolve and submit/);
  timer.resolve(commandEncoder());
  const reading = timer.read();
  assert.equal(timer.state, 'reading');
  assert.throws(() => timer.timestampWrites(), /reading/);
  assert.throws(() => timer.resolve(commandEncoder()), /reading/);
  assert.throws(() => timer.reset(), /reading/);
  await assert.rejects(timer.read(), /only one read/);
  mapped();
  assert.equal((await reading)[0].durationNs,30);
  assert.equal(timer.state,'idle');
  assert.equal(resultBuffer.unmapped,1);
  assert.equal(timer.timestampWrites('two').beginningOfPassWriteIndex,0);
  timer.destroy();
}));

test('mapped bytes are read without copying and are always unmapped on failure', () => withGPUConstants(async () => {
  const device = observedDevice([100n, 90n]);
  const timer = createBatchedWebGPUTimer(device, {capacity:1});
  timer.timestampWrites(); timer.resolve(commandEncoder());
  await assert.rejects(timer.read(), /Invalid WebGPU timestamps/);
  assert.equal(device.buffers[1].unmapped,1);
  assert.equal(timer.state,'idle');
  device.buffers[1].getMappedRange = () => { throw new Error('lost mapping'); };
  timer.timestampWrites(); timer.resolve(commandEncoder());
  await assert.rejects(timer.read(), /lost mapping/);
  assert.equal(device.buffers[1].unmapped,2);
  timer.destroy();
}));

test('read timeouts cancel mapping and destroying a timer rejects pending readback', () => withGPUConstants(async () => {
  const device = observedDevice();
  const timer = createBatchedWebGPUTimer(device, {capacity:1,timeoutMs:10});
  device.buffers[1].mapAsync = () => new Promise(() => {});
  timer.timestampWrites(); timer.resolve(commandEncoder());
  await assert.rejects(timer.read(), /timed out/);
  assert.equal(device.buffers[1].unmapped,1);
  timer.timestampWrites(); timer.resolve(commandEncoder());
  const reading = timer.read();
  timer.destroy(); timer.destroy();
  await assert.rejects(reading, /destroyed/);
  assert.equal(timer.state,'destroyed');
  assert.equal(device.querySet.destroyed,1);
  assert.deepEqual(device.buffers.map(b=>b.destroyed),[1,1]);
  assert.throws(()=>timer.timestampWrites(),/destroyed/);
}));

test('failed timer allocation releases partially created resources', () => withGPUConstants(() => {
  const device = observedDevice();
  const createBuffer = device.createBuffer;
  device.createBuffer = function(descriptor) {
    if (this.buffers.length) throw new Error('allocation failed');
    return createBuffer.call(this,descriptor);
  };
  assert.throws(()=>createBatchedWebGPUTimer(device),/allocation failed/);
  assert.equal(device.querySet.destroyed,1);
  assert.equal(device.buffers[0].destroyed,1);
}));

test('foreign query sets and query index overrides cannot silently corrupt timings', () => withGPUConstants(() => {
  const device = observedDevice();
  const timer = createBatchedWebGPUTimer(device);
  assert.throws(()=>timer.timestampWrites(null,{endOfPassWriteIndex:8}),/cannot be overridden/);
  assert.equal(timer.count,0);
  assert.throws(()=>timer.beginRenderPass(commandEncoder(),{timestampWrites:{querySet:{},beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}),/reserved by this timer/);
  const writes=timer.timestampWrites('reserved');
  assert.doesNotThrow(()=>timer.beginRenderPass(commandEncoder(),{timestampWrites:writes}));
  timer.destroy();
}));

test('single-pass measurements avoid queue-wide waits, reject overlaps and recover from callback errors', () => withGPUConstants(async () => {
  const device = observedDevice([10n,50n]);
  const timer = createWebGPUTimer(device);
  let resume;
  const recording = timer.measure(async (encoder, helper) => {
    helper.beginRenderPass(encoder,{});
    await new Promise(resolve => {resume=resolve;});
  });
  await assert.rejects(timer.measure(()=>{}),/measuring/);
  resume();
  assert.equal(await recording,40);
  assert.equal(device.queueWaits,0);
  assert.equal(device.submissions,1);
  await assert.rejects(timer.measure(()=>{throw new Error('bad record');}),/bad record/);
  assert.equal(timer.state,'idle');
  assert.equal(await timer.measure((encoder,helper)=>helper.beginComputePass(encoder)),40);
  timer.destroy();
}));

function observedDevice(values = [0n, 1n]) {
  const device = timestampDevice(values);
  device.buffers = [];
  device.submissions = 0;
  device.queueWaits = 0;
  device.queue.submit = () => {device.submissions++;};
  device.queue.onSubmittedWorkDone = async () => {device.queueWaits++;};
  device.createQuerySet = function() { return this.querySet = {destroyed:0,destroy(){this.destroyed++;}}; };
  device.createBuffer = function() {
    const bytes = new BigUint64Array(values).buffer;
    bytes.slice = () => {throw Error('Unexpected mapped-range copy');};
    const buffer = {
      destroyed:0,unmapped:0,
      async mapAsync(){}, getMappedRange(){return bytes;},
      destroy(){this.destroyed++;},unmap(){this.unmapped++;}
    };
    this.buffers.push(buffer);
    return buffer;
  };
  return device;
}
