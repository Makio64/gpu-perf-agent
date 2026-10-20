// L3b decisions on the v3 fixtures: summary (§1.9), bottleneck (§5.2), findings and verdict (§5.3),
// heap (§5.4) and the compare rules of §4 that need v3 data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeReport, classifyBottleneck, finalizeReport, heapSummary } from "../src/analysis.js";
import { buildFindings, verdictFromFindings } from "../src/diagnostics.js";
import { compareReports, comparisonStatus, DECISION_METRICS, rowScreen, selectPrimaryMetric, workEquivalence } from "../src/compare.js";
import { aggregateReports } from "../src/ab-runner.js";
import { comparisonExitCode } from "../src/output.js";
import { generateAgentCompareDigest } from "../src/agent.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v3/${name}`, import.meta.url), "utf8"));
const REPORT_KEYS = ["schemaVersion", "tool", "summary", "diagnostics", "options", "timings", "target", "artifacts", "measurementLock",
  "cpuProfile", "inPage", "cdp", "pageEventSummary", "pageEvents", "trace", "browser", "host", "createdAt"];
const VARIANTS = ["report-capture.json", "report-saturated.json", "report-clock-sensitive.json", "report-hook-warm.json",
  "report-hook-vsync.json", "report-hookmode.json", "report-blank.json", "report-cdp-attached-zero.json"];
const codes = summary => summary.findings.map(finding => finding.code);

test("finalizeReport writes schemaVersion 3, the §1 key order and the §1.9 summary shape without mutating its input", () => {
  const example = fixture("summary.json");
  for (const name of [...VARIANTS, "report-v2.json"]) {
    const report = fixture(name);
    const before = JSON.stringify(report);
    const finalized = finalizeReport(report);
    assert.equal(JSON.stringify(report), before, name);
    assert.equal(finalized.schemaVersion, 3, name);
    const keys = Object.keys(finalized);
    assert.deepEqual(keys.filter(key => REPORT_KEYS.includes(key)), REPORT_KEYS.filter(key => keys.includes(key)), name);
    assert.deepEqual(Object.keys(finalized.summary), Object.keys(example), name);
    assert.deepEqual(Object.keys(finalized.summary.bottleneck), Object.keys(example.bottleneck), name);
    assert.deepEqual(Object.keys(finalized.summary.gpu), Object.keys(example.gpu), name);
    assert.equal(finalized.summary.warningCount, finalized.summary.warnings.length, name);
    for (const finding of finalized.summary.findings) {
      assert.deepEqual(Object.keys(finding).slice(0, 9), ["code", "role", "severity", "value", "threshold", "unit", "message", "next", "aliases"], name);
    }
    assert.deepEqual(finalized.diagnostics.validity, finalized.diagnostics.validity && JSON.parse(JSON.stringify(finalized.diagnostics.validity)));
    assert.equal(finalized.diagnostics.signal.gpuTiming.schemaVersion, 2, name);
  }
});

test("decision fields of every v3 fixture match the §5 rules the fixtures were written from", () => {
  for (const name of VARIANTS) {
    const expected = fixture(name).summary;
    const { summary } = analyzeReport(fixture(name));
    assert.equal(summary.verdict, expected.verdict, `${name} verdict`);
    assert.equal(summary.bottleneck.class, expected.bottleneck.class, `${name} class`);
    // L3b fix: a trusted warm hook is the primary even when auto timing classifies the page, because auto GPU
    // never gates between separate captures (§4.2). The fixture's precomputed summary predates that rule.
    const primary = name === "report-hook-warm.json" ? "health.gpuFrameMs.mean" : expected.bottleneck.primaryMetric;
    assert.equal(summary.bottleneck.primaryMetric, primary, `${name} primary`);
    assert.equal(summary.bottleneck.gpuSource, expected.bottleneck.gpuSource, `${name} gpuSource`);
    assert.equal(summary.bottleneck.gpuSaturated, expected.bottleneck.gpuSaturated, `${name} saturated`);
    assert.deepEqual(summary.verdictReasons.map(reason => reason.code), expected.verdictReasons.map(reason => reason.code), `${name} reasons`);
    assert.equal(summary.slowFrameCount, expected.slowFrameCount, `${name} slow`);
    assert.equal(summary.idleSampleCount, expected.idleSampleCount, `${name} idle`);
  }
});

