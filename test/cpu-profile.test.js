import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startCpuProfile, stopCpuProfile, summarizeCpuProfile } from "../src/cpu-profile.js";
import { FastCDPHarness } from "../src/fast-cdp-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V3_FIXTURES_DIR = path.join(__dirname, "fixtures", "v3");
const PAGES_DIR = path.join(__dirname, "fixtures", "pages");
const BROWSER_TESTS = process.env.GPU_PERF_BROWSER_TESTS === "1";

test("startCpuProfile and stopCpuProfile drive CDP Profiler domain", async () => {
  const calls = [];
  const fakeProfile = { nodes: [], startTime: 0, endTime: 1000, samples: [], timeDeltas: [] };
  const session = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Profiler.stop") return { profile: fakeProfile };
      return {};
    }
  };

  await startCpuProfile(session, { intervalUs: 100 });
  const profile = await stopCpuProfile(session);

  assert.equal(profile, fakeProfile);
  assert.deepEqual(calls, [
    { method: "Profiler.enable", params: undefined },
    { method: "Profiler.setSamplingInterval", params: { interval: 100 } },
    { method: "Profiler.start", params: undefined },
    { method: "Profiler.stop", params: undefined },
    { method: "Profiler.disable", params: undefined }
  ]);
});

test("summarizeCpuProfile attributes saved draws.html CDP profiles to submitDraws and submission-bound", () => {
  const uninstrumented = JSON.parse(
    fs.readFileSync(path.join(V3_FIXTURES_DIR, "prof-draws.html-n_200000-0.json"), "utf8")
  );
  const instrumented = JSON.parse(
    fs.readFileSync(path.join(V3_FIXTURES_DIR, "prof-draws.html-n_200000-1.json"), "utf8")
  );

  const summary0 = summarizeCpuProfile(uninstrumented, {
    frames: 9,
    windowMs: 250,
    budgetMs: 16.67,
    hz: 60,
    fps: 36
  });

  assert.equal(summary0.classification, "submission-bound");
  assert.equal(summary0.frames, 9);
  assert.equal(summary0.intervalUs, 100);
  assert.ok(summary0.busy >= 0.85, `expected busy >= 0.85, got ${summary0.busy}`);
  assert.ok(summary0.msPerFrame.nativeGpuApi > summary0.msPerFrame.appJs);
  assert.equal(summary0.top[0].fn, "drawArrays");
  assert.equal(summary0.top[0].kind, "native");
  assert.deepEqual(summary0.top[0].caller, {
    fn: "submitDraws",
    url: "draws.js",
    line: 14
  });

  const summary1 = summarizeCpuProfile(instrumented, {
    frames: 9,
    windowMs: 250,
    budgetMs: 16.67,
    hz: 60,
    fps: 36
  });

  assert.equal(summary1.classification, "submission-bound");
  assert.ok(summary1.msPerFrame.tool > 0, "expected gpuPerfGLDraw wrapper time in tool bucket");
  assert.equal(summary1.top[0].fn, "drawArrays");
  assert.equal(summary1.top[0].kind, "native");
  assert.deepEqual(summary1.top[0].caller, {
    fn: "submitDraws",
    url: "draws.js",
    line: 14
  });
});

