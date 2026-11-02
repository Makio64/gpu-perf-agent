import { readFile } from "node:fs/promises";
import { numberOption } from "./options.js";
import { cpuMsPerFrameOf, cpuSampleValues, heapSummary, perFrameCounters, pipelineCounts, refreshState, samplingModeOf,
  sampleFrameTimeMs, slowFrameRateSamples, slowFrameStats, warningCodes } from "./analysis.js";
import { reportValidity } from "./validity.js";
import { flattenMeasurementNumbers, formatNumber, independentDifferenceStatsFromStats, median, numericStats,
  pairedDifferenceStats, robustStandardError } from "./stats.js";
import { collectAutoGpuEvidence, collectGpuTimingEvidence, gpuTimingMetadata } from "./gpu-timing.js";

const AUTO_GPU = "health.autoGpuFrameMs.p50";
const HOOK_GPU = "health.gpuFrameMs.mean";
const FRAME = "frame.frameTimeMs.mean";
const CPU = "health.cpuMsPerFrame";
const SLOW = "health.slowFrameRate";
const HEAP = "health.retainedHeapMiBPerSec";
const MIN_PAIRED_ROUNDS = 4;
// Hook-returned paths that mirror profiler telemetry or clocks, never workload metrics (§4.1).
const CUSTOM_EXCLUDED = /(^|\.)(trackedGpuMemory|gpuTiming)(\.|$)|\.atMs$|timestamp/i;
const CUSTOM_SEGMENT_EXCLUDED_RE = /(^|\.)(length|byteLength|count|fps|frameCount|frameTimeMs|observationWindowMs|observedFrames|samples|slowFrameCount|totalResources|trackedGpuMemory|gpuTiming)(\.|$)|timestamp/i;
const LEADING_DIGIT_RE = /^\d+/;
const AT_MS_LEAF_RE = /(^|\.)atMs$/i;
const GPU_TIMING_LEAF = /^(gpuMs|gpuFrameMs|gpuTimeMs|gpuDurationMs|gpuNs|gpuTimeNs|gpuDurationNs)$/i;
/** Rows whose ab per-round value is the round's median per-sample value (§4.6). */
export const PER_ROUND_MEDIAN = Object.freeze(new Set([FRAME, AUTO_GPU, HOOK_GPU, CPU, SLOW, "frame.fps.mean"]));

const entry = (direction, unit, absFloor, kind) => Object.freeze({ direction, unit, absFloor, kind });
/** §4.2 decision-metric allowlist. Everything else is informational. */
export const DECISION_METRICS = Object.freeze({
  [AUTO_GPU]: entry("lower", "ms", 0.02, "auto-gpu"),
  [HOOK_GPU]: entry("lower", "ms", 0.02, "hook-gpu"),
  [FRAME]: entry("lower", "ms", 0.25, "frame"),
  [SLOW]: entry("lower", "ratio", 0.01, "slow-frames"),
  [CPU]: entry("lower", "ms", 0.25, "cpu"),
  [HEAP]: entry("lower", "MiB/s", null, "heap"),
  "health.trackedVramMiB": entry("lower", "MiB", 1, "deterministic"),
  "health.drawCallsPerFrame": entry("lower", "count", 0.5, "deterministic"),
  "webgpu.syncPipelinesInWindow.count": entry("lower", "count", 1, "deterministic")
});
const CUSTOM_METRIC = entry(null, null, 0, "custom");

