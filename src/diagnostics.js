import { analyzeReport as analyzeFullReport, finalizeReport as finalizeFullReport } from "./analysis.js";

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };
// Legacy views (§1.9 `warnings`, `recommendations`): metric name and category per finding code.
const LEGACY = {
  "gpu-bound": ["fpsEff", "rendering"], "cpu-bound": ["fpsEff", "rendering"], "frame-rate-below-refresh": ["fpsEff", "rendering"],
  "gpu-near-budget": ["gpuMs", "gpu-execution"], stutter: ["slowFrameCount", "rendering"], "heap-leak": ["heap.retainedMiBPerSec", "memory"],
  "pipeline-sync-stall": ["pipelines.syncInWindow", "pipeline"], "resource-churn": ["perFrame.createBuffer", "memory"],
  "bind-group-churn": ["perFrame.createBindGroup", "bindgroup"], "gpu-resource-growth": ["trackedVram.leakedResources", "memory"],
  "high-vram": ["trackedVram.totalMiB", "memory"], "low-fps": ["fps", "rendering"], "frame-jitter": ["frameTimeP95MinusMeanMs", "rendering"],
  "unstable-cadence": ["cadence.hitRate", "rendering"], "draw-call-pressure": ["drawCallsPerFrame", "draw-calls"],
  "heap-churn": ["heap.allocKiBPerFrame", "memory"], "startup-sync-pipelines": ["pipelines.syncCount", "pipeline"],
  "page-errors": ["failedResources", "network"], "gpu-timing-unstable": ["gpu.stability", "gpu-execution"],
  "gpu-timing-unavailable": ["gpu.source", "gpu-execution"], "limited-signal": ["observedFrameCount", "rendering"],
  "limited-frame-signal": ["observedFrameCount", "rendering"], "ambiguous-gpu-timing": ["gpuTiming", "gpu-execution"]
};

/**
 * The one findings rule set (§5.3). `context` is analysis.js's measurement context plus
 * `bottleneck` and `validity`. Every finding:
 * `{code, role, severity, value, threshold, unit, message, next, aliases, evidence?}`.
 */
