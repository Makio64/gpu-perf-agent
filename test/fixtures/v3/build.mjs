// Regenerates the schemaVersion 3 fixtures from the normative examples of the
// 2.2.0 contract (§1). Deterministic: the same code always writes the same files.
//   node test/fixtures/v3/build.mjs [--v2 path/to/saved-v2-report.json]
// report-v2.json is only rewritten when --v2 is given (it is a saved capture).
// Report `summary` objects are the §1.9 shape with the values the §5 rules give
// for each variant; `diagnostics.validity` and `diagnostics.signal` are produced
// by src/validity.js and src/gpu-timing.js.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectAutoGpuEvidence, collectGpuTimingEvidence, gpuTimingMetadata } from "../../../src/gpu-timing.js";
import { reportValidity } from "../../../src/validity.js";

const out = name => new URL(name, import.meta.url);
const write = (name, value) => writeFileSync(out(name), `${JSON.stringify(value, null, 2)}\n`);
const round = (value, digits = 4) => Number(value.toFixed(digits));
const MIB = 1024 * 1024;

// ---------------------------------------------------------------- helpers
function rng(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}
function fullStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { coefficientOfVariation: round(mean ? stddev / mean : 0, 6), count: values.length, min: sorted[0], max: sorted.at(-1),
    mean: round(mean), p50: round(percentile(sorted, 0.5)), p90: round(percentile(sorted, 0.9)), p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)), p99_9: round(percentile(sorted, 0.999)), stddev: round(stddev, 6), variance: round(variance, 8) };
}
function nsStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, p50: Math.round(percentile(sorted, 0.5)), p95: Math.round(percentile(sorted, 0.95)),
    mean: Math.round(values.reduce((total, value) => total + value, 0) / values.length), min: sorted[0], max: sorted.at(-1) };
}
const p50p95 = values => { const s = nsStats(values); return { p50: s.p50, p95: s.p95 }; };
const median = values => percentile([...values].sort((a, b) => a - b), 0.5);

const SAMPLE_COUNTER_KEYS = ["webgpu.queueSubmits", "webgpu.commandBuffersSubmitted", "webgpu.renderPasses", "webgpu.computePasses",
  "webgpu.drawCalls", "webgpu.drawIndexed", "webgpu.bundleDrawCalls", "webgpu.bundleDrawsExecuted", "webgpu.dispatchCalls",
  "webgpu.createBindGroup", "webgpu.createBuffer", "webgpu.createTexture", "webgpu.createView", "webgpu.writeBufferBytes",
  "webgpu.uncapturedErrors", "webgpu.deviceLost", "webgl2.clearCalls", "webgl.contextLost", "webgl.shaderCompileFailures",
  "webgl.programLinkFailures"];
const GLOBAL_COUNTER_KEYS = ["webgpu.devices", "webgpu.canvasContexts", "webgpu.commandEncoders", "webgpu.createShaderModule",
  "webgpu.createRenderPipeline", "webgpu.createComputePipeline", "webgpu.createRenderPipelineAsync", "webgpu.writeTextureBytes",
  "webgl2.contexts", "webgl2.drawCalls", "webgl.contexts", "webgl.drawCalls", "webgl.clearCalls", ...SAMPLE_COUNTER_KEYS];
const scale = (perFrame, frames) => Object.fromEntries(SAMPLE_COUNTER_KEYS.map(key => [key, (perFrame[key] || 0) * frames]));
const addCounters = (base, delta) => Object.fromEntries(GLOBAL_COUNTER_KEYS.map(key => [key, (base[key] || 0) + (delta[key] || 0)]));

// ---------------------------------------------------------------- normative examples (§1.5, §1.9, §1.11)
const observedFrames = { type: "raf", frameCount: 16, fps: 60.0,
  frameTimeMs: { coefficientOfVariation: 0.0027, count: 15, min: 16.6, max: 16.7, mean: 16.67, p50: 16.7, p90: 16.7, p95: 16.7, p99: 16.7, p99_9: 16.7, stddev: 0.045, variance: 0.002 },
  cadence: { hz: 60, intervalMs: 16.67, hitRate: 1 },
  maxJitter: 0.2, slowFrameCount: 0, durationMs: 233.3, observationWindowMs: 250.6 };

const sampleWebgpu = {
  index: 2, startedAtMs: 1366.1, elapsedMs: 266.4, error: null,
  idle: false,
  measurement: { observedFrames },
  instrumentation: { delta: {
    "webgpu.queueSubmits": 16, "webgpu.commandBuffersSubmitted": 16, "webgpu.renderPasses": 32, "webgpu.computePasses": 16,
    "webgpu.drawCalls": 3200, "webgpu.drawIndexed": 0, "webgpu.bundleDrawCalls": 0, "webgpu.bundleDrawsExecuted": 0,
    "webgpu.dispatchCalls": 16, "webgpu.createBindGroup": 0, "webgpu.createBuffer": 0, "webgpu.createTexture": 0,
    "webgpu.createView": 16, "webgpu.writeBufferBytes": 4096, "webgpu.uncapturedErrors": 0, "webgpu.deviceLost": 0,
    "webgl2.clearCalls": 0, "webgl.contextLost": 0, "webgl.shaderCompileFailures": 0, "webgl.programLinkFailures": 0
  } },
  memory: { delta: { performanceMemory: { usedJSHeapSize: 18400, totalJSHeapSize: 0, jsHeapSizeLimit: 0 }, trackedGpuMemoryBytes: 0 },
    trackedGpuTotalBytes: 16777216 },
  activity: { ticks: 16, activeTicks: 16, submits: 16, glDraws: 0, glClears: 0, pageFps: 60.0, activeFrameRatio: 1.0 },
  autoGpu: {
    status: "ok", source: "webgpu-timestamp",
    frames: 16, workFrames: 16, noWorkFrames: 0, timedFrames: 15, partialFrames: 1, pending: 0,
    partialReasons: { "page-timed-pass": 0, "no-slot": 0, "slot-reclaimed": 0, "invalid-timestamps": 1, disjoint: 0, unresolved: 0, "timer-error": 0 },
    frameNs: { count: 15, p50: 8412000, p95: 8901000, mean: 8450000, min: 8390000, max: 9020000 },
    sumNs: { p50: 8530000, p95: 9100000 },
    spanNs: { p50: 8700000, p95: 9300000 },
    overlapRatio: 1.01, idleGapRatio: 1.03,
    passes: [
      { key: "render#0", type: "render", label: null, count: 15, exclusiveP50Ns: 8302000, durationP50Ns: 8310000, overlapped: false,
        site: "frame app.js:88", appSite: "frame app.js:88", pipeline: "pipeline@createScene app.js:40" },
      { key: "sim", type: "compute", label: "sim", count: 15, exclusiveP50Ns: 44000, durationP50Ns: 46000, overlapped: false,
        site: "frame app.js:81", appSite: "frame app.js:81", pipeline: "sim-pipeline" }
    ]
  }
};

