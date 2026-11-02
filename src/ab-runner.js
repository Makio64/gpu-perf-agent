import { compareReports, compareReportOptions, compareReportEnvironments, DECISION_METRICS, PER_ROUND_MEDIAN, reportEnvironment,
  reportMetricSamples, reportMetricsWithGpuEvidence, validateBudget } from "./compare.js";
import { normalizeOptions, numberOption, PROFILING_PRESETS } from "./options.js";
import { median, numericStats } from "./stats.js";
import { reportValidity } from "./validity.js";
import { aggregateGpuTimingEvidence, collectAutoGpuEvidence, collectGpuTimingEvidence, gpuTimingMetadata } from "./gpu-timing.js";

/** ab defaults (§4.6): auto timing on, so `ab` measures what `agent` measures. */
const AB_DEFAULTS = Object.freeze({ durationMs: 250, samples: 1, warmup: 1, autoInstrument: true, gpuTiming: true });

/**
 * Interleaved A/B rounds (ABBA). With `harness`, runs on it without launching or
 * closing it (the MCP/serve warm harness); `onProgress` and `signal` go to every run.
 */
export async function runABComparison(options = {}, { harness: sharedHarness = null, onProgress, signal } = {}) {
  const baseTarget = normalizeTarget(options.base, "base");
  const candidateTarget = normalizeTarget(options.candidate, "candidate");
  const rounds = numberOption(options.rounds ?? 4, "rounds", { min: 2, max: 1000, integer: true });
  // §2 precedence: explicit > preset > ab default. A named preset's values beat AB_DEFAULTS.
  const presetValues = typeof options.preset === "string" && Object.hasOwn(PROFILING_PRESETS, options.preset) ? PROFILING_PRESETS[options.preset] : {};
  options = normalizeOptions({ ...AB_DEFAULTS, ...presetValues, ...withoutUndefined(options) }, { requireTarget: false });
  normalizeOptions({ ...options, ...baseTarget });
  normalizeOptions({ ...options, ...candidateTarget });
  numberOption(options.thresholdPercent ?? 5, "thresholdPercent");
  validateBudget(options.budget);
  let harness = sharedHarness;
  if (!harness) {
    const { FastCDPHarness } = await import("./fast-cdp-runner.js");
    harness = await FastCDPHarness.launch(options);
  }
  const runs = [];

  try {
    for (const entry of alternatingOrder(rounds)) {
      if (signal?.aborted) throw Object.assign(new Error("A/B comparison aborted."), { code: "aborted" });
      const target = entry.variant === "base" ? baseTarget : candidateTarget;
      const startedAt = performance.now();
      const report = await harness.run({
        ...options,
        ...target,
        samples: Number(options.samples ?? 1),
        warmup: Number(options.warmup ?? 1)
      }, {
        signal,
        onProgress: onProgress ? (event) => onProgress({ ...event, round: entry.round, variant: entry.variant, rounds }) : undefined
      });
      runs.push({
        durationMs: performance.now() - startedAt,
        report,
        round: entry.round,
        sequence: entry.sequence,
        variant: entry.variant
      });
    }
  } finally {
    if (!sharedHarness) await harness.close();
  }

  const baseReport = aggregateReports(runs.filter((run) => run.variant === "base").map((run) => run.report));
  const candidateReport = aggregateReports(runs.filter((run) => run.variant === "candidate").map((run) => run.report));
  const comparison = compareReports(baseReport, candidateReport, {
    budget: options.budget,
    paired: true,
    thresholdPercent: Number(options.thresholdPercent ?? 5),
    primaryMetric: options.primaryMetric ?? options.metric,
    allowMismatch: options.allowMismatch === true
  });

  return {
    base: aggregateSummary(baseReport),
    candidate: aggregateSummary(candidateReport),
    comparison,
    createdAt: new Date().toISOString(),
    order: runs.map(({ durationMs, report, round, sequence, variant }) => ({
      durationMs,
      round,
      sequence,
      variant,
      verdict: report.summary?.verdict || null
    })),
    rounds,
    runs,
    schemaVersion: 1
  };
}

export function alternatingOrder(rounds) {
  const order = [];
  for (let round = 0; round < rounds; round += 1) {
    const variants = round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
    for (const variant of variants) {
      order.push({ round, sequence: order.length, variant });
    }
  }
  return order;
}

/**
 * One side of an ab comparison: per-round values (`metricSamples`), their means
 * (`aggregateMetrics`) and each round's validity. Frame, GPU, CPU and slow-frame
 * rows use the round's median per-sample value (§4.6); with samples=1 that is the
 * round's own value.
 */
