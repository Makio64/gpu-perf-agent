import { readFile } from "node:fs/promises";
import { numberOption } from "./options.js";
import { warningCodes } from "./analysis.js";
import { reportValidity } from "./validity.js";
import { formatNumber, independentDifferenceStatsFromStats, numericStats, pairedDifferenceStats } from "./stats.js";
import { collectGpuTimingEvidence, gpuTimingMetadata, gpuTimingValidityIssues } from "./gpu-timing.js";

export async function loadReport(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function reportMetrics(report) {
  // Reports without a health scalar do not need another measurement traversal.
  const hasHealth = Object.hasOwn(report?.summary || {}, "gpuFrameMsMean") || Number.isFinite(report?.aggregateMetrics?.["health.gpuFrameMs.mean"]);
  return reportMetricsWithGpuEvidence(report, hasHealth ? collectGpuTimingEvidence(report) : { status: "unavailable" });
}

// Internal aggregation helper; public reportMetrics remains a unary mapper.
export function reportMetricsWithGpuEvidence(report, gpu) {
  return collectReportMetrics(report, customMeasurementStats(report), gpu);
}

function collectReportMetrics(report, customStats, gpu, statsCache = new Map()) {
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
  if (gpu.status === "single-scope" && (Object.hasOwn(report?.summary || {}, "gpuFrameMsMean") || Number.isFinite(report?.aggregateMetrics?.["health.gpuFrameMs.mean"]))) {
    // Old saved captures may contain a mean pooled over unrelated passes. Raw
    // observations, when present, are authoritative for this derived metric.
    add(metrics, "health.gpuFrameMs.mean", gpu.source === "raw" ? sampleStats(gpu.values, statsCache)?.mean : report?.summary?.gpuFrameMsMean);
  }
  add(metrics, "health.heapGrowthMBPerSec", report?.summary?.jsHeapGrowthMBPerSec);
  add(metrics, "health.slowFrameCount", report?.summary?.slowFrameCount);
  add(metrics, "health.trackedVramMiB", report?.summary?.trackedVram?.totalMiB);
  add(metrics, "health.drawCallsPerFrame", report?.summary?.drawCallsPerFrame);

  for (const [path, stats] of Object.entries(customStats)) {
    add(metrics, `custom.${path}.mean`, stats.mean);
    add(metrics, `custom.${path}.p95`, stats.p95);
    add(metrics, `custom.${path}.max`, stats.max);
  }

  for (const [key, value] of Object.entries(report?.aggregateMetrics || {})) {
    if (key === "health.gpuFrameMs.mean" && (gpu.status !== "single-scope" || gpu.source === "raw")) continue;
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
  const baseEvidence = collectReportSamples(baseReport, true);
  const candidateEvidence = collectReportSamples(candidateReport, true);
  const base = collectReportMetrics(baseReport, baseEvidence.customStats, baseEvidence.gpu, baseEvidence.stats);
  const candidate = collectReportMetrics(candidateReport, candidateEvidence.customStats, candidateEvidence.gpu, candidateEvidence.stats);
  const baseSamples = baseEvidence.paths;
  const candidateSamples = candidateEvidence.paths;
  const scopeMismatch = baseEvidence.gpu.status === "single-scope" && candidateEvidence.gpu.status === "single-scope"
    && baseEvidence.gpu.scope !== candidateEvidence.gpu.scope;
  if (scopeMismatch) {
    delete base["health.gpuFrameMs.mean"];
    delete candidate["health.gpuFrameMs.mean"];
    delete baseSamples["health.gpuFrameMs.mean"];
    delete candidateSamples["health.gpuFrameMs.mean"];
  }
  const allKeys = Array.from(new Set([...Object.keys(base), ...Object.keys(candidate), ...Object.keys(budget.metrics || {})])).sort();
  const rows = [];
  const issues = [];
  if (scopeMismatch) issues.push({ code: "gpu-timing-scope-mismatch", key: "health.gpuFrameMs.mean",
    baseScope: baseEvidence.gpu.scope, candidateScope: candidateEvidence.gpu.scope,
    message: "GPU timing scopes differ; the health GPU metric cannot be compared." });
  const baseValidity = reportValidity(baseReport);
  const candidateValidity = reportValidity(candidateReport);
  for (const [validity, evidence] of [[baseValidity, baseEvidence.gpu], [candidateValidity, candidateEvidence.gpu]]) {
    validity.issues.push(...gpuTimingValidityIssues(evidence));
    validity.valid = validity.issues.length === 0;
  }
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

    const baseStats = sampleStats(baseSamples[key], baseEvidence.stats);
    const candidateStats = sampleStats(candidateSamples[key], candidateEvidence.stats);
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
    const difference = !canEstimate ? null : options.paired
      ? pairedDifferenceStats(baseValues, candidateValues)
      : independentDifferenceStatsFromStats(baseStats, candidateStats);
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
      baseStats: baseStats && { ...baseStats },
      candidate: candidate[key],
      candidateStats: candidateStats && { ...candidateStats },
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
    compatibility: compareCompatibility(baseReport, candidateReport, comparableCount, scopeMismatch ? {
      key: "gpuTiming.scope", base: baseEvidence.gpu.scope, candidate: candidateEvidence.gpu.scope
    } : null),
    gpuTiming: { base: gpuTimingMetadata(baseEvidence.gpu), candidate: gpuTimingMetadata(candidateEvidence.gpu) },
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
  return collectReportSamples(report).paths;
}

function sampleStats(values, cache) {
  if (!values) return null;
  if (!cache.has(values)) cache.set(values, numericStats(values));
  return cache.get(values);
}

function collectReportSamples(report, shareCustomSamples = false) {
  const samples = report?.inPage?.samples || [];
  const paths = {};
  const customSamples = {};
  const stats = new Map();
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
    push("gpu.durationNs.mean", sample.measurement?.gpuTimeNs);
    push("gpu.computeDurationNs.mean", sample.measurement?.computeTimeNs);
    push("gpu.renderDurationNs.mean", sample.measurement?.renderTimeNs);
    push("memory.jsHeapDeltaBytes.mean", sample.memory?.delta?.performanceMemory?.usedJSHeapSize);
    push("memory.trackedGpuDeltaBytes.mean", sample.memory?.delta?.trackedGpuMemoryBytes);
    push("memory.trackedGpuTotalBytes.max", sample.memory?.after?.trackedGpuMemory?.totalBytes);
    push("memory.userAgentMemoryDeltaBytes.mean", sample.memory?.delta?.userAgentSpecificMemoryBytes);

    const flat = flattenCustomNumbers(sample.measurement);
    for (const [path, value] of Object.entries(flat)) {
      if (!isNoisyPath(path)) {
        const meanKey = `custom.${path}.mean`;
        push(meanKey, value);
        if (shareCustomSamples) {
          // Share only within a comparison; public sample arrays stay independent.
          customSamples[path] = paths[meanKey];
          paths[`custom.${path}.p95`] = paths[meanKey];
          paths[`custom.${path}.max`] = paths[meanKey];
        } else {
          push(`custom.${path}.p95`, value);
          push(`custom.${path}.max`, value);
        }
      }
    }
    sampleIndex += 1;
  }
  let customStats = {};
  for (const [path, values] of Object.entries(customSamples)) {
    const summary = sampleStats(values, stats);
    if (summary) customStats[path] = summary;
  }
  // Legacy scalar zero measurements are sampled but excluded by summary's
  // historical filter(Boolean). Preserve that distinction for those reports.
  if (shareCustomSamples && samples.some(sample => sample.measurement === 0)) {
    customStats = customMeasurementStats(report);
  }
  const gpu = collectGpuTimingEvidence(report);
  if (gpu.status === "single-scope" && gpu.source === "raw") paths["health.gpuFrameMs.mean"] = gpu.values;
  for (const [key, values] of Object.entries(report?.metricSamples || {})) {
    if (key === "health.gpuFrameMs.mean" && (gpu.status !== "single-scope" || gpu.source === "raw")) continue;
    paths[key] = Array.isArray(values) ? values.map(value => Number.isFinite(value) ? value : null) : [];
  }
  return { paths, gpu, customStats, stats };
}

export function compareReportOptions(baseReport, candidateReport) {
  const keys = ["api", "autoInstrument", "durationMs", "runner", "samples", "slowFrameThresholdMs", "viewport", "warmup", "deviceScaleFactor", "gc", "trace", "deepMemory", "waitUntil", "waitForHook", "hookName", "angle", "contextMode", "headful", "browserChannel", "frameObservation", "samplingMode", "adaptive", "minimalTrace", "cdpAttached", "waitCondition"];
  const differences = [];
  for (const key of keys) {
    // Reports predating hook mode always sampled frames. Other absent settings
    // retain the existing conservative compatibility behavior.
    const base = baseReport?.options?.[key] ?? (key === "samplingMode" ? baseReport?.inPage?.config?.samplingMode ?? "frames" : null);
    const candidate = candidateReport?.options?.[key] ?? (key === "samplingMode" ? candidateReport?.inPage?.config?.samplingMode ?? "frames" : null);
    if (base !== candidate) {
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
  return {
    compatible: differences.length === 0,
    differences,
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

function confidenceSupports(interval, direction, outcome, boundary) {
  if (!interval) {
    return true;
  }
  const positiveIsOutcome = (direction === "higher" && outcome === "improved")
    || (direction === "lower" && outcome === "regression");
  return positiveIsOutcome ? interval.low > boundary : interval.high < -boundary;
}

function customMeasurementStats(report) {
  const paths = new Map();
  for (const sample of report?.inPage?.samples || []) {
    if (!sample.measurement) continue;
    for (const [path, value] of Object.entries(flattenCustomNumbers(sample.measurement))) {
      // Do not sort large observed-frame histories only to discard them below.
      if (isNoisyPath(path)) continue;
      if (!paths.has(path)) paths.set(path, []);
      paths.get(path).push(value);
    }
  }
  const compact = {};
  for (const [path, values] of paths) {
    compact[path] = numericStats(values);
  }
  return compact;
}

function isNoisyPath(path) {
  return /(^|\.)(length|byteLength|count|fps|frameCount|frameTimeMs|observationWindowMs|observedFrames|samples|slowFrameCount|totalResources)(\.|$)/i.test(path)
    || /^\d+/.test(path);
}

function flattenCustomNumbers(value, prefix = "", out = {}) {
  // Once a path contains an excluded segment every descendant is excluded too.
  // Skip observed-frame histories before allocating their thousands of paths.
  if (prefix && isNoisyPath(prefix)) return out;
  if (Number.isFinite(value)) {
    out[prefix || "value"] = value;
  } else if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => flattenCustomNumbers(item, prefix ? `${prefix}.${index}` : String(index), out));
    } else {
      for (const [key, item] of Object.entries(value)) {
        flattenCustomNumbers(item, prefix ? `${prefix}.${key}` : key, out);
      }
    }
  }
  return out;
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
