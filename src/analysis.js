import { numericStats } from "./stats.js";
import { analyzeReport as detailedAnalysis, summarizeReport } from "./diagnostics.js";
import { reportValidity } from "./validity.js";

const MIB = 1024 * 1024;

export function finalizeReport(report, options = {}) {
  const analysis = analyzeReport(report, options);
  const details = detailedAnalysis(report);
  const extraSummary = summarizeReport(report, details);
  const ranks = {excellent: 0, good: 1, "needs-work": 2, poor: 3};
  if (details.recommendations.some(item => item.severity === "critical")) analysis.summary.verdict = "poor";
  else if (details.recommendations.length && ranks[analysis.summary.verdict] < 2) analysis.summary.verdict = "needs-work";
  return {
    ...report,
    diagnostics: { ...details, ...analysis.diagnostics },
    schemaVersion: 2,
    summary: { ...extraSummary, ...analysis.summary }
  };
}

export function analyzeReport(report, options = {}) {
  const inPage = report?.inPage || {};
  const source = inPage.summary || {};
  const frameTimeMsMean = number(source.frameTimeMsMean?.mean);
  const frameTimeMsP95 = number(source.frameTimeMsP95?.p95 ?? source.frameTimeMsP95?.mean);
  const frameTimeMsMax = number(source.frameTimeMsMax?.max);
  const fps = number(source.fps?.mean);
  const gpuTimes = collectGpuFrameTimes(inPage.samples || []);
  const gpuFrameStats = numericStats(gpuTimes);
  const trackedVram = trackedVramSummary(inPage);
  const elapsedSeconds = totalElapsedMs(inPage.samples || []) / 1000;
  const heapDelta = number(inPage.memory?.delta?.performanceMemory?.usedJSHeapSize)
    ?? sumNumbers(inPage.samples || [], (sample) => sample.memory?.delta?.performanceMemory?.usedJSHeapSize);
  const jsHeapGrowthMBPerSec = heapDelta != null && elapsedSeconds > 0
    ? heapDelta / MIB / elapsedSeconds
    : null;
  const slowFrameCount = number(source.slowFrameCount) || 0;
  const observedFrameCount = number(source.observedFrameCount) || 0;
  const counters = source.instrumentationCounters || inPage.instrumentation?.delta || {};
  const drawCalls = sumMatchingCounters(counters, /(^|\.)(drawCalls)$/i);
  const drawCallsPerFrame = observedFrameCount > 0 ? drawCalls / observedFrameCount : null;
  const pageErrors = (report?.pageEvents || []).filter((event) => event.type === "pageerror" || event.type === "requestfailed");
  const sampleErrors = (inPage.samples || []).filter(sample => sample.error).map(sample => ({ index: sample.index, ...sample.error }));
  const warnings = buildWarnings({
    autoInstrument: Boolean(report?.options?.autoInstrument),
    drawCallsPerFrame,
    fps,
    frameTimeMsMean,
    frameTimeMsP95,
    gpuFrameMsMean: gpuFrameStats?.mean ?? null,
    hookFound: Boolean(inPage.hook?.found),
    jsHeapGrowthMBPerSec,
    observedFrameCount,
    pageErrors: [...pageErrors, ...sampleErrors],
    slowFrameCount,
    trackedVram,
    thresholds: thresholdOptions(report, options)
  });
  const verdict = verdictFor(warnings, {
    fps,
    frameTimeMsP95,
    jsHeapGrowthMBPerSec
  });

  const summary = {
    drawCallsPerFrame,
    fps,
    frameTimeMsMax,
    frameTimeMsMean,
    frameTimeMsP95,
    gpuFrameMsMean: gpuFrameStats?.mean ?? null,
    gpuFrameMsP95: gpuFrameStats?.p95 ?? null,
    jsHeapGrowthMBPerSec,
    observedFrameCount,
    slowFrameCount,
    trackedVram,
    verdict,
    warnings
  };

  return {
    diagnostics: {
      validity: reportValidity(report),
      instrumentation: {
        enabled: Boolean(inPage.instrumentation?.after),
        errors: inPage.instrumentation?.after?.errors || []
      },
      pageErrors,
      sampleErrors,
      signal: {
        gpuTimingSamples: gpuTimes.length,
        hookFound: Boolean(inPage.hook?.found),
        observedFrameCount,
        sampleCount: number(source.sampleCount) || inPage.samples?.length || 0
      },
      warningCount: warnings.length,
      warnings
    },
    summary
  };
}

export function warningCodes(report) {
  return new Set((report?.summary?.warnings || report?.diagnostics?.warnings || []).map((warning) => warning.code));
}

