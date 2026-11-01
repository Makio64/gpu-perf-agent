import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  compactComparison,
  compactReport,
  comparisonExitCode,
  formatAgentComparison,
  formatAgentReport,
  formatCaptureAndCompare,
  formatCliError,
  formatGpuTimingSignal,
  normalizeCliError
} from "../src/output.js";
import { compareReports } from "../src/compare.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);

function approxTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

test("formatAgentReport renders §8.1 healthy capture within token and line budgets", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/report-capture.json"), "utf8"));
  const digest = formatAgentReport(fixture, { out: path.join(root, "reports/three-healthy.json"), cwd: root });
  const lines = digest.split("\n").filter(Boolean);

  assert.ok(lines.length <= 10, `expected <=10 lines, got ${lines.length}`);
  assert.ok(approxTokens(digest) <= 160, `expected <=160 tokens, got ${approxTokens(digest)}`);
  assert.match(lines[0], /^EXCELLENT — no limiting cause; vsync-capped at 60 Hz$/);
  assert.match(lines[1], /^Bound: vsync-capped 60 Hz; GPU 8\.41 ms \(51% of 16\.67 ms\), CPU 1\.3 ms\/frame → primary health\.autoGpuFrameMs\.p50$/);
  assert.match(lines[2], /^Frame 16\.67 ms p95 16\.7 \| GPU p50 8\.41 ms \(auto, 88\/90 frames\) \| 3 passes\/f, 200 draws\/f \| VRAM 16 MiB \| heap 0\.00 MiB\/s retained$/);
  assert.match(lines[3], /^Passes \(excl p50\): render#0@frame\(app\.js:88\) 8\.3 ms  sim@frame\(app\.js:81\) 0\.05 ms$/);
  assert.match(digest, /Trust: valid; .*GPU clock-sensitive: confirm GPU deltas with ab/);
  assert.doesNotMatch(digest, /GPU stable/);
  assert.match(digest, /Next: No action needed/);
  assert.match(digest, /Report: reports\/three-healthy\.json$/);
});