test("w-gpu-heavy (saturated at 60 FPS) is gpu-bound, needs work for gpu-near-budget, and never reports a GPU share", () => {
  const { summary } = analyzeReport(fixture("report-saturated.json"));
  assert.equal(summary.bottleneck.class, "gpu-bound");
  assert.equal(summary.bottleneck.primaryMetric, "frame.frameTimeMs.mean");
  assert.equal(summary.bottleneck.gpuShare, null);
  assert.equal(summary.bottleneck.headroomMs, null);
  assert.ok(["needs-work", "poor"].includes(summary.verdict));
  assert.equal(summary.verdictReasons[0].code, "gpu-near-budget");
  assert.equal(summary.verdictReasons[0].severity, "high");
  assert.match(summary.verdictReasons[0].message, /GPU ≥ budget \(saturated\)/);
  assert.doesNotMatch(summary.verdictReasons[0].message, /% of/);
  assert.deepEqual(summary.warnings.map(warning => warning.code), ["gpu-near-budget"]);
  assert.deepEqual(summary.recommendations[0].id, "gpu-near-budget");
});

test("a healthy page with startup sync pipelines stays excellent; the pipelines are info only", () => {
  const { summary } = analyzeReport(fixture("report-capture.json"));
  assert.equal(summary.verdict, "excellent");
  assert.deepEqual(summary.pipelines, { syncCount: 3, asyncCount: 0, shaderModules: 2, syncInWindow: 0 });
  const startup = summary.findings.find(finding => finding.code === "startup-sync-pipelines");
  assert.equal(startup.role, "info");
  assert.ok(summary.highlights.includes(startup.message));
  assert.equal(summary.warnings.length, 0);
  assert.equal(summary.bottleneck.reason, "fps pinned at 60 Hz; GPU 50% of budget");
  assert.equal(summary.gpu.passes[0].key, "render#0");
});

test("sampling-window pipeline creation is a stall; churn needs two non-zero samples", () => {
  const report = fixture("report-capture.json");
  report.inPage.instrumentation.delta["webgpu.createRenderPipeline"] = 2;
  report.inPage.summary.perFrame = { ...report.inPage.summary.perFrame, createBuffer: 0.5, createBindGroup: 2,
    nonZeroSamples: { createBindGroup: 2, createBuffer: 1, createTexture: 0 } };
  report.inPage.summary.churnSites = { createBindGroup: [{ site: "makeFrameBindGroups multipass.js:59", count: 20 }] };
  const { summary } = analyzeReport(report);
  assert.equal(summary.pipelines.syncInWindow, 2);
  assert.ok(codes(summary).includes("pipeline-sync-stall"));
  assert.ok(!codes(summary).includes("resource-churn"), "one non-zero sample is not churn");
  const bindGroups = summary.findings.find(finding => finding.code === "bind-group-churn");
  assert.equal(bindGroups.severity, "low");
  assert.match(bindGroups.next, /multipass\.js:59/);
  assert.equal(summary.verdict, "needs-work");
  report.inPage.summary.perFrame.nonZeroSamples.createBuffer = 4;
  assert.ok(codes(analyzeReport(report).summary).includes("resource-churn"));
});

test("slow frames use only frameDeltasMs > 1.5 × budget; slowFrameThresholdMs never changes them", () => {
  const report = fixture("report-capture.json");
  const deltas = report.inPage.summary.frameDeltasMs;
  deltas.splice(0, 4, 26, 30, 70.1, 24.9);
  const first = analyzeReport(report).summary;
  assert.equal(first.slowFrameCount, 3);
  assert.equal(first.slowFrameRate, Math.round(3 / deltas.length * 1e6) / 1e6);
  assert.ok(codes(first).includes("stutter"));
  report.options.slowFrameThresholdMs = 50;
  const second = analyzeReport(report, { slowFrameThresholdMs: 50 }).summary;
  assert.equal(second.slowFrameCount, 3);
  assert.equal(second.frameTimeMsMax, 70.1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const index = (sorted.length - 1) * 0.95;
  const p95 = sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index - Math.floor(index));
  assert.ok(Math.abs(second.frameTimeMsP95 - p95) < 1e-3, "p95 is pooled from frameDeltasMs");
});

