import { readFile } from "node:fs/promises";
import { formatNumber, summarizeNumericPaths } from "./stats.js";

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

  for (const [path, stats] of Object.entries(customMeasurementStats(report))) {
    add(metrics, `custom.${path}.mean`, stats.mean);
    add(metrics, `custom.${path}.p95`, stats.p95);
    add(metrics, `custom.${path}.max`, stats.max);
  }

  return metrics;
}

export function compareReports(baseReport, candidateReport, options = {}) {
  const budget = options.budget || {};
  const defaultMaxRegressionPercent = Number(budget.defaultMaxRegressionPercent ?? options.thresholdPercent ?? 5);
  const base = reportMetrics(baseReport);
  const candidate = reportMetrics(candidateReport);
  const allKeys = Array.from(new Set([...Object.keys(base), ...Object.keys(candidate)])).sort();
  const rows = [];

  for (const key of allKeys) {
    if (!Number.isFinite(base[key]) || !Number.isFinite(candidate[key])) {
      continue;
    }

    const rule = budget.metrics?.[key] || {};
    const direction = rule.direction || inferDirection(key);
    const delta = candidate[key] - base[key];
    const deltaPercent = base[key] === 0 ? null : (delta / Math.abs(base[key])) * 100;
    const maxRegressionPercent = Number(rule.maxRegressionPercent ?? defaultMaxRegressionPercent);
    const absoluteMax = Number.isFinite(rule.max) ? Number(rule.max) : null;
    const absoluteMin = Number.isFinite(rule.min) ? Number(rule.min) : null;
    let status = "pass";

    if (deltaPercent != null) {
      const regressed = direction === "higher"
        ? deltaPercent < -maxRegressionPercent
        : deltaPercent > maxRegressionPercent;
      const improved = direction === "higher"
        ? deltaPercent > maxRegressionPercent
        : deltaPercent < -maxRegressionPercent;
      if (regressed) {
        status = "regression";
      } else if (improved) {
        status = "improved";
      }
    }

    if (absoluteMax != null && candidate[key] > absoluteMax) {
      status = "regression";
    }
    if (absoluteMin != null && candidate[key] < absoluteMin) {
      status = "regression";
    }

    rows.push({
      base: base[key],
      candidate: candidate[key],
      delta,
      deltaPercent,
      direction,
      key,
      maxRegressionPercent,
      status
    });
  }

  const baseRecs = baseReport?.diagnostics?.recommendations || [];
  const candidateRecs = candidateReport?.diagnostics?.recommendations || [];
  const resolved = baseRecs.filter(b => !candidateRecs.some(c => c.id === b.id));
  const introduced = candidateRecs.filter(c => !baseRecs.some(b => b.id === c.id));

  return {
    failures: rows.filter((row) => row.status === "regression"),
    rows,
    recommendationDiff: {
      resolved,
      introduced
    },
    summary: {
      improved: rows.filter((row) => row.status === "improved").length,
      passed: rows.filter((row) => row.status === "pass").length,
      regressions: rows.filter((row) => row.status === "regression").length,
      total: rows.length
    }
  };
}

export function formatCompareTable(result) {
  const important = result.rows
    .filter((row) => row.status !== "pass" || /fps|frame|memory|trackedGpu|gpu|webgpu|warmup/i.test(row.key))
    .slice(0, 50);
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
  lines.push(`Compared ${result.summary.total} metrics: ${result.summary.regressions} regressions, ${result.summary.improved} improvements, ${result.summary.passed} passing.`);

  if (result.recommendationDiff?.resolved?.length > 0) {
    lines.push("");
    lines.push("🎉 Resolved Optimization Recommendations:");
    for (const r of result.recommendationDiff.resolved) {
      lines.push(`  - [${r.category.toUpperCase()}] ${r.title}: ${r.action}`);
    }
  }

  if (result.recommendationDiff?.introduced?.length > 0) {
    lines.push("");
    lines.push("⚠️ New Bottlenecks / Recommendations Introduced:");
    for (const r of result.recommendationDiff.introduced) {
      lines.push(`  - [${r.category.toUpperCase()}] ${r.title}: ${r.evidence}`);
    }
  }

  return lines.join("\n");
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
  return /(^|\.)(length|byteLength|count|frameCount|samples|totalResources)$/i.test(path) || /^\d+/.test(path);
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
