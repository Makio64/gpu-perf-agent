import { reportValidity } from "./validity.js";

/** Bounded stdout for agents. Full measurement evidence stays in the report file. */
export function compactReport(report, out) {
  const diagnostics = report.diagnostics || {};
  const validity = diagnostics.validity || reportValidity(report);
  return {
    ok: validity.valid,
    ...(out ? { out } : {}),
    verdict: report.summary?.verdict || null,
    summary: report.summary,
    diagnostics: {
      validity,
      signal: diagnostics.signal,
      instrumentation: diagnostics.instrumentation,
      pageErrors: diagnostics.pageErrors?.slice(0, 5),
      pageErrorCount: diagnostics.pageErrors?.length || 0,
      sampleErrors: diagnostics.sampleErrors?.slice(0, 3)
    },
    artifacts: report.artifacts,
    timings: report.timings
  };
}

const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
const line = value => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 280);

export function formatAgentReport(report, { out, maxWarnings = 3 } = {}) {
  const s = report.summary || {};
  const signal = report.diagnostics?.signal || {};
  const warnings = s.warnings || [];
  const validity = report.diagnostics?.validity || reportValidity(report);
  const rows = [
    `GPU ${validity.valid ? String(s.verdict || 'unknown').toUpperCase() : 'INVALID'} | ${number(s.fps, 1)} FPS | p95 ${number(s.frameTimeMsP95)} ms | GPU ${number(s.gpuFrameMsMean)} ms`,
    `VRAM ${number(s.trackedVram?.totalMiB, 1)} MiB | heap ${number(s.jsHeapGrowthMBPerSec)} MiB/s | draws/frame ${number(s.drawCallsPerFrame, 0)} | slow ${s.slowFrameCount ?? 0}`,
    `Signal: ${signal.sampleCount ?? 0} samples, ${signal.observedFrameCount ?? 0} frames, ${signal.gpuTimingSamples ?? 0} GPU timings.`
  ];
  if (!validity.valid) rows.push(`Invalid: ${line(validity.issues.map(issue => issue.message).join(' '))}`);
  for (const warning of warnings.slice(0, maxWarnings)) rows.push(`- [${line(warning.severity)}:${line(warning.code)}] ${line(warning.recommendation || warning.message)}`);
  if (warnings.length > maxWarnings) rows.push(`+${warnings.length - maxWarnings} more warnings in report.`);
  if (out) rows.push(`Report: ${line(out)}`);
  return rows.join('\n');
}

export function comparisonExitCode(result, { allowMismatch = false } = {}) {
  if (result.validity?.valid === false) return 2;
  if (!result.compatibility.compatible && !allowMismatch) return 2;
  return result.failures.length ? 1 : 0;
}

export function formatAgentComparison(result) {
  const s = result.summary;
  const lines = [`Compare: ${s.regressions} regressions, ${s.improved} improvements, ${s.inconclusive} inconclusive.`];
  if (result.validity?.valid === false) lines.push(`INVALID: ${line(result.validity.issues.map(issue => issue.message).join(' '))}`);
  if (!result.compatibility.compatible) lines.push(`Mismatched options: ${result.compatibility.differences.map(d => d.key).join(', ')}.`);
  for (const row of result.rows.filter(row => row.status !== 'pass').slice(0, 5)) {
    lines.push(`- ${row.status}: ${row.key} ${number(row.base)} → ${number(row.candidate)} (${number(row.deltaPercent, 1)}%).`);
  }
  const resolved = result.diagnostics.resolvedWarnings.map(w => w.code);
  if (resolved.length) lines.push(`Resolved: ${resolved.join(', ')}.`);
  return lines.join('\n');
}
