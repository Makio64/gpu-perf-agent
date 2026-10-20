import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTrace } from "../src/trace.js";

test("summarizeTrace classifies GPU, frame, and memory events", () => {
  const result = summarizeTrace({
    traceEvents: [
      { cat: "gpu", dur: 2000, name: "WebGPU.Submit", ph: "X", ts: 1000 },
      { cat: "viz", dur: 1000, name: "DrawFrame", ph: "X", ts: 4000 },
      { args: { dumps: { gpu_memory: { bytes: { value: "0x1000" } } } }, cat: "memory-infra", name: "periodic dump", ph: "v", ts: 6000 }
    ]
  });
  assert.equal(result.durationMs, 5);
  assert.equal(result.gpu.eventCount, 1);
  assert.equal(result.gpu.completeDurationMs.mean, 2);
  assert.equal(result.frames.eventCount, 1);
  assert.equal(result.memory.topBytePaths[0].maxBytes, 4096);
});

test("summarizeTrace handles missing trace data", () => {
  const result = summarizeTrace(null);
  assert.equal(result.eventCount, 0);
  assert.equal(result.durationMs, null);
  assert.equal(result.gpu.completeDurationMs, null);
});

test("trace rankings preserve encounter order at ties and bound every list", () => {
  const events = Array.from({ length: 30 }, (_, index) => ({
    cat: "gpu", dur: (index % 3) * 1000, name: `operation-${index}`, ph: "X", ts: index * 1000
  }));
  // GPU summaries historically include finite durations for all phases; the
  // overall complete-event ranking includes only X events.
  events.push({ cat: "gpu", dur: 4000, name: "async-operation", ph: "B", ts: 32000 });
  const summary = summarizeTrace({ traceEvents: events });
  const names = summary.topCompleteEvents.map(event => event.name);
  assert.deepEqual(names, [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 1, 4, 7, 10, 13].map(index => `operation-${index}`));
  assert.deepEqual(summary.gpu.topCompleteEvents.map(event => event.name), ["async-operation", ...names.slice(0, 11)]);
  assert.deepEqual(summary.gpu.topNames, Array.from({ length: 15 }, (_, index) => ({ count: 1, name: `operation-${index}` })));
  assert.equal(summary.gpu.completeDurationMs.count, 31);
  assert.equal(summary.gpu.completeDurationMs.mean, 34 / 31);
  assert.equal(summary.durationMs, 32);
});

test("trace categories overlap and memory paths retain maxima and sample counts", () => {
  const summary = summarizeTrace({ traceEvents: [
    { cat: "gpu,memory", name: "DrawFrame", ph: "X", dur: 2000, ts: 0,
      args: { dumps: { gpu_memory: { bytes: { value: "0x1000" } }, resident: 2048, size: -1 } } },
    { cat: "gpu", name: "DrawFrame", ph: "v", dur: 1000, ts: 5000,
      args: { gpu_memory: { bytes: 1024 }, resident: "4096", size: 0 } },
    { cat: "memory", name: "dump", args: { unrelated: 99999, allocated: "invalid" } }
  ] });
  assert.equal(summary.eventCount, 3);
  assert.equal(summary.gpu.eventCount, 2);
  assert.equal(summary.frames.eventCount, 2);
  assert.deepEqual(summary.frames.topNames, [{ count: 2, name: "DrawFrame" }]);
  assert.equal(summary.memory.eventCount, 3);
  assert.deepEqual(summary.memory.topBytePaths, [
    { maxBytes: 4096, path: "gpu_memory.bytes", samples: 2 },
    { maxBytes: 4096, path: "resident", samples: 2 }
  ]);
  assert.equal(summary.topCompleteEvents.length, 1);
  assert.equal(summary.gpu.topCompleteEvents.length, 2);
});

test("trace summaries ignore non-finite durations and tolerate cyclic memory arguments", () => {
  const args = { bytes: 10 };
  args.self = args;
  const summary = summarizeTrace({ traceEvents: [
    { cat: "gpu", name: "", ph: "X", dur: NaN, ts: NaN },
    { cat: "gpu", ph: "X", dur: Infinity },
    { cat: "gpu", ph: "X", dur: "2000" },
    { cat: "gpu", ph: "X", dur: -1000, ts: 3000 },
    { cat: "memory", ph: "v", args }
  ] });
  assert.equal(summary.gpu.eventCount, 4);
  assert.equal(summary.gpu.completeDurationMs.count, 1);
  assert.equal(summary.gpu.completeDurationMs.mean, -1);
  assert.equal(summary.durationMs, 0);
  assert.deepEqual(summary.gpu.topNames, [{ count: 4, name: "(unnamed)" }]);
  assert.deepEqual(summary.topCompleteEvents, [{ cat: "gpu", durationMs: -1, name: "(unnamed)" }]);
  assert.deepEqual(summary.memory.topBytePaths, [{ maxBytes: 10, path: "bytes", samples: 1 }]);
});

test('trace completion times out and removes its listener', async () => {
  const { EventEmitter } = await import('node:events');
  const { stopChromeTrace } = await import('../src/trace.js');
  const session = new EventEmitter();
  session.send = async () => ({});
  await assert.rejects(stopChromeTrace(session, { timeoutMs: 10 }), /Timed out/);
  assert.equal(session.listenerCount('Tracing.tracingComplete'), 0);
});

test('trace stream closes on parse failure or size limits and decodes base64', async () => {
  const { EventEmitter } = await import('node:events');
  const { stopChromeTrace } = await import('../src/trace.js');
  for (const [text, limit, expected] of [['{', 100, 'parse'], ['{}', 1, 'size'], ['{"traceEvents":[]}', 100, 'ok']]) {
    const session = new EventEmitter();
    let closed = false;
    session.send = async method => {
      if (method === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'one' });
      if (method === 'IO.close') closed = true;
      return { data: Buffer.from(text).toString('base64'), base64Encoded: true, eof: true };
    };
    const result = stopChromeTrace(session, { maxBytes: limit });
    if (expected === 'ok') assert.deepEqual(await result, { traceEvents: [] });
    else await assert.rejects(result);
    assert.equal(closed, true);
    assert.equal(session.listenerCount('Tracing.tracingComplete'), 0);
  }
});
