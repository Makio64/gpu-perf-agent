import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FastCDPHarness } from "../src/fast-cdp-runner.js";

// In-page evidence in a real Chrome (L1b): readiness, page render rate, texture bytes, churn sites, LoAF
// attribution, GPU errors and off-main-thread counts. Reads report.inPage, not the digest.
const enabled = process.env.GPU_PERF_BROWSER_TESTS === "1";
const pages = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pages");
let harness;

async function capture(file, options = {}) {
  harness ??= await FastCDPHarness.launch({});
  return harness.run({ file: path.join(pages, file), samples: 3, durationMs: 300, warmup: 1, autoInstrument: true, ...options });
}

test.after(async () => {
  await harness?.close();
});

test("readiness waits for rendering that starts after load", { skip: !enabled, timeout: 60000 }, async () => {
  const { inPage } = await capture("delayed.html");
  assert.equal(inPage.ready.reason, "gpu-work");
  assert.ok(inPage.ready.waitedMs > 500 && inPage.ready.waitedMs < 3000, String(inPage.ready.waitedMs));
  assert.equal(inPage.summary.perFrame.glDrawCalls, 200);
  assert.ok(inPage.samples.every((sample) => sample.idle === false));
});

test("a hook installed late (setTimeout or top-level await) is found after the readiness gate", { skip: !enabled, timeout: 60000 }, async () => {
  const late = await capture("late-hook-2500.html", { readyTimeoutMs: 4000 });
  assert.equal(late.inPage.hook.found, true);
  assert.equal(late.inPage.ready.reason, "hook");
  const tla = await capture("tla-hook.html");
  assert.equal(tla.inPage.hook.found, true);
  assert.equal(tla.inPage.ready.reason, "hook");
  assert.equal(tla.inPage.samples[0].measurement.tla, true);
});

test("the page render rate is reported beside the observer's rAF rate", { skip: !enabled, timeout: 60000 }, async () => {
  const { inPage } = await capture("half.html", { allowIdle: true });
  const pageFps = inPage.summary.activity.pageFps.p50;
  assert.ok(pageFps > 25 && pageFps < 35, String(pageFps));
  assert.ok(inPage.summary.activity.activeFrameRatio > 0.4 && inPage.summary.activity.activeFrameRatio < 0.6);
});

test("WebGL texture bytes follow the active texture unit", { skip: !enabled, timeout: 60000 }, async () => {
  const { inPage } = await capture("texunits.html");
  assert.equal(inPage.instrumentation.after.resources.byKind.texture.bytes, 4194368);
});

test("steady-state churn: rates from sampling-window deltas and the creating call site", { skip: !enabled, timeout: 60000 }, async () => {
  const clean = (await capture("multipass-churn0.html")).inPage.summary;
  assert.equal(clean.perFrame.createBindGroup, 0);
  assert.equal(clean.perFrame.createBuffer, 0);
  assert.equal(clean.perFrame.createTexture, 0);
  assert.equal(clean.churnSites.createBindGroup, undefined);
  const churn = (await capture("multipass-churn20.html")).inPage.summary;
  assert.equal(churn.perFrame.createBindGroup, 20);
  assert.match(churn.churnSites.createBindGroup[0].site, /^makeFrameBindGroups (\S*\/)?multipass\.js:\d+$/);
});

test("slow frames carry LoAF script attribution to the page, never to the tool", { skip: !enabled, timeout: 60000 }, async () => {
  const { inPage } = await capture("slow-frame-80.html");
  const attributed = inPage.slowFrames.filter((frame) => frame.loaf?.scripts?.length);
  assert.ok(attributed.length > 0, JSON.stringify(inPage.slowFrames.slice(0, 3)));
  assert.ok(attributed.some((frame) => frame.loaf.scripts.some((script) => script.fn === "frame" && /slow-frame-80\.js$/.test(script.url))));
  for (const frame of inPage.slowFrames) {
    for (const script of frame.loaf?.scripts || []) assert.ok(!String(script.url).startsWith("gpu-perf-agent/"), script.url);
  }
});

test("uncaptured WebGPU errors are counted by message; off-main-thread rendering is counted", { skip: !enabled, timeout: 60000 }, async () => {
  const broken = (await capture("webgpu-broken.html")).inPage;
  assert.ok(broken.summary.gpuErrors.inWindow > 0, JSON.stringify(broken.summary.gpuErrors));
  assert.match(broken.summary.gpuErrors.top[0].message, /bind group|invalid/i);
  assert.deepEqual(broken.instrumentation.errors, []);
  const worker = (await capture("worker.html", { readyTimeoutMs: 500 })).inPage;
  assert.deepEqual(worker.summary.offMainThread, { workers: 1, offscreenTransfers: 1 });
  assert.equal(worker.summary.appGpuContexts.webgpuDevices, 0);
});