const summaryExample = {
  verdict: "needs-work",
  verdictReasons: [
    { code: "gpu-near-budget", role: "cause", severity: "medium", value: 13.9, threshold: 13.3, unit: "ms",
      message: "GPU 13.9 ms/frame is 83% of the 16.7 ms budget", next: "Reduce pass shadow (9.1 ms exclusive)" }
  ],
  bottleneck: { class: "vsync-capped", subtype: null, hz: 60, budgetMs: 16.67, fps: 60.0, pageFps: 60.0,
    mainThreadBusy: 0.08, cpuMsPerFrame: 1.3, gpuMs: 13.9, gpuSource: "auto", gpuSaturated: false, gpuShare: 0.83, headroomMs: 2.77,
    primaryMetric: "health.autoGpuFrameMs.p50", reason: "fps pinned at 60 Hz; GPU 83% of budget" },
  fps: 60.0, pageFps: 60.0, activeFrameRatio: 1.0,
  frameTimeMsMean: 16.67, frameTimeMsP95: 16.8, frameTimeMsMax: 17.1,
  slowFrameCount: 0, slowFrameRate: 0,
  observedFrameCount: 90, sampleCount: 6, idleSampleCount: 0,
  gpu: { source: "auto", frameMsP50: 13.9, frameMsP95: 14.6, timedFrames: 88, provenance: "auto.frame-busy",
    stability: { status: "stable", clockSensitive: false, reasons: [], cv: 0.004, ratio: 1.01 },
    plausibility: { status: "ok", implausibleSamples: 0 },
    passes: [{ key: "shadow", type: "render", exclusiveMs: 9.1, durationMs: 9.2, share: 0.65, overlapped: false, site: "renderShadow app.js:68" }],
    hook: null },
  gpuFrameMsMean: null, gpuFrameMsP95: null,
  cpuMsPerFrame: 1.3, mainThreadBusy: 0.08,
  heap: { available: true, method: "gc-bracket", retainedMiBPerSec: 0.0, retainedBytes: 1200, allocKiBPerFrame: 1.1 },
  jsHeapGrowthMBPerSec: 0.0,
  trackedVram: { available: true, bufferCount: 1, bufferMiB: 16, leakedResources: 0, textureCount: 0, textureMiB: 0, totalMiB: 16 },
  drawCallsPerFrame: 200,
  webgpuOps: { drawCalls: 200, dispatchCalls: 1, renderPasses: 2, computePasses: 1, setPipelineCalls: null, setBindGroupCalls: null, bundleDrawCalls: 0 },
  glOps: { drawCalls: 0, clearCalls: 0 },
  perFrame: perFrameSummary({ "webgpu.drawCalls": 200, "webgpu.dispatchCalls": 1, "webgpu.renderPasses": 2, "webgpu.computePasses": 1,
    "webgpu.createView": 1, "webgpu.writeBufferBytes": 4096 }),
  churnSites: {},
  pipelines: { syncCount: 3, asyncCount: 0, shaderModules: 2, syncInWindow: 0 },
  gpuErrors: { total: 0, inWindow: 0, top: [] },
  hitches: [{ durationMs: 70.1, blockingMs: 21, where: "frame @ app.js (char 2037)", loaf: true }],
  findings: [
    { code: "gpu-near-budget", role: "cause", severity: "medium", value: 13.9, threshold: 13.3, unit: "ms",
      message: "GPU 13.9 ms/frame is 83% of the 16.7 ms budget", next: "Reduce pass shadow (9.1 ms exclusive)", aliases: ["high-gpu-time"] },
    { code: "startup-sync-pipelines", role: "info", severity: "info", value: 3, threshold: 0, unit: "count",
      message: "3 sync pipelines created at startup (none during sampling).", next: "Use createRenderPipelineAsync for startup pipelines.", aliases: [] }
  ],
  warnings: [
    { code: "gpu-near-budget", message: "GPU 13.9 ms/frame is 83% of the 16.7 ms budget", metric: "gpuMs",
      recommendation: "Reduce pass shadow (9.1 ms exclusive)", severity: "medium", threshold: 13.3, value: 13.9 }
  ],
  warningCount: 1,
  recommendations: [
    { id: "gpu-near-budget", category: "gpu", severity: "medium", title: "GPU 13.9 ms/frame is 83% of the 16.7 ms budget",
      action: "Reduce pass shadow (9.1 ms exclusive)", evidence: "health.autoGpuFrameMs.p50 13.9 ms", value: 13.9, threshold: 13.3, unit: "ms" }
  ],
  highlights: ["3 sync pipelines created at startup (none during sampling)."]
};

function perFrameSummary(perFrame, nonZero = {}) {
  const get = key => perFrame[key] || 0;
  return { createBindGroup: get("webgpu.createBindGroup"), createBuffer: get("webgpu.createBuffer"), createTexture: get("webgpu.createTexture"),
    createView: get("webgpu.createView"), createSampler: 0, createShaderModule: 0, createPipelinesSync: 0, createPipelinesAsync: 0,
    writeBufferBytes: get("webgpu.writeBufferBytes"), writeTextureBytes: 0, drawCalls: get("webgpu.drawCalls"),
    bundleDraws: get("webgpu.bundleDrawsExecuted"), dispatches: get("webgpu.dispatchCalls"), renderPasses: get("webgpu.renderPasses"),
    computePasses: get("webgpu.computePasses"), glDrawCalls: get("webgl2.drawCalls") + get("webgl.drawCalls"),
    glClears: get("webgl2.clearCalls") + get("webgl.clearCalls"),
    nonZeroSamples: { createBindGroup: nonZero.createBindGroup || 0, createBuffer: nonZero.createBuffer || 0, createTexture: nonZero.createTexture || 0 } };
}