test("§5.2 classes: hook mode unknown, blank page unknown, cpu-bound with submission subtype, gpu/compositor and mixed", () => {
  assert.equal(classifyBottleneck(fixture("report-hookmode.json")).class, "unknown");
  assert.equal(classifyBottleneck(fixture("report-hookmode.json")).primaryMetric, "health.gpuFrameMs.mean");
  const blank = analyzeReport(fixture("report-blank.json")).summary;
  assert.equal(blank.verdict, "unknown");
  assert.equal(blank.bottleneck.class, "unknown");
  const attached = classifyBottleneck(fixture("report-cdp-attached-zero.json"));
  assert.equal(attached.gpuMs, null);
  assert.equal(attached.primaryMetric, "health.cpuMsPerFrame");
  assert.match(attached.reason, /GPU headroom unknown/);

  const slow = (busy, gpuNs) => {
    const report = fixture("report-capture.json");
    report.inPage.summary.fps.mean = 40;
    report.inPage.summary.frameDeltasMs = report.inPage.summary.frameDeltasMs.map(() => 25);
    const metrics = report.cdp.after.performanceMetrics, start = report.cdp.before.performanceMetrics;
    metrics.TaskDuration = start.TaskDuration + busy * (metrics.Timestamp - start.Timestamp);
    if (gpuNs !== undefined) for (const key of ["p50", "p95", "mean", "min", "max"]) report.inPage.summary.autoGpu.frameNs[key] = gpuNs;
    return report;
  };
  const cpu = slow(0.95);
  cpu.cpuProfile = { classification: "submission-bound", top: [{ fn: "drawArrays", selfMsPerFrame: 15.3, caller: { fn: "submitDraws" } }] };
  const cpuSummary = analyzeReport(cpu).summary;
  assert.equal(cpuSummary.bottleneck.class, "cpu-bound");
  assert.equal(cpuSummary.bottleneck.subtype, "submission-bound");
  assert.equal(cpuSummary.bottleneck.primaryMetric, "frame.frameTimeMs.mean");
  const cause = cpuSummary.findings.find(finding => finding.code === "cpu-bound");
  assert.equal(cause.severity, "medium");
  assert.match(cause.next, /drawArrays.*submitDraws/);
  assert.equal(classifyBottleneck(slow(0.1)).class, "gpu/compositor-bound");
  assert.equal(classifyBottleneck(slow(0.6)).class, "mixed");
  const gpuLimited = slow(0.1, 23e6);
  assert.equal(classifyBottleneck(gpuLimited).class, "gpu-bound");
  assert.ok(codes(analyzeReport(gpuLimited).summary).includes("gpu-bound"));
  assert.ok(!codes(analyzeReport(gpuLimited).summary).includes("gpu-near-budget"), "gpu-bound already fired on the same evidence");
});

test("half-rate rendering is judged by the page's own frame rate (fpsEff)", () => {
  const report = fixture("report-capture.json");
  report.inPage.summary.activity = { pageFps: { mean: 30 }, activeFrameRatio: 0.5, idleSampleIndices: [] };
  const { summary } = analyzeReport(report);
  assert.equal(summary.pageFps, 30);
  assert.notEqual(summary.verdict, "excellent");
  assert.ok(codes(summary).includes("frame-rate-below-refresh") || codes(summary).includes("gpu-bound"));
});

test("verdictFromFindings: invalid, unknown, poor, needs-work, good, excellent", () => {
  const cause = severity => ({ code: "x", role: "cause", severity });
  const valid = { valid: true, issues: [], warnings: [] };
  assert.equal(verdictFromFindings([cause("high")], { valid: false, issues: [{}], warnings: [] }).verdict, "invalid");
  assert.equal(verdictFromFindings([], { valid: true, issues: [], warnings: [{ code: "gpu-work-unobserved" }] }).verdict, "unknown");
  assert.equal(verdictFromFindings([cause("high"), cause("high")], valid).verdict, "poor");
  assert.equal(verdictFromFindings([], valid, { fpsEff: 25, hz: 60 }).verdict, "poor");
  assert.equal(verdictFromFindings([], valid, { frameTimeMsP95: 60, hz: 60, budgetMs: 16.67 }).verdict, "poor");
  assert.equal(verdictFromFindings([], valid, { retainedMiBPerSec: 6 }).verdict, "poor");
  assert.equal(verdictFromFindings([cause("medium"), { code: "s", role: "symptom", severity: "high" }], valid).verdict, "needs-work");
  assert.equal(verdictFromFindings([cause("low"), { code: "i", role: "info", severity: "info" }], valid).verdict, "good");
  assert.equal(verdictFromFindings([{ code: "s", role: "symptom", severity: "high" }], valid).verdict, "excellent");
  const reasons = verdictFromFindings([cause("low"), cause("high"), cause("medium"), cause("medium")], valid).reasons;
  assert.deepEqual(reasons.map(reason => reason.severity), ["high", "medium", "medium"]);
});

test("verdictFromFindings(findings, validity) reaches analyzeReport's verdict: the findings carry the poor inputs", () => {
  const report = fixture("report-capture.json");
  report.inPage.summary.frameDeltasMs = report.inPage.summary.frameDeltasMs.map(() => 40);
  report.inPage.summary.fps = { ...report.inPage.summary.fps, mean: 25 };
  for (const sample of report.inPage.samples) { sample.measurement.observedFrames.frameTimeMs.mean = 40; sample.measurement.observedFrames.fps = 25; }
  const { summary, diagnostics } = analyzeReport(report);
  assert.equal(summary.verdict, "poor");
  assert.equal(verdictFromFindings(summary.findings, diagnostics.validity).verdict, "poor");
  assert.ok(summary.verdictReasons.every(reason => !("evidence" in reason)), "verdictReasons stay compact");
  for (const name of VARIANTS) {
    const analysis = analyzeReport(fixture(name));
    assert.equal(verdictFromFindings(analysis.summary.findings, analysis.diagnostics.validity).verdict, analysis.summary.verdict, name);
  }
});

