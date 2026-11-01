import { flattenMeasurementNumbers, median, numericStats, percentile } from "./stats.js";
import { buildFindings, legacyRecommendations, legacyWarnings, verdictFromFindings } from "./diagnostics.js";
import { reportValidity, pageErrorCounts, failedResources } from "./validity.js";
import { collectAutoGpuEvidence, collectGpuTimingEvidence, gpuTimingMetadata } from "./gpu-timing.js";

const MIB = 1024 * 1024;
const KIB = 1024;
const DEFAULT_BUDGET_MS = 16.67;
const AUTO_GPU_METRIC = "health.autoGpuFrameMs.p50";
const HOOK_GPU_METRIC = "health.gpuFrameMs.mean";
const FRAME_METRIC = "frame.frameTimeMs.mean";
const CPU_METRIC = "health.cpuMsPerFrame";
// §1: report key order. Keys outside this list keep their relative order after it.
const REPORT_KEY_ORDER = ["schemaVersion", "tool", "summary", "diagnostics", "options", "timings", "target", "artifacts",
  "measurementLock", "cpuProfile", "inPage", "cdp", "pageEventSummary", "pageEvents", "trace", "browser", "host", "createdAt"];

/** Attach `summary` and `diagnostics` (schemaVersion 3, §1 key order) without mutating the input. */
export function finalizeReport(report, options = {}) {
  const { summary, diagnostics } = analyzeReport(report, options);
  const merged = { ...report, schemaVersion: 3, summary, diagnostics };
  const ordered = {};
  for (const key of REPORT_KEY_ORDER) if (Object.hasOwn(merged, key)) ordered[key] = merged[key];
  for (const key of Object.keys(merged)) if (!Object.hasOwn(ordered, key)) ordered[key] = merged[key];
  return ordered;
}

/** One pass over a raw or finalized report: the §1.9 summary and the diagnostics block. */
export function analyzeReport(report, options = {}) {
  const inPage = report?.inPage || {};
  const validity = reportValidity(report);
  const context = analysisContext(report, options);
  const bottleneck = classifyContext(context, validity);
  const findings = buildFindings({ ...context, bottleneck, validity });
  // The §6.4 two-argument call: the findings carry every input of the verdict.
  const { verdict, reasons } = verdictFromFindings(findings, validity);
  const warnings = legacyWarnings(findings);
  const recommendations = legacyRecommendations(findings);
  const highlights = findings.filter(finding => finding.role === "info").map(finding => finding.message);
  if (report?.screenshotError != null) highlights.push(`Screenshot capture failed: ${report.screenshotError}. Visual correctness remains unchecked.`);
  else if (Number.isFinite(report?.screenshotSize) && report.screenshotSize > 0) {
    highlights.push(`Screenshot captured (${(report.screenshotSize / 1024).toFixed(1)} KiB); visual correctness has not been checked.`);
  }
  const { gpu, perFrame, pipelines } = context;
  const summary = {
    verdict,
    verdictReasons: reasons.map(({ aliases, evidence, ...rest }) => rest),
    bottleneck,
    fps: context.fps,
    pageFps: context.pageFps ?? context.fps,
    activeFrameRatio: context.activeFrameRatio,
    frameTimeMsMean: context.frameTimeMsMean,
    frameTimeMsP95: context.frameTimeMsP95,
    frameTimeMsMax: context.frameTimeMsMax,
    slowFrameCount: context.slowFrameCount,
    slowFrameRate: context.slowFrameRate,
    observedFrameCount: context.observedFrameCount,
    sampleCount: context.sampleCount,
    idleSampleCount: context.idleSampleCount,
    gpu: gpuSummary(context),
    gpuFrameMsMean: gpu.hookStats?.mean ?? null,
    gpuFrameMsP95: gpu.hookStats?.p95 ?? null,
    cpuMsPerFrame: context.cpuMsPerFrame,
    mainThreadBusy: context.mainThreadBusy,
    heap: context.heap,
    jsHeapGrowthMBPerSec: context.heap.retainedMiBPerSec,
    trackedVram: context.trackedVram,
    drawCallsPerFrame: context.drawCallsPerFrame,
    webgpuOps: {
      drawCalls: perFrame?.drawCalls ?? finite(inPage.summary?.drawCalls?.mean),
      dispatchCalls: perFrame?.dispatches ?? finite(inPage.summary?.dispatchCalls?.mean),
      renderPasses: perFrame?.renderPasses ?? finite(inPage.summary?.renderPasses?.mean),
      computePasses: perFrame?.computePasses ?? finite(inPage.summary?.computePasses?.mean),
      setPipelineCalls: finite(inPage.summary?.setPipelineCalls?.mean),
      setBindGroupCalls: finite(inPage.summary?.setBindGroupCalls?.mean),
      bundleDrawCalls: perFrame?.bundleDraws ?? null
    },
    glOps: { drawCalls: perFrame?.glDrawCalls ?? null, clearCalls: perFrame?.glClears ?? null },
    perFrame,
    churnSites: inPage.summary?.churnSites ?? {},
    pipelines,
    gpuErrors: context.gpuErrors,
    hitches: context.hitches,
    findings,
    warnings,
    warningCount: warnings.length,
    recommendations,
    highlights
  };

  const sampleErrors = (inPage.samples || []).filter(sample => sample?.error).map(sample => ({ index: sample.index, ...sample.error }));
  return {
    diagnostics: {
      validity,
      signal: {
        gpuTimingSamples: gpu.hookValues.length,
        gpuTiming: gpuTimingMetadata(gpu.hook),
        autoGpu: gpu.auto.status === "unavailable" ? null : gpuTimingMetadata(gpu.auto),
        hookFound: Boolean(inPage.hook?.found),
        observedFrameCount: context.observedFrameCount,
        samplingMode: context.samplingMode,
        sampleCount: context.sampleCount
      },
      instrumentation: {
        enabled: Boolean(inPage.instrumentation?.after),
        errors: Array.isArray(inPage.instrumentation?.errors) ? inPage.instrumentation.errors : inPage.instrumentation?.after?.errors || []
      },
      pageErrors: (report?.pageEvents || []).filter(event => event?.type === "pageerror" || event?.type === "requestfailed" || event?.type === "httperror"),
      pageErrorCount: pageErrorCounts(report).total,
      sampleErrors,
      warningCount: warnings.length,
      warnings,
      recommendations,
      highlights
    },
    summary
  };
}