export function buildFindings(context) {
  const findings = [];
  const add = (code, role, severity, value, threshold, unit, message, next, aliases = [], evidence) => {
    findings.push({ code, role, severity, value: round(value), threshold: round(threshold), unit, message, next, aliases,
      ...(evidence === undefined ? {} : { evidence }) });
  };
  const c = context;
  const bottleneck = c.bottleneck || {};
  const gpu = c.gpu || {};
  const hz = c.refreshHz ?? 60;
  const budgetMs = c.budgetMs ?? 16.67;
  const thresholds = c.thresholds || {};
  const pass = heaviestPass(gpu);
  const passNext = pass ? `Reduce pass ${pass.key} (${fmt(pass.exclusiveP50Ns / 1e6, 2)} ms exclusive)` : null;
  const firstSite = kind => c.report?.inPage?.summary?.churnSites?.[kind]?.[0]?.site ?? null;

  // Rate cause: one finding whose code follows the bottleneck class.
  let rateCause = null;
  if (c.frameSignal !== false && !c.hookMode && Number.isFinite(c.fpsEff) && c.fpsEff < 0.95 * hz) {
    const code = bottleneck.class === "gpu-bound" ? "gpu-bound" : bottleneck.class === "cpu-bound" ? "cpu-bound" : "frame-rate-below-refresh";
    const severity = c.fpsEff < 0.5 * hz ? "high" : "medium";
    const message = code === "gpu-bound"
      ? `${fmt(c.fpsEff, 1)} fps is below the ${fmt(hz, 0)} Hz refresh; the GPU limits the frame${Number.isFinite(gpu.estimateMs) ? ` (GPU ${fmt(gpu.estimateMs, 1)} ms)` : ""}`
      : code === "cpu-bound"
        ? `${fmt(c.fpsEff, 1)} fps is below the ${fmt(hz, 0)} Hz refresh; main thread ${fmt((c.mainThreadBusy ?? 0) * 100, 0)}% busy${Number.isFinite(c.cpuMsPerFrame) ? ` (CPU ${fmt(c.cpuMsPerFrame, 1)} ms/frame)` : ""}`
        : `${fmt(c.fpsEff, 1)} fps is below the ${fmt(hz, 0)} Hz refresh (${bottleneck.class || "unknown"})`;
    const top = c.cpuProfile?.top?.[0];
    const next = code === "gpu-bound" ? passNext ?? "Reduce GPU work per frame (fragment cost, resolution, passes) and confirm with ab."
      : code === "cpu-bound" ? (top?.fn ? `Optimize ${top.fn} (${fmt(top.selfMsPerFrame, 1)} ms/frame)${top.caller?.fn ? ` called from ${top.caller.fn}` : ""}.`
        : "Profile the main thread (--cpu-profile) and cut per-frame JS and draw submission.")
        : "Compare GPU time and main-thread busy time; capture with --cpu-profile to locate the limit.";
    rateCause = code;
    // `evidence` carries the verdict inputs, so verdictFromFindings(findings, validity) needs nothing else.
    add(code, "cause", severity, c.fpsEff, 0.95 * hz, "fps", message, next, ["low-frame-rate", "moderate-frame-rate"],
      { fpsEff: round(c.fpsEff), hz: round(hz), budgetMs: round(budgetMs), frameTimeMsP95: round(c.frameTimeMsP95) });
  }

  // GPU near or over budget, whatever the class (suppressed only when gpu-bound already fired on it).
  if ((gpu.gpuSaturated || (Number.isFinite(gpu.gpuMs) && gpu.gpuMs >= 0.8 * budgetMs)) && rateCause !== "gpu-bound") {
    const severity = gpu.gpuSaturated || gpu.gpuMs >= budgetMs ? "high" : "medium";
    const message = gpu.gpuSaturated
      ? "GPU ≥ budget (saturated); frame time is the decision metric"
      : `GPU ${fmt(gpu.gpuMs, 1)} ms/frame is ${fmt(gpu.gpuMs / budgetMs * 100, 0)}% of the ${fmt(budgetMs, 1)} ms budget`;
    const next = gpu.gpuSaturated
      ? `${pass ? `Reduce pass ${pass.key}` : "Reduce GPU work per frame"}; judge changes by frame time and confirm with ab.`
      : passNext ?? "Reduce GPU work per frame and confirm with ab.";
    add("gpu-near-budget", "cause", severity, gpu.gpuSaturated ? null : gpu.gpuMs, 0.8 * budgetMs, "ms", message, next, ["high-gpu-time"]);
  }

  // Stutter: frame deltas above 1.5 × budget (the only slow-frame definition, §1.9).
  const frames = c.slowFrameFrames ?? c.observedFrameCount ?? 0;
  const stutterThreshold = Math.max(3, 0.01 * frames);
  if (!c.hookMode && c.slowFrameCount >= stutterThreshold) {
    const hitch = c.hitches?.[0];
    add("stutter", "cause", Number.isFinite(c.frameTimeMsP99) && c.frameTimeMsP99 > 3 * budgetMs ? "high" : "medium",
      c.slowFrameCount, stutterThreshold, "frames",
      `${c.slowFrameCount} of ${frames} frames took longer than ${fmt(1.5 * budgetMs, 1)} ms`,
      hitch?.where ? `Inspect the ${fmt(hitch.durationMs, 0)} ms frame at ${hitch.where}.`
        : "Look for GC, uploads, pipeline compiles and long tasks around the slow frames.",
      ["frame-stutter"], { hz: round(hz), budgetMs: round(budgetMs), frameTimeMsP95: round(c.frameTimeMsP95) });
  }

  // Heap: retained growth after GC, never CDP JSHeapUsedSize (§5.4).
  const heap = c.heap || {};
  if (heap.method === "gc-bracket" && heap.retainedMiBPerSec > 0.25 && heap.retainedBytes > 512 * 1024) {
    add("heap-leak", "cause", heap.retainedMiBPerSec > 5 ? "high" : "medium", heap.retainedMiBPerSec, 0.25, "MiB/s",
      `JS heap retained ${fmt(heap.retainedMiBPerSec, 2)} MiB/s after GC (${fmt(heap.retainedBytes / 1024, 0)} KiB over the sampling window)`,
      "Find objects kept per frame (caches, arrays, listeners, closures) and release or reuse them.",
      ["heap-churn", "high-js-heap-churn", "moderate-js-heap-growth"]);
  } else if (heap.method === "hook-median" && heap.flagged) {
    add("heap-leak", "cause", "medium", heap.retainedBytes / 1024, 64, "KiB",
      `JS heap grew a median ${fmt(heap.retainedBytes / 1024, 0)} KiB per sample (${heap.samplesOver64KiB}/${heap.sampleCount} samples over 64 KiB)`,
      "Find objects kept per iteration (caches, arrays, listeners, closures) and release or reuse them.",
      ["heap-churn", "high-js-heap-churn", "moderate-js-heap-growth"]);
  }

  // Sampling-window pipeline and resource churn (cap-6/cap-7).
  const pipelines = c.pipelines || {};
  if (pipelines.syncInWindow > 0) {
    add("pipeline-sync-stall", "cause", "medium", pipelines.syncInWindow, 0, "count",
      `${pipelines.syncInWindow} synchronous pipeline creation(s) during sampling`,
      "Create pipelines with create*PipelineAsync before the render loop and cache them.");
  }
  const perFrame = c.perFrame || {};
  const nonZero = perFrame.nonZeroSamples || {};
  const churnKind = (nonZero.createBuffer ?? 0) >= 2 ? "createBuffer" : (nonZero.createTexture ?? 0) >= 2 ? "createTexture" : null;
  if (churnKind && ((perFrame.createBuffer ?? 0) > 0 || (perFrame.createTexture ?? 0) > 0)) {
    const site = firstSite(churnKind);
    add("resource-churn", "cause", "medium", (perFrame.createBuffer ?? 0) + (perFrame.createTexture ?? 0), 0, "per frame",
      `${fmt((perFrame.createBuffer ?? 0) + (perFrame.createTexture ?? 0), 1)} buffers/textures created per frame (${nonZero[churnKind]} samples)`,
      site ? `Reuse the ${churnKind === "createBuffer" ? "buffers" : "textures"} created at ${site}.` : "Allocate buffers and textures once and reuse them across frames.");
  }
  if ((nonZero.createBindGroup ?? 0) >= 2 && (perFrame.createBindGroup ?? 0) > 0) {
    const site = firstSite("createBindGroup");
    add("bind-group-churn", "cause", "low", perFrame.createBindGroup, 0, "per frame",
      `${fmt(perFrame.createBindGroup, 1)} bind groups created per frame (${nonZero.createBindGroup} samples)`,
      site ? `Cache the bind groups created at ${site}.` : "Cache bind groups whose layout and resources do not change.");
  }
  const vram = c.trackedVram || {};
  if (vram.leakedResources > (thresholds.maxResourceGrowth ?? 0)) {
    add("gpu-resource-growth", "cause", "medium", vram.leakedResources, thresholds.maxResourceGrowth ?? 0, "resources",
      `${vram.leakedResources} GPU resource(s) remained live after the sampled workload`,
      "Destroy or reuse per-frame buffers, textures and render targets.");
  }
  if (vram.totalMiB > (thresholds.maxTrackedVramMiB ?? 512)) {
    add("high-vram", "cause", vram.totalMiB > 1024 ? "high" : "medium", vram.totalMiB, thresholds.maxTrackedVramMiB ?? 512, "MiB",
      `Tracked live GPU resources total ${fmt(vram.totalMiB, 1)} MiB`,
      "Downsize or compress textures, reuse transient targets and destroy unused resources.", ["high-vram-footprint"]);
  }

  // Symptoms (old thresholds): never set the verdict on their own. In hook mode fps and frame times come from
  // hook-returned values, not the display, so the frame symptoms are skipped (§5.2 rule 0).
  if (!c.hookMode && Number.isFinite(c.fps) && c.fps < (thresholds.minFps ?? 50)) {
    add("low-fps", "symptom", c.fps < 30 ? "high" : "medium", c.fps, thresholds.minFps ?? 50, "fps",
      `Mean frame rate is ${fmt(c.fps, 1)} FPS`, "See the cause findings for the limiting side.");
  }
  if (!c.hookMode && Number.isFinite(c.frameTimeMsP95) && Number.isFinite(c.frameTimeMsMean) && c.frameTimeMsP95 - c.frameTimeMsMean > (thresholds.maxFrameJitterMs ?? 5)) {
    add("frame-jitter", "symptom", "medium", c.frameTimeMsP95 - c.frameTimeMsMean, thresholds.maxFrameJitterMs ?? 5, "ms",
      `Frame-time p95 is ${fmt(c.frameTimeMsP95 - c.frameTimeMsMean, 2)} ms above the mean`,
      "Move uploads and allocations out of the render loop and precompile pipelines.");
  }
  if (!c.hookMode && Number.isFinite(c.hitRate) && c.hitRate < 0.85) {
    add("unstable-cadence", "symptom", "medium", c.hitRate, 0.85, "ratio",
      `Only ${fmt(c.hitRate * 100, 1)}% of frames hit the ${fmt(hz, 0)} Hz interval`,
      "Even out per-frame CPU/GPU work to keep frame pacing steady.");
  }
  if (Number.isFinite(c.drawCallsPerFrame) && c.drawCallsPerFrame > (thresholds.maxDrawCallsPerFrame ?? 1000)) {
    add("draw-call-pressure", bottleneck.class === "cpu-bound" ? "symptom" : "info", bottleneck.class === "cpu-bound" ? "medium" : "info",
      c.drawCallsPerFrame, thresholds.maxDrawCallsPerFrame ?? 1000, "per frame",
      `${fmt(c.drawCallsPerFrame, 0)} draw calls per frame`, "Use instancing, batching or render bundles.");
  }

  // Info.
  if (heap.allocKiBPerFrame > 64) {
    add("heap-churn", "info", "info", heap.allocKiBPerFrame, 64, "KiB/frame",
      `${fmt(heap.allocKiBPerFrame, 0)} KiB of JS heap allocated per frame (collected by GC)`,
      "Hoist per-frame allocations (vectors, arrays, descriptors) out of the render loop.");
  }
  if (pipelines.syncCount > (pipelines.syncInWindow ?? 0)) {
    const startup = pipelines.syncCount - (pipelines.syncInWindow ?? 0);
    add("startup-sync-pipelines", "info", "info", startup, 0, "count",
      `${startup} sync pipeline${startup === 1 ? "" : "s"} created at startup (${pipelines.syncInWindow > 0 ? `${pipelines.syncInWindow} during sampling` : "none during sampling"}).`,
      "Use createRenderPipelineAsync for startup pipelines.");
  }
  const nonCritical = (c.failedResources || []).filter(resource => !resource.critical);
  if (nonCritical.length) {
    const url = nonCritical.find(resource => typeof resource.url === "string" && /^[a-z]+:/i.test(resource.url))?.url ?? null;
    add("page-errors", "info", "info", nonCritical.length, 0, "requests",
      `${nonCritical.length} non-critical request(s) failed${url ? `, first: ${url}` : ""}`,
      url ? `Fix or remove the request for ${url}.` : "Inspect pageEvents for the failed requests.");
  }
  const unstable = [gpu.auto?.stability, gpu.hookStats ? gpu.hook?.stability : null].filter(item => item?.status === "unstable");
  if (unstable.length) {
    const reasons = [...new Set(unstable.flatMap(item => item.reasons || []))];
    add("gpu-timing-unstable", "info", "info", null, null, null, `GPU timing unstable (${reasons.join(", ")})`,
      "Confirm GPU deltas with ab; separate captures do not gate GPU rows.");
  }
  if (!c.hookMode && gpu.autoMs === null && !gpu.hookStats && gpu.hook?.status !== "ambiguous") {
    const autoInstrument = c.options?.autoInstrument === true;
    add("gpu-timing-unavailable", "info", "info", null, null, null,
      `No GPU timing${autoInstrument ? (c.options?.gpuTiming === false ? " (gpuTiming off)" : " (no timed frames)") : " (auto-instrumentation off)"}`,
      autoInstrument ? "Check timestamp-query support (doctor) or return gpuTimeNs from a warm hook."
        : "Run with --auto-instrument for per-pass GPU timing.");
  }
  // Not in §5.3 (kept from the old rule set): why a frames-mode verdict is unknown, and an ambiguous hook scope.
  if (c.frameSignal === false) {
    const hookFound = c.report?.inPage?.hook?.found === true;
    add(hookFound ? "limited-frame-signal" : "limited-signal", "symptom", "low", c.observedFrameCount, 2, "frames",
      `Fewer than 2 animation frames were observed${hookFound ? " although the benchmark hook ran" : ""}.`,
      "Keep the page rendering continuously while sampled, or use --sampling-mode hook.");
  }
  if (gpu.hook?.status === "ambiguous") {
    add("ambiguous-gpu-timing", "symptom", "low", gpu.hook.timingCount ?? null, null, "timings",
      `Multiple or changing GPU timing scopes (${(gpu.hook.reasons || []).join(", ")}) prevent one hook GPU summary`,
      "Return one GPU timing per sample (one gpuTimeNs scope) or compare the exact custom metrics.");
  }
  return findings.sort((a, b) => roleRank(a.role) - roleRank(b.role) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/**
 * §5.3 verdict, first match wins. The `poor` thresholds that are not findings (fpsEff, frame p95,
 * retained heap) are read from the findings' `evidence`/values; optional `metrics` ({fpsEff, hz,
 * budgetMs, frameTimeMsP95, retainedMiBPerSec, frameSignal, hookMode}) override them.
 */
export function verdictFromFindings(findings, validity, metrics = {}) {
  const causes = (findings || []).filter(finding => finding.role === "cause")
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const reasons = causes.slice(0, 3);
  const m = { ...metricsFromFindings(findings), ...Object.fromEntries(Object.entries(metrics || {}).filter(([, value]) => value !== undefined)) };
  if (validity?.valid === false) return { verdict: "invalid", reasons: [] };
  if ((validity?.warnings || []).some(warning => warning.code === "gpu-work-unobserved")) return { verdict: "unknown", reasons: [] };
  // Not in §5.3: a frames-mode capture without frames has nothing to judge.
  if (m.frameSignal === false) return { verdict: "unknown", reasons: [] };
  const hz = m.hz ?? 60;
  const budgetMs = m.budgetMs ?? 1000 / hz;
  const high = causes.filter(finding => finding.severity === "high").length;
  // Hook mode: fps and frame times are hook-returned, not display frames (§5.2 rule 0).
  const frameRules = m.hookMode !== true;
  if ((frameRules && Number.isFinite(m.fpsEff) && m.fpsEff < 0.5 * hz)
      || (frameRules && Number.isFinite(m.frameTimeMsP95) && m.frameTimeMsP95 > 3 * budgetMs)
      || (Number.isFinite(m.retainedMiBPerSec) && m.retainedMiBPerSec > 5)
      || high >= 2) {
    return { verdict: "poor", reasons };
  }
  if (causes.some(finding => finding.severity === "medium" || finding.severity === "high")) return { verdict: "needs-work", reasons };
  if (causes.some(finding => finding.severity === "low")) return { verdict: "good", reasons };
  return { verdict: "excellent", reasons };
}

/** Verdict inputs carried by the findings themselves (rate/stutter evidence, heap-leak value, frame signal). */
function metricsFromFindings(findings) {
  const metrics = {};
  for (const finding of findings || []) {
    const evidence = finding?.evidence;
    if (finding?.role === "cause" && evidence && typeof evidence === "object") {
      for (const key of ["fpsEff", "hz", "budgetMs", "frameTimeMsP95"]) {
        if (Number.isFinite(evidence[key]) && metrics[key] === undefined) metrics[key] = evidence[key];
      }
    }
    if (finding?.code === "heap-leak" && finding.unit === "MiB/s" && Number.isFinite(finding.value)) metrics.retainedMiBPerSec = finding.value;
    if (finding?.code === "limited-signal" || finding?.code === "limited-frame-signal") metrics.frameSignal = false;
  }
  return metrics;
}

/** LEGACY `summary.warnings`: findings with role ≠ info, old shape. */
export function legacyWarnings(findings) {
  return (findings || []).filter(finding => finding.role !== "info").map(finding => ({
    code: finding.code, message: finding.message, metric: LEGACY[finding.code]?.[0] ?? finding.unit, recommendation: finding.next,
    severity: finding.severity, threshold: finding.threshold, value: finding.value
  }));
}

/** LEGACY `summary.recommendations`: findings with role ≠ info, old recommendation shape. */
export function legacyRecommendations(findings) {
  return (findings || []).filter(finding => finding.role !== "info").map(finding => ({
    id: finding.code, category: LEGACY[finding.code]?.[1] ?? "rendering", severity: finding.severity, title: finding.message,
    action: finding.next, evidence: `${LEGACY[finding.code]?.[0] ?? finding.code} ${fmt(finding.value, 2)}${finding.unit ? ` ${finding.unit}` : ""}`,
    value: finding.value, threshold: finding.threshold, unit: finding.unit
  }));
}

/** Compatibility: the diagnostics block of analysis.js `analyzeReport` (findings + legacy views). */
export function analyzeReport(report) {
  const { summary, diagnostics } = analyzeFullReport(report);
  return { ...diagnostics, findings: summary.findings };
}

/** Compatibility: the §1.9 summary of a report. */
export function summarizeReport(report) {
  return analyzeFullReport(report).summary;
}

/** Compatibility: attaches `summary` and `diagnostics` in place and returns the same object. */
export function finalizeReport(report) {
  const finalized = finalizeFullReport(report);
  report.summary = finalized.summary;
  report.diagnostics = finalized.diagnostics;
  report.schemaVersion = finalized.schemaVersion;
  return report;
}

export function formatDiagnostics(analysis) {
  const lines = [];
  const highlights = analysis.highlights || [];
  if (highlights.length > 0) {
    lines.push("Performance highlights:");
    for (const highlight of highlights) lines.push(`  - ${highlight}`);
  }
  const recommendations = analysis.recommendations || [];
  if (recommendations.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Bottlenecks and recommendations:");
    for (const rec of recommendations) {
      lines.push(`  [${rec.severity}] [${String(rec.category).toUpperCase()}] ${rec.title}`);
      lines.push(`     Evidence: ${rec.evidence}`);
      lines.push(`     Action:   ${rec.action}`);
    }
  } else {
    if (lines.length > 0) lines.push("");
    lines.push("No significant bottlenecks or memory leaks detected.");
  }
  return lines.join("\n");
}

function heaviestPass(gpu) {
  const passes = Array.isArray(gpu?.auto?.passes) ? gpu.auto.passes : [];
  return passes.filter(pass => Number.isFinite(pass?.exclusiveP50Ns)).sort((a, b) => b.exclusiveP50Ns - a.exclusiveP50Ns)[0] ?? null;
}

function roleRank(role) {
  return { cause: 0, symptom: 1, info: 2 }[role] ?? 3;
}

function fmt(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
}