const row = { key: "health.autoGpuFrameMs.p50", unit: "ms", direction: "lower", base: 1.68, candidate: 1.49,
  delta: -0.19, deltaPercent: -11.3, status: "improved", gated: true,
  evidence: "paired-samples", confidence95: { low: -0.23, high: -0.15, method: "paired-t" },
  boundary: 0.084, screen: null, reasons: [], notes: [],
  baseStats: { count: 4, mean: 1.68, p50: 1.68, min: 1.64, max: 1.72, mad: 0.02 },
  candidateStats: { count: 4, mean: 1.49, p50: 1.49, min: 1.46, max: 1.52, mad: 0.015 } };
const comparisonExample = {
  kind: "comparison", schemaVersion: 2,
  status: "improved", exitCode: 0, statusReasons: ["primary improved; paired CI excludes boundary"],
  mode: "paired",
  primary: { key: "health.autoGpuFrameMs.p50", selection: "bottleneck", row },
  workEquivalence: { status: "same", differences: [] },
  rows: [row],
  failures: [],
  summary: { improved: 1, regression: 0, inconclusive: 0, unchanged: 6, unverified: 0, changed: 3, gated: 7, total: 10,
    regressions: 0, passed: 6, missing: 0 },
  compatibility: { compatible: true, differences: [], warnings: [] },
  validity: { valid: true, issues: [], warnings: [] },
  gpuTiming: { base: null, candidate: null },
  diagnostics: {},
  recommendationDiff: { introduced: [], resolved: [], persisted: [] },
  verdicts: { base: "good", candidate: "excellent" },
  baseReportPath: "reports/base-1.json", candidateReportPath: "reports/cand-1.json"
};

// ---------------------------------------------------------------- report builder
const ORIGIN = "http://127.0.0.1:57216";
const SAMPLE_GAP_MS = 0; // samples are contiguous so Σ per-sample deltas = the sampling window (§1.4)

/**
 * spec: { name, frames, frameMs, autoNs(frameIndex, sampleIndex, random) → ns|null, perFrame counters,
 *         hook(sampleIndex, random) → measurement extras, options, partialEvery, page, ... }
 */