test("summarizeCpuProfile classifies main-thread-bound, gpu-side-bound, library, tool, and positionTicks hotLine", () => {
  const syntheticMainThread = {
    startTime: 1_000_000,
    endTime: 1_250_000,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4, 5, 6] },
      { id: 2, callFrame: { functionName: "(idle)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } },
      { id: 3, callFrame: { functionName: "(garbage collector)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } },
      {
        id: 4,
        callFrame: {
          functionName: "updateParticles",
          scriptId: "12",
          url: "http://127.0.0.1:8080/cpu-heavy.js",
          lineNumber: 41,
          columnNumber: 0
        },
        positionTicks: [
          { line: 45, ticks: 10 },
          { line: 51, ticks: 85 },
          { line: 54, ticks: 5 }
        ]
      },
      {
        id: 5,
        callFrame: {
          functionName: "renderScene",
          scriptId: "13",
          url: "https://unpkg.com/three@0.170.0/build/three.module.js",
          lineNumber: 999,
          columnNumber: 0
        }
      },
      {
        id: 6,
        callFrame: {
          functionName: "recordPass",
          scriptId: "14",
          url: "gpu-perf-agent/auto-instrument.js",
          lineNumber: 120,
          columnNumber: 0
        }
      }
    ],
    samples: [4, 4, 4, 5, 6, 3, 2],
    timeDeltas: [0, 80_000, 80_000, 50_000, 15_000, 10_000, 5_000, 10_000]
  };

  const mainThreadSummary = summarizeCpuProfile(syntheticMainThread, {
    frames: 10,
    windowMs: 250,
    budgetMs: 16.67,
    hz: 60,
    fps: 40,
    trigger: "requested",
    overheadMs: 12.34
  });

  assert.equal(mainThreadSummary.trigger, "requested");
  assert.equal(mainThreadSummary.classification, "main-thread-bound");
  assert.equal(mainThreadSummary.overheadMs, 12.3);
  assert.equal(mainThreadSummary.msPerFrame.appJs, 21);
  assert.equal(mainThreadSummary.msPerFrame.libraryJs, 1.5);
  assert.equal(mainThreadSummary.msPerFrame.tool, 1);
  assert.equal(mainThreadSummary.msPerFrame.gc, 0.5);
  assert.equal(mainThreadSummary.msPerFrame.idle, 1);
  assert.deepEqual(mainThreadSummary.top[0], {
    fn: "updateParticles",
    kind: "app",
    url: "cpu-heavy.js",
    line: 42,
    hotLine: 51,
    selfMsPerFrame: 21,
    caller: null
  });
  assert.equal(mainThreadSummary.top[1].kind, "library");

  const syntheticGpuSide = {
    startTime: 1_000_000,
    endTime: 1_250_000,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2, 3] },
      { id: 2, callFrame: { functionName: "(idle)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } },
      { id: 3, callFrame: { functionName: "tick", scriptId: "10", url: "http://127.0.0.1:8080/app.js", lineNumber: 9, columnNumber: 0 } }
    ],
    samples: [2, 3],
    timeDeltas: [0, 230_000, 20_000]
  };

  const gpuSideSummary = summarizeCpuProfile(syntheticGpuSide, {
    frames: 5,
    windowMs: 250,
    budgetMs: 16.67,
    hz: 60,
    fps: 20
  });
  assert.equal(gpuSideSummary.classification, "gpu-side-bound");
  assert.ok(gpuSideSummary.busy < 0.3);
});

test("L5 browser integration: draws200k, cpu-heavy, and gl-fill auto trigger", { skip: !BROWSER_TESTS }, async () => {
  const harness = await FastCDPHarness.launch();
  try {
    const drawsReport = await harness.run({
      file: path.join(PAGES_DIR, "draws200k.html"),
      fileRoot: PAGES_DIR,
      autoInstrument: true,
      samples: 2,
      durationMs: 250,
      warmup: 1,
      readyTimeoutMs: 500,
      cpuProfile: "auto"
    });
    assert.ok(drawsReport.cpuProfile, "expected cpuProfile on draws200k.html");
    assert.equal(drawsReport.cpuProfile.trigger, "auto");
    assert.equal(drawsReport.cpuProfile.classification, "submission-bound");
    assert.equal(drawsReport.summary.bottleneck.subtype, "submission-bound");
    const nativeDraw = drawsReport.cpuProfile.top.find(entry => entry.kind === "native");
    assert.ok(nativeDraw, "expected native GPU API entry in cpuProfile.top");
    assert.equal(nativeDraw.caller?.fn, "submitDraws");
    assert.equal(nativeDraw.caller?.url, "draws2.js");
    assert.ok(
      drawsReport.diagnostics.validity.warnings.some(w => w.code === "instrumentation-overhead"),
      "expected instrumentation-overhead warning on draws200k"
    );

    const cpuHeavyReport = await harness.run({
      file: path.join(PAGES_DIR, "cpu-heavy.html"),
      fileRoot: PAGES_DIR,
      autoInstrument: true,
      samples: 2,
      durationMs: 250,
      warmup: 1,
      readyTimeoutMs: 500,
      cpuProfile: "auto"
    });
    assert.ok(cpuHeavyReport.cpuProfile, "expected cpuProfile on cpu-heavy.html");
    const updateEntry = cpuHeavyReport.cpuProfile.top.find(entry => entry.fn === "updateParticles");
    assert.ok(updateEntry, "expected updateParticles in cpuProfile.top");
    assert.equal(updateEntry.kind, "app");
    assert.equal(updateEntry.url, "cpu-heavy.js");
    assert.ok(Number.isInteger(updateEntry.hotLine) && updateEntry.hotLine > 0, "expected hotLine on updateParticles");

    const glFillReport = await harness.run({
      file: path.join(PAGES_DIR, "gl-fill.html"),
      fileRoot: PAGES_DIR,
      autoInstrument: true,
      samples: 2,
      durationMs: 250,
      warmup: 1,
      readyTimeoutMs: 500,
      cpuProfile: "auto"
    });
    assert.equal(glFillReport.summary.bottleneck.class, "gpu-bound");
    assert.equal(glFillReport.cpuProfile ?? null, null);
  } finally {
    await harness.close();
  }
});