export async function loadReport(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function reportMetrics(report) {
  // Reports without a health scalar do not need another measurement traversal.
  const hasHealth = Object.hasOwn(report?.summary || {}, "gpuFrameMsMean") || Number.isFinite(report?.aggregateMetrics?.[HOOK_GPU]);
  return reportMetricsWithGpuEvidence(report, hasHealth ? collectGpuTimingEvidence(report) : { status: "unavailable" });
}

// Internal aggregation helper; public reportMetrics remains a unary mapper.
export function reportMetricsWithGpuEvidence(report, gpu) {
  return collectReportMetrics(report, customMeasurementStats(report, gpu), gpu);
}

function hasHealthGpu(report, gpu) {
  return gpu.status === "single-scope"
    && (Object.hasOwn(report?.summary || {}, "gpuFrameMsMean") || Number.isFinite(report?.aggregateMetrics?.[HOOK_GPU]));
}

function collectReportMetrics(report, customStats, gpu, statsCache = new Map(), paths = null, precomputedAuto = null, precomputedRefresh = null) {
  const metrics = {};
  const summary = report?.inPage?.summary || {};
  const health = report?.summary || {};
  const hasSamples = Array.isArray(report?.inPage?.samples) && report.inPage.samples.length > 0;
  const pooled = key => {
    const values = paths?.[key]?.filter(Number.isFinite);
    return values?.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
  };

  add(metrics, "frame.elapsedMs.mean", summary.elapsedMs?.mean);
  add(metrics, "frame.elapsedMs.p95", summary.elapsedMs?.p95);
  add(metrics, "frame.fps.mean", summary.fps?.mean);
  add(metrics, "frame.fps.p95", summary.fps?.p95);
  add(metrics, FRAME, pooled(FRAME) ?? summary.frameTimeMsMean?.mean);
  add(metrics, "frame.frameTimeMs.p95", summary.frameTimeMsP95?.mean);
  add(metrics, "frame.frameTimeMs.p99", summary.frameTimeMsP99?.mean);
  add(metrics, "frame.maxJitterMs.mean", summary.maxJitterMs?.mean ?? summary.maxJitter?.mean);
  add(metrics, "gpu.computeDurationNs.mean", summary.computeTimeNs?.mean);
  add(metrics, "gpu.renderDurationNs.mean", summary.renderTimeNs?.mean);
  add(metrics, "webgpu.drawCalls.mean", summary.drawCalls?.mean ?? health.webgpuOps?.drawCalls);
  add(metrics, "webgpu.dispatchCalls.mean", summary.dispatchCalls?.mean ?? health.webgpuOps?.dispatchCalls);
  add(metrics, "webgpu.syncPipelines.count", health.pipelines?.syncCount ?? report?.diagnostics?.recommendations?.find(r => r.id === "pipeline-sync-stall")?.value);
  add(metrics, "webgpu.bindGroupsCreated.count", health.bindGroups?.createdCount);
  add(metrics, "webgpu.syncPipelinesInWindow.count", health.pipelines?.syncInWindow ?? (hasSamples ? pipelineCounts(report).syncInWindow : undefined));
  add(metrics, "warmup.durationMs", report?.inPage?.warmup?.durationMs);
  add(metrics, "warmup.lagSpikeMs", report?.inPage?.warmup?.lagSpikeMs);
  add(metrics, "memory.jsHeapDeltaBytes.mean", summary.jsHeapDeltaBytes?.mean);
  add(metrics, "memory.trackedGpuDeltaBytes.mean", summary.trackedGpuDeltaBytes?.mean);
  add(metrics, "memory.trackedGpuTotalBytes.max", summary.trackedGpuTotalBytes?.max);
  add(metrics, "memory.userAgentMemoryDeltaBytes.mean", summary.userAgentMemoryDeltaBytes?.mean);
  add(metrics, "cdp.JSHeapUsedSize.after", report?.cdp?.after?.performanceMetrics?.JSHeapUsedSize);
  add(metrics, "cdp.JSHeapTotalSize.after", report?.cdp?.after?.performanceMetrics?.JSHeapTotalSize);
  add(metrics, "trace.durationMs", report?.trace?.summary?.durationMs);
  add(metrics, "trace.gpu.eventCount", report?.trace?.summary?.gpu?.eventCount);
  add(metrics, "trace.gpu.completeDurationMs.mean", report?.trace?.summary?.gpu?.completeDurationMs?.mean);
  add(metrics, "health.frameTimeMs.p95", health.frameTimeMsP95);
  add(metrics, "health.frameTimeMs.max", health.frameTimeMsMax);
  if (hasHealthGpu(report, gpu)) {
    // Old saved captures may contain a mean pooled over unrelated passes. Raw
    // observations, when present, are authoritative for this derived metric.
    add(metrics, HOOK_GPU, gpu.source === "raw" ? sampleStats(gpu.values, statsCache)?.mean : health.gpuFrameMsMean);
  }
  // The hook's own nanosecond mean duplicates the health GPU row.
  if (!Number.isFinite(metrics[HOOK_GPU])) add(metrics, "gpu.durationNs.mean", summary.gpuTimeNs?.mean);
  // v3 summaries alias jsHeapGrowthMBPerSec to the retained rate; keep the legacy row only for older reports.
  if (!health.heap) add(metrics, "health.heapGrowthMBPerSec", health.jsHeapGrowthMBPerSec);
  add(metrics, "health.trackedVramMiB", health.trackedVram?.totalMiB);
  add(metrics, "health.drawCallsPerFrame", health.drawCallsPerFrame);
  if (hasSamples || report?.inPage?.summary) {
    const auto = precomputedAuto ?? collectAutoGpuEvidence(report);
    if (auto.status !== "unavailable") {
      add(metrics, AUTO_GPU, auto.pooled?.p50 ?? (auto.perSampleMs.length ? median(auto.perSampleMs) : undefined));
      add(metrics, "health.autoGpuFrameMs.p95", auto.pooled?.p95);
      for (const pass of auto.passes || []) {
        if (typeof pass?.key === "string") add(metrics, `gpu.pass.${pass.key}.exclusiveP50Ns`, pass.exclusiveP50Ns);
      }
    }
    add(metrics, CPU, health.cpuMsPerFrame ?? cpuMsPerFrameOf(report));
    const slow = health.slowFrameRate === undefined && samplingModeOf(report) !== "hook" ? slowFrameStats(report) : null;
    add(metrics, SLOW, health.slowFrameRate ?? (slow?.frames > 0 ? slow.rate : undefined));
    const heap = health.heap ?? heapSummary(report);
    if (heap?.method === "gc-bracket") add(metrics, HEAP, heap.retainedMiBPerSec);
  } else {
    add(metrics, CPU, health.cpuMsPerFrame);
    add(metrics, SLOW, health.slowFrameRate);
    if (health.heap?.method === "gc-bracket") add(metrics, HEAP, health.heap.retainedMiBPerSec);
  }

  for (const key of Object.keys(customStats)) {
    add(metrics, `custom.${key}.mean`, customStats[key].mean);
  }

  if (report?.aggregateMetrics) {
    for (const [key, value] of Object.entries(report.aggregateMetrics)) {
      if (key === HOOK_GPU && (gpu.status !== "single-scope" || gpu.source === "raw")) continue;
      add(metrics, key, value);
    }
  }

  return metrics;
}

/** Reject malformed budgets before starting expensive browser work. */
export function validateBudget(budget) {
  if (budget == null) return {};
  object(budget, "budget");
  knownKeys(budget, ["defaultMaxRegressionPercent", "metrics"], "budget");
  if (budget.defaultMaxRegressionPercent !== undefined) finite(budget.defaultMaxRegressionPercent, "budget.defaultMaxRegressionPercent", true);
  if (budget.metrics !== undefined) {
    object(budget.metrics, "budget.metrics");
    for (const [key, rule] of Object.entries(budget.metrics)) {
      const name = `budget.metrics.${key}`;
      if (!key.trim()) throw new TypeError("Budget metric names must not be empty.");
      object(rule, name);
      knownKeys(rule, ["direction", "maxRegressionPercent", "min", "max"], name);
      if (rule.direction !== undefined && !["higher", "lower"].includes(rule.direction)) throw new TypeError(`${name}.direction must be higher or lower.`);
      if (rule.maxRegressionPercent !== undefined) finite(rule.maxRegressionPercent, `${name}.maxRegressionPercent`, true);
      for (const bound of ["min", "max"]) if (rule[bound] !== undefined) finite(rule[bound], `${name}.${bound}`);
      if (rule.min > rule.max) throw new TypeError(`${name}.min must not exceed max.`);
    }
  }
  return budget;
}

/**
 * Comparison artifact v2 (§1.11, §4). `paired` is for ab rounds (one value per side
 * per round); separate captures never gate GPU or light-CPU rows and carry a `screen`.
 */
export function compareReports(baseReport, candidateReport, options = {}) {
  const budget = validateBudget(options.budget);
  if (options.paired !== undefined && typeof options.paired !== "boolean") throw new TypeError("paired must be a boolean.");
  const paired = options.paired === true;
  const pct = numberOption(budget.defaultMaxRegressionPercent ?? options.thresholdPercent ?? 5, "thresholdPercent") / 100;
  const base = collectSide(baseReport);
  const candidate = collectSide(candidateReport);
  const scopeMismatch = base.gpu.status === "single-scope" && candidate.gpu.status === "single-scope" && base.gpu.scope !== candidate.gpu.scope;
  if (scopeMismatch) {
    for (const side of [base, candidate]) { delete side.metrics[HOOK_GPU]; delete side.paths[HOOK_GPU]; }
  }
  const issues = [];
  if (scopeMismatch) issues.push({ code: "gpu-timing-scope-mismatch", key: HOOK_GPU, baseScope: base.gpu.scope, candidateScope: candidate.gpu.scope,
    message: "GPU timing scopes differ; the health GPU metric cannot be compared." });
  // reportValidity folds in the GPU timing issues (review:bug-1); nothing is appended here.
  const baseValidity = reportValidity(baseReport, base);
  const candidateValidity = reportValidity(candidateReport, candidate);
  if (!baseValidity.valid) issues.push({ code: "invalid-base", message: "Baseline measurements are invalid.", issues: baseValidity.issues });
  if (!candidateValidity.valid) issues.push({ code: "invalid-candidate", message: "Candidate measurements are invalid.", issues: candidateValidity.issues });
  // A capture that observed no GPU work has no work counts to hold the other side to.
  base.unobserved = (baseValidity.warnings || []).some(warning => warning.code === "gpu-work-unobserved");
  candidate.unobserved = (candidateValidity.warnings || []).some(warning => warning.code === "gpu-work-unobserved");

  const explicit = typeof options.primaryMetric === "string" && options.primaryMetric.trim() ? options.primaryMetric.trim() : null;
  const allKeys = Array.from(new Set([...Object.keys(base.metrics), ...Object.keys(candidate.metrics), ...Object.keys(budget.metrics || {}),
    ...(explicit ? [explicit] : [])])).sort();
  const context = { base, candidate, paired, pct, budget, explicit };
  const rows = [];
  for (const key of allKeys) {
    const row = buildRow(key, context, issues);
    if (row) rows.push(row);
  }

  const primarySelection = selectPrimary(base, candidate, explicit, { paired });
  let primary = null;
  if (primarySelection) {
    let row = rows.find(item => item.key === primarySelection.key);
    if (!row) row = { key: primarySelection.key, unit: metricUnit(primarySelection.key), direction: inferDirection(primarySelection.key), base: null,
      candidate: null, delta: null, deltaPercent: null, status: "unverified", gated: false, evidence: "unavailable", confidence95: null,
      boundary: null, screen: null, reasons: [], notes: [], baseStats: null, candidateStats: null };
    if (primarySelection.selection === "explicit" && (row.base === null || row.candidate === null)) {
      row.status = "unverified";
      if (!row.reasons.includes("primary-missing")) row.reasons.push("primary-missing");
    }
    primary = { key: primarySelection.key, selection: primarySelection.selection, row };
  }

  const comparableCount = rows.filter(row => row.status !== "missing").length;
  if (!comparableCount) issues.push({ code: "no-comparable-metrics", message: "No numeric metrics could be evaluated." });
  const failures = rows.filter(row => row.status === "regression" && (
    row.budgeted || (paired ? row.gated : row === primary?.row || row.evidence === "deterministic")));
  const compatibility = compareCompatibility(baseReport, candidateReport, comparableCount, scopeMismatch ? {
    key: "gpuTiming.scope", base: base.gpu.scope, candidate: candidate.gpu.scope
  } : null);
  const count = status => rows.filter(row => row.status === status).length;
  const result = {
    kind: "comparison",
    schemaVersion: 2,
    status: null,
    exitCode: null,
    statusReasons: [],
    mode: paired ? "paired" : "separate",
    primary,
    workEquivalence: workEquivalence(baseReport, candidateReport),
    rows,
    failures,
    summary: {
      improved: count("improved"), regression: count("regression"), inconclusive: count("inconclusive"), unchanged: count("unchanged"),
      unverified: count("unverified"), changed: count("changed"), gated: rows.filter(row => row.gated).length, total: rows.length,
      regressions: count("regression"), passed: count("unchanged"), missing: count("missing")
    },
    compatibility,
    validity: { valid: issues.length === 0, issues, base: baseValidity, candidate: candidateValidity },
    gpuTiming: {
      base: gpuTimingMetadata(base.gpu), candidate: gpuTimingMetadata(candidate.gpu),
      auto: { base: base.auto, candidate: candidate.auto }
    },
    missingMetrics: {
      base: allKeys.filter(key => !Number.isFinite(base.metrics[key])),
      candidate: allKeys.filter(key => !Number.isFinite(candidate.metrics[key]))
    },
    diagnostics: compareDiagnostics(baseReport, candidateReport),
    recommendationDiff: recommendationDiff(baseReport, candidateReport),
    verdicts: {
      base: baseReport?.summary?.verdict || null,
      candidate: candidateReport?.summary?.verdict || null
    }
  };
  const headline = comparisonStatus(result, { allowMismatch: options.allowMismatch === true });
  result.status = headline.status;
  result.exitCode = headline.exitCode;
  result.statusReasons = headline.reasons;
  return result;
}

/** §4.5 headline, the one status function for output.js, agent.js and the CLI. */
export function comparisonStatus(result, { allowMismatch = false } = {}) {
  const issues = result?.validity?.issues || [];
  if (result?.validity?.valid === false) {
    return { status: "invalid", exitCode: 2, reasons: issues.slice(0, 3).map(issue => issueText(issue)) };
  }
  const compatibility = result?.compatibility || {};
  if (compatibility.compatible === false && !allowMismatch) {
    return { status: "mismatch", exitCode: 2,
      reasons: (compatibility.differences || []).slice(0, 3).map(difference => `${difference.key}: base ${display(difference.base)} ≠ candidate ${display(difference.candidate)}`) };
  }
  const schema = (compatibility.warnings || []).find(warning => warning.key === "schemaVersion");
  if (schema) {
    // Name the older side: that is the one to recapture.
    const side = schema.base <= schema.candidate ? "baseline" : "candidate";
    const version = Math.min(schema.base, schema.candidate);
    return { status: "unverified", exitCode: 0, reasons: [`${side} from schemaVersion ${version}; recapture the ${side}`] };
  }
  const failures = result?.failures || [];
  if (failures.length) {
    return { status: "regression", exitCode: 1, reasons: failures.slice(0, 3).map(row => `${row.key} regressed ${formatPercent(row.deltaPercent)}`) };
  }
  const primary = result?.primary?.row;
  const work = result?.workEquivalence;
  if (primary?.status === "improved" && work?.status === "different") {
    const differences = (work.differences || []).map(item => `${item.key} ${display(item.base)} → ${display(item.candidate)}`).join(", ");
    return { status: "different-work", exitCode: 0, reasons: [`candidate does different work: ${differences || "GPU errors introduced"}`] };
  }
  if (!primary) return { status: "unverified", exitCode: 0, reasons: ["no measurable primary (vsync-pinned, no GPU timing)"] };
  const status = ["improved", "inconclusive", "unverified", "unchanged"].includes(primary.status) ? primary.status
    : primary.status === "missing" ? "unverified" : "unchanged";
  const evidence = primary.evidence === "paired-samples" ? "paired CI" : primary.evidence === "independent-samples" ? "CI" : primary.evidence;
  const why = status === "unverified" ? `primary unverified (${(primary.reasons || []).join(", ") || "no CI"})`
    : status === "improved" ? `primary improved; ${evidence} excludes boundary`
      : status === "inconclusive" ? `primary changed but its ${evidence} overlaps the boundary` : "primary within boundary";
  return { status, exitCode: 0, reasons: [why] };
}

/** §4.3 primary metric, from two reports. */
export function selectPrimaryMetric(baseReport, candidateReport, explicit = null, { paired = false } = {}) {
  return selectPrimary(collectSide(baseReport), collectSide(candidateReport), explicit, { paired });
}

/** §4.4: do the two captures render the same work? */
export function workEquivalence(baseReport, candidateReport) {
  const work = report => {
    const perFrame = report?.inPage?.summary?.perFrame ?? report?.summary?.perFrame ?? perFrameCounters(report);
    if (!perFrame) return null;
    const window = report?.inPage?.instrumentation?.delta ?? report?.inPage?.summary?.instrumentationCounters;
    const frames = report?.inPage?.summary?.frameDeltasMs?.length || report?.inPage?.summary?.observedFrameCount;
    const submits = Number.isFinite(perFrame.submits) ? perFrame.submits
      : window && frames > 0 && Number.isFinite(window["webgpu.queueSubmits"]) ? window["webgpu.queueSubmits"] / frames : 0;
    const value = key => Number.isFinite(perFrame[key]) ? perFrame[key] : 0;
    return {
      draws: value("drawCalls") + value("bundleDraws") + value("glDrawCalls"),
      dispatches: value("dispatches"),
      passes: value("renderPasses") + value("computePasses"),
      clears: value("glClears"),
      submits,
      errors: report?.summary?.gpuErrors?.total ?? report?.inPage?.summary?.gpuErrors?.total ?? null
    };
  };
  const base = work(baseReport);
  const candidate = work(candidateReport);
  if (!base || !candidate) return { status: "same", differences: [] };
  const differences = [];
  for (const [key, name] of [["draws", "draws/f"], ["dispatches", "dispatches/f"], ["passes", "passes/f"], ["clears", "clears/f"], ["errors", "gpuErrors"]]) {
    const a = base[key], b = candidate[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(b - a) > Math.max(0.5, 0.1 * Math.abs(a))) {
      differences.push({ key: name, base: round(a), candidate: round(b), deltaPercent: a !== 0 ? round((b - a) / Math.abs(a) * 100) : null });
    }
  }
  const baseWork = base.draws + base.dispatches + base.clears;
  const candidateWork = candidate.draws + candidate.dispatches + candidate.clears;
  let status = "same";
  if (baseWork + base.submits > 0 && candidateWork + candidate.submits === 0) status = "reduced-to-zero";
  // Instancing and batching collapse draws but keep the passes; work that collapses
  // to < 5% together with its passes, or to nothing, is different work.
  else if ((base.errors === 0 && candidate.errors > 0)
      || (baseWork > 0 && (candidateWork === 0 || (candidateWork < 0.05 * baseWork && candidate.passes < base.passes)))) status = "different";
  return { status, differences: differences.slice(0, 4) };
}

/** Non-gating hint for an unverified row (§4.2): where Δ lies against the boundary. */
export function rowScreen(row) {
  if (!row || row.status !== "unverified" || !Number.isFinite(row.base) || !Number.isFinite(row.candidate)) return null;
  const delta = row.candidate - row.base;
  const boundary = Number.isFinite(row.boundary) ? row.boundary : 0;
  if (Math.abs(delta) <= boundary) return "same";
  const worse = row.direction === "higher" ? delta < 0 : delta > 0;
  return worse ? "worse" : "better";
}

function buildRow(key, context, issues) {
  const { base, candidate, paired, pct, budget, explicit } = context;
  const rule = budget.metrics?.[key];
  const budgeted = rule !== undefined;
  const definition = DECISION_METRICS[key] ?? (/^custom\..+\.mean$/.test(key) || key === explicit ? CUSTOM_METRIC : null);
  const direction = rule?.direction || definition?.direction || inferDirection(key);
  const basePresent = Number.isFinite(base.metrics[key]);
  const candidatePresent = Number.isFinite(candidate.metrics[key]);
  const maxRegressionPercent = rule?.maxRegressionPercent ?? pct * 100;
  const absoluteOnly = !basePresent && candidatePresent && budgeted && (rule.min !== undefined || rule.max !== undefined) && rule.maxRegressionPercent === undefined;
  const baseValues = base.paths[key] || [];
  const candidateValues = candidate.paths[key] || [];
  const baseStats = sampleStats(base.paths[key], base.stats);
  const candidateStats = sampleStats(candidate.paths[key], candidate.stats);
  const row = {
    key, unit: definition?.unit ?? metricUnit(key), direction,
    base: basePresent ? base.metrics[key] : null, candidate: candidatePresent ? candidate.metrics[key] : null,
    delta: null, deltaPercent: null, status: "unchanged", gated: false, evidence: "threshold-only", confidence95: null,
    boundary: null, screen: null, reasons: [], notes: [],
    baseStats: baseStats && { ...baseStats }, candidateStats: candidateStats && { ...candidateStats }
  };
  if (budgeted) { row.budgeted = true; row.maxRegressionPercent = maxRegressionPercent; }

  if (!basePresent || !candidatePresent) {
    if (budgeted && !absoluteOnly) {
      issues.push({ code: "missing-metric", key, message: `${key} is missing from ${!basePresent && !candidatePresent ? "both reports" : !basePresent ? "the baseline" : "the candidate"}.` });
      return { ...row, status: "missing", evidence: "unavailable" };
    }
    if (!budgeted) {
      if (!basePresent && !candidatePresent) return null;
      return { ...row, status: "unverified", evidence: "unavailable", reasons: [basePresent ? "missing-candidate" : "missing-base"] };
    }
  }

  row.delta = basePresent ? candidatePresent ? row.candidate - row.base : null : null;
  row.deltaPercent = basePresent && row.base !== 0 && row.delta !== null ? (row.delta / Math.abs(row.base)) * 100 : null;
  const difference = paired ? pairedDifferenceStats(baseValues, candidateValues)
    : independentDifferenceStatsFromStats(baseStats, candidateStats);
  const rounds = paired ? difference?.differences.length ?? 0 : 0;
  const ciBacked = paired ? rounds >= 2 : baseStats?.count >= 3 && candidateStats?.count >= 3;
  const confidence95 = ciBacked && difference?.confidence95 && Number.isFinite(difference.confidence95.low)
    ? { low: difference.confidence95.low, high: difference.confidence95.high, method: paired ? "paired-t" : "welch-t" } : null;
  const se = paired ? 0 : Math.hypot(robustStandardError(baseStats) ?? 0, robustStandardError(candidateStats) ?? 0);
  const floor = definition?.absFloor ?? 0;
  row.boundary = Math.max(pct * Math.abs(row.base ?? 0), floor, paired ? 0 : 2 * se);
  row.confidence95 = confidence95;
  row.evidence = confidence95 ? (paired ? "paired-samples" : "independent-samples") : "threshold-only";

  if (budgeted) {
    // Budgets keep their own percent and absolute bounds and always gate.
    row.gated = true;
    row.boundary = Math.abs(row.base ?? 0) * maxRegressionPercent / 100;
    if (row.delta !== null && Math.abs(row.delta) > row.boundary) {
      row.status = (direction === "higher" ? row.delta < 0 : row.delta > 0) ? "regression" : "improved";
      if (confidence95 && !confidenceSupports(confidence95, direction, row.status, row.boundary)) row.status = "inconclusive";
    }
    if ((rule.max !== undefined && row.candidate > rule.max) || (rule.min !== undefined && row.candidate < rule.min)) {
      row.status = "regression";
      row.reasons.push("budget-breach");
    }
    return row;
  }

  if (!definition) {
    // Informational (§4.2): changed or unchanged, never gated.
    row.status = row.delta !== null && Math.abs(row.delta) > row.boundary ? "changed" : "unchanged";
    return row;
  }

  if (paired && !["heap", "deterministic"].includes(definition.kind) && (baseValues.length || candidateValues.length)
      && (baseValues.length !== candidateValues.length || baseValues.some((value, index) => !Number.isFinite(value) || !Number.isFinite(candidateValues[index])))) {
    issues.push({ code: "unmatched-pairs", key, message: `${key} does not have a complete set of matched samples.` });
  }
  const gate = gateRow(key, definition, context, { baseStats, candidateStats, rounds });
  row.notes.push(...gate.notes);
  if (definition.kind === "heap") {
    // Deterministic retained-heap rule: a new leak must clear 0.25 MiB/s and the baseline by 0.15 MiB/s.
    row.gated = true;
    row.evidence = "deterministic";
    row.confidence95 = null;
    row.boundary = 0.15;
    row.status = row.candidate > Math.max(0.25, row.base + 0.15) ? "regression"
      : row.base > Math.max(0.25, row.candidate + 0.15) ? "improved" : "unchanged";
    return row;
  }
  if (definition.kind === "deterministic" && key !== "health.trackedVramMiB" && (base.unobserved || candidate.unobserved)) {
    row.status = "unverified";
    row.evidence = "deterministic";
    row.confidence95 = null;
    row.boundary = Math.max(pct * Math.abs(row.base), floor);
    row.reasons.push("gpu-work-unobserved");
    row.screen = rowScreen(row);
    return row;
  }
  if (definition.kind === "deterministic") {
    row.gated = true;
    row.evidence = "deterministic";
    row.confidence95 = null;
    row.boundary = Math.max(pct * Math.abs(row.base), floor);
    row.status = Math.abs(row.delta) > row.boundary ? (direction === "higher" ? row.delta < 0 : row.delta > 0) ? "regression" : "improved" : "unchanged";
    return row;
  }
  if (!gate.gated) {
    row.status = "unverified";
    row.reasons.push(gate.reason);
    row.screen = rowScreen(row);
    return row;
  }
  row.gated = true;
  if (!confidence95) {
    row.status = "unverified";
    row.reasons.push("threshold-only");
    row.screen = rowScreen(row);
    return row;
  }
  if (Math.abs(row.delta) <= row.boundary) row.status = "unchanged";
  else {
    const outcome = (direction === "higher" ? row.delta < 0 : row.delta > 0) ? "regression" : "improved";
    row.status = confidenceSupports(confidence95, direction, outcome, row.boundary) ? outcome : "inconclusive";
  }
  if (gate.onlyOutcome && row.status !== gate.onlyOutcome) {
    // A saturated side cannot support any other outcome (see gateRow).
    row.status = "unverified";
    row.gated = false;
    row.reasons.push(gate.closedReason);
    row.screen = rowScreen(row);
  }
  return row;
}

// §4.2 gating conditions per decision row: {gated, reason, notes}.
function gateRow(key, definition, { base, candidate, paired }, { baseStats, candidateStats, rounds }) {
  const notes = [];
  const open = () => ({ gated: true, reason: null, notes });
  const closed = reason => ({ gated: false, reason, notes });
  const ciRow = !["heap", "deterministic"].includes(definition.kind);
  if (paired && ciRow && rounds < MIN_PAIRED_ROUNDS) return closed("too-few-rounds");
  switch (definition.kind) {
    case "auto-gpu": {
      for (const side of [base, candidate]) {
        if (side.auto?.stability?.status === "unstable" && !notes.includes("gpu-unstable")) notes.push("gpu-unstable");
        if (side.auto?.clockSensitive === true && !notes.includes("clock-sensitive")) notes.push("clock-sensitive");
      }
      if (!paired) return closed("separate-capture-gpu");
      // Timestamps that include other GPU work on most rounds of a side are not a cost difference.
      if (base.auto?.contended || candidate.auto?.contended) return closed("gpu-contended");
      if (base.auto?.saturated && candidate.auto?.saturated) return closed("gpu-saturated");
      // One side saturated: its value is a floor (the GPU is busy the whole interval), so only the outcome in which
      // the saturated side is the slower one is sound: newly saturated → regression, no longer saturated → improved.
      if (base.auto?.saturated || candidate.auto?.saturated) {
        notes.push(candidate.auto?.saturated ? "candidate-saturated" : "base-saturated");
        return { ...open(), onlyOutcome: candidate.auto?.saturated ? "regression" : "improved", closedReason: "gpu-saturated" };
      }
      return open();
    }
    case "hook-gpu": {
      const provenances = [base.gpu.provenance ?? "unknown", candidate.gpu.provenance ?? "unknown"];
      if (provenances[0] !== provenances[1]) return closed("provenance-mismatch");
      if (paired) return [base, candidate].some(side => side.gpu.plausibility?.status === "contended") ? closed("gpu-contended") : open();
      if (!["warm", "fixed-work"].includes(provenances[0])) return closed("unverified-between-run");
      if ([base, candidate].some(side => side.gpu.stability?.status !== "stable")) return closed("gpu-unstable");
      if ([base, candidate].some(side => side.gpu.plausibility?.status === "contended")) return closed("gpu-contended");
      if ([baseStats, candidateStats].some(stats => !(robustCv(stats) <= 0.05))) return closed("gpu-unstable");
      return open();
    }
    case "frame":
      return base.refresh.belowRefresh || candidate.refresh.belowRefresh ? open() : closed("vsync-pinned");
    case "slow-frames":
      return paired ? open() : closed("episodic-slow-frames");
    case "cpu": {
      if (paired) return open();
      if (!(baseStats?.count >= 3 && candidateStats?.count >= 3) || !base.cpuPerSample || !candidate.cpuPerSample) return closed("too-few-samples");
      const budgetMs = base.refresh.budgetMs;
      if (!(baseStats.p50 >= 0.25 * budgetMs && candidateStats.p50 >= 0.25 * budgetMs)) return closed("light-cpu-load");
      if (!(baseStats.max <= 1.15 * baseStats.min && candidateStats.max <= 1.15 * candidateStats.min)) return closed("cpu-drift");
      return open();
    }
    default:
      // Hook-returned custom metrics and an explicitly chosen primary: CI-backed.
      return open();
  }
}

/** §4.3: first applicable rule. */
function selectPrimary(base, candidate, explicit, { paired = false } = {}) {
  const both = key => Number.isFinite(base.metrics[key]) && Number.isFinite(candidate.metrics[key]);
  if (explicit) return { key: explicit, selection: "explicit" };
  const strongHook = side => ["warm", "fixed-work"].includes(side.gpu.provenance);
  const warmHook = both(HOOK_GPU) && strongHook(base) && strongHook(candidate);
  // Separate captures: auto GPU never gates (§4.2), so a warm/fixed-work hook on both sides outranks it
  // (rules 2 and 3 yield to rule 4). Older or unclassified baselines would otherwise hide a warm regression.
  const preferHook = !paired && warmHook;
  const fromBottleneck = base.report?.summary?.bottleneck?.primaryMetric;
  const unclassified = base.report?.summary?.bottleneck?.class === "unknown";
  if (typeof fromBottleneck === "string" && both(fromBottleneck) && !(preferHook && (fromBottleneck === AUTO_GPU || unclassified))) {
    return { key: fromBottleneck, selection: "bottleneck" };
  }
  if (both(AUTO_GPU) && !preferHook) return { key: AUTO_GPU, selection: "default" };
  if (warmHook) return { key: HOOK_GPU, selection: "default" };
  if (both(FRAME) && (base.refresh.belowRefresh || candidate.refresh.belowRefresh)) return { key: FRAME, selection: "default" };
  if (both(CPU) && base.cpuPerSample && candidate.cpuPerSample) return { key: CPU, selection: "default" };
  if (base.samplingMode === "hook") {
    const custom = Object.keys(base.metrics).filter(key => /^custom\..+\.mean$/.test(key) && both(key)).sort()[0];
    if (custom) return { key: custom, selection: "default" };
  }
  const fallback = [AUTO_GPU, HOOK_GPU, FRAME, CPU].find(both);
  return fallback ? { key: fallback, selection: "fallback" } : null;
}

/** Metrics, per-sample (or per-round) values and gating evidence for one side. */
function collectSide(report) {
  const evidence = collectReportSamples(report, true);
  const savedAuto = report?.autoGpu;
  const autoEvidence = collectAutoGpuEvidence(report);
  const refresh = refreshState(report);
  const metrics = collectReportMetrics(report, evidence.customStats, evidence.gpu, evidence.stats, evidence.paths, autoEvidence, refresh);
  const auto = savedAuto ?? (autoEvidence.status === "unavailable" ? null : gpuTimingMetadata(autoEvidence));
  return {
    report, metrics, paths: evidence.paths, stats: evidence.stats, gpu: evidence.gpu, auto, autoEvidence, refresh,
    samplingMode: report?.options?.samplingMode ?? report?.inPage?.config?.samplingMode ?? "frames",
    cpuPerSample: (evidence.paths[CPU] || []).some(Number.isFinite)
  };
}

export function formatCompareTable(result) {
  const important = result.rows
    .filter((row) => row.status !== "unchanged" || /fps|frame|memory|trackedGpu|gpu/i.test(row.key))
    .slice(0, 40);
  const widths = [12, 58, 16, 16, 22];
  const header = formatRow(["status", "metric", "base", "candidate", "delta"], widths);
  const lines = [header, "-".repeat(header.length)];

  for (const row of important) {
    const unit = metricUnit(row.key) === "bytes" ? "bytes" : "";
    const delta = row.deltaPercent == null
      ? formatNumber(row.delta, unit)
      : `${formatNumber(row.delta, unit)} (${row.deltaPercent.toFixed(1)}%)`;
    lines.push(formatRow([
      row.screen ? `${row.status}:${row.screen}` : row.status,
      row.key,
      formatNumber(row.base, unit),
      formatNumber(row.candidate, unit),
      delta
    ], widths));
  }

  lines.push("");
  const s = result.summary;
  lines.push(`Status: ${String(result.status ?? "unknown").toUpperCase()}${result.primary ? ` (primary ${result.primary.key}, ${result.primary.selection})` : ""}.`);
  lines.push(`Compared ${s.total} metrics: ${s.regressions} regressions, ${s.improved} improvements, ${s.inconclusive} inconclusive, ${s.unverified ?? 0} unverified, ${s.passed} unchanged.`);
  if (!result.compatibility.compatible) {
    lines.push(`Warning: ${result.compatibility.differences.length} profiling option(s) differ between reports.`);
  }
  for (const warning of result.compatibility.warnings || []) {
    const older = warning.key === "schemaVersion" && warning.candidate < warning.base ? "candidate" : "baseline";
    lines.push(`Warning: ${warning.key} differs (base ${warning.base}, candidate ${warning.candidate}); recapture the ${older}.`);
  }
  if (result.validity?.valid === false) {
    lines.push(`INVALID: ${result.validity.issues.map(issue => issue.message).join(" ")}`);
  }
  for (const [kind, title] of [["resolved", "Resolved Optimization Recommendations"], ["introduced", "New Bottlenecks / Recommendations Introduced"]]) {
    if (result.recommendationDiff?.[kind]?.length) {
      lines.push(title + ":");
      for (const item of result.recommendationDiff[kind]) lines.push(`- ${item.title}: ${item.action}`);
    }
  }
  return lines.join("\n");
}

export function reportMetricSamples(report) {
  return collectReportSamples(report).paths;
}

function sampleStats(values, cache) {
  if (!values) return null;
  if (!cache.has(values)) cache.set(values, numericStats(values));
  return cache.get(values);
}

function collectReportSamples(report, shareCustomSamples = false) {
  const samples = report?.inPage?.samples || [];
  const sampleCount = samples.length;
  const paths = {};
  const customSamples = new Map();
  const stats = new Map();
  const gpu = collectGpuTimingEvidence(report);
  const excludeLeaf = selectedGpuLeaf(report, gpu);
  const cpu = sampleCount ? cpuSampleValues(report) : [];
  const slow = sampleCount ? slowFrameRateSamples(report) : [];
  let sampleIndex = 0;
  const push = (key, value) => {
    let arr = paths[key];
    if (!arr) {
      arr = Array(sampleCount).fill(null);
      paths[key] = arr;
    }
    arr[sampleIndex] = Number.isFinite(value) ? value : null;
  };
  const onCustomNumber = (path, value) => {
    let arr = customSamples.get(path);
    if (!arr) {
      arr = Array(sampleCount).fill(null);
      customSamples.set(path, arr);
      paths[`custom.${path}.mean`] = arr;
    }
    arr[sampleIndex] = value;
  };

  for (let i = 0; i < sampleCount; i += 1) {
    const sample = samples[i];
    // Idle samples are excluded from every per-sample path (§4.1).
    if (sample?.idle === true) { sampleIndex += 1; continue; }
    const frames = sample.measurement?.observedFrames || sample.measurement || {};
    push("frame.elapsedMs.mean", sample.elapsedMs);
    push("frame.fps.mean", sample.measurement?.fps ?? frames.fps);
    push(FRAME, sampleFrameTimeMs(sample));
    push("frame.maxJitterMs.mean", sample.measurement?.observedFrames?.maxJitter ?? sample.measurement?.maxJitter);
    if (!excludeLeaf) push("gpu.durationNs.mean", sample.measurement?.gpuTimeNs);
    push("gpu.computeDurationNs.mean", sample.measurement?.computeTimeNs);
    push("gpu.renderDurationNs.mean", sample.measurement?.renderTimeNs);
    push("memory.jsHeapDeltaBytes.mean", sample.memory?.delta?.performanceMemory?.usedJSHeapSize);
    push("memory.trackedGpuDeltaBytes.mean", sample.memory?.delta?.trackedGpuMemoryBytes);
    push("memory.trackedGpuTotalBytes.max", sample.memory?.trackedGpuTotalBytes ?? sample.memory?.after?.trackedGpuMemory?.totalBytes);
    push("memory.userAgentMemoryDeltaBytes.mean", sample.memory?.delta?.userAgentSpecificMemoryBytes);
    const auto = sample.autoGpu;
    if (auto && auto.timedFrames > 0 && Number.isFinite(auto.frameNs?.p50)) push(AUTO_GPU, auto.frameNs.p50 / 1e6);
    if (Number.isFinite(cpu[sampleIndex])) push(CPU, cpu[sampleIndex]);
    if (Number.isFinite(slow[sampleIndex])) push(SLOW, slow[sampleIndex]);

    if (sample.measurement != null) {
      visitCustomNumbers(sample.measurement, excludeLeaf, onCustomNumber);
    }
    sampleIndex += 1;
  }
  let customStats = {};
  if (shareCustomSamples) {
    if (samples.some(sample => sample.measurement === 0)) {
      customStats = customMeasurementStats(report, gpu);
    } else {
      for (const [path, values] of customSamples) {
        const summary = sampleStats(values, stats);
        if (summary) customStats[path] = summary;
      }
    }
  }
  if (gpu.status === "single-scope" && gpu.source === "raw") paths[HOOK_GPU] = gpu.values;
  if (report?.metricSamples) {
    for (const [key, values] of Object.entries(report.metricSamples)) {
      if (key === HOOK_GPU && (gpu.status !== "single-scope" || gpu.source === "raw")) continue;
      if (Array.isArray(values)) {
        const copy = Array(values.length);
        for (let i = 0; i < values.length; i += 1) {
          const v = values[i];
          copy[i] = Number.isFinite(v) ? v : null;
        }
        paths[key] = copy;
      } else {
        paths[key] = [];
      }
    }
  }
  return { paths, gpu, customStats, stats };
}

// The hook GPU leaf that feeds health.gpuFrameMs.mean; it is not also a custom metric (§4.1).
function selectedGpuLeaf(report, gpu) {
  return hasHealthGpu(report, gpu) ? { scope: gpu.scope } : null;
}

function visitCustomNumbers(value, excludeLeaf, onNumber, prefix = "", depth = 0) {
  if (depth > 32) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      const path = prefix || "value";
      if (!CUSTOM_EXCLUDED.test(path)) {
        if (excludeLeaf) {
          const dot = path.lastIndexOf(".");
          const scope = dot < 0 ? "" : path.slice(0, dot);
          if (scope === excludeLeaf.scope && GPU_TIMING_LEAF.test(path.slice(dot + 1))) return;
        }
        onNumber(path, value);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (!prefix) return;
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const nextPrefix = `${prefix}.${index}`;
      if (typeof item === "number") {
        if (Number.isFinite(item)) onNumber(nextPrefix, item);
      } else if (item && typeof item === "object") {
        visitCustomNumbers(item, excludeLeaf, onNumber, nextPrefix, depth + 1);
      }
    }
    return;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (CUSTOM_SEGMENT_EXCLUDED_RE.test(key) || (!prefix && LEADING_DIGIT_RE.test(key))) continue;
    const item = value[key];
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) continue;
      if (prefix ? AT_MS_LEAF_RE.test(key) : /\.atMs$/i.test(key)) continue;
      if (excludeLeaf) {
        const dot = nextPrefix.lastIndexOf(".");
        const scope = dot < 0 ? "" : nextPrefix.slice(0, dot);
        if (scope === excludeLeaf.scope && GPU_TIMING_LEAF.test(nextPrefix.slice(dot + 1))) continue;
      }
      onNumber(nextPrefix, item);
    } else if (item && typeof item === "object") {
      visitCustomNumbers(item, excludeLeaf, onNumber, nextPrefix, depth + 1);
    }
  }
}

