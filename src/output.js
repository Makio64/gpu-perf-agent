import { reportValidity, pageErrorCounts } from "./validity.js";
import { comparisonStatus } from "./compare.js";

const summaryFields = [
  'verdict', 'verdictReasons', 'bottleneck', 'fps', 'pageFps', 'activeFrameRatio',
  'frameTimeMsMean', 'frameTimeMsP95', 'frameTimeMsMax', 'maxJitterMs',
  'slowFrameCount', 'slowFrameRate', 'observedFrameCount', 'sampleCount', 'idleSampleCount',
  'gpu', 'gpuFrameMsMean', 'gpuFrameMsP95', 'cpuMsPerFrame', 'mainThreadBusy',
  'heap', 'jsHeapGrowthMBPerSec', 'trackedVram', 'drawCallsPerFrame',
  'webgpuOps', 'glOps', 'perFrame', 'churnSites', 'pipelines', 'gpuErrors', 'hitches',
  'cadence', 'warmup', 'bindGroups', 'findings', 'warningCount'
];

/** Bounded stdout for agents. Measurements and retained diagnostics stay on disk. */
export function compactReport(report, out) {
  const diagnostics = report.diagnostics || {};
  const pageErrorCount = pageErrorCounts(report).total;
  const pageErrors = diagnostics.pageErrors || (report.pageEvents || []).filter(event => event.type === "pageerror" || event.type === "requestfailed");
  const validity = diagnostics.validity || reportValidity(report);
  const state = { text: 6000, omittedItems: 0, omittedFields: 0, truncatedText: 0, omittedNestedValues: 0 };
  // Preserve validity first, then measurements. Bulky guidance never displaces them.
  const compactValidity = compactValue(validity, state);
  const compactSignal = compactValue(diagnostics.signal, state);
  const compactTimings = compactValue(report.timings, state);
  // Artifact paths are references, not prose; do not shorten usable paths.
  const artifacts = report.artifacts;
  const source = report.summary;
  let summary;
  if (source) {
    const { warnings, recommendations, highlights, ...measurements } = source;
    const known = summaryFields.filter(key => Object.hasOwn(measurements, key));
    const extra = Object.keys(measurements).filter(key => !summaryFields.includes(key));
    summary = {};
    const orderedKeys = [...known, ...extra];
    const maxKeys = Math.max(32, known.length);
    state.omittedFields += Math.max(0, orderedKeys.length - maxKeys);
    for (const key of orderedKeys.slice(0, maxKeys)) {
      summary[key] = compactValue(measurements[key], state, 1, 5, { nodes: 128 });
    }
    for (const [key, items, limit] of [["warnings", warnings, 5], ["recommendations", recommendations, 3], ["highlights", highlights, 3]]) {
      if (!Array.isArray(items)) continue;
      const selected = items.slice(0, limit).map(item => {
        if (key !== "recommendations" || !item || typeof item !== "object") return item;
        const { codeHint, agentPrompt, ...guidance } = item;
        if (codeHint !== undefined) state.omittedFields++;
        if (agentPrompt !== undefined) state.omittedFields++;
        return guidance;
      });
      summary[key] = compactValue(selected, state);
      const countKey = key === "warnings" ? "warningCount" : key === "recommendations" ? "recommendationCount" : "highlightCount";
      summary[countKey] = items.length;
      if (items.length > limit) {
        summary[`${key}Omitted`] = items.length - limit;
        state.omittedItems += items.length - limit;
      }
    }
  }
  const result = {
    ok: validity.valid,
    ...(out ? { out } : {}),
    verdict: report.summary?.verdict ? line(report.summary.verdict) : null,
    summary,
    diagnostics: {
      validity: compactValidity,
      signal: compactSignal,
      instrumentation: compactValue(diagnostics.instrumentation, state),
      pageErrors: compactValue(pageErrors, state),
      pageErrorCount,
      ...(pageErrorCount > Math.min(pageErrors.length, 5) ? { pageErrorsOmitted: pageErrorCount - Math.min(pageErrors.length, 5) } : {}),
      sampleErrors: compactValue(diagnostics.sampleErrors, state, 0, 3),
      sampleErrorCount: diagnostics.sampleErrors?.length || 0,
      ...(diagnostics.sampleErrors?.length > 3 ? { sampleErrorsOmitted: diagnostics.sampleErrors.length - 3 } : {})
    },
    ...(report.pageEventSummary ? { pageEventSummary: compactValue(report.pageEventSummary, state) } : {}),
    artifacts,
    timings: compactTimings
  };
  const { omittedItems, omittedFields, truncatedText, omittedNestedValues } = state;
  if (omittedItems || omittedFields || truncatedText || omittedNestedValues) result.truncation = { omittedItems, omittedFields, truncatedText, omittedNestedValues };
  return result;
}