/**
 * §5.2 bottleneck class. Pure; works on a raw report (inPage + cdp + options)
 * before finalize. Pass `{validity}` to reuse an already computed validity.
 */
export function classifyBottleneck(report, { validity } = {}) {
  return classifyContext(analysisContext(report), validity ?? report?.diagnostics?.validity ?? null);
}

/** §5.4: the one heap computation. diagnostics and compare read only this. */
export function heapSummary(report) {
  const inPage = report?.inPage || {};
  const samples = activeSamples(report);
  const hookMode = samplingModeOf(report) === "hook";
  const frames = frameDeltasOf(report)?.length ?? finite(inPage.summary?.observedFrameCount) ?? 0;
  const deltas = samples.map(sample => sample.memory?.delta?.performanceMemory?.usedJSHeapSize).filter(Number.isFinite);
  const allocKiBPerFrame = frames > 0 && deltas.length
    ? round(deltas.reduce((total, value) => total + Math.max(0, value), 0) / KIB / frames, 4) : null;
  const retained = inPage.memory?.retained;
  const windowMs = finite(retained?.windowMs) ?? (samples.length ? samples.reduce((total, sample) => total + (finite(sample.elapsedMs) ?? 0), 0) : null);
  if (hookMode || (windowMs !== null && windowMs < 1000)) {
    // No per-second rate: a short or hook-paced window cannot separate a leak from GC timing.
    if (!deltas.length) return unavailableHeap(allocKiBPerFrame);
    const middle = median(deltas);
    const over = deltas.filter(value => value > 64 * KIB).length;
    // Per-sample deltas are pre-GC, so allocation churn (three.js ≈ 275 KiB/sample) looks like growth. Flag only
    // with ≥ 3 samples, and only when the GC bracket, if present, also retained > 512 KiB. Frames mode without a
    // bracket never flags: rAF-driven churn is indistinguishable from a leak there.
    const bracketed = retained?.available === true && Number.isFinite(retained.deltaBytes);
    const confirmed = bracketed ? retained.deltaBytes > 512 * KIB : hookMode;
    return { available: true, method: "hook-median", retainedMiBPerSec: null, retainedBytes: middle, allocKiBPerFrame,
      samplesOver64KiB: over, sampleCount: deltas.length,
      flagged: deltas.length >= 3 && middle > 64 * KIB && over * 3 >= deltas.length * 2 && confirmed };
  }
  // CDP JSHeapUsedSize is blind to ArrayBuffer leaks; only the GC bracket counts.
  if (retained?.available === true && Number.isFinite(retained.deltaBytes) && windowMs > 0) {
    return { available: true, method: "gc-bracket", retainedMiBPerSec: round(retained.deltaBytes / MIB / (windowMs / 1000), 4),
      retainedBytes: retained.deltaBytes, allocKiBPerFrame };
  }
  return unavailableHeap(allocKiBPerFrame);
}

function unavailableHeap(allocKiBPerFrame) {
  return { available: false, method: "unavailable", retainedMiBPerSec: null, retainedBytes: null, allocKiBPerFrame };
}

export function warningCodes(report) {
  return new Set((report?.summary?.warnings || report?.diagnostics?.warnings || []).map((warning) => warning.code));
}

// ---------------------------------------------------------------- measurement context (shared with compare.js)