function buildReport(spec) {
  const random = rng(spec.seed ?? 1);
  const samples = [];
  const frameDeltasMs = [];
  const sampleCount = spec.samples ?? 6;
  const frames = spec.frames ?? 15;
  const frameMs = spec.frameMs ?? 16.67;
  const autoOn = spec.options?.autoInstrument !== false;
  const timingOn = autoOn && spec.options?.gpuTiming !== false && spec.autoNs != null;
  const hookMode = spec.options?.samplingMode === "hook";
  const pooledFrames = [];
  const perSampleP50Ns = [];
  const passPool = new Map();
  let startedAtMs = 1100;
  let window = Object.fromEntries(SAMPLE_COUNTER_KEYS.map(key => [key, 0]));
  let cpuIndex = 0;
  const cdpSamples = [];
  for (let index = 0; index < sampleCount; index++) {
    const deltas = hookMode ? [] : Array.from({ length: frames }, (_, i) => round(frameMs + [-0.07, 0.03, 0.03][(i + index) % 3], 2));
    frameDeltasMs.push(...deltas);
    const elapsedMs = hookMode ? 4.2 : round(deltas.reduce((total, value) => total + value, 0) + 16.4, 1);
    const sampleFrames = hookMode ? 0 : frames;
    const delta = scale(spec.perFrame || {}, sampleFrames);
    if (spec.extraSampleCounters) Object.assign(delta, spec.extraSampleCounters(index));
    for (const key of SAMPLE_COUNTER_KEYS) window[key] += delta[key];
    const sample = { index, startedAtMs: round(startedAtMs, 1), elapsedMs, error: null };
    if (!hookMode) sample.idle = false;
    const measurement = {};
    if (spec.hook) Object.assign(measurement, spec.hook(index, random));
    if (!hookMode) {
      const stats = fullStats(deltas);
      measurement.observedFrames = { type: "raf", frameCount: frames + 1, fps: round(1000 / stats.mean, 2), frameTimeMs: stats,
        cadence: { hz: 60, intervalMs: 16.67, hitRate: 1 }, maxJitter: round(stats.max - stats.min, 2), slowFrameCount: 0,
        durationMs: round(deltas.reduce((t, v) => t + v, 0), 1), observationWindowMs: round(elapsedMs - 15.8, 1) };
    }
    sample.measurement = measurement;
    sample.instrumentation = { delta };
    sample.memory = { delta: { performanceMemory: { usedJSHeapSize: spec.heapPerSample ?? 1840, totalJSHeapSize: 0, jsHeapSizeLimit: 0 }, trackedGpuMemoryBytes: 0 },
      trackedGpuTotalBytes: spec.vramBytes ?? 16777216 };
    if (autoOn && !hookMode) {
      const submits = delta["webgpu.queueSubmits"];
      const active = submits > 0 ? frames : 0;
      sample.activity = { ticks: frames, activeTicks: active, submits, glDraws: 0, glClears: 0,
        pageFps: active ? round(1000 / frameMs, 1) : 0, activeFrameRatio: active ? 1 : 0 };
    }
    if (autoOn && !hookMode && spec.options?.gpuTiming !== false) {
      const values = [];
      let partial = 0;
      const work = delta["webgpu.queueSubmits"] > 0;
      for (let frame = 0; work && frame < frames; frame++) {
        if (spec.partialAt?.(index, frame)) { partial++; continue; }
        values.push(spec.autoNs(frame, index, random));
      }
      pooledFrames.push(...values);
      const auto = {
        status: values.length === 0 ? "no-frames" : partial > values.length ? "partial" : "ok",
        source: "webgpu-timestamp", frames, workFrames: work ? frames : 0, noWorkFrames: work ? 0 : frames,
        timedFrames: values.length, partialFrames: partial, pending: 0,
        partialReasons: { "page-timed-pass": 0, "no-slot": 0, "slot-reclaimed": 0, "invalid-timestamps": partial, disjoint: 0, unresolved: 0, "timer-error": 0 },
        frameNs: values.length ? nsStats(values) : { count: 0, p50: null, p95: null, mean: null, min: null, max: null },
        sumNs: values.length ? p50p95(values.map(v => Math.round(v * (spec.sumRatio ?? 1.01)))) : { p50: null, p95: null },
        spanNs: values.length ? p50p95(values.map(v => Math.round(v * (spec.spanRatio ?? 1.03)))) : { p50: null, p95: null },
        overlapRatio: values.length ? spec.sumRatio ?? 1.01 : null, idleGapRatio: values.length ? spec.spanRatio ?? 1.03 : null,
        passes: []
      };
      if (values.length) {
        perSampleP50Ns.push(auto.frameNs.p50);
        auto.passes = (spec.passes || []).map(pass => {
          const exclusive = values.map(v => Math.round(v * pass.share));
          const stats = nsStats(exclusive);
          const entry = passPool.get(pass.key) ?? { pass, exclusive: [] };
          entry.exclusive.push(...exclusive);
          passPool.set(pass.key, entry);
          return passEntry(pass, values.length, stats.p50);
        }).sort((a, b) => b.exclusiveP50Ns - a.exclusiveP50Ns);
      }
      sample.autoGpu = auto;
    }
    samples.push(sample);
    const startTs = 448571 + startedAtMs / 1000;
    const durationS = elapsedMs / 1000;
    cdpSamples.push({ index, startTs: round(startTs, 6), endTs: round(startTs + durationS, 6),
      threadTimeS: round(durationS * (spec.cpuShare ?? 0.078) * (1 + (cpuIndex++ % 3 - 1) * 0.01), 6),
      taskDurationS: round(durationS * (spec.taskShare ?? 0.08), 6) });
    startedAtMs += elapsedMs + SAMPLE_GAP_MS;
  }

  const observedFrameCount = frameDeltasMs.length;
  const warmupFrames = 31;
  const setupCounters = { "webgpu.devices": spec.devices ?? 1, "webgpu.canvasContexts": spec.canvasContexts ?? 1,
    "webgpu.createShaderModule": spec.shaderModules ?? 2, "webgpu.createRenderPipeline": spec.syncPipelines ?? 3,
    "webgpu.createBindGroup": spec.setupBindGroups ?? 4, "webgpu.createBuffer": spec.setupBuffers ?? 1,
    "webgpu.uncapturedErrors": spec.setupErrors ?? 0 };
  const warmupStartCounters = addCounters(setupCounters, {});
  const before = addCounters(setupCounters, scale(spec.perFrame || {}, hookMode ? 0 : warmupFrames));
  const after = addCounters(before, window);
  for (const key of ["webgpu.commandEncoders"]) {
    warmupStartCounters[key] = 0;
    before[key] = (spec.perFrame?.["webgpu.queueSubmits"] || 0) * warmupFrames;
    after[key] = before[key] + window["webgpu.queueSubmits"];
  }
  const delta = Object.fromEntries(GLOBAL_COUNTER_KEYS.map(key => [key, after[key] - before[key]]));
  const snapshot = counters => ({ counters, errors: [], version: 2,
    resources: { pipelines: { syncCount: spec.syncPipelines ?? 3, asyncCount: 0, shaderModules: spec.shaderModules ?? 2 },
      bindGroups: { createdCount: spec.setupBindGroups ?? 4, layoutCount: 1 }, api: "webgpu",
      byApi: { webgpu: { bytes: spec.vramBytes ?? 16777216, count: 1 } }, byKind: { buffer: { bytes: spec.vramBytes ?? 16777216, count: 1 } },
      history: [], liveResources: [], totalBytes: spec.vramBytes ?? 16777216, totalResources: 1 } });

  const stat = values => fullStats(values);
  const perSampleMean = key => samples.map(sample => sample.measurement.observedFrames?.frameTimeMs?.[key]).filter(Number.isFinite);
  const fpsValues = samples.map(sample => sample.measurement.observedFrames?.fps).filter(Number.isFinite);
  const perFrame = Object.fromEntries(SAMPLE_COUNTER_KEYS.map(key => [key, observedFrameCount ? round(window[key] / observedFrameCount, 3) : 0]));
  const autoSamples = samples.filter(sample => sample.autoGpu);
  const sumAuto = key => autoSamples.reduce((total, sample) => total + sample.autoGpu[key], 0);
  const pooledPasses = [...passPool.values()].map(({ pass, exclusive }) => passEntry(pass, exclusive.length, nsStats(exclusive).p50))
    .sort((a, b) => b.exclusiveP50Ns - a.exclusiveP50Ns);
  const summaryAutoGpu = autoSamples.length ? {
    status: pooledFrames.length === 0 ? "no-frames" : sumAuto("partialFrames") > pooledFrames.length ? "partial" : "ok",
    source: "webgpu-timestamp", frames: sumAuto("frames"), workFrames: sumAuto("workFrames"), noWorkFrames: sumAuto("noWorkFrames"),
    timedFrames: pooledFrames.length, partialFrames: sumAuto("partialFrames"),
    frameNs: pooledFrames.length ? nsStats(pooledFrames) : { count: 0, p50: null, p95: null, mean: null, min: null, max: null },
    perSampleP50Ns, overlapRatio: pooledFrames.length ? spec.sumRatio ?? 1.01 : null, idleGapRatio: pooledFrames.length ? spec.spanRatio ?? 1.03 : null,
    passes: pooledPasses
  } : undefined;
  const inPageSummary = {
    frameTimeMsMean: hookMode ? undefined : stat(perSampleMean("mean")),
    frameTimeMsP95: hookMode ? undefined : stat(perSampleMean("p95")),
    frameTimeMsMax: hookMode ? undefined : stat(perSampleMean("max")),
    frameTimeMsP99: hookMode ? undefined : stat(perSampleMean("p99")),
    fps: fpsValues.length ? stat(fpsValues) : undefined,
    elapsedMs: stat(samples.map(sample => sample.elapsedMs)),
    maxJitter: hookMode ? undefined : stat(samples.map(sample => sample.measurement.observedFrames.maxJitter)),
    cadence: hookMode ? undefined : { hz: 60, intervalMs: 16.67, hitRate: 1 },
    instrumentationCounters: delta,
    jsHeapDeltaBytes: stat(samples.map(sample => sample.memory.delta.performanceMemory.usedJSHeapSize)),
    trackedGpuTotalBytes: stat(samples.map(sample => sample.memory.trackedGpuTotalBytes)),
    observedFrameCount, sampleCount, slowFrameCount: 0,
    ...(summaryAutoGpu ? { autoGpu: summaryAutoGpu } : {}),
    ...(autoOn && !hookMode ? { activity: {
      pageFps: stat(samples.map(sample => sample.activity.pageFps)),
      activeFrameRatio: round(samples.reduce((t, s) => t + s.activity.activeTicks, 0) / samples.reduce((t, s) => t + s.activity.ticks, 0), 4),
      idleSampleIndices: [] } } : {}),
    frameDeltasMs,
    perFrame: perFrameSummary(perFrame),
    churnSites: {},
    gpuErrors: { total: spec.setupErrors ?? 0, inWindow: 0, top: spec.setupErrors ? [{ message: "Invalid BindGroupLayout (unused fallback).", count: spec.setupErrors }] : [],
      deviceLost: [], contextLost: 0, shaderFailures: [] },
    offMainThread: { workers: 0, offscreenTransfers: 0 },
    appGpuContexts: { webgpuDevices: spec.devices ?? 1, webgpuCanvasContexts: spec.canvasContexts ?? 1, webgl2: 0, webgl: 0 }
  };
  for (const key of Object.keys(inPageSummary)) if (inPageSummary[key] === undefined) delete inPageSummary[key];

  const options = {
    angle: null, api: "auto", autoInstrument: autoOn, browserChannel: null,
    chromiumArgs: ["--headless=new", "--enable-unsafe-webgpu", "--enable-dawn-features=allow_unsafe_apis", "--js-flags=--expose-gc"],
    contextMode: "isolated", samplingMode: hookMode ? "hook" : "frames", frameObservation: "wall-clock", adaptive: false,
    minimalTrace: false, cdpAttached: false, waitCondition: null, durationMs: 250, deviceScaleFactor: 1, deepMemory: false,
    waitUntil: "networkidle", waitForHook: false, gc: false, headful: false, hookName: "__gpuReportBench", runner: "fast-cdp",
    samples: sampleCount, slowFrameThresholdMs: 20, trace: false, viewport: "1280x720", warmup: 2,
    gpuTiming: true, readyTimeoutMs: 3000, allowIdle: false, networkIdleBudgetMs: 10000, cpuProfile: "auto", measureLock: true,
    label: null, ...spec.options
  };
  const path = `/examples/${spec.page}.html`;
  const timings = { launchMs: 412.1, harnessReused: false, pageSetupMs: 38.0, navigationMs: 266.0, networkIdleWaitMs: 0,
    networkIdle: { status: "overlapped", waitedMs: 251, budgetMs: 10000, pending: [] }, lockWaitMs: 0,
    readyWaitMs: spec.ready?.waitedMs ?? 12.4, warmupMs: 517.7, samplingMs: round(startedAtMs - 1100 + 530, 1), cpuProfileMs: 0,
    teardownMs: 64.0, totalMs: 2647.1, anomalies: [] };
  const report = {
    schemaVersion: 3,
    tool: { name: "gpu-perf-agent", version: "2.2.0" },
    summary: null,
    diagnostics: null,
    options,
    timings,
    target: { file: `/work/project${path}`, root: "/work/project", source: "file-server", url: `${ORIGIN}${path}`,
      httpStatus: 200, documentUrl: `${ORIGIN}${path}` },
    artifacts: { screenshotPath: null },
    measurementLock: { acquired: true, waitedMs: 0, timedOut: false, holder: null, path: "/tmp/gpu-perf-agent-501/measure.lock", frozenWhileWaiting: false },
    inPage: {
      config: { adaptive: false, api: "auto", durationMs: 250, gc: false, deepMemory: false, hookName: "__gpuReportBench",
        samplingMode: options.samplingMode, samples: sampleCount, slowFrameThresholdMs: 20, warmup: 2,
        readyTimeoutMs: 3000, waitNetworkIdle: true, networkIdleBudgetMs: 10000, progress: true },
      apiSupport: { webgpu: { available: true, adapter: { vendor: "apple", architecture: "metal-3", device: "", description: "" }, error: null,
        features: ["timestamp-query", "shader-f16"] }, webgl2: { available: true, error: null, renderer: "WebKit WebGL" } },
      hook: { found: spec.hookFound ?? false, foundAfterReady: spec.hookFound ?? false, name: "__gpuReportBench" },
      ready: spec.ready ?? { reason: "gpu-work", waitedMs: 12.4 },
      location: `${ORIGIN}${path}`,
      warmup: { durationMs: 517.7, lagSpikeMs: 16.7, settled: true, networkIdle: "overlapped", extendedForNetworkMs: 0 },
      memory: {
        before: { atMs: 1090.2, performanceMemory: { jsHeapSizeLimit: 4395630592, totalJSHeapSize: 2918260, usedJSHeapSize: 930000 },
          trackedGpuMemory: { api: "webgpu", totalBytes: spec.vramBytes ?? 16777216, totalResources: 1 }, userAgentSpecificMemory: null },
        after: { atMs: round(startedAtMs, 1), performanceMemory: { jsHeapSizeLimit: 4395630592, totalJSHeapSize: 2918260, usedJSHeapSize: 930000 + (spec.retainedBytes ?? 1200) },
          trackedGpuMemory: { api: "webgpu", totalBytes: spec.vramBytes ?? 16777216, totalResources: 1 }, userAgentSpecificMemory: null },
        delta: { performanceMemory: { jsHeapSizeLimit: 0, totalJSHeapSize: 0, usedJSHeapSize: spec.retainedBytes ?? 1200 }, trackedGpuMemoryBytes: 0 },
        retained: { available: true, method: "gc-bracket", beforeBytes: 930000, afterBytes: 930000 + (spec.retainedBytes ?? 1200),
          deltaBytes: spec.retainedBytes ?? 1200, windowMs: round(startedAtMs - 1100, 1) }
      },
      instrumentation: autoOn ? { warmupStartCounters, before: snapshot(before), after: snapshot(after), delta, errors: [] } : undefined,
      samples,
      sampling: { mode: options.samplingMode, adaptive: false, stoppedEarly: false, requestedSamples: sampleCount, coefficientOfVariation: null },
      slowFrames: [],
      summary: inPageSummary,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36",
      warnings: []
    },
    cdp: {
      before: { domCounters: { documents: 4, nodes: 37, jsEventListeners: 0 }, performanceMetrics: { Timestamp: 448570.617326, ThreadTime: 0.012287,
        TaskDuration: 0.019336, ScriptDuration: 0.006089, JSHeapUsedSize: 930012, JSHeapTotalSize: 1835008 } },
      after: { domCounters: { documents: 4, nodes: 38, jsEventListeners: 0 }, performanceMetrics: {
        Timestamp: round(448570.617326 + (startedAtMs - 1100) / 1000, 6),
        ThreadTime: round(0.012287 + cdpSamples.reduce((t, s) => t + s.threadTimeS, 0), 6),
        TaskDuration: round(0.019336 + cdpSamples.reduce((t, s) => t + s.taskDurationS, 0), 6),
        ScriptDuration: 0.0151, JSHeapUsedSize: 931212, JSHeapTotalSize: 1835008 } },
      samples: cdpSamples
    },
    pageEventSummary: { total: 0, retained: 0, dropped: 0, truncated: 0,
      counts: { console: 0, consoleError: 0, pageerror: 0, requestfailed: 0, log: 0, logError: 0, httpError: 0, renderingError: 0, renderingErrorWebgpu: 0 },
      renderingErrors: [], failedResources: [] },
    pageEvents: [],
    trace: { captured: false, error: null, rawTracePath: null, summary: null },
    browser: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", pid: 17132, version: "HeadlessChrome/155.0.0.0" },
    host: { arch: "arm64", cpus: ["Apple M3 Max"], hostname: "fixture-host", node: "v24.18.0", platform: "darwin", release: "24.6.0" },
    createdAt: "2026-10-20T12:00:00.000Z"
  };
  if (!report.inPage.instrumentation) delete report.inPage.instrumentation;
  spec.mutate?.(report);
  report.diagnostics = diagnosticsFor(report);
  report.summary = summaryFor(report, spec.summary || {});
  return report;
}