// Bound nested errors, custom fields and strings as well as top-level lists.
// Extra count fields explain truncated collections without changing their shape.
function compactValue(value, state, depth = 0, maxItems = 5, budget = { nodes: 128 }) {
  if (value === undefined) return undefined;
  if (budget.nodes-- <= 0 || depth > 4) { state.omittedNestedValues++; return null; }
  if (typeof value === "string") {
    // Keep short codes/types usable even after the descriptive text budget is spent.
    const max = value.length <= 80 ? 80 : Math.min(280, Math.max(0, state.text));
    state.text -= Math.min(value.length, max);
    if (value.length > max) { state.truncatedText++; return `${value.slice(0, Math.max(0, max - 1))}…`; }
    return value;
  }
  if (Array.isArray(value)) {
    state.omittedItems += Math.max(0, value.length - maxItems);
    return value.slice(0, maxItems).map(item => compactValue(item, state, depth + 1, 5, budget));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const result = {};
    state.omittedFields += Math.max(0, entries.length - 32);
    for (const [key, item] of entries.slice(0, 32)) {
      // Report schema keys are short; limit arbitrary workload-provided keys too.
      const name = key.length > 120 ? `${key.slice(0, 119)}…` : key;
      if (name !== key) state.truncatedText++;
      result[name] = compactValue(item, state, depth + 1, 5, budget);
      if (Array.isArray(item) && item.length > 5) {
        result[`${name}Count`] = item.length;
        result[`${name}Omitted`] = item.length - 5;
      }
    }
    return result;
  }
  return value;
}

const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
const line = value => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 280);

/** Describe the timing scope even when the general warning list is clipped. */
export function formatGpuTimingSignal(timing) {
  if (!timing) return null;
  if (timing.status === 'single-scope') {
    return `GPU timing scope: ${line(timing.scope === '' ? '(root)' : timing.scope)}; ${number(timing.validSampleCount, 0)}/${number(timing.sampleCount, 0)} samples.`;
  }
  const reasons = Array.isArray(timing.reasons) ? timing.reasons.slice(0, 4).map(line).join(', ') : '';
  return `GPU timing scope: ${line(timing.status)}; aggregate GPU time unavailable${reasons ? ` (${reasons})` : ''}.`;
}

export function formatAgentReport(report, { out, maxWarnings = 3 } = {}) {
  const s = report.summary || {};
  const signal = report.diagnostics?.signal || {};
  const warnings = s.warnings || [];
  const validity = report.diagnostics?.validity || reportValidity(report);
  maxWarnings = boundedLimit(maxWarnings, 3, 0, 5);
  const rows = [
    `GPU ${validity.valid && s.verdict !== 'invalid' ? line(s.verdict || 'unknown').toUpperCase() : 'INVALID'} | ${number(s.fps, 1)} FPS | p95 ${number(s.frameTimeMsP95)} ms | GPU ${number(s.gpuFrameMsMean)} ms`,
    `VRAM ${number(s.trackedVram?.totalMiB, 1)} MiB | heap ${number(s.jsHeapGrowthMBPerSec)} MiB/s | draws/frame ${number(s.drawCallsPerFrame, 0)} | slow ${number(s.slowFrameCount, 0)}`,
    `Signal: ${number(signal.sampleCount ?? s.sampleCount, 0)} samples, ${number(signal.observedFrameCount ?? s.observedFrameCount, 0)} frames, ${number(signal.gpuTimingSamples, 0)} GPU timings.`
  ];
  const gpuTimingLine = formatGpuTimingSignal(signal.gpuTiming);
  if (gpuTimingLine) rows.push(gpuTimingLine);
  if (!validity.valid) rows.push(`Invalid: ${issueSummary(validity.issues)}`);
  if ((report.options?.samplingMode ?? signal.samplingMode) === 'hook') rows.push('Sampling: hook completion; profiler frame observation disabled.');
  const events = report.pageEventSummary;
  if (events?.dropped || events?.truncated) rows.push(`Page diagnostics: ${number(events.retained, 0)}/${number(events.total, 0)} events retained; ${number(events.dropped, 0)} dropped, ${number(events.truncated, 0)} shortened. Error totals include dropped events.`);
  for (const warning of warnings.slice(0, maxWarnings)) rows.push(`- [${line(warning.severity)}:${line(warning.code)}] ${line(warning.recommendation || warning.message)}`);
  if (warnings.length > maxWarnings) rows.push(`+${warnings.length - maxWarnings} more warnings in report.`);
  if (out) rows.push(`Report: ${out}`);
  return rows.join('\n');
}

