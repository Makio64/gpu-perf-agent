import { readFile } from "node:fs/promises";
import { numberOption } from "./options.js";
import { warningCodes } from "./analysis.js";
import { reportValidity } from "./validity.js";
import { flattenNumbers, formatNumber, independentDifferenceStats, numericStats, pairedDifferenceStats, summarizeNumericPaths } from "./stats.js";

export async function loadReport(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function reportMetrics(report) {
  const metrics = {};
  const summary = report?.inPage?.summary || {};

  add(metrics, "frame.elapsedMs.mean", summary.elapsedMs?.mean);
  add(metrics, "frame.elapsedMs.p95", summary.elapsedMs?.p95);
  add(metrics, "frame.fps.mean", summary.fps?.mean);
  add(metrics, "frame.fps.p95", summary.fps?.p95);
  add(metrics, "frame.frameTimeMs.mean", summary.frameTimeMsMean?.mean);
  add(metrics, "frame.frameTimeMs.p95", summary.frameTimeMsP95?.mean);
  add(metrics, "frame.frameTimeMs.p99", summary.frameTimeMsP99?.mean);
  add(metrics, "frame.maxJitterMs.mean", summary.maxJitterMs?.mean ?? summary.maxJitter?.mean);
  add(metrics, "gpu.durationNs.mean", summary.gpuTimeNs?.mean);
  add(metrics, "gpu.computeDurationNs.mean", summary.computeTimeNs?.mean);
  add(metrics, "gpu.renderDurationNs.mean", summary.renderTimeNs?.mean);
  add(metrics, "webgpu.drawCalls.mean", summary.drawCalls?.mean ?? report?.summary?.webgpuOps?.drawCalls);
  add(metrics, "webgpu.dispatchCalls.mean", summary.dispatchCalls?.mean ?? report?.summary?.webgpuOps?.dispatchCalls);
  add(metrics, "webgpu.syncPipelines.count", report?.summary?.pipelines?.syncCount ?? report?.diagnostics?.recommendations?.find(r => r.id === "pipeline-sync-stall")?.value);
  add(metrics, "webgpu.bindGroupsCreated.count", report?.summary?.bindGroups?.createdCount ?? report?.diagnostics?.recommendations?.find(r => r.id === "bind-group-churn")?.value);
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
  add(metrics, "health.frameTimeMs.p95", report?.summary?.frameTimeMsP95);
  add(metrics, "health.frameTimeMs.max", report?.summary?.frameTimeMsMax);
  add(metrics, "health.gpuFrameMs.mean", report?.summary?.gpuFrameMsMean);
  add(metrics, "health.heapGrowthMBPerSec", report?.summary?.jsHeapGrowthMBPerSec);
  add(metrics, "health.slowFrameCount", report?.summary?.slowFrameCount);
  add(metrics, "health.trackedVramMiB", report?.summary?.trackedVram?.totalMiB);
  add(metrics, "health.drawCallsPerFrame", report?.summary?.drawCallsPerFrame);

  for (const [path, stats] of Object.entries(customMeasurementStats(report))) {
    add(metrics, `custom.${path}.mean`, stats.mean);
    add(metrics, `custom.${path}.p95`, stats.p95);
    add(metrics, `custom.${path}.max`, stats.max);
  }

  for (const [key, value] of Object.entries(report?.aggregateMetrics || {})) {
    add(metrics, key, value);
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

export function compareReports(baseReport, candidateReport, options = {}) {
  const budget = validateBudget(options.budget);
  if (options.paired !== undefined && typeof options.paired !== "boolean") throw new TypeError("paired must be a boolean.");
  const defaultMaxRegressionPercent = numberOption(budget.defaultMaxRegressionPercent ?? options.thresholdPercent ?? 5, "thresholdPercent");
  const base = reportMetrics(baseReport);
  const candidate = reportMetrics(candidateReport);
  const baseSamples = reportMetricSamples(baseReport);
  const candidateSamples = reportMetricSamples(candidateReport);
  const allKeys = Array.from(new Set([...Object.keys(base), ...Object.keys(candidate), ...Object.keys(budget.metrics || {})])).sort();
  const rows = [];
  const issues = [];
  const baseValidity = reportValidity(baseReport);
  const candidateValidity = reportValidity(candidateReport);
  if (!baseValidity.valid) issues.push({ code: "invalid-base", message: "Baseline measurements are invalid.", issues: baseValidity.issues });
  if (!candidateValidity.valid) issues.push({ code: "invalid-candidate", message: "Candidate measurements are invalid.", issues: candidateValidity.issues });

  for (const key of allKeys) {
    const rule = budget.metrics?.[key] || {};
    const direction = rule.direction || inferDirection(key);
    const maxRegressionPercent = rule.maxRegressionPercent ?? defaultMaxRegressionPercent;
    const basePresent = Number.isFinite(base[key]);
    const candidatePresent = Number.isFinite(candidate[key]);
    const absoluteOnly = !basePresent && candidatePresent && (rule.min !== undefined || rule.max !== undefined) && rule.maxRegressionPercent === undefined;
    if (!basePresent || !candidatePresent) {
      if (candidatePresent && !Object.hasOwn(budget.metrics || {}, key)) continue; // new optional metric
      if (!absoluteOnly) {
        issues.push({ code: "missing-metric", key, message: `${key} is missing from ${!basePresent && !candidatePresent ? "both reports" : !basePresent ? "the baseline" : "the candidate"}.` });
        rows.push({ key, base: base[key] ?? null, candidate: candidate[key] ?? null, delta: null, deltaPercent: null, direction, status: "missing" });
        continue;
      }
    }

    const baseStats = numericStats(baseSamples[key] || []);
    const candidateStats = numericStats(candidateSamples[key] || []);
    const delta = basePresent ? candidate[key] - base[key] : null;
    const deltaPercent = basePresent && base[key] !== 0 ? (delta / Math.abs(base[key])) * 100 : null;
    // Per-sample means cannot provide a confidence interval for a pooled max or percentile.
    const canEstimate = key.endsWith(".mean") || (baseReport?.metricSamples && candidateReport?.metricSamples);
    const baseValues = baseSamples[key] || [];
    const candidateValues = candidateSamples[key] || [];
    if (options.paired && canEstimate && (baseValues.length || candidateValues.length)
        && (baseValues.length !== candidateValues.length || baseValues.some((value, index) => !Number.isFinite(value) || !Number.isFinite(candidateValues[index])))) {
      issues.push({ code: "unmatched-pairs", key, message: `${key} does not have a complete set of matched samples.` });
    }
    const difference = canEstimate ? (options.paired ? pairedDifferenceStats : independentDifferenceStats)(baseSamples[key] || [], candidateSamples[key] || []) : null;
    const enoughSamples = options.paired ? difference?.differences.length >= 3 : baseStats?.count >= 3 && candidateStats?.count >= 3;
    const confidence95 = enoughSamples ? difference?.confidence95 || null : null;
    const boundary = Math.abs(base[key] ?? 0) * maxRegressionPercent / 100;
    let status = "pass";
    if (delta !== null && Math.abs(delta) > boundary) {
      const regressed = direction === "higher" ? delta < 0 : delta > 0;
      status = regressed ? "regression" : "improved";
      if (confidence95 && !confidenceSupports(confidence95, direction, status, boundary)) status = "inconclusive";
    }
    if ((rule.max !== undefined && candidate[key] > rule.max) || (rule.min !== undefined && candidate[key] < rule.min)) status = "regression";

    rows.push({
      base: base[key] ?? null,
      baseStats,
      candidate: candidate[key],
      candidateStats,
      confidence95,
      evidence: confidence95 ? (options.paired ? "paired-samples" : "independent-samples") : "threshold-only",
      delta,
      deltaPercent,
      direction,
      key,
      maxRegressionPercent,
      status
    });
  }

  const comparableCount = rows.filter(row => row.status !== "missing").length;
  if (!comparableCount) issues.push({ code: "no-comparable-metrics", message: "No numeric metrics could be evaluated." });
  return {
    compatibility: compareCompatibility(baseReport, candidateReport, comparableCount),
    validity: { valid: issues.length === 0, issues, base: baseValidity, candidate: candidateValidity },
    missingMetrics: {
      base: allKeys.filter(key => !Number.isFinite(base[key])),
      candidate: allKeys.filter(key => !Number.isFinite(candidate[key]))
    },
    diagnostics: compareDiagnostics(baseReport, candidateReport),
    recommendationDiff: {
      resolved: (baseReport?.diagnostics?.recommendations || []).filter(item => !(candidateReport?.diagnostics?.recommendations || []).some(other => other.id === item.id)),
      introduced: (candidateReport?.diagnostics?.recommendations || []).filter(item => !(baseReport?.diagnostics?.recommendations || []).some(other => other.id === item.id))
    },
    failures: rows.filter(row => row.status === "regression"),
    rows,
    summary: {
      improved: rows.filter(row => row.status === "improved").length,
      inconclusive: rows.filter(row => row.status === "inconclusive").length,
      missing: rows.filter(row => row.status === "missing").length,
      passed: rows.filter(row => row.status === "pass").length,
      regressions: rows.filter(row => row.status === "regression").length,
      total: rows.length
    },
    verdicts: {
      base: baseReport?.summary?.verdict || null,
      candidate: candidateReport?.summary?.verdict || null
    }
  };
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

export function formatCompareTable(result) {
  const important = result.rows
    .filter((row) => row.status !== "pass" || /fps|frame|memory|trackedGpu|gpu/i.test(row.key))
    .slice(0, 40);
  const widths = [12, 58, 16, 16, 22];
  const header = formatRow(["status", "metric", "base", "candidate", "delta"], widths);
  const lines = [header, "-".repeat(header.length)];

  for (const row of important) {
    const unit = metricUnit(row.key);
    const delta = row.deltaPercent == null
      ? formatNumber(row.delta, unit)
      : `${formatNumber(row.delta, unit)} (${row.deltaPercent.toFixed(1)}%)`;
    lines.push(formatRow([
      row.status,
      row.key,
      formatNumber(row.base, unit),
      formatNumber(row.candidate, unit),
      delta
    ], widths));
  }

  lines.push("");
  lines.push(`Compared ${result.summary.total} metrics: ${result.summary.regressions} regressions, ${result.summary.improved} improvements, ${result.summary.inconclusive} inconclusive, ${result.summary.passed} passing.`);
  if (!result.compatibility.compatible) {
    lines.push(`Warning: ${result.compatibility.differences.length} profiling option(s) differ between reports.`);
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
  const samples = report?.inPage?.samples || [];
  const paths = {};
  let sampleIndex = 0;
  const push = (key, value) => {
    paths[key] ||= Array(samples.length).fill(null);
    paths[key][sampleIndex] = Number.isFinite(value) ? value : null;
  };

  for (const sample of samples) {
    const frames = sample.measurement?.observedFrames || sample.measurement || {};
    push("frame.elapsedMs.mean", sample.elapsedMs);
    push("frame.fps.mean", sample.measurement?.fps ?? frames.fps);
    push("frame.frameTimeMs.mean", sample.measurement?.frameTimeMs?.mean ?? frames.frameTimeMs?.mean);
    push("memory.jsHeapDeltaBytes.mean", sample.memory?.delta?.performanceMemory?.usedJSHeapSize);
    push("memory.trackedGpuDeltaBytes.mean", sample.memory?.delta?.trackedGpuMemoryBytes);
    push("memory.trackedGpuTotalBytes.max", sample.memory?.after?.trackedGpuMemory?.totalBytes);
    push("memory.userAgentMemoryDeltaBytes.mean", sample.memory?.delta?.userAgentSpecificMemoryBytes);

    const flat = flattenNumbers(sample.measurement);
    for (const [path, value] of Object.entries(flat)) {
      if (!isNoisyPath(path)) {
        push(`custom.${path}.mean`, value);
        push(`custom.${path}.p95`, value);
        push(`custom.${path}.max`, value);
      }
    }
    sampleIndex += 1;
  }
  for (const [key, values] of Object.entries(report?.metricSamples || {})) {
    paths[key] = Array.isArray(values) ? values.map(value => Number.isFinite(value) ? value : null) : [];
  }
  return paths;
}

function compareCompatibility(baseReport, candidateReport, metricCount) {
  const keys = ["api", "autoInstrument", "durationMs", "runner", "samples", "slowFrameThresholdMs", "viewport", "warmup", "deviceScaleFactor", "gc", "trace", "deepMemory", "waitUntil", "waitForHook", "hookName", "angle", "contextMode", "headful", "browserChannel", "frameObservation", "adaptive", "minimalTrace", "cdpAttached", "waitCondition"];
  const differences = [];
  for (const key of keys) {
    const base = baseReport?.options?.[key] ?? null;
    const candidate = candidateReport?.options?.[key] ?? null;
    if (base !== candidate) {
      differences.push({ base, candidate, key });
    }
  }
  if (!metricCount) differences.push({ key: "metrics", base: null, candidate: null, reason: "No common numeric metrics to compare." });
  return {
    compatible: differences.length === 0,
    differences
  };
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

function confidenceSupports(interval, direction, outcome, boundary) {
  if (!interval) {
    return true;
  }
  const positiveIsOutcome = (direction === "higher" && outcome === "improved")
    || (direction === "lower" && outcome === "regression");
  return positiveIsOutcome ? interval.low > boundary : interval.high < -boundary;
}

function customMeasurementStats(report) {
  const measurements = report?.inPage?.samples?.map((sample) => sample.measurement).filter(Boolean) || [];
  const summary = summarizeNumericPaths(measurements);
  const compact = {};

  for (const [path, stats] of Object.entries(summary)) {
    if (isNoisyPath(path)) {
      continue;
    }
    compact[path] = stats;
  }

  return compact;
}

function isNoisyPath(path) {
  return /(^|\.)(length|byteLength|count|fps|frameCount|frameTimeMs|observationWindowMs|observedFrames|samples|slowFrameCount|totalResources)(\.|$)/i.test(path)
    || /^\d+/.test(path);
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
  if (/(^|\.)(count|frameCount|eventCount|totalResources)$/i.test(key)) {
    return "";
  }
  if (/(bytes|heap.*size|memory.*bytes|totalBytes|allocatedBytes|scratchBufferSize)/i.test(key)) {
    return "bytes";
  }
  return "";
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