function passEntry(pass, count, exclusiveP50Ns) {
  return { key: pass.key, type: pass.type, label: pass.label ?? null, count, exclusiveP50Ns,
    durationP50Ns: Math.round(exclusiveP50Ns * (pass.durationRatio ?? 1.001)), overlapped: pass.overlapped ?? false,
    site: pass.site, appSite: pass.appSite ?? pass.site, pipeline: pass.pipeline ?? null };
}

function diagnosticsFor(report) {
  const hook = collectGpuTimingEvidence(report);
  const auto = collectAutoGpuEvidence(report);
  const inPage = report.inPage;
  return {
    validity: reportValidity(report),
    signal: {
      gpuTimingSamples: hook.status === "single-scope" ? hook.values.filter(Number.isFinite).length : 0,
      gpuTiming: gpuTimingMetadata(hook),
      autoGpu: auto.status === "unavailable" ? null : gpuTimingMetadata(auto),
      hookFound: inPage.hook?.found === true,
      observedFrameCount: inPage.summary.observedFrameCount,
      samplingMode: report.options.samplingMode,
      sampleCount: inPage.samples.length
    },
    instrumentation: { enabled: Boolean(inPage.instrumentation?.after), errors: inPage.instrumentation?.errors ?? [] },
    pageErrors: [], pageErrorCount: 0, sampleErrors: [],
    warnings: [], warningCount: 0, recommendations: [], highlights: []
  };
}