test("hook mode: hook-returned fps and frame times never set the verdict or frame symptoms", () => {
  const report = fixture("report-hookmode.json");
  report.inPage.summary.fps = { mean: 8 };
  report.inPage.summary.frameTimeMsMean = { mean: 100 };
  report.inPage.summary.frameTimeMsP95 = { mean: 120, p95: 120 };
  const { summary } = analyzeReport(report);
  assert.equal(summary.bottleneck.class, "unknown");
  assert.equal(summary.verdict, "excellent");
  assert.deepEqual(summary.verdictReasons, []);
  assert.ok(!codes(summary).includes("low-fps") && !codes(summary).includes("frame-jitter"));
  assert.equal(verdictFromFindings([], { valid: true, issues: [], warnings: [] }, { hookMode: true, fpsEff: 8, hz: 60 }).verdict, "excellent");
});

test("a warm hook is the primary next to auto timing, so a separate-capture warm regression sets the headline", () => {
  const make = scale => {
    const report = fixture("report-hook-warm.json");
    delete report.summary; delete report.diagnostics;
    report.inPage.samples.forEach((sample, index) => {
      sample.measurement.gpuTimeNs = Math.round(sample.measurement.gpuTimeNs * scale * (1 + (index % 3 - 1) * 0.002));
      for (const key of ["p50", "p95", "mean", "min", "max"]) sample.autoGpu.frameNs[key] = Math.round(sample.autoGpu.frameNs[key] * scale);
    });
    const pooled = report.inPage.summary.autoGpu;
    for (const key of ["p50", "p95", "mean", "min", "max"]) pooled.frameNs[key] = Math.round(pooled.frameNs[key] * scale);
    pooled.perSampleP50Ns = pooled.perSampleP50Ns.map(value => Math.round(value * scale));
    return finalizeReport(report);
  };
  const base = make(1);
  assert.equal(base.summary.bottleneck.gpuSource, "auto", "auto still classifies");
  assert.equal(base.summary.bottleneck.primaryMetric, "health.gpuFrameMs.mean");
  const result = compareReports(base, make(1.2));
  assert.equal(result.primary.key, "health.gpuFrameMs.mean");
  assert.equal(result.status, "regression");
  assert.equal(result.exitCode, 1);
  assert.equal(result.rows.find(row => row.key === "health.autoGpuFrameMs.p50").status, "unverified");
  assert.equal(compareReports(base, make(1)).exitCode, 0);
  // A baseline whose bottleneck names auto GPU (written before this rule, or unclassified) still yields to the
  // warm hook in separate mode; paired mode keeps §4.3's order because auto gates there.
  const legacyBase = fixture("report-hook-warm.json");
  assert.equal(legacyBase.summary.bottleneck.primaryMetric, "health.autoGpuFrameMs.p50");
  const legacy = compareReports(legacyBase, make(1.2));
  assert.deepEqual([legacy.primary.key, legacy.status], ["health.gpuFrameMs.mean", "regression"]);
  assert.equal(selectPrimaryMetric(legacyBase, make(1.2), null, { paired: true }).key, "health.autoGpuFrameMs.p50");
});

test("auto timing that is stable but partial is still trusted (§5.1)", () => {
  const report = fixture("report-saturated.json");
  report.inPage.summary.autoGpu.status = "partial";
  const { summary } = analyzeReport(report);
  assert.equal(summary.bottleneck.class, "gpu-bound");
  assert.equal(summary.bottleneck.gpuSaturated, true);
});

test("buildFindings maps old codes through aliases and keeps one rule set", () => {
  const { summary } = analyzeReport(fixture("report-saturated.json"));
  assert.deepEqual(summary.findings.find(finding => finding.code === "gpu-near-budget").aliases, ["high-gpu-time"]);
  const findings = buildFindings({ report: {}, bottleneck: { class: "vsync-capped" }, gpu: { auto: {}, hook: {} }, refreshHz: 60, budgetMs: 16.67,
    fps: 60, fpsEff: 60, heap: { method: "gc-bracket", retainedMiBPerSec: 1, retainedBytes: 2 * 1024 * 1024 }, slowFrameCount: 0,
    observedFrameCount: 90, trackedVram: { totalMiB: 2048 }, thresholds: {} });
  const leak = findings.find(finding => finding.code === "heap-leak");
  assert.deepEqual([leak.role, leak.severity], ["cause", "medium"]);
  assert.ok(leak.aliases.includes("high-js-heap-churn"));
  assert.deepEqual(findings.find(finding => finding.code === "high-vram").severity, "high");
});

