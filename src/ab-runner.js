import { compareReports, reportMetrics, validateBudget } from "./compare.js";
import { FastCDPHarness } from "./fast-cdp-runner.js";
import { normalizeOptions, numberOption } from "./options.js";
import { numericStats } from "./stats.js";
import { reportValidity } from "./validity.js";

export async function runABComparison(options = {}) {
  const baseTarget = normalizeTarget(options.base, "base");
  const candidateTarget = normalizeTarget(options.candidate, "candidate");
  const rounds = numberOption(options.rounds ?? 4, "rounds", { min: 2, max: 1000, integer: true });
  options = normalizeOptions({ durationMs: 250, samples: 1, warmup: 1, ...options }, { requireTarget: false });
  normalizeOptions({ ...options, ...baseTarget });
  normalizeOptions({ ...options, ...candidateTarget });
  numberOption(options.thresholdPercent ?? 5, "thresholdPercent");
  validateBudget(options.budget);
  const harness = await FastCDPHarness.launch(options);
  const runs = [];

  try {
    for (const entry of alternatingOrder(rounds)) {
      const target = entry.variant === "base" ? baseTarget : candidateTarget;
      const startedAt = performance.now();
      const report = await harness.run({
        ...options,
        ...target,
        samples: Number(options.samples ?? 1),
        warmup: Number(options.warmup ?? 1)
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
    await harness.close();
  }

  const baseReport = aggregateReports(runs.filter((run) => run.variant === "base").map((run) => run.report));
  const candidateReport = aggregateReports(runs.filter((run) => run.variant === "candidate").map((run) => run.report));
  const comparison = compareReports(baseReport, candidateReport, {
    budget: options.budget,
    paired: true,
    thresholdPercent: Number(options.thresholdPercent ?? 5)
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

export function aggregateReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("Cannot aggregate an empty report list.");
  }
  const metricSamples = {};
  const metrics = reports.map(reportMetrics);
  const roundValidity = reports.map(reportValidity);
  for (const key of new Set(metrics.flatMap(Object.keys))) {
    metricSamples[key] = metrics.map(values => Number.isFinite(values[key]) ? values[key] : null);
    metricSamples[key].forEach((value, round) => {
      if (value === null) {
        roundValidity[round].valid = false;
        roundValidity[round].issues.push({ code: "missing-metric", key, message: `${key} was not measured in round ${round + 1}.` });
      }
    });
  }
  const aggregateMetrics = Object.fromEntries(Object.entries(metricSamples).map(([key, values]) => [
    key,
    numericStats(values).mean
  ]));
  const warningMap = new Map();
  for (const report of reports) {
    for (const warning of report.summary?.warnings || []) {
      warningMap.set(warning.code, warning);
    }
  }
  const first = reports[0];
  return {
    aggregateMetrics,
    inPage: { samples: [] },
    metricSamples,
    options: first.options,
    roundValidity,
    summary: {
      verdict: worstVerdict(reports.map((report) => report.summary?.verdict)),
      warnings: Array.from(warningMap.values())
    }
  };
}

function aggregateSummary(report) {
  return {
    metrics: report.aggregateMetrics,
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

function worstVerdict(verdicts) {
  const ranks = { excellent: 0, good: 1, "needs-work": 2, poor: 3 };
  return verdicts.filter((value) => value in ranks).sort((a, b) => ranks[b] - ranks[a])[0] || null;
}