export function aggregateReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("Cannot aggregate an empty report list.");
  }
  const metricSamples = {};
  const gpuEvidence = reports.map(collectGpuTimingEvidence);
  const metrics = reports.map((report, index) => {
    const values = reportMetricsWithGpuEvidence(report, gpuEvidence[index]);
    const perSample = reportMetricSamples(report);
    for (const key of PER_ROUND_MEDIAN) {
      const middle = Array.isArray(perSample[key]) ? median(perSample[key]) : null;
      if (Number.isFinite(middle) && Number.isFinite(values[key])) values[key] = middle;
    }
    return values;
  });
  // reportValidity already folds in each round's GPU timing issues (review:bug-1).
  const roundValidity = reports.map(reportValidity);
  const firstGpuScope = gpuEvidence.find(item => item.status === 'single-scope')?.scope;
  reports.forEach((report, round) => {
    const differences = compareReportOptions(reports[0], report);
    if (differences.length) {
      roundValidity[round].valid = false;
      roundValidity[round].issues.push({ code: 'capture-options-drift', severity: 'invalid', message: `Capture settings changed in round ${round + 1}.`, differences });
    }
    if (gpuEvidence[round].status === 'single-scope' && gpuEvidence[round].scope !== firstGpuScope) {
      roundValidity[round].valid = false;
      roundValidity[round].issues.push({ code: 'gpu-timing-scope-drift', severity: 'invalid', message: `GPU timing scope changed in round ${round + 1}.`,
        baseScope: firstGpuScope, candidateScope: gpuEvidence[round].scope });
    }
  });
  const roundEnvironments = reports.map(report => ({ schemaVersion: 1, values: reportEnvironment(report) }));
  const environment = { schemaVersion: 1, values: {} };
  roundEnvironments.forEach((current, round) => {
    const { differences } = compareReportEnvironments({ environment }, { environment: current });
    if (differences.length) {
      roundValidity[round].valid = false;
      roundValidity[round].issues.push({ code: 'environment-drift', severity: 'invalid', message: `Profiling environment changed in round ${round + 1}.`, differences });
    }
    // Retain the first known value of every field, including fields absent in round 1.
    for (const [key, value] of Object.entries(current.values)) {
      if (!Object.hasOwn(environment.values, key)) environment.values[key] = value;
    }
  });
  environment.unverifiedKeys = Object.keys(environment.values)
    .filter(key => roundEnvironments.some(current => !Object.hasOwn(current.values, key)));
  for (const key of new Set(metrics.flatMap(Object.keys))) {
    metricSamples[key] = metrics.map(values => Number.isFinite(values[key]) ? values[key] : null);
    // A decision or hook metric lost in one round invalidates that round; informational rows do not.
    if (!Object.hasOwn(DECISION_METRICS, key) && !/^custom\..+\.mean$/.test(key)) continue;
    metricSamples[key].forEach((value, round) => {
      if (value === null) {
        roundValidity[round].valid = false;
        roundValidity[round].issues.push({ code: "missing-metric", severity: "invalid", key, message: `${key} was not measured in round ${round + 1}.` });
      }
    });
  }
  const aggregateMetrics = {};
  for (const [key, values] of Object.entries(metricSamples)) {
    const stats = numericStats(values);
    if (stats) aggregateMetrics[key] = stats.mean;
  }
  const first = reports[0];
  const gpuTiming = aggregateGpuTimingEvidence(gpuEvidence);
  if (gpuTiming.status !== 'single-scope') {
    delete aggregateMetrics['health.gpuFrameMs.mean'];
    delete metricSamples['health.gpuFrameMs.mean'];
  }
  return {
    schemaVersion: first.schemaVersion,
    aggregateMetrics,
    gpuTiming,
    autoGpu: aggregateAutoGpu(reports),
    environment,
    inPage: { samples: [] },
    metricSamples,
    roundEnvironments,
    options: { ...first.options, samplingMode: first.options?.samplingMode ?? first.inPage?.config?.samplingMode ?? "frames" },
    roundValidity,
    summary: aggregateSummaryFields(reports)
  };
}