test("heapSummary: gc bracket, hook median (flagged and quiet), short windows and unavailable", () => {
  const capture = fixture("report-capture.json");
  const heap = heapSummary(capture);
  assert.equal(heap.method, "gc-bracket");
  assert.equal(heap.retainedBytes, 1200);
  assert.ok(heap.retainedMiBPerSec < 0.01);
  capture.inPage.memory.retained.deltaBytes = 3 * 1024 * 1024;
  const leaking = analyzeReport(capture).summary;
  assert.ok(leaking.heap.retainedMiBPerSec > 1);
  assert.ok(codes(leaking).includes("heap-leak"));
  assert.equal(leaking.jsHeapGrowthMBPerSec, leaking.heap.retainedMiBPerSec);

  const hook = fixture("report-hookmode.json");
  assert.equal(heapSummary(hook).method, "hook-median");
  assert.equal(heapSummary(hook).flagged, false);
  hook.inPage.samples.forEach((sample, index) => { sample.memory.delta.performanceMemory.usedJSHeapSize = index < 4 ? 200 * 1024 : 0; });
  // Pre-GC per-sample growth whose GC bracket retained almost nothing is allocation churn, not a leak.
  assert.equal(heapSummary(hook).flagged, false, "churn collected by GC");
  hook.inPage.memory.retained.deltaBytes = 4 * 200 * 1024;
  assert.equal(heapSummary(hook).flagged, true);
  assert.equal(heapSummary(hook).retainedMiBPerSec, null);
  assert.ok(codes(analyzeReport(hook).summary).includes("heap-leak"));
  delete hook.inPage.memory.retained;
  assert.equal(heapSummary(hook).flagged, true, "hook mode without a bracket uses the median rule alone");
  // One sample (the ab default) or frames mode without a bracket never flags.
  const single = fixture("report-hookmode.json");
  single.inPage.samples = single.inPage.samples.slice(0, 1);
  single.inPage.samples[0].memory.delta.performanceMemory.usedJSHeapSize = 800 * 1024;
  single.inPage.memory.retained.deltaBytes = 800 * 1024;
  assert.deepEqual([heapSummary(single).method, heapSummary(single).flagged], ["hook-median", false]);
  assert.ok(!codes(analyzeReport(single).summary).includes("heap-leak"));
  const round = fixture("report-capture.json");
  round.inPage.samples = round.inPage.samples.slice(0, 1);
  round.inPage.samples[0].memory.delta.performanceMemory.usedJSHeapSize = 600 * 1024;
  round.inPage.memory.retained.windowMs = 250;
  const roundSummary = analyzeReport(round).summary;
  assert.deepEqual([roundSummary.heap.method, roundSummary.heap.flagged], ["hook-median", false]);
  assert.ok(!codes(roundSummary).includes("heap-leak"));
  const churn = fixture("report-capture.json");
  churn.inPage.samples.forEach(sample => { sample.memory.delta.performanceMemory.usedJSHeapSize = 275 * 1024; });
  churn.inPage.memory.retained.windowMs = 900;
  delete churn.inPage.memory.retained.available;
  assert.equal(heapSummary(churn).flagged, false, "frames-mode churn without a GC bracket");

  const short = fixture("report-capture.json");
  short.inPage.memory.retained.windowMs = 250;
  assert.equal(heapSummary(short).method, "hook-median");
  const none = fixture("report-capture.json");
  none.inPage.memory.retained = { available: false };
  assert.deepEqual([heapSummary(none).method, heapSummary(none).retainedMiBPerSec], ["unavailable", null]);
  assert.equal(heapSummary(fixture("report-v2.json")).method, "unavailable", "CDP JSHeapUsedSize is never used");
});

test("cpuMsPerFrame is the per-sample median of ThreadTime share × frame time (§4.1)", () => {
  const report = fixture("report-capture.json");
  const { summary } = analyzeReport(report);
  const expected = report.cdp.samples.map(sample => {
    const frame = report.inPage.samples.find(item => item.index === sample.index).measurement.observedFrames.frameTimeMs.mean;
    return sample.threadTimeS / (sample.endTs - sample.startTs) * frame;
  }).sort((a, b) => a - b);
  assert.ok(Math.abs(summary.cpuMsPerFrame - (expected[2] + expected[3]) / 2) < 1e-3);
  assert.equal(summary.mainThreadBusy, 0.08);
});

// ---------------------------------------------------------------- compare on v3 data

test("separate captures never gate auto GPU rows; the screen shows the direction", () => {
  const base = fixture("report-capture.json");
  const candidate = fixture("report-capture.json");
  for (const sample of candidate.inPage.samples) for (const key of ["p50", "p95", "mean", "min", "max"]) sample.autoGpu.frameNs[key] *= 1.4;
  for (const key of ["p50", "p95", "mean", "min", "max"]) candidate.inPage.summary.autoGpu.frameNs[key] *= 1.4;
  const result = compareReports(base, candidate);
  const row = result.rows.find(item => item.key === "health.autoGpuFrameMs.p50");
  assert.equal(row.status, "unverified");
  assert.deepEqual(row.reasons, ["separate-capture-gpu"]);
  assert.equal(row.screen, "worse");
  assert.equal(result.primary.key, "health.autoGpuFrameMs.p50");
  assert.equal(result.primary.selection, "bottleneck");
  assert.equal(result.status, "unverified");
  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, "separate");
  assert.equal(result.kind, "comparison");
  assert.equal(result.schemaVersion, 2);
});

