const statuses = new Set(['single-scope', 'ambiguous', 'invalid', 'unavailable', 'unverified']);
const reasonCodes = new Set(['multiple-timings', 'scope-change', 'negative-duration', 'no-timings', 'missing-provenance', 'incomplete-scope']);

/** Select one GPU timing per sample only when its scope is unambiguous. */
export function collectGpuTimingEvidence(report) {
  const samples = report?.inPage?.samples;
  if (!Array.isArray(samples) || (!samples.length && (report?.metricSamples || report?.aggregateMetrics || report?.roundValidity))) {
    const saved = report?.gpuTiming ?? report?.diagnostics?.signal?.gpuTiming;
    if (saved?.schemaVersion === 1 && statuses.has(saved.status)
        && (saved.status !== 'single-scope' || typeof saved.scope === 'string')) {
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const metadata = { schemaVersion: 1, status: saved.status, scope: saved.status === 'single-scope' ? saved.scope : null,
        sampleCount: count(saved.sampleCount), validSampleCount: count(saved.validSampleCount), timingCount: count(saved.timingCount),
        ambiguousSampleCount: count(saved.ambiguousSampleCount), negativeTimingCount: count(saved.negativeTimingCount),
        reasons: [...new Set((Array.isArray(saved.reasons) ? saved.reasons : []).filter(reason => reasonCodes.has(reason)))],
        values: [], source: 'saved' };
      // Saved evidence may be inconsistent; its counters/reasons cannot be waived
      // by a single-scope label and restore a misleading health comparison.
      if (metadata.negativeTimingCount || metadata.reasons.includes('negative-duration')) metadata.status = 'invalid';
      else if (metadata.ambiguousSampleCount || metadata.reasons.includes('multiple-timings') || metadata.reasons.includes('scope-change')) metadata.status = 'ambiguous';
      else if (metadata.status === 'single-scope' && (!metadata.validSampleCount || metadata.validSampleCount > metadata.sampleCount
          || metadata.validSampleCount > metadata.timingCount || metadata.reasons.length)) {
        metadata.status = 'unverified';
        if (!metadata.reasons.includes('missing-provenance')) metadata.reasons.push('missing-provenance');
      }
      if (metadata.status !== 'single-scope') metadata.scope = null;
      return metadata;
    }
    return { schemaVersion: 1, status: 'unverified', scope: null, sampleCount: 0, validSampleCount: 0,
      timingCount: 0, ambiguousSampleCount: 0, negativeTimingCount: 0,
      reasons: ['missing-provenance'], values: [], source: 'none' };
  }

  const values = Array(samples.length).fill(null);
  const parts = [];
  let scope = null;
  let scopeChanged = false;
  let timingCount = 0;
  let ambiguousSampleCount = 0;
  let negativeTimingCount = 0;
  let validSampleCount = 0;
  let sampleCount = 0;
  let sampleValue = null;
  let sampleScope = null;

  function visit(value, property = '', depth = 0) {
    if (depth > 8 || value == null) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const key = property.slice(property.lastIndexOf('.') + 1);
      const milliseconds = /^(gpuMs|gpuFrameMs|gpuTimeMs|gpuDurationMs)$/i.test(key);
      if (!milliseconds && !/^(gpuNs|gpuTimeNs|gpuDurationNs)$/i.test(key)) return;
      sampleCount++;
      timingCount++;
      if (value < 0) { negativeTimingCount++; return; }
      // Build a path only for a matching timing leaf, never other telemetry.
      // Match the custom metric prefix convention, including leading empty keys.
      let path = '';
      for (const part of parts) path = path ? `${path}.${part}` : part;
      sampleScope = path.slice(0, Math.max(0, path.lastIndexOf('.')));
      sampleValue = milliseconds ? value : value / 1e6;
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      parts.push(key);
      visit(item, key, depth + 1);
      parts.pop();
    }
  }

  samples.forEach((sample, index) => {
    sampleCount = 0;
    sampleValue = null;
    sampleScope = null;
    visit(sample?.measurement);
    if (sampleCount > 1) ambiguousSampleCount++;
    if (sampleCount !== 1 || sampleValue === null) return;
    values[index] = sampleValue;
    validSampleCount++;
    if (scope !== null && scope !== sampleScope) scopeChanged = true;
    scope ??= sampleScope;
  });
  const reasons = [];
  if (ambiguousSampleCount) reasons.push('multiple-timings');
  if (scopeChanged) reasons.push('scope-change');
  if (negativeTimingCount) reasons.push('negative-duration');
  if (!timingCount) reasons.push('no-timings');
  const status = negativeTimingCount ? 'invalid' : ambiguousSampleCount || scopeChanged ? 'ambiguous' : validSampleCount ? 'single-scope' : 'unavailable';
  return { schemaVersion: 1, status, scope: status === 'single-scope' ? scope : null,
    sampleCount: samples.length, validSampleCount, timingCount, ambiguousSampleCount, negativeTimingCount, reasons, values, source: 'raw' };
}

/** Persist only bounded provenance, not a second copy of every sample. */
export function gpuTimingMetadata(evidence) {
  const { values, source, ...metadata } = evidence;
  return metadata;
}

export function aggregateGpuTimingEvidence(evidence) {
  const first = evidence[0];
  const reasons = new Set(evidence.flatMap(item => item.reasons));
  const verified = evidence.filter(item => item.status === 'single-scope');
  const scopeChanged = verified.some(item => item.scope !== verified[0]?.scope);
  if (scopeChanged) reasons.add('scope-change');
  if (verified.length && verified.length !== evidence.length) reasons.add('incomplete-scope');
  const status = evidence.some(item => item.status === 'invalid') ? 'invalid'
    : scopeChanged || evidence.some(item => item.status === 'ambiguous') ? 'ambiguous'
    : evidence.some(item => item.status === 'unverified') ? 'unverified'
    : verified.length === evidence.length && first ? 'single-scope' : 'unavailable';
  const totals = Object.fromEntries(['sampleCount', 'validSampleCount', 'timingCount', 'ambiguousSampleCount', 'negativeTimingCount']
    .map(key => [key, evidence.reduce((total, item) => total + item[key], 0)]));
  return { schemaVersion: 1, status, scope: status === 'single-scope' ? first.scope : null, ...totals, reasons: [...reasons] };
}

/** Scope drift and invalid durations cannot be waived as an option mismatch. */
export function gpuTimingValidityIssues(evidence) {
  const issues = [];
  if (evidence.reasons.includes('scope-change')) issues.push({ code: 'gpu-timing-scope-drift',
    message: 'GPU timing scope changed within these measurements.' });
  if (evidence.status === 'invalid') issues.push({ code: 'invalid-gpu-timing',
    message: 'Negative GPU durations prevent valid timing evidence.', count: evidence.negativeTimingCount });
  return issues;
}