// Pooled per-round state the comparison needs from an aggregate: refresh, bottleneck, work.
function aggregateSummaryFields(reports) {
  const first = reports[0];
  const warningMap = new Map();
  for (const report of reports) for (const warning of report.summary?.warnings || []) warningMap.set(warning.code, warning);
  const mean = values => {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : null;
  };
  const perFrames = reports.map(report => report.summary?.perFrame ?? report.inPage?.summary?.perFrame).filter(Boolean);
  const perFrame = perFrames.length ? Object.fromEntries(Object.keys(perFrames[0])
    .filter(key => Number.isFinite(perFrames[0][key]))
    .map(key => [key, mean(perFrames.map(item => item[key]))])) : null;
  const errors = reports.map(report => report.summary?.gpuErrors?.total ?? report.inPage?.summary?.gpuErrors?.total).filter(Number.isFinite);
  const activity = reports.map(report => report.inPage?.summary?.activity);
  return {
    verdict: worstVerdict(reports.map((report) => report.summary?.verdict)),
    warnings: Array.from(warningMap.values()),
    bottleneck: first.summary?.bottleneck ?? null,
    cadence: first.inPage?.summary?.cadence ?? first.summary?.cadence ?? null,
    fps: mean(reports.map(report => report.inPage?.summary?.fps?.mean ?? report.summary?.fps)),
    pageFps: mean(activity.map((item, index) => item?.pageFps?.mean ?? item?.pageFps ?? reports[index].summary?.pageFps)),
    activeFrameRatio: mean(activity.map((item, index) => item?.activeFrameRatio ?? reports[index].summary?.activeFrameRatio)),
    perFrame,
    gpuErrors: errors.length ? { total: errors.reduce((total, value) => total + value, 0) } : null
  };
}

// Auto GPU gating state across rounds. Saturated needs a strict majority of rounds (the rule gpuTimingPlausibility
// applies to samples; an even split is not saturated): one contended round must not close the paired gate, its
// spread already widens the CI. Unstable in any round counts for the side, as in aggregateGpuTimingEvidence: it
// only adds a note and never closes the gate. A contended round (not saturated) stays visible in plausibility so
// the aggregate does not read 'ok'.
function aggregateAutoGpu(reports) {
  const rounds = reports.map(report => report.autoGpu ?? collectAutoGpuEvidence(report)).filter(item => item.status !== "unavailable");
  if (!rounds.length) return null;
  const metadata = rounds.map(item => item.provenance ? gpuTimingMetadata(item) : item);
  const unstable = metadata.find(item => item.stability?.status === "unstable");
  const saturatedRounds = metadata.filter(item => item.saturated === true).length;
  const contendedRounds = metadata.filter(item => item.plausibility?.status === "contended").length;
  const saturated = saturatedRounds * 2 > metadata.length;
  // Contended rounds are not this page's cost: a side that is contended (or saturated) in most rounds cannot gate.
  const contended = !saturated && (saturatedRounds + contendedRounds) * 2 > metadata.length;
  return {
    status: metadata.every(item => item.status === "ok") ? "ok" : metadata.find(item => item.status !== "ok").status,
    source: metadata[0].source ?? null,
    frames: metadata.reduce((total, item) => total + (item.frames || 0), 0),
    timedFrames: metadata.reduce((total, item) => total + (item.timedFrames || 0), 0),
    partialFrames: metadata.reduce((total, item) => total + (item.partialFrames || 0), 0),
    provenance: "auto.frame-busy",
    stability: unstable?.stability ?? metadata[0].stability ?? null,
    plausibility: { status: saturated ? "saturated"
      : metadata.some(item => item.plausibility?.status === "contended") ? "contended" : "ok",
      implausibleSamples: metadata.reduce((total, item) => total + (item.plausibility?.implausibleSamples || 0), 0), contendedRounds },
    saturated,
    contended,
    clockSensitive: metadata.some(item => item.clockSensitive === true) ? true : metadata.every(item => item.clockSensitive === false) ? false : null
  };
}

function aggregateSummary(report) {
  return {
    metrics: report.aggregateMetrics,
    gpuTiming: report.gpuTiming,
    autoGpu: report.autoGpu,
    sampleCounts: Object.fromEntries(Object.entries(report.metricSamples).map(([key, values]) => [key, values.filter(Number.isFinite).length])),
    validity: reportValidity(report),
    verdict: report.summary.verdict,
    warnings: report.summary.warnings
  };
}

function normalizeTarget(target, label) {
  if (typeof target === "string") {
    return { url: target };
  }
  if (target?.url || target?.file) {
    return target;
  }
  throw new Error(`A ${label} URL or file target is required.`);
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function worstVerdict(verdicts) {
  const ranks = { excellent: 0, good: 1, unknown: 2, "needs-work": 3, poor: 4, invalid: 5 };
  return verdicts.filter((value) => value in ranks).sort((a, b) => ranks[b] - ranks[a])[0] || null;
}