function customNumbers(measurement, excludeLeaf) {
  const flat = {};
  visitCustomNumbers(measurement, excludeLeaf, (path, value) => {
    flat[path] = value;
  });
  return flat;
}

export function compareReportOptions(baseReport, candidateReport) {
  const keys = ["api", "autoInstrument", "gpuTiming", "durationMs", "runner", "samples", "viewport", "warmup", "deviceScaleFactor", "gc", "trace", "deepMemory", "waitUntil", "waitForHook", "hookName", "angle", "contextMode", "headful", "browserChannel", "frameObservation", "samplingMode", "adaptive", "minimalTrace", "cdpAttached", "waitCondition"];
  const differences = [];
  for (const key of keys) {
    // Reports predating hook mode always sampled frames. Any other key absent
    // from one report (an older report) is unknown, not a difference (§2).
    const base = key === "samplingMode" ? samplingModeOf(baseReport) : baseReport?.options?.[key];
    const candidate = key === "samplingMode" ? samplingModeOf(candidateReport) : candidateReport?.options?.[key];
    if (base === undefined || candidate === undefined) continue;
    if (JSON.stringify(base) !== JSON.stringify(candidate)) {
      differences.push({ base, candidate, key });
    }
  }
  return differences;
}

function compareCompatibility(baseReport, candidateReport, metricCount, gpuScopeDifference = null) {
  const differences = compareReportOptions(baseReport, candidateReport);
  if (gpuScopeDifference) differences.push(gpuScopeDifference);
  const environment = compareReportEnvironments(baseReport, candidateReport);
  differences.push(...environment.differences);
  if (!metricCount) differences.push({ key: "metrics", base: null, candidate: null, reason: "No common numeric metrics to compare." });
  // A schemaVersion difference is never a mismatch (§2): the headline is capped at unverified.
  const warnings = [];
  const baseVersion = baseReport?.schemaVersion ?? 2;
  const candidateVersion = candidateReport?.schemaVersion ?? 2;
  if (baseVersion !== candidateVersion) warnings.push({ key: "schemaVersion", base: baseVersion, candidate: candidateVersion });
  return {
    compatible: differences.length === 0,
    differences,
    warnings,
    environment: { checkedKeys: environment.checkedKeys, unverifiedKeys: environment.unverifiedKeys }
  };
}