/** Display refresh, budget and the page's effective frame rate (§5.1). */
export function refreshState(report) {
  const summary = report?.inPage?.summary || {};
  const cadence = summary.cadence || report?.summary?.cadence || null;
  const rawHz = finite(cadence?.hz);
  const validRefresh = rawHz !== null && rawHz >= 60 && cadence?.hitRate !== null;
  const hz = validRefresh ? rawHz : (cadence ? 60 : null);
  const budgetMs = validRefresh ? (finite(cadence?.intervalMs) ?? 1000 / rawHz) : DEFAULT_BUDGET_MS;
  const refreshHz = hz ?? 1000 / budgetMs;
  const fps = finite(summary.fps?.mean) ?? finite(report?.summary?.fps);
  const activity = summary.activity;
  const pageFps = finite(activity?.pageFps?.mean ?? activity?.pageFps) ?? finite(report?.summary?.pageFps);
  const activeFrameRatio = finite(activity?.activeFrameRatio) ?? finite(report?.summary?.activeFrameRatio);
  const lowActivity = activeFrameRatio !== null && activeFrameRatio < 0.9 && pageFps > 0;
  const fpsEff = lowActivity ? pageFps : fps;
  return { hz, budgetMs, refreshHz, hitRate: finite(cadence?.hitRate), fps, pageFps, activeFrameRatio, lowActivity, fpsEff,
    belowRefresh: fpsEff !== null && fpsEff < 0.95 * refreshHz };
}

/** The page's own frame time for one sample: 1000/pageFps when it renders on < 90% of ticks (§4.1). */
export function sampleFrameTimeMs(sample) {
  const activity = sample?.activity;
  if (Number.isFinite(activity?.activeFrameRatio) && activity.activeFrameRatio < 0.9 && activity.pageFps > 0) return 1000 / activity.pageFps;
  return finite(sample?.measurement?.observedFrames?.frameTimeMs?.mean ?? sample?.measurement?.frameTimeMs?.mean);
}

/** Per-sample CPU ms/frame from `cdp.samples` (§4.1), aligned with `inPage.samples`; null where unknown or idle. */
export function cpuSampleValues(report) {
  const samples = Array.isArray(report?.inPage?.samples) ? report.inPage.samples : [];
  const values = Array(samples.length).fill(null);
  const cdpSamples = Array.isArray(report?.cdp?.samples) ? report.cdp.samples : [];
  if (!cdpSamples.length) return values;
  const byIndex = new Map(samples.map((sample, position) => [sample?.index ?? position, position]));
  for (const entry of cdpSamples) {
    const position = byIndex.get(entry?.index);
    const sample = samples[position];
    if (position === undefined || !sample || sample.idle === true) continue;
    const seconds = entry.endTs - entry.startTs;
    const frameRefMs = sampleFrameTimeMs(sample);
    if (!(seconds > 0) || !Number.isFinite(entry.threadTimeS) || frameRefMs === null) continue;
    values[position] = entry.threadTimeS / seconds * frameRefMs;
  }
  return values;
}

/** Per-sample slow-frame rate (deltas > 1.5 × budget), aligned with `inPage.samples`. */
export function slowFrameRateSamples(report) {
  const samples = Array.isArray(report?.inPage?.samples) ? report.inPage.samples : [];
  const values = Array(samples.length).fill(null);
  const { budgetMs } = refreshState(report);
  const deltas = frameDeltasOf(report);
  const counts = samples.map(sample => sample?.idle === true ? 0 : finite(sample?.measurement?.observedFrames?.frameTimeMs?.count) ?? 0);
  if (deltas && deltas.length === counts.reduce((total, count) => total + count, 0)) {
    // frameDeltasMs concatenates every non-idle sample's deltas in sample order.
    let offset = 0;
    samples.forEach((sample, index) => {
      const count = counts[index];
      if (sample?.idle === true || !count) return;
      let slow = 0;
      for (let item = offset; item < offset + count; item++) if (deltas[item] > 1.5 * budgetMs) slow++;
      values[index] = slow / count;
      offset += count;
    });
    return values;
  }
  // Older reports: the frame observer's own slow count (slowFrameThresholdMs) is the closest per-sample evidence.
  samples.forEach((sample, index) => {
    const observed = sample?.measurement?.observedFrames;
    const count = finite(observed?.frameTimeMs?.count);
    if (sample?.idle === true || !(count > 0) || !Number.isFinite(observed?.slowFrameCount)) return;
    values[index] = observed.slowFrameCount / count;
  });
  return values;
}