test("formatAgentReport renders §8.1 GPU-bound, saturated GPU, CPU hotspot, hitch, and capture anomalies", () => {
  const gpuBoundReport = {
    summary: {
      verdict: "needs-work",
      verdictReasons: [
        { code: "gpu-bound", severity: "high", message: "GPU-bound (9.27 ms/frame vs 8.33 ms budget at 120 Hz)" }
      ],
      bottleneck: {
        class: "gpu-bound",
        subtype: null,
        hz: 120,
        budgetMs: 8.33,
        gpuMs: 9.27,
        gpuShare: 1.11,
        gpuSaturated: false,
        cpuMsPerFrame: 1.9,
        primaryMetric: "health.autoGpuFrameMs.p50"
      },
      frameTimeMsMean: 9.52,
      frameTimeMsP95: 13.8,
      observedFrameCount: 60,
      sampleCount: 6,
      cpuMsPerFrame: 1.9,
      gpu: {
        source: "auto",
        frameMsP50: 9.27,
        frameMsP95: 10.1,
        timedFrames: 58,
        stability: { status: "stable", clockSensitive: true },
        passes: [
          { key: "render#1", exclusiveMs: 6.91, overlapped: false, site: "frame scene.js:142" },
          { key: "render#0", exclusiveMs: 1.88, overlapped: false, site: "frame scene.js:98" },
          { key: "compute#0", exclusiveMs: 0.48, overlapped: true, site: "step sim.js:54" }
        ]
      },
      perFrame: { renderPasses: 2, computePasses: 1, drawCalls: 420 },
      drawCallsPerFrame: 420,
      trackedVram: { totalMiB: 590.5 },
      heap: { retainedMiBPerSec: 0.12 },
      findings: [
        { code: "gpu-bound", role: "cause", severity: "high", message: "GPU-bound", next: "Reduce fragment cost in render#1 (6.91 ms, 75% of GPU time)." }
      ]
    },
    diagnostics: { validity: { valid: true, issues: [], warnings: [] } }
  };

  const digest = formatAgentReport(gpuBoundReport, { out: "reports/scene.json" });
  assert.ok(approxTokens(digest) <= 160, `expected <=160 tokens, got ${approxTokens(digest)}`);
  assert.match(digest, /^NEEDS-WORK — GPU-bound \(9\.27 ms\/frame vs 8\.33 ms budget at 120 Hz\)/);
  assert.match(digest, /Bound: gpu-bound 120 Hz; GPU 9\.27 ms \(111% of 8\.33 ms\), CPU 1\.9 ms\/frame → primary health\.autoGpuFrameMs\.p50/);
  assert.match(digest, /Passes \(excl p50\): render#1@frame\(scene\.js:142\) 6\.91 ms  render#0@frame\(scene\.js:98\) 1\.88 ms  compute#0@step\(sim\.js:54\) 0\.48 ms~/);
  assert.match(digest, /Next: Reduce fragment cost in render#1/);

  // Hitch line formatting
  const hitchDigest = formatAgentReport({
    ...gpuBoundReport,
    summary: { ...gpuBoundReport.summary, gpu: { ...gpuBoundReport.summary.gpu, passes: [] }, hitches: [{ durationMs: 28.4, where: "compilePost @ post.js:48", loaf: true }] }
  });
  assert.match(hitchDigest, /Hitch: 28\.4 ms frame @ compilePost @ post\.js:48/);

  // Saturated GPU prints GPU >= budget (saturated) instead of GPU <x> ms (<share>%)
  gpuBoundReport.summary.bottleneck.gpuSaturated = true;
  const satDigest = formatAgentReport(gpuBoundReport);
  assert.match(satDigest, /Bound: gpu-bound 120 Hz; GPU ≥ budget \(saturated\), CPU 1\.9 ms\/frame/);

  // CPU submission-bound + capture anomaly
  const cpuBoundReport = {
    summary: {
      verdict: "poor",
      verdictReasons: [{ code: "cpu-bound", severity: "high", message: "CPU submission-bound (main thread 95% busy at 46.2 fps)" }],
      bottleneck: {
        class: "cpu-bound",
        subtype: "submission-bound",
        hz: 120,
        budgetMs: 8.33,
        gpuMs: 0.38,
        gpuShare: 0.05,
        cpuMsPerFrame: 12.1,
        primaryMetric: "frame.frameTimeMs.mean"
      },
      frameTimeMsMean: 21.6,
      frameTimeMsP95: 25.4,
      observedFrameCount: 30,
      sampleCount: 6,
      cpuMsPerFrame: 12.1,
      gpu: { source: "auto", frameMsP50: 0.38, timedFrames: 30, passes: [] },
      perFrame: { renderPasses: 1, computePasses: 0, drawCalls: 2500 },
      drawCallsPerFrame: 2500,
      trackedVram: { totalMiB: 24.1 },
      heap: { retainedMiBPerSec: 0 },
      findings: [{ code: "cpu-bound", role: "cause", severity: "high", message: "CPU-bound", next: "Batch the 2500 draws/f in frame (index.html:64)." }]
    },
    cpuProfile: {
      msPerFrame: { appJs: 2.34, gc: 0.24 },
      top: [{ fn: "draw", kind: "native", selfMsPerFrame: 8.92, caller: { fn: "frame", url: "index.html", line: 64 } }]
    },
    timings: {
      anomalies: [
        { code: "slow-navigation", ms: 25600 },
        { code: "slow-tls", ms: 25300, host: "unpkg.com" }
      ]
    },
    diagnostics: { validity: { valid: true, issues: [], warnings: [{ code: "instrumentation-overhead", message: "overhead" }] } }
  };
  const cpuDigest = formatAgentReport(cpuBoundReport, { out: "reports/cpu.json" });
  assert.ok(approxTokens(cpuDigest) <= 160, `expected <=160 tokens, got ${approxTokens(cpuDigest)}`);
  assert.match(cpuDigest, /CPU: native draw 8\.92 ms\/f <- frame index\.html:64; app JS 2\.34 ms; GC 0\.24 ms/);
  assert.match(cpuDigest, /Capture: slow navigation 25\.6 s \(TLS 25\.3 s on unpkg\.com\); keep Chrome warm \(daemon\/serve\)/);
  assert.match(cpuDigest, /instrumentation overhead/);
});

test("formatAgentReport renders §8.1 invalid capture concisely", () => {
  const invalidReport = {
    summary: { verdict: "invalid" },
    diagnostics: {
      validity: {
        valid: false,
        issues: [
          { code: "page-errors", message: "2 runtime/network errors occurred during capture." },
          { code: "no-gpu-work", message: "No GPU work observed." }
        ]
      },
      pageErrors: [
        { type: "httperror", status: 404, url: "http://localhost:8080/assets/env.hdr" },
        { type: "pageerror", message: "ReferenceError: HDRLoader is not defined" }
      ]
    },
    pageEvents: [
      { type: "httperror", status: 404, url: "http://localhost:8080/assets/env.hdr" },
      { type: "pageerror", message: "ReferenceError: HDRLoader is not defined" }
    ]
  };
  const digest = formatAgentReport(invalidReport, { out: "reports/three-broken.json" });
  const lines = digest.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "INVALID — page-errors: 2 runtime/network errors occurred during capture; no GPU work during sampling");
  assert.match(lines[1], /^Trust: invalid \(2 issues\); 2 page\/network errors \(404 \/assets\/env\.hdr, ReferenceError: HDRLoader is not defined\)$/);
  assert.match(lines[2], /^Next: Fix the 2 runtime\/network errors first/);
  assert.equal(lines[3], "Report: reports/three-broken.json");
});

test("formatAgentComparison renders §8.2 paired and separate digests within 140-token budget", async () => {
  const paired = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/comparison.json"), "utf8"));
  // The trimmed fixture lacks the auto GPU evidence a real comparison of its primary carries.
  const stableAuto = { status: "single-scope", stability: { status: "stable", clockSensitive: true }, clockSensitive: true };
  paired.gpuTiming = { ...paired.gpuTiming, auto: { base: stableAuto, candidate: stableAuto } };
  const pairedDigest = formatAgentComparison(paired, { out: "reports/ab-1.json" });
  assert.ok(approxTokens(pairedDigest) <= 140, `expected <=140 tokens, got ${approxTokens(pairedDigest)}`);
  assert.match(pairedDigest, /^IMPROVED — primary health\.autoGpuFrameMs\.p50 1\.68 → 1\.49 ms \(-11\.3%, 95% CI -0\.23\.\.-0\.15 ms; paired, 4 rounds\) \(primary from base bottleneck\)/);
  assert.match(pairedDigest, /Trust: base valid, cand valid; GPU stable both sides/);
  assert.match(pairedDigest, /Not gated: 3 changed/);
  assert.match(pairedDigest, /Saved: reports\/ab-1\.json$/);

  // Separate unverified comparison with copied flags in Next:
  const separate = {
    ...paired,
    status: "unverified",
    exitCode: 0,
    mode: "separate",
    baseFile: "base.html",
    candidateFile: "cand.html",
    primary: {
      key: "health.autoGpuFrameMs.p50",
      selection: "bottleneck",
      row: {
        ...paired.primary.row,
        status: "unverified",
        screen: "better",
        reasons: ["auto GPU is clock-sensitive across separate Chrome launches"]
      }
    }
  };
  const sepDigest = formatAgentComparison(separate, {
    out: "reports/cand-1.compare.json",
    baseOptions: { autoInstrument: false, gpuTiming: false, api: "webgpu", hookName: "customBench" }
  });
  assert.ok(approxTokens(sepDigest) <= 140, `expected <=140 tokens, got ${approxTokens(sepDigest)}`);
  assert.match(sepDigest, /^UNVERIFIED \(screen: better\) — primary health\.autoGpuFrameMs\.p50 1\.68 → 1\.49 ms \(-11\.3%; separate, auto GPU is clock-sensitive across separate Chrome launches\) \(primary from base bottleneck\)/);
  assert.match(sepDigest, /Next: confirm with ab --base-file base\.html --candidate-file cand\.html --metric health\.autoGpuFrameMs\.p50 --no-auto-instrument --no-gpu-timing --api webgpu --hook-name customBench/);

  // Work equivalence + compatibility mismatch + schemaVersion warning
  const mismatchDigest = formatAgentComparison({
    ...paired,
    workEquivalence: { status: "different", differences: [{ key: "drawCallsPerFrame", base: 200, candidate: 100 }] },
    compatibility: {
      compatible: false,
      differences: [{ key: "autoInstrument", base: false, candidate: true }],
      warnings: [{ key: "schemaVersion", base: 2, candidate: 3 }]
    }
  });
  assert.ok(approxTokens(mismatchDigest) <= 140);
  assert.match(mismatchDigest, /Work: drawCallsPerFrame 200 → 100 — confirm identical output/);
  assert.match(mismatchDigest, /Mismatch: autoInstrument base false ≠ cand true → recapture with --no-auto-instrument, or use agent --base/);
  assert.match(mismatchDigest, /baseline schemaVersion 2: recapture/);
});

test("formatCaptureAndCompare combines capture, baseline overrides, comparison, and saved paths", async () => {
  const capture = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/report-capture.json"), "utf8"));
  const comparison = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/comparison.json"), "utf8"));
  const combined = formatCaptureAndCompare(capture, comparison, {
    out: "reports/cand-1.json",
    comparisonOut: "reports/cand-1.compare.json",
    baseReportPath: "reports/base-1.json",
    overrides: [{ key: "autoInstrument", value: false, flag: "--auto-instrument" }]
  });
  assert.match(combined, /^EXCELLENT — no limiting cause; vsync-capped at 60 Hz/m);
  assert.match(combined, /^Matched baseline: autoInstrument=false \(override with --auto-instrument\)/m);
  assert.match(combined, /^vs reports\/base-1\.json:/m);
  assert.match(combined, /^IMPROVED — primary health\.autoGpuFrameMs\.p50/m);
  assert.match(combined, /^Saved: reports\/cand-1\.json, reports\/cand-1\.compare\.json$/m);
});

test("compactReport and compactComparison obey §8.3 byte caps (<=1.6 KB and <=2 KB)", async () => {
  const capture = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/report-capture.json"), "utf8"));
  const comparison = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/comparison.json"), "utf8"));

  const cReport = compactReport(capture, path.join(root, "reports/scene-1.json"));
  // `out` repeats the absolute path: measure it at a typical length, not this checkout's.
  const reportBytes = Buffer.byteLength(JSON.stringify({ ...cReport, out: "/Users/dev/projects/scene/reports/scene-1.json" }), "utf8");
  assert.ok(reportBytes <= 1638, `expected compactReport <= 1638 bytes, got ${reportBytes}`);
  assert.equal(cReport.schemaVersion, 3);
  assert.equal(cReport.ok, true);
  assert.equal(cReport.exitCode, 0);
  assert.equal(cReport.reportPath, "reports/scene-1.json");
  assert.equal(cReport.verdict, "excellent");
  assert.equal(cReport.bottleneck.class, "vsync-capped");
  assert.equal(cReport.headline.fps, 60);
  assert.equal(cReport.topPasses.length, 2);
  assert.equal(cReport.validity.valid, true);

  const cComp = compactComparison(comparison, path.join(root, "reports/cand-1.compare.json"));
  const compBytes = Buffer.byteLength(JSON.stringify(cComp), "utf8");
  assert.ok(compBytes <= 2048, `expected compactComparison <= 2048 bytes, got ${compBytes}`);
  assert.equal(cComp.kind, "comparison");
  assert.equal(cComp.schemaVersion, 2);
  assert.equal(cComp.status, "improved");
  assert.equal(cComp.exitCode, 0);
  assert.equal(cComp.comparisonPath, "reports/cand-1.compare.json");
  assert.equal(cComp.primary.key, "health.autoGpuFrameMs.p50");
});

test("formatCliError unwraps nested Error: Error: prefixes and hides stack unless GPU_PERF_DEBUG=1", () => {
  const err = Object.assign(new Error("Error: Error: File not found: /tmp/missing.html"), {
    code: "file-not-found",
    hint: "resolved from --file missing.html, cwd /tmp"
  });
  const text = formatCliError(err, { reportPath: "reports/failed-1.json", debug: false });
  assert.equal(
    text,
    "error[file-not-found]: File not found: /tmp/missing.html\nhint: resolved from --file missing.html, cwd /tmp\nReport: reports/failed-1.json"
  );
  assert.doesNotMatch(text, /Error: Error:/);
  assert.doesNotMatch(text, /\n\s+at /);

  const withDebug = formatCliError(err, { debug: true });
  assert.match(withDebug, /at /);
});

test("comparisonExitCode and formatGpuTimingSignal preserve contract semantics", () => {
  const result = { compatibility: { compatible: false, differences: [{ key: "api", base: "webgpu", candidate: "webgl2" }] }, failures: [], validity: { valid: true, issues: [] } };
  assert.equal(comparisonExitCode(result), 2);
  assert.equal(comparisonExitCode(result, { allowMismatch: true }), 0);
  result.failures.push({ key: "frame.frameTimeMs.mean", status: "regression" });
  assert.equal(comparisonExitCode(result, { allowMismatch: true }), 1);

  assert.equal(
    formatGpuTimingSignal({ status: "single-scope", scope: "", validSampleCount: 3, sampleCount: 3 }),
    "GPU timing scope: (root); 3/3 samples."
  );
});

test("comparison Trust line states the GPU stability evidence and comparison-level invalidity", async () => {
  const capture = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/report-capture.json"), "utf8"));
  const trustOf = (result) => formatAgentComparison(result).split("\n").find((line) => line.startsWith("Trust:"));
  const withAuto = (base, candidate) => ({
    mode: "separate",
    rows: [],
    validity: { valid: true, issues: [], base: { valid: true }, candidate: { valid: true } },
    gpuTiming: { base: null, candidate: null, auto: { base, candidate } }
  });
  const stable = { stability: { status: "stable", clockSensitive: false }, clockSensitive: false };
  const sensitive = { stability: { status: "stable", clockSensitive: true }, clockSensitive: true };
  const unstable = { stability: { status: "unstable", clockSensitive: false }, clockSensitive: false };

  assert.equal(trustOf(withAuto(stable, stable)), "Trust: base valid, cand valid; GPU stable both sides");
  assert.equal(trustOf(withAuto(stable, sensitive)), "Trust: base valid, cand valid; GPU clock-sensitive cand");
  assert.equal(trustOf(withAuto(sensitive, sensitive)), "Trust: base valid, cand valid; GPU clock-sensitive both sides");
  assert.equal(trustOf(withAuto(unstable, sensitive)), "Trust: base valid, cand valid; GPU unstable base");
  assert.equal(trustOf({ ...withAuto(sensitive, sensitive), mode: "paired" }), "Trust: base valid, cand valid; GPU stable both sides");
  // No GPU timing on either side: no GPU claim at all.
  assert.equal(trustOf({ ...withAuto(null, null), gpuTiming: { base: null, candidate: null } }), "Trust: base valid, cand valid");

  // A budget metric neither capture has: both captures valid, the comparison INVALID, and the Trust line says why.
  const missing = compareReports(capture, capture, { budget: { metrics: { "custom.score.mean": { maxRegressionPercent: 5 } } } });
  assert.equal(missing.status, "invalid");
  const digest = formatAgentComparison(missing);
  assert.match(digest, /^INVALID/);
  // Line 1 names the invalid reason, not an unrelated row reason.
  assert.match(digest.split("\n")[0], /missing-metric/);
  assert.doesNotMatch(digest.split("\n")[0], /separate-capture-gpu/);
  assert.match(digest, /^Trust: base valid, cand valid; comparison invalid: missing-metric \(custom\.score\.mean is missing from both reports\); GPU clock-sensitive both sides$/m);
});

test("comparison Not gated line names every changed metric or counts the rest", () => {
  const row = (key) => ({ key, status: "changed", gated: false, base: 1, candidate: 2 });
  const result = {
    mode: "paired",
    rows: ["trace.durationMs", "warmup.durationMs", "frame.fps.p95", "cdp.JSHeapUsedSize.after", "trace.gpu.eventCount"].map(row),
    validity: { valid: true, issues: [] }
  };
  assert.match(formatAgentComparison(result), /^Not gated: 5 changed \(trace\.durationMs, warmup\.durationMs, fps\.p95, \+2 more\)$/m);
  result.rows = result.rows.slice(0, 2);
  assert.match(formatAgentComparison(result), /^Not gated: 2 changed \(trace\.durationMs, warmup\.durationMs\)$/m);
});

test("Next: confirm with ab uses a baseline placeholder after an in-place edit and copies capture flags", () => {
  const unverified = {
    mode: "separate",
    primary: { key: "health.autoGpuFrameMs.p50", selection: "bottleneck", row: { key: "health.autoGpuFrameMs.p50", base: 2, candidate: 1.8, unit: "ms", status: "unverified", reasons: ["separate-capture-gpu"] } },
    rows: [],
    validity: { valid: true, issues: [] }
  };
  const nextOf = (extra, options) => formatAgentComparison({ ...unverified, ...extra }, { cwd: "/work/app", ...options }).split("\n").find((line) => line.startsWith("Next:"));

  assert.equal(nextOf({ baseFile: "/work/app/index.html", candidateFile: "/work/app/index.html" }),
    "Next: confirm with ab --base-file <baseline-copy.html> --candidate-file index.html --metric health.autoGpuFrameMs.p50");
  assert.equal(nextOf({ baseUrl: "http://localhost:5173/", candidateUrl: "http://localhost:5173/" }),
    "Next: confirm with ab --base-url <baseline-url> --candidate-url http://localhost:5173/ --metric health.autoGpuFrameMs.p50");
  assert.equal(nextOf({ baseUrl: "http://localhost:5174/", candidateUrl: "http://localhost:5173/" }),
    "Next: confirm with ab --base-url http://localhost:5174/ --candidate-url http://localhost:5173/ --metric health.autoGpuFrameMs.p50");

  const baseOptions = {
    fileRoot: "/work/app", autoInstrument: true, gpuTiming: true, api: "auto", samplingMode: "hook", hookName: "__gpuReportBench",
    waitForHook: true, waitUntil: "load", waitCondition: "window.ready === true", viewport: "800x600", deviceScaleFactor: 2
  };
  assert.equal(nextOf({ baseFile: "/work/app/base.html", candidateFile: "/work/app/index.html" }, { baseOptions }),
    "Next: confirm with ab --base-file base.html --candidate-file index.html --metric health.autoGpuFrameMs.p50"
      + " --file-root . --sampling-mode hook --wait-until load --wait-condition 'window.ready === true' --viewport 800x600 --device-scale-factor 2");
  // Defaults copy nothing; --wait-for-hook only outside hook mode, where it is not implied.
  assert.equal(nextOf({ baseFile: "/work/app/base.html", candidateFile: "/work/app/index.html" }, {
    baseOptions: { autoInstrument: true, gpuTiming: true, api: "auto", samplingMode: "frames", waitForHook: true, waitUntil: "networkidle", viewport: "1280x720", deviceScaleFactor: 1 }
  }), "Next: confirm with ab --base-file base.html --candidate-file index.html --metric health.autoGpuFrameMs.p50 --wait-for-hook");
});

test("capture Bound line gives no GPU share when the classifier left GPU time untrusted", async () => {
  const capture = JSON.parse(await readFile(path.join(root, "test/fixtures/v3/report-capture.json"), "utf8"));
  capture.summary.bottleneck = { ...capture.summary.bottleneck, gpuMs: null, gpuShare: null, gpuSource: null };
  const bound = formatAgentReport(capture).split("\n").find((line) => line.startsWith("Bound:"));
  assert.equal(bound, "Bound: vsync-capped 60 Hz; GPU 8.41 ms (untrusted), CPU 1.3 ms/frame → primary health.autoGpuFrameMs.p50");
  // Reports whose bottleneck predates gpuMs keep using the measured GPU time.
  delete capture.summary.bottleneck.gpuMs;
  capture.summary.bottleneck.gpuShare = 0.505;
  assert.match(formatAgentReport(capture), /^Bound: vsync-capped 60 Hz; GPU 8\.41 ms \(51% of 16\.67 ms\)/m);
});

test("normalizeCliError infers codes from the message, not from stack frame URLs", () => {
  const hookException = new Error("Error: hook threw: scene not ready\n    at __gpuReportBench (http://127.0.0.1:5173/src/browser/bench.js:4:11)\n    at http://127.0.0.1:5173/src/chrome/loop.js:9:3");
  assert.equal(normalizeCliError(hookException).code, "command-failed");
  assert.equal(normalizeCliError(Object.assign(new Error("Timed out after 15000 ms waiting for benchmark hook x (--wait-for-hook-timeout)."), { code: "hook-timeout" })).code, "hook-timeout");
  assert.equal(normalizeCliError(new Error("Failed to launch Chrome: spawn EACCES")).code, "browser-launch-failed");
  // Page messages that only mention the browser, or load src/browser/*, are not launch failures.
  assert.equal(normalizeCliError(new Error("WebGPU is not supported in this browser")).code, "command-failed");
  assert.equal(normalizeCliError(new Error("Failed to fetch dynamically imported module: http://127.0.0.1:5173/src/browser/timing.js")).code, "command-failed");
  assert.equal(normalizeCliError(new Error("Chrome failed to start (exit 1)")).code, "browser-launch-failed");
  // The full message (with the page's stack location) is kept.
  assert.match(normalizeCliError(hookException).message, /bench\.js:4:11/);
});