const environmentPaths = [
  'browser.version.product', 'browser.version.revision', 'browser.version.jsVersion',
  'host.platform', 'host.arch', 'host.release', 'host.totalmem',
  'browser.systemInfo.modelName', 'browser.systemInfo.modelVersion',
  ...['displayType', 'glImplementationParts', 'glVendor', 'glRenderer', 'glVersion', 'skiaBackendType']
    .map(key => `browser.systemInfo.gpu.auxAttributes.${key}`),
  ...['webgpu', 'webgl', 'gpu_compositing', 'rasterization']
    .map(key => `browser.systemInfo.gpu.featureStatus.${key}`),
  ...['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter']
    .map(key => `inPage.apiSupport.webgpu.adapter.${key}`),
  ...['webgl', 'webgl2'].flatMap(api => ['vendor', 'renderer', 'unmaskedVendor', 'unmaskedRenderer', 'version', 'shadingLanguageVersion']
    .map(key => `inPage.apiSupport.${api}.${key}`))
];
const gpuDeviceFields = ['vendorId', 'deviceId', 'vendorString', 'deviceString', 'driverVendor', 'driverVersion'];
const knownEnvironmentKeys = [...environmentPaths, 'host.cpus', 'options.chromiumArgs', 'browser.systemInfo.gpu.devices.count'];

