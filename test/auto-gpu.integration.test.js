import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FastCDPHarness } from "../src/fast-cdp-runner.js";

// Automatic per-pass GPU timing in a real Chrome (L1a). Timing values are loose bounds here; exact targets
// (nohook-2000 p50 8.0-9.0 ms, glframe-2000 p50 8.3-9.2 ms) are benchmarked in isolation.
const enabled = process.env.GPU_PERF_BROWSER_TESTS === "1";
const pages = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pages");
const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
let harness;

async function capture(file, options = {}) {
  harness ??= await FastCDPHarness.launch({});
  return harness.run({ file, samples: 3, durationMs: 400, warmup: 1, autoInstrument: true, ...options });
}

test.after(async () => {
  await harness?.close();
});

test("WebGPU passes are timed per frame without a hook", { skip: !enabled, timeout: 60000 }, async () => {
  const report = await capture(path.join(pages, "nohook-2000.html"));
  const auto = report.inPage.summary.autoGpu;
  assert.equal(auto.status, "ok", JSON.stringify(auto));
  assert.equal(auto.source, "webgpu-timestamp");
  assert.ok(auto.frameNs.p50 > 1e6 && auto.frameNs.p50 < 50e6, String(auto.frameNs.p50));
  assert.deepEqual(auto.passes.map((pass) => pass.key).sort(), ["render#0", "sim"]);
  assert.match(auto.passes.find((pass) => pass.key === "sim").site, /^frame .*nohook-2000\.html:\d+$/);
  for (const sample of report.inPage.samples) {
    assert.ok(sample.autoGpu.frameNs.p50 <= sample.autoGpu.sumNs.p50);
    assert.ok(sample.autoGpu.frameNs.p50 <= sample.autoGpu.spanNs.p50);
    assert.equal(sample.measurement.autoGpu, undefined);
  }
  assert.deepEqual(report.inPage.instrumentation.after.errors, []);
  const counters = report.inPage.instrumentation.after.counters;
  assert.equal(counters["webgl2.contexts"], undefined, "the capability probe context is not page work");
  assert.equal(counters["webgpu.resolveQuerySet"], undefined, "tool resolves stay out of page counters");
  assert.equal(report.pageEventSummary?.counts?.renderingError ?? 0, 0);
});

test("gpuTiming false records activity but no autoGpu", { skip: !enabled, timeout: 60000 }, async () => {
  const report = await capture(path.join(pages, "nohook-2000.html"), { gpuTiming: false });
  assert.equal(report.inPage.summary.autoGpu, undefined);
  assert.ok(report.inPage.samples.every((sample) => sample.autoGpu === undefined && sample.activity.activeTicks > 0));
});

test("WebGL2 frames are timed with TIME_ELAPSED and frames without draws are no-work frames", { skip: !enabled, timeout: 60000 }, async () => {
  const gl = (await capture(path.join(pages, "glframe-2000.html"))).inPage.summary.autoGpu;
  assert.equal(gl.status, "ok", JSON.stringify(gl));
  assert.equal(gl.source, "webgl-time-elapsed");
  assert.ok(gl.frameNs.p50 > 1e6, String(gl.frameNs.p50));
  assert.deepEqual(gl.passes.map((pass) => pass.key), ["gl-frame#0"]);
  const half = (await capture(path.join(pages, "half.html"), { allowIdle: true })).inPage.summary.autoGpu;
  assert.ok(half.noWorkFrames > half.frames * 0.35 && half.noWorkFrames < half.frames * 0.65, JSON.stringify(half));
  assert.equal(half.timedFrames + half.partialFrames, half.workFrames);
});

test("examples/webgpu-clear.html is ok and its allocation tracker never sees tool buffers", { skip: !enabled, timeout: 60000 }, async () => {
  const report = await capture(path.join(examples, "webgpu-clear.html"), { waitForHook: true });
  assert.equal(report.inPage.summary.autoGpu.status, "ok");
  assert.deepEqual(report.inPage.instrumentation.after.errors, []);
  // trackWebGPUDevice wraps device.createBuffer after requestDevice; the page owns exactly its 16 MiB scratch buffer.
  assert.equal(report.inPage.memory.after.trackedGpuMemory.totalBytes, 16 * 1024 * 1024);
  const resources = report.inPage.instrumentation.after.resources;
  if (resources?.byKind?.buffer) assert.ok(resources.byKind.buffer.bytes < 16 * 1024 * 1024 + 32768, JSON.stringify(resources.byKind));
});

test("a page that times its own pass and wraps createBuffer/submit keeps its data; frames are page-timed-pass", { skip: !enabled, timeout: 60000 }, async () => {
  const report = await capture(path.join(pages, "page-timed.html"), { waitForHook: true });
  const auto = report.inPage.summary.autoGpu;
  assert.deepEqual(report.inPage.instrumentation.after.errors, []);
  const pooled = report.inPage.samples.reduce((total, sample) => total + sample.autoGpu.partialReasons["page-timed-pass"], 0);
  assert.ok(pooled >= 1, JSON.stringify(auto));
  assert.ok(auto.timedFrames >= 1, JSON.stringify(auto));
  assert.ok(auto.passes.some((pass) => pass.key === "render#1"), JSON.stringify(auto.passes));
  const seen = report.inPage.samples.at(-1).measurement.pageTimed;
  assert.equal(seen.timed, true);
  assert.ok(seen.ownNs > 0, "the page's own timestampWrites still produce data");
  // Only the page's own two buffers pass through its createBuffer wrapper; the tool's resolves never reach its submit hook.
  assert.equal(seen.buffers, 2);
  assert.equal(seen.bufferBytes, 32);
  const submits = report.inPage.instrumentation.after.counters["webgpu.queueSubmits"];
  assert.ok(seen.submits <= submits + 2, `${seen.submits} page submits vs ${submits} counted`);
  assert.ok(seen.submits >= submits - 10, `${seen.submits} page submits vs ${submits} counted`);
});