/** Pooled slow frames: count of frame deltas > 1.5 × budget (the only definition, §1.9). */
export function slowFrameStats(report) {
  const { budgetMs } = refreshState(report);
  const limit = 1.5 * budgetMs;
  const deltas = frameDeltasOf(report);
  if (deltas) {
    const count = deltas.filter(value => value > limit).length;
    return { count, frames: deltas.length, rate: deltas.length ? count / deltas.length : 0 };
  }
  const inPage = report?.inPage || {};
  const frames = finite(inPage.summary?.observedFrameCount) ?? 0;
  // Older reports kept every frame above slowFrameThresholdMs (≤ 1.5 × budget) as a record.
  const count = Array.isArray(inPage.slowFrames)
    ? inPage.slowFrames.filter(frame => frame?.frameDurationMs > limit).length
    : finite(inPage.summary?.slowFrameCount) ?? 0;
  return { count, frames, rate: frames > 0 ? count / frames : 0 };
}

/** Sampling-window GPU work per frame (§1.6 `perFrame`), derived from counters for older reports. */
export function perFrameCounters(report) {
  const inPage = report?.inPage || {};
  const summary = inPage.summary || {};
  if (summary.perFrame && typeof summary.perFrame === "object") return summary.perFrame;
  // Aggregates (ab) carry no samples, only the pooled summary.
  if (report?.summary?.perFrame && typeof report.summary.perFrame === "object" && !inPage.samples?.length) return report.summary.perFrame;
  const window = inPage.instrumentation?.delta ?? summary.instrumentationCounters;
  const frames = frameDeltasOf(report)?.length ?? finite(summary.observedFrameCount);
  if (!window || !(frames > 0)) return null;
  const get = key => Number.isFinite(window[key]) ? window[key] / frames : 0;
  const nonZero = key => activeSamples(report).filter(sample => sample.instrumentation?.delta?.[key] > 0).length;
  return {
    createBindGroup: get("webgpu.createBindGroup"), createBuffer: get("webgpu.createBuffer") + get("webgl2.createBuffer") + get("webgl.createBuffer"),
    createTexture: get("webgpu.createTexture") + get("webgl2.createTexture") + get("webgl.createTexture"),
    createView: get("webgpu.createView"), createSampler: get("webgpu.createSampler"), createShaderModule: get("webgpu.createShaderModule"),
    createPipelinesSync: get("webgpu.createRenderPipeline") + get("webgpu.createComputePipeline"),
    createPipelinesAsync: get("webgpu.createRenderPipelineAsync") + get("webgpu.createComputePipelineAsync"),
    writeBufferBytes: get("webgpu.writeBufferBytes"), writeTextureBytes: get("webgpu.writeTextureBytes"),
    drawCalls: get("webgpu.drawCalls"), bundleDraws: get("webgpu.bundleDrawsExecuted"), dispatches: get("webgpu.dispatchCalls"),
    renderPasses: get("webgpu.renderPasses"), computePasses: get("webgpu.computePasses"),
    glDrawCalls: get("webgl2.drawCalls") + get("webgl.drawCalls"), glClears: get("webgl2.clearCalls") + get("webgl.clearCalls"),
    submits: get("webgpu.queueSubmits"),
    nonZeroSamples: { createBindGroup: nonZero("webgpu.createBindGroup"), createBuffer: nonZero("webgpu.createBuffer"), createTexture: nonZero("webgpu.createTexture") }
  };
}

/** CPU ms/frame (§5.1): the per-sample median when `cdp.samples` exists, else the before/after window. */
export function cpuMsPerFrameOf(report) {
  const deltas = frameDeltasOf(report);
  const frameTimeMsMean = deltas?.length ? deltas.reduce((total, value) => total + value, 0) / deltas.length
    : finite(report?.inPage?.summary?.frameTimeMsMean?.mean);
  return cpuContext(report, refreshState(report), frameTimeMsMean).cpuMsPerFrame;
}

/** `summary.pipelines` for a raw report: totals plus the sampling-window sync count. */
export function pipelineCounts(report) {
  const frames = frameDeltasOf(report)?.length ?? finite(report?.inPage?.summary?.observedFrameCount) ?? 0;
  return pipelineSummary(report, perFrameCounters(report), frames);
}

export function samplingModeOf(report) {
  return report?.options?.samplingMode ?? report?.inPage?.config?.samplingMode ?? "frames";
}

function activeSamples(report) {
  return (Array.isArray(report?.inPage?.samples) ? report.inPage.samples : []).filter(sample => sample && sample.idle !== true);
}

function frameDeltasOf(report) {
  const deltas = report?.inPage?.summary?.frameDeltasMs;
  return Array.isArray(deltas) ? deltas.filter(Number.isFinite) : null;
}