/** Stable, reported environment witnesses; absent/redacted metadata stays unknown. */
export function reportEnvironment(report) {
  if (report?.environment?.schemaVersion === 1) return report.environment.values || {};
  const values = {};
  for (const key of environmentPaths) {
    const value = key.split('.').reduce((object, part) => object?.[part], report);
    if (knownEnvironmentValue(value)) values[key] = typeof value === 'string' ? value.trim() : value;
  }
  const cpus = report?.host?.cpus;
  if (Array.isArray(cpus) && cpus.length && cpus.every(cpu => typeof cpu === 'string' && cpu.trim())) {
    values['host.cpus'] = cpus.map(cpu => cpu.trim()).sort();
  }
  const args = report?.options?.chromiumArgs;
  // Attached browsers do not expose their launch argv in this structured field.
  if (Array.isArray(args) && args.every(arg => typeof arg === 'string') && !(report.options.cdpAttached && !args.length)) {
    values['options.chromiumArgs'] = stableChromiumArgs(args);
  }
  const devices = report?.browser?.systemInfo?.gpu?.devices;
  if (Array.isArray(devices) && devices.length) {
    values['browser.systemInfo.gpu.devices.count'] = devices.length;
    devices.forEach((device, index) => {
      for (const key of gpuDeviceFields) {
        if (knownEnvironmentValue(device?.[key])) values[`browser.systemInfo.gpu.devices.${index}.${key}`] = device[key];
      }
    });
  }
  return values;
}