test("a v2 baseline against a v3 candidate is unverified with a schemaVersion warning, never a mismatch", () => {
  const base = fixture("report-v2.json");
  const candidate = fixture("report-capture.json");
  candidate.options.chromiumArgs = base.options.chromiumArgs; // same launch; only the schema differs
  const result = compareReports(base, candidate);
  assert.deepEqual(result.compatibility.warnings, [{ key: "schemaVersion", base: 2, candidate: 3 }]);
  assert.ok(!result.compatibility.differences.some(difference => difference.key === "schemaVersion"));
  assert.equal(result.status, "unverified");
  assert.equal(result.exitCode, 0);
  assert.match(result.statusReasons[0], /schemaVersion 2; recapture the baseline/);
  // Reversed: the older report is the candidate, so that is the side to recapture.
  const reversed = compareReports(candidate, base);
  assert.equal(reversed.status, "unverified");
  assert.equal(reversed.statusReasons[0], "candidate from schemaVersion 2; recapture the candidate");
  const missing = result.rows.find(row => row.key === "health.autoGpuFrameMs.p50");
  assert.deepEqual(missing.reasons, ["missing-base"]);
});

test("compared option keys: gpuTiming differs, an absent key is unknown, slowFrameThresholdMs and readyTimeoutMs are ignored", () => {
  const base = fixture("report-capture.json");
  const candidate = fixture("report-capture.json");
  candidate.options.gpuTiming = false;
  candidate.options.slowFrameThresholdMs = 50;
  candidate.options.readyTimeoutMs = 0;
  let result = compareReports(base, candidate);
  assert.deepEqual(result.compatibility.differences.map(item => item.key), ["gpuTiming"]);
  assert.equal(result.status, "mismatch");
  assert.equal(result.exitCode, 2);
  assert.equal(comparisonStatus(result, { allowMismatch: true }).exitCode, 0);
  delete base.options.gpuTiming;
  result = compareReports(base, candidate);
  assert.equal(result.compatibility.compatible, true);
});

test("paired gating needs ≥ 4 rounds; saturated auto timing gates only toward the saturated side; deterministic rows always do", () => {
  const rounds = (n, scale) => Array.from({ length: n }, () => {
    const report = fixture("report-capture.json");
    for (const sample of report.inPage.samples) for (const key of ["p50", "p95", "mean", "min", "max"]) sample.autoGpu.frameNs[key] *= scale;
    for (const key of ["p50", "p95", "mean", "min", "max"]) report.inPage.summary.autoGpu.frameNs[key] *= scale;
    return report;
  });
  const three = compareReports(aggregateReports(rounds(3, 1)), aggregateReports(rounds(3, 1.3)), { paired: true });
  assert.deepEqual(three.rows.find(row => row.key === "health.autoGpuFrameMs.p50").reasons, ["too-few-rounds"]);
  const four = compareReports(aggregateReports(rounds(4, 1)), aggregateReports(rounds(4, 1.3)), { paired: true });
  const gpu = four.rows.find(row => row.key === "health.autoGpuFrameMs.p50");
  assert.equal(gpu.status, "regression");
  assert.equal(gpu.evidence, "paired-samples");
  assert.equal(gpu.confidence95.method, "paired-t");
  assert.equal(four.status, "regression");
  assert.equal(four.exitCode, 1);
  assert.equal(four.mode, "paired");
  // One side saturated: only the outcome where the saturated side is slower gates (its value is a floor).
  const autoRow = result => result.rows.find(row => row.key === "health.autoGpuFrameMs.p50");
  const newly = compareReports(aggregateReports(rounds(4, 1)), aggregateReports(rounds(4, 2.2)), { paired: true });
  assert.deepEqual([aggregateReports(rounds(4, 1)).autoGpu.saturated, aggregateReports(rounds(4, 2.2)).autoGpu.saturated], [false, true]);
  assert.deepEqual([autoRow(newly).status, autoRow(newly).gated, autoRow(newly).notes.includes("candidate-saturated")], ["regression", true, true]);
  assert.equal(newly.status, "regression");
  const relieved = compareReports(aggregateReports(rounds(4, 2.2)), aggregateReports(rounds(4, 1)), { paired: true });
  assert.deepEqual([autoRow(relieved).status, autoRow(relieved).gated], ["improved", true]);
  const both = compareReports(aggregateReports(rounds(4, 2.2)), aggregateReports(rounds(4, 2.3)), { paired: true });
  assert.deepEqual([autoRow(both).status, autoRow(both).reasons], ["unverified", ["gpu-saturated"]]);
});