function buildWarnings(metrics) {
  const warnings = [];
  const add = (code, severity, message, recommendation, metric, value, threshold) => {
    warnings.push({ code, message, metric, recommendation, severity, threshold, value });
  };

  if (metrics.pageErrors.length > 0) {
    add(
      "page-errors",
      "high",
      `${metrics.pageErrors.length} page or network error(s) occurred during profiling.`,
      "Fix runtime and failed-request errors before trusting performance measurements.",
      "pageErrors",
      metrics.pageErrors.length,
      0
    );
  }
  if (metrics.observedFrameCount < 2 && !metrics.hookFound) {
    add(
      "limited-signal",
      "high",
      "No benchmark hook and too few animation frames were observed.",
      "Expose globalThis.__gpuReportBench or ensure the page continuously renders while sampled.",
      "observedFrameCount",
      metrics.observedFrameCount,
      2
    );
  }
  if (metrics.hookFound && (metrics.observedFrameCount < 2 || (metrics.fps == null && metrics.frameTimeMsMean == null))) {
    add(
      "limited-frame-signal",
      "medium",
      "The benchmark ran, but too few animation callbacks were observed for frame pacing.",
      "Keep the profiled page visible; use the hook's GPU or compute timings when no animation loop is expected.",
      "observedFrameCount",
      metrics.observedFrameCount,
      2
    );
  }
  if (!metrics.autoInstrument && !metrics.trackedVram.available) {
    add(
      "vram-untracked",
      "low",
      "GPU allocations were not tracked.",
      "Re-run with --auto-instrument to capture declared buffer and texture memory.",
      "trackedVram.available",
      0,
      1
    );
  }
  if (metrics.fps != null && metrics.fps < metrics.thresholds.minFps) {
    add(
      "low-fps",
      metrics.fps < 30 ? "high" : "medium",
      `Mean frame rate is ${metrics.fps.toFixed(1)} FPS.`,
      "Reduce per-frame CPU/GPU work; use frame-time and GPU-time metrics to locate the limiting side.",
      "fps",
      metrics.fps,
      metrics.thresholds.minFps
    );
  }
  if (metrics.frameTimeMsP95 != null && metrics.frameTimeMsP95 > metrics.thresholds.slowFrameThresholdMs) {
    add(
      "frame-stutter",
      metrics.frameTimeMsP95 > 50 ? "high" : "medium",
      `Frame-time p95 is ${metrics.frameTimeMsP95.toFixed(2)} ms with ${metrics.slowFrameCount} slow frame(s).`,
      "Inspect long tasks, shader/pipeline compilation, resource uploads, and oversized render passes around slow frames.",
      "frameTimeMsP95",
      metrics.frameTimeMsP95,
      metrics.thresholds.slowFrameThresholdMs
    );
  }
  if (metrics.frameTimeMsMean != null && metrics.frameTimeMsP95 != null
      && metrics.frameTimeMsP95 - metrics.frameTimeMsMean > metrics.thresholds.maxFrameJitterMs) {
    add(
      "frame-jitter",
      "medium",
      `Frame-time p95 is ${(metrics.frameTimeMsP95 - metrics.frameTimeMsMean).toFixed(2)} ms above the mean.`,
      "Batch uploads and allocations outside the render loop and precompile pipelines before measurement.",
      "frameTimeP95MinusMeanMs",
      metrics.frameTimeMsP95 - metrics.frameTimeMsMean,
      metrics.thresholds.maxFrameJitterMs
    );
  }
  if (metrics.gpuFrameMsMean != null && metrics.gpuFrameMsMean > metrics.thresholds.maxGpuFrameMs) {
    add(
      "gpu-bound",
      metrics.gpuFrameMsMean > 25 ? "high" : "medium",
      `Mean GPU work is ${metrics.gpuFrameMsMean.toFixed(2)} ms per measured frame/pass.`,
      "Reduce overdraw, bandwidth, attachment size, shader complexity, or dispatch dimensions.",
      "gpuFrameMsMean",
      metrics.gpuFrameMsMean,
      metrics.thresholds.maxGpuFrameMs
    );
  }
  if (metrics.jsHeapGrowthMBPerSec != null && metrics.jsHeapGrowthMBPerSec > metrics.thresholds.maxHeapGrowthMBPerSec) {
    add(
      "heap-churn",
      metrics.jsHeapGrowthMBPerSec > 20 ? "high" : "medium",
      `JS heap grew at ${metrics.jsHeapGrowthMBPerSec.toFixed(2)} MiB/s during sampling.`,
      "Reuse typed arrays and transient objects; move allocations out of the frame loop and verify after forced GC.",
      "jsHeapGrowthMBPerSec",
      metrics.jsHeapGrowthMBPerSec,
      metrics.thresholds.maxHeapGrowthMBPerSec
    );
  }
  if (metrics.trackedVram.totalMiB != null && metrics.trackedVram.totalMiB > metrics.thresholds.maxTrackedVramMiB) {
    add(
      "high-vram",
      metrics.trackedVram.totalMiB > 1024 ? "high" : "medium",
      `Declared live GPU resources total ${metrics.trackedVram.totalMiB.toFixed(1)} MiB.`,
      "Downsize textures, select compressed formats, reuse transient targets, and destroy unused resources.",
      "trackedVram.totalMiB",
      metrics.trackedVram.totalMiB,
      metrics.thresholds.maxTrackedVramMiB
    );
  }
  if (metrics.trackedVram.leakedResources > metrics.thresholds.maxResourceGrowth) {
    add(
      "gpu-resource-growth",
      "medium",
      `${metrics.trackedVram.leakedResources} GPU resource(s) remained live after the sampled workload.`,
      "Verify that per-frame or per-scene buffers, textures, and render targets are reused or destroyed.",
      "trackedVram.leakedResources",
      metrics.trackedVram.leakedResources,
      metrics.thresholds.maxResourceGrowth
    );
  }
  if (metrics.drawCallsPerFrame != null && metrics.drawCallsPerFrame > metrics.thresholds.maxDrawCallsPerFrame) {
    add(
      "draw-call-pressure",
      "medium",
      `Approximately ${metrics.drawCallsPerFrame.toFixed(0)} draw calls were issued per observed frame.`,
      "Use instancing, batching, render bundles, culling, and material/state sorting.",
      "drawCallsPerFrame",
      metrics.drawCallsPerFrame,
      metrics.thresholds.maxDrawCallsPerFrame
    );
  }

  return warnings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.code.localeCompare(b.code));
}