function analysisContext(report, options = {}) {
  const inPage = report?.inPage || {};
  const summary = inPage.summary || {};
  const samples = Array.isArray(inPage.samples) ? inPage.samples : [];
  const samplingMode = samplingModeOf(report);
  const refresh = refreshState(report);
  const deltas = frameDeltasOf(report);
  const sortedDeltas = deltas?.length ? [...deltas].sort((a, b) => a - b) : null;
  const hookFrameTimeMean = samples.some(sample => Number.isFinite(sample?.measurement?.frameTimeMs?.mean) || Number.isFinite(sample?.measurement?.frameTimeMsMean));
  const frameTimeMsMean = !hookFrameTimeMean && sortedDeltas
    ? round(sortedDeltas.reduce((total, value) => total + value, 0) / sortedDeltas.length, 4)
    : finite(summary.frameTimeMsMean?.mean);
  const frameTimeMsP95 = sortedDeltas ? round(percentile(sortedDeltas, 0.95), 4) : finite(summary.frameTimeMsP95?.p95 ?? summary.frameTimeMsP95?.mean);
  const frameTimeMsP99 = sortedDeltas ? percentile(sortedDeltas, 0.99) : finite(summary.frameTimeMsP99?.max ?? summary.frameTimeMsP99?.mean);
  const frameTimeMsMax = sortedDeltas ? sortedDeltas.at(-1) : finite(summary.frameTimeMsMax?.max);
  const knownFrames = finite(summary.observedFrameCount) ?? deltas?.length ?? null;
  const observedFrameCount = knownFrames ?? 0;
  const slow = slowFrameStats(report);
  const cpu = cpuContext(report, refresh, frameTimeMsMean);
  const gpu = gpuContext(report);
  const perFrame = perFrameCounters(report);
  const heap = heapSummary(report);
  const trackedVram = trackedVramSummary(inPage);
  const drawCallsPerFrame = perFrame
    ? round((perFrame.drawCalls ?? 0) + (perFrame.bundleDraws ?? 0) + (perFrame.glDrawCalls ?? 0), 4)
    : drawCallsFromCounters(summary.instrumentationCounters || inPage.instrumentation?.delta, observedFrameCount);
  const appContexts = summary.appGpuContexts && typeof summary.appGpuContexts === "object"
    ? Object.values(summary.appGpuContexts).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0) : null;
  return {
    report,
    options: report?.options || {},
    thresholds: thresholdOptions(report, options),
    samplingMode,
    hookMode: samplingMode === "hook",
    ...refresh,
    frameTimeMsMean, frameTimeMsP95, frameTimeMsP99, frameTimeMsMax,
    observedFrameCount,
    // Older inputs without a frame count still carry a frame rate.
    frameSignal: samplingMode === "hook" || (knownFrames !== null ? knownFrames >= 2 : refresh.fps !== null),
    slowFrameCount: slow.count,
    slowFrameRate: round(slow.rate, 6),
    slowFrameFrames: slow.frames,
    sampleCount: finite(summary.sampleCount) ?? samples.length,
    idleSampleCount: samples.filter(sample => sample?.idle === true).length,
    cpuMsPerFrame: cpu.cpuMsPerFrame,
    cpuSource: cpu.source,
    mainThreadBusy: cpu.mainThreadBusy,
    cpuProfile: report?.cpuProfile ?? null,
    gpu,
    perFrame,
    heap,
    trackedVram,
    drawCallsPerFrame,
    pipelines: pipelineSummary(report, perFrame, observedFrameCount),
    gpuErrors: gpuErrorSummary(inPage),
    hitches: hitchSummary(inPage, refresh.budgetMs),
    failedResources: failedResources(report),
    appGpuContexts: appContexts,
    unobserved: report?.options?.autoInstrument === true && appContexts === 0
  };
}

function cpuContext(report, refresh, frameTimeMsMean) {
  const before = report?.cdp?.before?.performanceMetrics;
  const after = report?.cdp?.after?.performanceMetrics;
  const elapsed = after && before ? after.Timestamp - before.Timestamp : null;
  const mainThreadBusy = elapsed > 0 && Number.isFinite(after.TaskDuration) && Number.isFinite(before.TaskDuration)
    ? round((after.TaskDuration - before.TaskDuration) / elapsed, 4) : null;
  const perSample = cpuSampleValues(report).filter(Number.isFinite);
  if (perSample.length) return { cpuMsPerFrame: round(median(perSample), 4), source: "samples", mainThreadBusy };
  // ThreadTime only: Script/Layout/RecalcStyle durations never split CPU time (§5.1).
  const frameRefMs = refresh.lowActivity ? 1000 / refresh.pageFps : frameTimeMsMean;
  const cpuMsPerFrame = elapsed > 0 && Number.isFinite(after.ThreadTime) && Number.isFinite(before.ThreadTime) && frameRefMs > 0
    ? round((after.ThreadTime - before.ThreadTime) / elapsed * frameRefMs, 4) : null;
  return { cpuMsPerFrame, source: cpuMsPerFrame === null ? null : "window", mainThreadBusy };
}