// The §1.9 summary for a fixture: measured fields from the report, decision
// fields (bottleneck, findings, verdict) from the variant's spec (§5 rules).
function summaryFor(report, decision) {
  const inPage = report.inPage;
  const summary = inPage.summary;
  const hook = collectGpuTimingEvidence(report);
  const auto = collectAutoGpuEvidence(report);
  const deltas = summary.frameDeltasMs;
  const sorted = [...deltas].sort((a, b) => a - b);
  const frames = deltas.length;
  const budgetMs = 16.67;
  const slow = deltas.filter(value => value > 1.5 * budgetMs).length;
  const cpuValues = (report.cdp.samples || []).map(sample => sample.threadTimeS / (sample.endTs - sample.startTs)
    * (frames ? deltas.reduce((t, v) => t + v, 0) / frames : budgetMs));
  const cpuMsPerFrame = cpuValues.length && frames ? round(median(cpuValues), 2) : null;
  const metricsBefore = report.cdp.before.performanceMetrics, metricsAfter = report.cdp.after.performanceMetrics;
  const mainThreadBusy = round((metricsAfter.TaskDuration - metricsBefore.TaskDuration) / (metricsAfter.Timestamp - metricsBefore.Timestamp), 3);
  const autoMs = auto.pooled ? round(auto.pooled.p50, 3) : null;
  const hookValues = hook.values?.filter(Number.isFinite) ?? [];
  const hookMean = hook.status === "single-scope" && hookValues.length ? round(hookValues.reduce((t, v) => t + v, 0) / hookValues.length, 4) : null;
  // §5.1 trust rule: auto p50 when stable or saturated, else the hook mean when
  // warm/fixed-work and stable, else null (untrusted).
  const autoTrusted = autoMs !== null && (auto.stability.status === "stable" || auto.saturated);
  const hookTrusted = hookMean !== null && ["warm", "fixed-work"].includes(hook.provenance) && hook.stability?.status === "stable";
  const gpuMs = autoTrusted ? autoMs : hookTrusted ? hookMean : null;
  const gpuSource = autoTrusted ? "auto" : hookTrusted ? "hook" : null;
  const passes = (summary.autoGpu?.passes || []).slice(0, 5).map(pass => ({ key: pass.key, type: pass.type,
    exclusiveMs: round(pass.exclusiveP50Ns / 1e6, 3), durationMs: round(pass.durationP50Ns / 1e6, 3),
    share: autoMs ? round(pass.exclusiveP50Ns / 1e6 / autoMs, 2) : null, overlapped: pass.overlapped, site: pass.site }));
  const retained = inPage.memory.retained;
  const allocKiBPerFrame = frames ? round(inPage.samples.reduce((t, s) => t + Math.max(0, s.memory.delta.performanceMemory.usedJSHeapSize), 0) / 1024 / frames, 2) : null;
  const retainedMiBPerSec = retained?.available ? round(retained.deltaBytes / MIB / (retained.windowMs / 1000), 4) : null;
  const fps = summary.fps ? round(summary.fps.mean, 2) : null;
  const pageFps = summary.activity ? round(summary.activity.pageFps.mean, 2) : fps;
  const perFrame = summary.perFrame;
  const draws = perFrame.drawCalls + perFrame.bundleDraws + perFrame.glDrawCalls;
  const vramMiB = round((report.inPage.memory.after.trackedGpuMemory.totalBytes || 0) / MIB, 2);
  const findings = decision.findings ?? [];
  const legacy = findings.filter(finding => finding.role !== "info");
  return {
    verdict: decision.verdict ?? "excellent",
    verdictReasons: findings.filter(finding => finding.role === "cause").slice(0, 3).map(({ aliases, ...rest }) => rest),
    bottleneck: { class: "vsync-capped", subtype: null, hz: summary.cadence ? 60 : null, budgetMs, fps, pageFps,
      mainThreadBusy, cpuMsPerFrame, gpuMs, gpuSource, gpuSaturated: autoTrusted && auto.saturated,
      gpuShare: gpuMs !== null && !(autoTrusted && auto.saturated) ? round(gpuMs / budgetMs, 3) : null,
      // Null when saturated, or when neither the CPU nor the GPU side is known.
      headroomMs: (autoTrusted && auto.saturated) || (cpuMsPerFrame === null && gpuMs === null) ? null
        : round(budgetMs - Math.max(cpuMsPerFrame ?? 0, gpuMs ?? 0), 2),
      primaryMetric: "health.autoGpuFrameMs.p50", reason: "fps pinned at 60 Hz", ...decision.bottleneck },
    fps, pageFps, activeFrameRatio: summary.activity?.activeFrameRatio ?? null,
    frameTimeMsMean: frames ? round(deltas.reduce((t, v) => t + v, 0) / frames, 3) : null,
    frameTimeMsP95: frames ? round(percentile(sorted, 0.95), 3) : null,
    frameTimeMsMax: frames ? sorted.at(-1) : null,
    slowFrameCount: slow, slowFrameRate: frames ? round(slow / frames, 4) : 0,
    observedFrameCount: frames, sampleCount: inPage.samples.length, idleSampleCount: inPage.samples.filter(s => s.idle === true).length,
    gpu: { source: autoMs !== null ? "auto" : hookMean !== null ? "hook" : null,
      frameMsP50: autoMs ?? (hookMean !== null ? round(median(hookValues), 4) : null),
      frameMsP95: auto.pooled ? round(auto.pooled.p95, 3) : null, timedFrames: auto.timedFrames,
      provenance: autoMs !== null ? "auto.frame-busy" : hookMean !== null ? hook.provenance : null,
      stability: autoMs !== null ? auto.stability : hook.stability,
      plausibility: autoMs !== null ? auto.plausibility : hook.plausibility,
      passes,
      hook: hookMean === null ? null : { meanMs: hookMean, p50Ms: round(median(hookValues), 4), scope: hook.scope,
        provenance: hook.provenance, stability: hook.stability, plausibility: hook.plausibility } },
    gpuFrameMsMean: hookMean, gpuFrameMsP95: hookMean === null ? null : round(percentile([...hookValues].sort((a, b) => a - b), 0.95), 4),
    cpuMsPerFrame, mainThreadBusy,
    heap: { available: Boolean(retained?.available), method: retained?.available ? "gc-bracket" : "unavailable",
      retainedMiBPerSec, retainedBytes: retained?.deltaBytes ?? null, allocKiBPerFrame },
    jsHeapGrowthMBPerSec: retainedMiBPerSec,
    trackedVram: { available: true, bufferCount: 1, bufferMiB: vramMiB, leakedResources: 0, textureCount: 0, textureMiB: 0, totalMiB: vramMiB },
    drawCallsPerFrame: draws,
    webgpuOps: { drawCalls: perFrame.drawCalls, dispatchCalls: perFrame.dispatches, renderPasses: perFrame.renderPasses,
      computePasses: perFrame.computePasses, setPipelineCalls: null, setBindGroupCalls: null, bundleDrawCalls: perFrame.bundleDraws },
    glOps: { drawCalls: perFrame.glDrawCalls, clearCalls: perFrame.glClears },
    perFrame, churnSites: summary.churnSites,
    pipelines: { syncCount: report.inPage.instrumentation?.after.resources.pipelines.syncCount ?? 0, asyncCount: 0,
      shaderModules: report.inPage.instrumentation?.after.resources.pipelines.shaderModules ?? 0, syncInWindow: 0 },
    gpuErrors: { total: summary.gpuErrors.total, inWindow: summary.gpuErrors.inWindow, top: summary.gpuErrors.top },
    hitches: [],
    findings,
    warnings: legacy.map(finding => ({ code: finding.code, message: finding.message, metric: finding.unit, recommendation: finding.next,
      severity: finding.severity, threshold: finding.threshold, value: finding.value })),
    warningCount: legacy.length,
    recommendations: legacy.map(finding => ({ id: finding.code, category: "gpu", severity: finding.severity, title: finding.message,
      action: finding.next, evidence: finding.message, value: finding.value, threshold: finding.threshold, unit: finding.unit })),
    highlights: decision.highlights ?? []
  };
}