/** Unknown fields are disclosed separately and never fabricated into mismatches. */
export function compareReportEnvironments(baseReport, candidateReport) {
  const base = reportEnvironment(baseReport);
  const candidate = reportEnvironment(candidateReport);
  const keys = new Set([...knownEnvironmentKeys, ...Object.keys(base), ...Object.keys(candidate)]);
  const differences = [];
  const checkedKeys = [];
  const unverifiedKeys = [];
  const incomplete = new Set([...(baseReport?.environment?.unverifiedKeys || []), ...(candidateReport?.environment?.unverifiedKeys || [])]);
  for (const key of keys) {
    if (!Object.hasOwn(base, key) || !Object.hasOwn(candidate, key)) {
      unverifiedKeys.push(key);
      continue;
    }
    (incomplete.has(key) ? unverifiedKeys : checkedKeys).push(key);
    if (JSON.stringify(base[key]) !== JSON.stringify(candidate[key])) differences.push({ key, base: base[key], candidate: candidate[key] });
  }
  return { differences, checkedKeys, unverifiedKeys };
}

function knownEnvironmentValue(value) {
  return typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && value.trim() !== '');
}

function stableChromiumArgs(args) {
  const volatile = new Set(['--user-data-dir', '--profile-directory', '--remote-debugging-port', '--remote-debugging-address', '--remote-debugging-pipe', '--remote-allow-origins']);
  const switches = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      if (!/^(?:https?|file):\/\/|^about:/i.test(arg)) positional.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    let value = equal < 0 ? null : arg.slice(equal + 1);
    if (equal < 0 && index + 1 < args.length && !args[index + 1].startsWith('--')
        && !/^(?:https?|file):\/\/|^about:/i.test(args[index + 1])) value = args[++index];
    if (volatile.has(name)) continue;
    // Order of distinct switches is immaterial; repeated switches retain order.
    if (!switches.has(name)) switches.set(name, []);
    switches.get(name).push(value);
  }
  return [...Array.from(switches).sort(([a], [b]) => a.localeCompare(b)), ...positional.map(value => ['positional', value])];
}

