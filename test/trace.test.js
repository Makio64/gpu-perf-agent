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