function gpuContext(report) {
  const hook = collectGpuTimingEvidence(report);
  const auto = collectAutoGpuEvidence(report);
  const hookValues = hook.status === "single-scope" ? (hook.values || []).filter(Number.isFinite) : [];
  const hookStats = numericStats(hookValues);
  const autoMs = auto.pooled?.p50 ?? (auto.perSampleMs.length ? median(auto.perSampleMs) : null);
  // §5.1 trust: auto p50 when stable or saturated (whatever its partial-frame status); else a warm/fixed-work
  // stable hook mean; else untrusted.
  const autoTrusted = autoMs !== null && (auto.stability.status === "stable" || auto.saturated);
  const hookTrusted = hookStats !== null && ["warm", "fixed-work"].includes(hook.provenance) && hook.stability?.status === "stable";
  // The decision metric: a trusted, uncontended warm/fixed-work hook gates in separate captures, auto GPU never
  // does (§4.2), so the hook wins the primary even when the auto value classifies the page.
  const hookPreferred = hookTrusted && hook.plausibility?.status !== "contended";
  const gpuMs = autoTrusted ? autoMs : hookTrusted ? hookStats.mean : null;
  return {
    hook, auto, hookValues, hookStats, autoMs, hookPreferred,
    gpuMs: gpuMs === null ? null : round(gpuMs, 4),
    gpuSource: autoTrusted ? "auto" : hookTrusted ? "hook" : null,
    gpuSaturated: autoTrusted && auto.saturated === true,
    // Best available estimate, trusted or not; only used to split gpu-bound from gpu/compositor-bound (§5.2 rule 4).
    estimateMs: gpuMs ?? autoMs ?? hookStats?.mean ?? null,
    metric: hookPreferred ? HOOK_GPU_METRIC : autoTrusted ? AUTO_GPU_METRIC : hookTrusted ? HOOK_GPU_METRIC : null
  };
}

function classifyContext(c, validity) {
  const { gpu } = c;
  const hzText = `${formatNumber(c.refreshHz, 0)} Hz`;
  const result = {
    class: "unknown", subtype: null, hz: c.hz, budgetMs: round(c.budgetMs, 4), fps: round(c.fps, 4), pageFps: round(c.pageFps ?? c.fps, 4),
    mainThreadBusy: c.mainThreadBusy, cpuMsPerFrame: c.cpuMsPerFrame,
    gpuMs: gpu.gpuMs, gpuSource: gpu.gpuSource, gpuSaturated: gpu.gpuSaturated,
    gpuShare: gpu.gpuMs !== null && !gpu.gpuSaturated ? round(gpu.gpuMs / c.budgetMs, 4) : null,
    headroomMs: gpu.gpuSaturated || (c.cpuMsPerFrame === null && gpu.gpuMs === null) ? null
      : round(c.budgetMs - Math.max(c.cpuMsPerFrame ?? 0, gpu.gpuMs ?? 0), 4),
    primaryMetric: null,
    reason: ""
  };
  const share = gpu.gpuMs !== null && !gpu.gpuSaturated ? `GPU ${Math.round(gpu.gpuMs / c.budgetMs * 100)}% of budget` : null;
  const unobserved = c.unobserved || validity?.warnings?.some?.(warning => warning.code === "gpu-work-unobserved");
  if (unobserved) {
    // A warm hook is still direct GPU evidence (and gates between separate captures).
    return { ...result, primaryMetric: gpu.hookPreferred ? HOOK_GPU_METRIC : c.cpuMsPerFrame !== null ? CPU_METRIC : null,
      reason: "no main-thread GPU work observed" };
  }
  // 0. Hook sampling or no frame signal: nothing to classify against a display.
  if (c.hookMode || !c.frameSignal) {
    const primary = gpu.hookStats ? HOOK_GPU_METRIC : firstCustomMeanKey(c.report);
    return { ...result, primaryMetric: primary, reason: c.hookMode ? "hook sampling mode" : "fewer than 2 observed frames" };
  }
  // 1. GPU first (digest:ux-1): a saturated or near-budget GPU limits the page even at full refresh.
  if (gpu.gpuSaturated || (gpu.gpuMs !== null && gpu.gpuMs >= 0.85 * c.budgetMs)) {
    // Saturated: auto GPU cannot rank changes, so frame time decides unless a warm hook measures the fixed work.
    return { ...result, class: "gpu-bound", primaryMetric: gpu.gpuSaturated ? (gpu.hookPreferred ? HOOK_GPU_METRIC : FRAME_METRIC) : gpu.metric,
      reason: gpu.gpuSaturated ? `GPU ≥ budget (saturated) at ${hzText}` : `GPU ${formatNumber(gpu.gpuMs, 1)} ms is ${share} at ${hzText}` };
  }
  // 2. Pinned at refresh.
  if (c.fpsEff !== null && c.fpsEff >= 0.95 * c.refreshHz && (c.hitRate === null || c.hitRate >= 0.9)) {
    let primary = CPU_METRIC;
    if (gpu.gpuMs !== null && (c.cpuMsPerFrame === null || gpu.gpuMs >= c.cpuMsPerFrame)) primary = gpu.metric;
    else if (gpu.gpuMs === null && c.cpuMsPerFrame === null) primary = FRAME_METRIC;
    return { ...result, class: "vsync-capped", primaryMetric: primary,
      reason: `fps pinned at ${hzText}; ${share ?? "GPU headroom unknown"}` };
  }
  const fpsText = `${formatNumber(c.fpsEff, 1)} fps`;
  // 3. Main thread saturated.
  if (c.mainThreadBusy !== null && c.mainThreadBusy >= 0.85) {
    return { ...result, class: "cpu-bound", subtype: c.cpuProfile?.classification === "submission-bound" ? "submission-bound" : null,
      primaryMetric: FRAME_METRIC, reason: `main thread ${Math.round(c.mainThreadBusy * 100)}% busy at ${fpsText}` };
  }
  // 4. Idle main thread below refresh: the GPU or the compositor limits the page.
  if (c.mainThreadBusy !== null && c.mainThreadBusy < 0.5) {
    const gpuBound = gpu.estimateMs !== null && c.frameTimeMsMean !== null && gpu.estimateMs >= 0.85 * c.frameTimeMsMean;
    return { ...result, class: gpuBound ? "gpu-bound" : "gpu/compositor-bound", primaryMetric: gpu.metric ?? FRAME_METRIC,
      reason: `main thread ${Math.round(c.mainThreadBusy * 100)}% busy at ${fpsText}; ${gpuBound
        ? `GPU ${formatNumber(gpu.estimateMs, 1)} ms${gpu.metric ? "" : " (untrusted timing)"} ≈ frame time` : "GPU time does not explain the frame time"}` };
  }
  return { ...result, class: "mixed", primaryMetric: FRAME_METRIC,
    reason: `${fpsText} below ${hzText}; main thread ${c.mainThreadBusy === null ? "busy unknown" : `${Math.round(c.mainThreadBusy * 100)}% busy`}` };
}