function verdictFor(warnings, metrics) {
  const high = warnings.filter((warning) => warning.severity === "high").length;
  const medium = warnings.filter((warning) => warning.severity === "medium").length;
  if (high >= 2 || (metrics.fps != null && metrics.fps < 30)
      || (metrics.frameTimeMsP95 != null && metrics.frameTimeMsP95 > 50)
      || (metrics.jsHeapGrowthMBPerSec != null && metrics.jsHeapGrowthMBPerSec > 20)) {
    return "poor";
  }
  if (high > 0 || medium > 0) {
    return "needs-work";
  }
  if (warnings.length > 0) {
    return "good";
  }
  return "excellent";
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
    bufferCount: number(buffers.count) || 0,
    bufferMiB: (number(buffers.bytes) || 0) / MIB,
    leakedResources: Math.max(0, (number(after.totalResources) || 0) - (number(before?.totalResources) || 0)),
    textureCount: number(textures.count) || 0,
    textureMiB: (number(textures.bytes) || 0) / MIB,
    totalMiB: after.totalBytes / MIB
  };
}

function collectGpuFrameTimes(samples) {
  const values = [];
  for (const sample of samples) {
    collectGpuNumbers(sample?.measurement, "", values);
  }
  return values;
}

function collectGpuNumbers(value, path, out, depth = 0) {
  if (depth > 8 || value == null) {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const key = path.split(".").at(-1) || "";
    if (/^(gpuMs|gpuFrameMs|gpuTimeMs|gpuDurationMs)$/i.test(key)) {
      out.push(value);
    } else if (/^(gpuNs|gpuTimeNs|gpuDurationNs)$/i.test(key)) {
      out.push(value / 1e6);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectGpuNumbers(item, path ? `${path}.${key}` : key, out, depth + 1);
  }
}

function thresholdOptions(report, options) {
  return {
    maxDrawCallsPerFrame: Number(options.maxDrawCallsPerFrame ?? 1000),
    maxFrameJitterMs: Number(options.maxFrameJitterMs ?? 5),
    maxGpuFrameMs: Number(options.maxGpuFrameMs ?? 13),
    maxHeapGrowthMBPerSec: Number(options.maxHeapGrowthMBPerSec ?? 5),
    maxResourceGrowth: Number(options.maxResourceGrowth ?? 0),
    maxTrackedVramMiB: Number(options.maxTrackedVramMiB ?? 512),
    minFps: Number(options.minFps ?? 50),
    slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? report?.options?.slowFrameThresholdMs ?? 20)
  };
}

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1 }[severity] || 0;
}

function sumMatchingCounters(counters, pattern) {
  return Object.entries(counters || {}).reduce((total, [key, value]) => (
    pattern.test(key) && Number.isFinite(value) ? total + value : total
  ), 0);
}

function totalElapsedMs(samples) {
  return samples.reduce((total, sample) => total + (number(sample?.elapsedMs) || 0), 0);
}

function sumNumbers(items, getter) {
  let found = false;
  let total = 0;
  for (const item of items) {
    const value = getter(item);
    if (Number.isFinite(value)) {
      found = true;
      total += value;
    }
  }
  return found ? total : null;
}

function number(value) {
  return Number.isFinite(value) ? value : null;
}