test("instancing (draws 200 → 1) with a paired GPU improvement is improved and lists the work difference", () => {
  const variant = (draws, scale) => Array.from({ length: 4 }, () => {
    const report = fixture("report-capture.json");
    report.inPage.summary.perFrame = { ...report.inPage.summary.perFrame, drawCalls: draws };
    for (const sample of report.inPage.samples) for (const key of ["p50", "p95", "mean", "min", "max"]) sample.autoGpu.frameNs[key] *= scale;
    for (const key of ["p50", "p95", "mean", "min", "max"]) report.inPage.summary.autoGpu.frameNs[key] *= scale;
    return finalizeReport(report);
  });
  const base = aggregateReports(variant(200, 1));
  const candidate = aggregateReports(variant(1, 0.8));
  const result = compareReports(base, candidate, { paired: true });
  assert.equal(result.primary.key, "health.autoGpuFrameMs.p50");
  assert.equal(result.primary.row.status, "improved");
  assert.equal(result.workEquivalence.status, "same");
  assert.deepEqual(result.workEquivalence.differences[0], { key: "draws/f", base: 200, candidate: 1, deltaPercent: -99.5 });
  assert.equal(result.rows.find(row => row.key === "health.drawCallsPerFrame").status, "improved");
  assert.equal(result.status, "improved");

  const errors = variant(1, 0.8).map(report => { report.summary.gpuErrors = { total: 3, inWindow: 0, top: [] }; return report; });
  const different = compareReports(base, aggregateReports(errors), { paired: true });
  assert.equal(different.workEquivalence.status, "different");
  assert.equal(different.status, "different-work");
  assert.equal(different.exitCode, 0);
});

test("workEquivalence: reduced-to-zero and same", () => {
  const base = fixture("report-capture.json");
  const empty = fixture("report-capture.json");
  empty.inPage.summary.perFrame = { ...empty.inPage.summary.perFrame, drawCalls: 0, dispatches: 0, glClears: 0, glDrawCalls: 0, bundleDraws: 0 };
  empty.inPage.instrumentation.delta["webgpu.queueSubmits"] = 0;
  assert.equal(workEquivalence(base, empty).status, "reduced-to-zero");
  const fewer = fixture("report-capture.json");
  fewer.inPage.summary.perFrame = { ...fewer.inPage.summary.perFrame, drawCalls: 2, renderPasses: 1 };
  assert.equal(workEquivalence(base, fewer).status, "different", "work and passes collapsed");
  assert.deepEqual(workEquivalence(base, fixture("report-capture.json")), { status: "same", differences: [] });
});

test("cpuMsPerFrame A/A from per-run values (cube-aa, srv): never a regression between separate captures", () => {
  // cpums.mjs per-run ThreadTime-based values for the cube-aa and srv captures (ms/frame).
  const runs = [0.583, 0.248, 0.291, 0.295, 0.303, 0.312, 0.297, 0.299, 0.263, 0.289, 0.278, 0.263, 0.268, 0.272];
  const capture = (value, seed) => {
    const report = fixture("report-capture.json");
    report.cdp.samples.forEach((sample, index) => {
      const frame = report.inPage.samples.find(item => item.index === sample.index).measurement.observedFrames.frameTimeMs.mean;
      const jitter = 1 + ((index * 7 + seed) % 7 - 3) / 100; // within ±3%
      sample.threadTimeS = value * jitter / frame * (sample.endTs - sample.startTs);
    });
    return finalizeReport(report);
  };
  const reports = runs.map(capture);
  let pairs = 0;
  for (const [i, base] of reports.entries()) for (const [j, candidate] of reports.entries()) {
    if (i === j) continue;
    pairs++;
    const result = compareReports(base, candidate);
    const row = result.rows.find(item => item.key === "health.cpuMsPerFrame");
    assert.notEqual(row.status, "regression");
    assert.notEqual(result.exitCode, 1);
  }
  assert.equal(pairs, 182);
  const row = compareReports(reports[0], reports[1]).rows.find(item => item.key === "health.cpuMsPerFrame");
  assert.deepEqual([row.status, row.reasons], ["unverified", ["light-cpu-load"]]);
  assert.equal(row.screen, "better");
});