function gpuSummary(c) {
  const { gpu } = c;
  const hookPart = gpu.hookStats ? {
    meanMs: round(gpu.hookStats.mean, 6), p50Ms: round(gpu.hookStats.p50, 6), scope: gpu.hook.scope, provenance: gpu.hook.provenance,
    stability: gpu.hook.stability, plausibility: gpu.hook.plausibility
  } : null;
  const autoPresent = gpu.autoMs !== null;
  const passes = (gpu.auto.passes || []).slice(0, 5).map(pass => ({
    key: pass.key, type: pass.type ?? null,
    exclusiveMs: finite(pass.exclusiveP50Ns) === null ? null : round(pass.exclusiveP50Ns / 1e6, 4),
    durationMs: finite(pass.durationP50Ns) === null ? null : round(pass.durationP50Ns / 1e6, 4),
    share: autoPresent && gpu.autoMs > 0 && Number.isFinite(pass.exclusiveP50Ns) ? round(pass.exclusiveP50Ns / 1e6 / gpu.autoMs, 4) : null,
    overlapped: pass.overlapped === true, site: pass.appSite ?? pass.site ?? null
  }));
  return {
    // Auto wins for display; the hook stays available below (and is the primary when warm, see gpuContext).
    source: autoPresent ? "auto" : gpu.hookStats ? "hook" : null,
    frameMsP50: autoPresent ? round(gpu.autoMs, 4) : gpu.hookStats ? round(gpu.hookStats.p50, 6) : null,
    frameMsP95: autoPresent ? round(gpu.auto.pooled?.p95 ?? Math.max(...gpu.auto.perSampleMs), 4) : gpu.hookStats ? round(gpu.hookStats.p95, 6) : null,
    timedFrames: autoPresent ? gpu.auto.timedFrames : null,
    provenance: autoPresent ? gpu.auto.provenance : gpu.hookStats ? gpu.hook.provenance : null,
    stability: autoPresent ? gpu.auto.stability : gpu.hookStats ? gpu.hook.stability : null,
    plausibility: autoPresent ? gpu.auto.plausibility : gpu.hookStats ? gpu.hook.plausibility : null,
    passes,
    hook: hookPart
  };
}

function pipelineSummary(report, perFrame, frames) {
  const instrumentation = report?.inPage?.instrumentation || {};
  const resources = instrumentation.after?.resources?.pipelines;
  const counters = instrumentation.after?.counters;
  const samples = report?.inPage?.samples || [];
  const hookPipelines = samples.reduce((max, sample) => Math.max(max, sample?.measurement?.trackedGpuMemory?.pipelines?.syncCount || 0), 0);
  const count = (...keys) => counters ? keys.reduce((total, key) => total + (Number.isFinite(counters[key]) ? counters[key] : 0), 0) : null;
  const window = instrumentation.delta ?? report?.inPage?.summary?.instrumentationCounters;
  const windowSync = window ? ["webgpu.createRenderPipeline", "webgpu.createComputePipeline"]
    .reduce((total, key) => total + (Number.isFinite(window[key]) ? window[key] : 0), 0) : null;
  return {
    syncCount: finite(resources?.syncCount) ?? count("webgpu.createRenderPipeline", "webgpu.createComputePipeline") ?? hookPipelines,
    asyncCount: finite(resources?.asyncCount) ?? count("webgpu.createRenderPipelineAsync", "webgpu.createComputePipelineAsync") ?? 0,
    shaderModules: finite(resources?.shaderModules) ?? count("webgpu.createShaderModule") ?? 0,
    // Sampling window only (cap-6): warmup creations feed only the startup info finding.
    syncInWindow: windowSync ?? (Number.isFinite(perFrame?.createPipelinesSync) && frames > 0 ? Math.round(perFrame.createPipelinesSync * frames) : null)
  };
}