function compareDiagnostics(baseReport, candidateReport) {
  const baseCodes = warningCodes(baseReport);
  const candidateCodes = warningCodes(candidateReport);
  return {
    remainingWarnings: (candidateReport?.summary?.warnings || []).filter((warning) => baseCodes.has(warning.code)),
    resolvedWarnings: (baseReport?.summary?.warnings || []).filter((warning) => !candidateCodes.has(warning.code)),
    introducedWarnings: (candidateReport?.summary?.warnings || []).filter((warning) => !baseCodes.has(warning.code))
  };
}

function recommendationDiff(baseReport, candidateReport) {
  const list = report => report?.diagnostics?.recommendations || report?.summary?.recommendations || [];
  const base = list(baseReport);
  const candidate = list(candidateReport);
  return {
    resolved: base.filter(item => !candidate.some(other => other.id === item.id)),
    introduced: candidate.filter(item => !base.some(other => other.id === item.id)),
    persisted: candidate.filter(item => base.some(other => other.id === item.id))
  };
}

function confidenceSupports(interval, direction, outcome, boundary) {
  if (!interval) {
    return true;
  }
  const positiveIsOutcome = (direction === "higher" && outcome === "improved")
    || (direction === "lower" && outcome === "regression");
  return positiveIsOutcome ? interval.low > boundary : interval.high < -boundary;
}