// ---------------------------------------------------------------- variants
const capturePasses = [
  { key: "render#0", type: "render", share: 0.987, site: "frame app.js:88", pipeline: "pipeline@createScene app.js:40" },
  { key: "sim", type: "compute", label: "sim", share: 0.0053, site: "frame app.js:81", pipeline: "sim-pipeline" }
];
const capturePerFrame = { "webgpu.queueSubmits": 1, "webgpu.commandBuffersSubmitted": 1, "webgpu.renderPasses": 2, "webgpu.computePasses": 1,
  "webgpu.drawCalls": 200, "webgpu.dispatchCalls": 1, "webgpu.createView": 1, "webgpu.writeBufferBytes": 4096 };
const clearPerFrame = { "webgpu.queueSubmits": 1, "webgpu.commandBuffersSubmitted": 1, "webgpu.renderPasses": 1, "webgpu.createView": 1 };
const startupInfo = { code: "startup-sync-pipelines", role: "info", severity: "info", value: 3, threshold: 0, unit: "count",
  message: "3 sync pipelines created at startup (none during sampling).", next: "Use createRenderPipelineAsync for startup pipelines.", aliases: [] };
// Frame union around a centre value with a small deterministic spread (ns).
const around = (centreNs, spreadNs) => (frame, sample, random) => Math.round(centreNs + (random() - 0.5) * spreadNs + (sample % 3 - 1) * spreadNs * 0.02);