function gpuErrorSummary(inPage) {
  const errors = inPage.summary?.gpuErrors;
  const counters = inPage.instrumentation?.after?.counters;
  const total = finite(errors?.total) ?? finite(counters?.["webgpu.uncapturedErrors"]) ?? 0;
  const start = inPage.instrumentation?.warmupStartCounters;
  const inWindow = finite(errors?.inWindow)
    ?? (start && counters ? (counters["webgpu.uncapturedErrors"] || 0) - (start["webgpu.uncapturedErrors"] || 0) : null)
    ?? finite(inPage.instrumentation?.delta?.["webgpu.uncapturedErrors"]) ?? 0;
  return { total, inWindow, top: Array.isArray(errors?.top) ? errors.top.slice(0, 3) : [] };
}

function hitchSummary(inPage, budgetMs) {
  const frames = Array.isArray(inPage.slowFrames) ? inPage.slowFrames : [];
  return frames.filter(frame => frame?.frameDurationMs > 1.5 * budgetMs)
    .sort((a, b) => b.frameDurationMs - a.frameDurationMs).slice(0, 3)
    .map(frame => {
      const script = frame.loaf?.scripts?.[0];
      const file = typeof script?.url === "string" ? script.url.replace(/^[a-z]+:\/\/[^/]+/i, "").split("/").pop() || script.url : null;
      return {
        durationMs: round(frame.frameDurationMs, 2),
        blockingMs: finite(frame.loaf?.blockingMs),
        where: script ? `${script.fn || "(anonymous)"} @ ${file ?? "?"}${Number.isFinite(script.charPosition) ? ` (char ${script.charPosition})` : ""}` : null,
        loaf: Boolean(frame.loaf)
      };
    });
}

function trackedVramSummary(inPage) {
  const after = inPage.memory?.after?.trackedGpuMemory
    || inPage.instrumentation?.after?.resources
    || null;
  const before = inPage.memory?.before?.trackedGpuMemory
    || inPage.instrumentation?.before?.resources
    || null;
  if (!after || !Number.isFinite(after.totalBytes)) {
    return {
      available: false,
      bufferCount: null,
      bufferMiB: null,
      leakedResources: 0,
      textureCount: null,
      textureMiB: null,
      totalMiB: null
    };
  }
  const buffers = after.byKind?.buffer || {};
  const textures = after.byKind?.texture || {};
  return {
    available: true,
    bufferCount: finite(buffers.count) || 0,
    bufferMiB: (finite(buffers.bytes) || 0) / MIB,
    leakedResources: Math.max(0, (finite(after.totalResources) || 0) - (finite(before?.totalResources) || 0)),
    textureCount: finite(textures.count) || 0,
    textureMiB: (finite(textures.bytes) || 0) / MIB,
    totalMiB: after.totalBytes / MIB
  };
}

function drawCallsFromCounters(counters, frames) {
  if (!counters || !(frames > 0)) return null;
  const draws = Object.entries(counters).reduce((total, [key, value]) => (
    /(^|\.)(drawCalls|bundleDrawsExecuted)$/i.test(key) && Number.isFinite(value) ? total + value : total), 0);
  return round(draws / frames, 4);
}

function firstCustomMeanKey(report) {
  const keys = new Set();
  for (const sample of report?.inPage?.samples || []) {
    if (!sample?.measurement || sample.idle === true) continue;
    for (const path of Object.keys(flattenMeasurementNumbers(sample.measurement))) keys.add(path);
  }
  const first = [...keys].filter(path => !/(^|\.)(trackedGpuMemory|gpuTiming)(\.|$)|\.atMs$|timestamp/i.test(path)).sort()[0];
  return first ? `custom.${first}.mean` : null;
}

function thresholdOptions(report, options) {
  return {
    maxDrawCallsPerFrame: Number(options.maxDrawCallsPerFrame ?? 1000),
    maxFrameJitterMs: Number(options.maxFrameJitterMs ?? 5),
    maxResourceGrowth: Number(options.maxResourceGrowth ?? 0),
    maxTrackedVramMiB: Number(options.maxTrackedVramMiB ?? 512),
    minFps: Number(options.minFps ?? 50),
    slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? report?.options?.slowFrameThresholdMs ?? 20)
  };
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}