function customMeasurementStats(report, gpu = null) {
  const paths = new Map();
  const excludeLeaf = gpu ? selectedGpuLeaf(report, gpu) : null;
  for (const sample of report?.inPage?.samples || []) {
    if (!sample.measurement || sample.idle === true) continue;
    const flat = customNumbers(sample.measurement, excludeLeaf);
    for (const key of Object.keys(flat)) {
      let arr = paths.get(key);
      if (!arr) {
        arr = [];
        paths.set(key, arr);
      }
      arr.push(flat[key]);
    }
  }
  const compact = {};
  for (const [path, values] of paths) {
    const numbers = values.slice().sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < numbers.length; i += 1) sum += numbers[i];
    compact[path] = { mean: sum / numbers.length };
  }
  return compact;
}

// Robust within-run CV: 1.4826·MAD/median (§4.2 hook gate).
function robustCv(stats) {
  if (!stats || !(stats.p50 > 0)) return null;
  return 1.4826 * stats.mad / stats.p50;
}

function inferDirection(key) {
  if (/(fps|throughput|opsPerSecond|score|bandwidth)/i.test(key)) {
    return "higher";
  }
  return "lower";
}

function add(metrics, key, value) {
  if (Number.isFinite(value)) {
    metrics[key] = value;
  }
}

function metricUnit(key) {
  if (/(^|\.)(count|frameCount|eventCount|totalResources)$/i.test(key)) return "count";
  if (/(bytes|heap.*size|memory.*bytes|totalBytes|allocatedBytes|scratchBufferSize)/i.test(key)) return "bytes";
  if (/Ns(\.|$)/.test(key)) return "ns";
  if (/MiB(\.|$)/.test(key)) return "MiB";
  if (/fps/i.test(key)) return "fps";
  if (/Ms(\.|$)|MBPerSec/.test(key)) return /MBPerSec/.test(key) ? "MiB/s" : "ms";
  return null;
}

function issueText(issue) {
  const nested = Array.isArray(issue?.issues) && issue.issues.length ? `: ${issue.issues.slice(0, 2).map(item => item.code).join(", ")}` : "";
  return `${issue?.code ?? "invalid"}${nested}`;
}

function display(value) {
  if (Number.isFinite(value)) return String(round(value));
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "(no baseline)";
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
}
function knownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field: ${key}.`);
}
function finite(value, name, nonnegative = false) {
  if (!Number.isFinite(value) || (nonnegative && value < 0)) throw new TypeError(`${name} must be a finite ${nonnegative ? "non-negative " : ""}number.`);
}

function formatRow(cells, widths) {
  return cells
    .map((cell, index) => clip(String(cell), widths[index]).padEnd(widths[index]))
    .join("  ");
}

function clip(value, width) {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}