export function comparisonExitCode(result, { allowMismatch = false } = {}) {
  return comparisonStatus(result, { allowMismatch }).exitCode;
}

export function formatAgentComparison(result, { primaryMetric, maxRows = 5 } = {}) {
  const s = result.summary;
  const lines = [`Compare: ${s.regressions} regressions, ${s.improved} improvements, ${s.inconclusive} inconclusive.`];
  const rows = result.rows || [];
  const changed = rows.filter(row => row.status !== 'pass');
  const counts = { intervals: 0, threshold: 0, unavailable: 0 };
  for (const row of rows) {
    if (hasInterval(row)) counts.intervals++;
    else if (row.evidence === 'threshold-only') counts.threshold++;
    else counts.unavailable++;
  }
  lines.push(`Evidence: ${counts.intervals} with 95% intervals, ${counts.threshold} threshold-only, ${counts.unavailable} unavailable.`);
  if (result.validity?.valid === false) lines.push(`INVALID: ${issueSummary(result.validity.issues)}`);
  if (result.compatibility?.compatible === false) {
    const differences = result.compatibility.differences || [];
    lines.push(`Mismatched capture/environment: ${differences.slice(0, 5).map(d => line(d.key)).join(', ')}${differences.length > 5 ? `; +${differences.length - 5} more` : ''}.`);
  }
  const environment = result.compatibility?.environment;
  if (environment?.unverifiedKeys?.length) lines.push(`Environment: ${environment.checkedKeys?.length ?? 0} fields checked; ${environment.unverifiedKeys.length} unverified.`);
  maxRows = boundedLimit(maxRows, 5, 1, 10);
  const priority = { regression: 0, missing: 1, inconclusive: 2, improved: 3, pass: 4 };
  const selected = [];
  const primary = primaryMetric ? rows.find(row => row.key === primaryMetric) : null;
  if (primaryMetric && !primary) lines.push(`Primary metric not measured: ${line(primaryMetric)}.`);
  if (primary) selected.push(primary);
  // Stable sort retains deterministic metric order within each severity.
  for (const row of changed.toSorted((a, b) => (priority[a.status] ?? 5) - (priority[b.status] ?? 5))) {
    if (selected.length >= maxRows) break;
    if (row !== primary) selected.push(row);
  }
  if (!selected.length && rows.length) selected.push(rows.find(row => /frame\.fps\.mean|frame\.frameTimeMs\.mean/.test(row.key)) || rows[0]);
  for (const row of selected) {
    const interval = hasInterval(row) ? `; 95% Δ [${number(row.confidence95.low)}, ${number(row.confidence95.high)}]` : '';
    lines.push(`- ${row === primary ? 'primary ' : ''}${line(row.status)}: ${line(row.key)} ${number(row.base)} → ${number(row.candidate)} (${number(row.deltaPercent, 1)}%); ${line(row.evidence || 'evidence unavailable')}${interval}.`);
  }
  const omitted = {};
  for (const row of changed) if (!selected.includes(row)) omitted[row.status] = (omitted[row.status] || 0) + 1;
  if (Object.keys(omitted).length) lines.push(`Omitted: ${Object.entries(omitted).map(([status, count]) => `${count} ${line(status)}`).join(', ')}. Inspect full comparison.`);
  const passed = rows.filter(row => row.status === 'pass').length;
  if (passed) lines.push(`${passed} within thresholds; passing alone does not establish equivalence.`);
  for (const [label, warnings] of [['Resolved', result.diagnostics?.resolvedWarnings], ['Introduced', result.diagnostics?.introducedWarnings]]) {
    if (warnings?.length) lines.push(`${label}: ${warnings.slice(0, 5).map(w => line(w.code)).join(', ')}${warnings.length > 5 ? `; +${warnings.length - 5} more` : ''}.`);
  }
  return lines.join('\n');
}

const hasInterval = row => Number.isFinite(row.confidence95?.low) && Number.isFinite(row.confidence95?.high);
const boundedLimit = (value, fallback, min, max) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
const issueSummary = (issues = []) => `${line(issues.slice(0, 3).map(issue => issue.message).join(' '))}${issues.length > 3 ? ` (+${issues.length - 3} more issues in report)` : ''}`;