const variants = {
  "report-capture.json": {
    page: "nohook-2000", seed: 7, perFrame: capturePerFrame, passes: capturePasses,
    autoNs: around(8.412e6, 0.06e6), partialAt: (sample, frame) => (sample === 2 || sample === 4) && frame === 7,
    summary: { verdict: "excellent", findings: [startupInfo], highlights: [startupInfo.message],
      bottleneck: { primaryMetric: "health.autoGpuFrameMs.p50", reason: "fps pinned at 60 Hz; GPU 50% of budget" } }
  },
  "report-saturated.json": {
    page: "w-gpu-heavy", seed: 11, perFrame: { ...capturePerFrame, "webgpu.drawCalls": 1, "webgpu.computePasses": 0, "webgpu.dispatchCalls": 0, "webgpu.renderPasses": 1 },
    passes: [{ key: "render#0", type: "render", share: 0.998, site: "frame w-gpu-heavy.html:61", pipeline: "pipeline@init w-gpu-heavy.html:40" }],
    autoNs: around(17.4e6, 0.5e6),
    summary: { verdict: "needs-work",
      findings: [{ code: "gpu-near-budget", role: "cause", severity: "high", value: null, threshold: 13.3, unit: "ms",
        message: "GPU ≥ budget (saturated); frame time is the decision metric", next: "Reduce pass render#0 (fragment cost) and confirm with ab",
        aliases: ["high-gpu-time"] }, startupInfo],
      bottleneck: { class: "gpu-bound", primaryMetric: "frame.frameTimeMs.mean", reason: "GPU ≥ budget (saturated) at 60 Hz" } }
  },
  "report-clock-sensitive.json": {
    page: "gpu-light", seed: 13, perFrame: capturePerFrame, passes: capturePasses,
    autoNs: around(1.65e6, 0.03e6),
    summary: { verdict: "excellent", findings: [startupInfo],
      bottleneck: { primaryMetric: "health.autoGpuFrameMs.p50", reason: "fps pinned at 60 Hz; GPU 10% of budget (clock-sensitive)" } }
  },
  "report-hook-warm.json": {
    page: "webgpu-warm-timing", seed: 17, perFrame: capturePerFrame, passes: capturePasses, hookFound: true,
    ready: { reason: "hook", waitedMs: 3.1 },
    autoNs: around(1.62e6, 0.04e6),
    hook: index => ({ gpuTimeNs: [1553000, 1651000, 1598000, 1620000, 1575000, 1640000][index],
      gpuTiming: { method: "warm", passes: 24, warmupMs: 20 } }),
    summary: { verdict: "excellent", findings: [startupInfo],
      bottleneck: { primaryMetric: "health.autoGpuFrameMs.p50", reason: "fps pinned at 60 Hz; GPU 10% of budget" } }
  },
  "report-hook-vsync.json": {
    page: "webgpu-clear", seed: 19, perFrame: clearPerFrame, hookFound: true, syncPipelines: 0, shaderModules: 0, setupBindGroups: 0,
    ready: { reason: "hook", waitedMs: 2.2 },
    passes: [{ key: "render#0", type: "render", share: 0.99, site: "frame webgpu-clear.html:88", pipeline: null }],
    autoNs: around(0.19e6, 0.01e6),
    hook: index => ({ gpuTimeNs: [38000, 112000, 3900000, 70000, 6651000, 98000][index] }),
    summary: { verdict: "excellent", findings: [],
      bottleneck: { primaryMetric: "health.cpuMsPerFrame", reason: "fps pinned at 60 Hz; GPU 1% of budget" } }
  },
  "report-hookmode.json": {
    page: "hook-bench", seed: 23, options: { samplingMode: "hook", autoInstrument: false, gpuTiming: false }, hookFound: true,
    ready: { reason: "hook", waitedMs: 0 },
    hook: index => ({ gpuMs: [2.1, 2.12, 2.11, 2.13, 2.09, 2.11][index], iterations: 100 }),
    summary: { verdict: "excellent", findings: [],
      bottleneck: { class: "unknown", hz: null, primaryMetric: "health.gpuFrameMs.mean", reason: "hook sampling mode" } }
  },
  "report-blank.json": {
    page: "blank", seed: 29, perFrame: {}, devices: 0, canvasContexts: 0, syncPipelines: 0, shaderModules: 0, setupBindGroups: 0, setupBuffers: 0,
    autoNs: around(0, 0), vramBytes: 0,
    ready: { reason: "timeout", waitedMs: 3000 },
    summary: { verdict: "unknown", findings: [],
      bottleneck: { class: "unknown", primaryMetric: "health.cpuMsPerFrame", reason: "no main-thread GPU work observed" } }
  },
  "report-cdp-attached-zero.json": {
    page: "webgpu-clear", seed: 31, perFrame: clearPerFrame, hookFound: true, syncPipelines: 0, shaderModules: 0, setupBindGroups: 0,
    options: { cdpAttached: true, chromiumArgs: [] },
    passes: [{ key: "render#0", type: "render", share: 1, site: "frame webgpu-clear.html:88", pipeline: null }],
    // Attached browsers without allow_unsafe_apis quantize timestamps to 100 µs.
    autoNs: (frame, sample) => (frame + sample) % 3 === 0 ? 200000 : 100000,
    hook: () => ({ gpuTimeNs: 0 }),
    summary: { verdict: "excellent", findings: [],
      bottleneck: { primaryMetric: "health.cpuMsPerFrame", reason: "fps pinned at 60 Hz; GPU headroom unknown (GPU timing quantized)" } }
  }
};

// ---------------------------------------------------------------- write
const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
export function buildFixtures() {
  const reports = Object.fromEntries(Object.entries(variants).map(([name, spec]) => [name, buildReport(spec)]));
  return { "sample-webgpu.json": sampleWebgpu, "summary.json": summaryExample, "comparison.json": comparisonExample, ...reports };
}

if (isMain) {
  for (const [name, value] of Object.entries(buildFixtures())) write(name, value);
  const v2Index = process.argv.indexOf("--v2");
  if (v2Index > 0) write("report-v2.json", trimV2(JSON.parse(readFileSync(process.argv[v2Index + 1], "utf8"))));
}

// A saved v2 report, minus machine-identifying and bulky browser fields.
function trimV2(report) {
  if (report.schemaVersion !== 2) throw new Error("--v2 expects a schemaVersion 2 report");
  const copy = structuredClone(report);
  copy.browser = { executablePath: copy.browser?.executablePath ?? null, pid: copy.browser?.pid ?? null, version: copy.browser?.version ?? null };
  copy.host = { arch: copy.host?.arch, cpus: (copy.host?.cpus || []).slice(0, 1), hostname: "fixture-host", node: copy.host?.node,
    platform: copy.host?.platform, release: copy.host?.release };
  copy.options.chromiumArgs = (copy.options.chromiumArgs || []).filter(arg => !arg.startsWith("--user-data-dir"));
  for (const api of ["webgpu", "webgl2", "webgl"]) {
    const support = copy.inPage?.apiSupport?.[api];
    if (support) for (const key of ["limits", "extensions", "features"]) if (Array.isArray(support[key]) || support[key]) support[key] = Array.isArray(support[key]) ? support[key].slice(0, 4) : support[key];
  }
  if (copy.target) {
    copy.target.file = copy.target.file?.replace(/^.*\/examples\//, "/work/project/examples/");
    copy.target.root = "/work/project";
  }
  return copy;
}