test("heavy CPU rows gate between separate captures only when stable", () => {
  const capture = (value, spread = 0) => {
    const report = fixture("report-capture.json");
    report.cdp.samples.forEach((sample, index) => {
      const frame = report.inPage.samples.find(item => item.index === sample.index).measurement.observedFrames.frameTimeMs.mean;
      sample.threadTimeS = value * (1 + (index % 2 ? spread : -spread) + index * 0.001) / frame * (sample.endTs - sample.startTs);
    });
    return finalizeReport(report);
  };
  const regressed = compareReports(capture(8), capture(10)).rows.find(row => row.key === "health.cpuMsPerFrame");
  assert.equal(regressed.status, "regression");
  assert.equal(regressed.gated, true);
  const drift = compareReports(capture(8, 0.1), capture(10)).rows.find(row => row.key === "health.cpuMsPerFrame");
  assert.deepEqual(drift.reasons, ["cpu-drift"]);
  // A gated CPU row is not the primary here, so a separate-capture regression does not fail the comparison.
  assert.equal(compareReports(capture(8), capture(10)).exitCode, 0);
});

test("selectPrimaryMetric follows §4.3", () => {
  const capture = fixture("report-capture.json");
  assert.deepEqual(selectPrimaryMetric(capture, capture), { key: "health.autoGpuFrameMs.p50", selection: "bottleneck" });
  assert.deepEqual(selectPrimaryMetric(capture, capture, "frame.fps.mean"), { key: "frame.fps.mean", selection: "explicit" });
  const raw = structuredClone(capture);
  delete raw.summary;
  assert.deepEqual(selectPrimaryMetric(raw, raw), { key: "health.autoGpuFrameMs.p50", selection: "default" });
  const warm = fixture("report-hook-warm.json");
  delete warm.summary.bottleneck;
  for (const report of [warm]) { delete report.inPage.summary.autoGpu; for (const sample of report.inPage.samples) delete sample.autoGpu; }
  assert.deepEqual(selectPrimaryMetric(warm, warm), { key: "health.gpuFrameMs.mean", selection: "default" });
  const hookMode = fixture("report-hookmode.json");
  delete hookMode.summary.bottleneck;
  hookMode.summary.gpuFrameMsMean = undefined;
  delete hookMode.summary.gpuFrameMsMean;
  assert.deepEqual(selectPrimaryMetric(hookMode, hookMode), { key: "custom.gpuMs.mean", selection: "default" });
  const missing = compareReports(capture, capture, { primaryMetric: "custom.absent.mean" });
  assert.equal(missing.primary.row.status, "unverified");
  assert.ok(missing.primary.row.reasons.includes("primary-missing"));
});

test("dedupe: the selected hook GPU leaf, trackedGpuMemory and timestamps are not custom rows", () => {
  const warm = fixture("report-hook-warm.json");
  for (const sample of warm.inPage.samples) sample.measurement.trackedGpuMemory = { totalBytes: 1 };
  for (const sample of warm.inPage.samples) sample.measurement.startedAtMs = 1;
  const keys = compareReports(warm, warm).rows.map(row => row.key);
  assert.ok(keys.includes("health.gpuFrameMs.mean"));
  assert.ok(!keys.some(key => /^custom\.(gpuTimeNs|trackedGpuMemory|gpuTiming)/.test(key)), keys.join(","));
  assert.ok(!keys.some(key => /\.(p95|max)$/.test(key) && key.startsWith("custom.")));
  assert.ok(!keys.includes("gpu.durationNs.mean"));
});

test("output.js, agent.js and comparisonStatus agree on the headline", () => {
  const base = fixture("report-capture.json");
  for (const [candidate, options] of [[fixture("report-capture.json"), {}], [fixture("report-v2.json"), {}],
    [Object.assign(fixture("report-capture.json"), { options: { ...fixture("report-capture.json").options, viewport: "1920x1080" } }), {}],
    [Object.assign(fixture("report-capture.json"), { options: { ...fixture("report-capture.json").options, viewport: "1920x1080" } }), { allowMismatch: true }]]) {
    const result = compareReports(base, candidate, options);
    const status = comparisonStatus(result, options);
    assert.equal(result.status, status.status);
    assert.equal(comparisonExitCode(result, options), status.exitCode);
    assert.equal(result.exitCode, status.exitCode);
    assert.match(generateAgentCompareDigest(base, candidate, options), new RegExp(`^${status.status.toUpperCase()}\\b`));
  }
});

test("DECISION_METRICS is frozen and rowScreen only screens unverified rows", () => {
  assert.ok(Object.isFrozen(DECISION_METRICS));
  assert.ok(Object.isFrozen(DECISION_METRICS["health.autoGpuFrameMs.p50"]));
  assert.throws(() => { "use strict"; DECISION_METRICS["x"] = 1; }, TypeError);
  assert.equal(rowScreen({ status: "unverified", base: 1, candidate: 2, boundary: 0.5, direction: "lower" }), "worse");
  assert.equal(rowScreen({ status: "unverified", base: 2, candidate: 1, boundary: 0.5, direction: "lower" }), "better");
  assert.equal(rowScreen({ status: "unverified", base: 1, candidate: 1.2, boundary: 0.5, direction: "lower" }), "same");
  assert.equal(rowScreen({ status: "improved", base: 2, candidate: 1, boundary: 0.5, direction: "lower" }), null);
});
