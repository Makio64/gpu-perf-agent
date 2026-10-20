const statuses = new Set(['single-scope', 'ambiguous', 'invalid', 'unavailable', 'unverified']);
const reasonCodes = new Set(['multiple-timings', 'scope-change', 'negative-duration', 'no-timings', 'missing-provenance', 'incomplete-scope']);
const provenances = new Set(['warm', 'fixed-work', 'vsync-paced', 'unknown']);
const stabilityStatuses = new Set(['stable', 'unstable', 'unknown']);
const stabilityReasons = new Set(['within-run-spread', 'between-sample-drift', 'high-dispersion', 'quantized']);
const AUTO_PROVENANCE = 'auto.frame-busy';
// Attached browsers without allow_unsafe_apis quantize timestamps to 100 µs.
const QUANTUM_MS = 0.1;

/** Select one GPU timing per sample only when its scope is unambiguous. */
export function collectGpuTimingEvidence(report) {
  const samples = report?.inPage?.samples;
  if (!Array.isArray(samples) || (!samples.length && (report?.metricSamples || report?.aggregateMetrics || report?.roundValidity))) {
    return savedGpuTimingEvidence(report?.gpuTiming ?? report?.diagnostics?.signal?.gpuTiming);
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
    // Idle samples are excluded from every statistic (§1.5).
    if (sample?.idle === true) return;
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
  const measured = values.filter(Number.isFinite);
  const evidence = { schemaVersion: 2, status, scope: status === 'single-scope' ? scope : null,
    sampleCount: samples.length, validSampleCount, timingCount, ambiguousSampleCount, negativeTimingCount, reasons,
    provenance: gpuTimingProvenance(report),
    stability: gpuTimingStability({ perSampleMs: measured, cadenceIntervalMs: cadenceOf(report).intervalMs, kind: 'hook' }),
    plausibility: { status: 'ok', implausibleSamples: 0 },
    zeroTimingCount: measured.filter(value => value === 0).length,
    quantized: hookQuantized(measured),
    values, source: 'raw' };
  evidence.plausibility = gpuTimingPlausibility(report, evidence);
  return evidence;
}

/** Saved provenance (diagnostics.signal.gpuTiming v1/v2, or an ab aggregate) without raw samples. */
function savedGpuTimingEvidence(saved) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const unknownStability = { status: 'unknown', clockSensitive: null, reasons: [], cv: null, ratio: null };
  if ((saved?.schemaVersion === 1 || saved?.schemaVersion === 2) && statuses.has(saved.status)
      && (saved.status !== 'single-scope' || typeof saved.scope === 'string')) {
    const v2 = saved.schemaVersion === 2;
    const metadata = { schemaVersion: 2, status: saved.status, scope: saved.status === 'single-scope' ? saved.scope : null,
      sampleCount: count(saved.sampleCount), validSampleCount: count(saved.validSampleCount), timingCount: count(saved.timingCount),
      ambiguousSampleCount: count(saved.ambiguousSampleCount), negativeTimingCount: count(saved.negativeTimingCount),
      reasons: [...new Set((Array.isArray(saved.reasons) ? saved.reasons : []).filter(reason => reasonCodes.has(reason)))],
      // v1 evidence predates provenance; it can never claim warm or fixed-work timing.
      provenance: v2 && provenances.has(saved.provenance) ? saved.provenance : 'unknown',
      stability: v2 ? savedStability(saved.stability) ?? unknownStability : unknownStability,
      plausibility: v2 && ['ok', 'contended'].includes(saved.plausibility?.status)
        ? { status: saved.plausibility.status, implausibleSamples: count(saved.plausibility.implausibleSamples) }
        : { status: 'ok', implausibleSamples: 0 },
      zeroTimingCount: v2 ? count(saved.zeroTimingCount) : 0,
      quantized: v2 && saved.quantized === true,
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
  return { schemaVersion: 2, status: 'unverified', scope: null, sampleCount: 0, validSampleCount: 0,
    timingCount: 0, ambiguousSampleCount: 0, negativeTimingCount: 0,
    reasons: ['missing-provenance'], provenance: 'unknown', stability: unknownStability,
    plausibility: { status: 'ok', implausibleSamples: 0 }, zeroTimingCount: 0, quantized: false, values: [], source: 'none' };
}

function savedStability(saved) {
  if (!saved || !stabilityStatuses.has(saved.status)) return null;
  const finite = value => Number.isFinite(value) ? value : null;
  return { status: saved.status, clockSensitive: typeof saved.clockSensitive === 'boolean' ? saved.clockSensitive : null,
    reasons: [...new Set((Array.isArray(saved.reasons) ? saved.reasons : []).filter(reason => stabilityReasons.has(reason)))],
    cv: finite(saved.cv), ratio: finite(saved.ratio) };
}

/**
 * Hook timing provenance (§6.3): the majority `measurement.gpuTiming.method`
 * when it is warm or fixed-work; otherwise vsync-paced in frames mode (one
 * out-of-band pass per sample at whatever clock vsync leaves); else unknown.
 */
export function gpuTimingProvenance(report) {
  const samples = (report?.inPage?.samples || []).filter(sample => sample && sample.idle !== true);
  const methods = new Map();
  for (const sample of samples) {
    const method = sample.measurement?.gpuTiming?.method;
    if (typeof method === 'string') methods.set(method, (methods.get(method) || 0) + 1);
  }
  for (const method of ['warm', 'fixed-work']) {
    if ((methods.get(method) || 0) * 2 > samples.length) return method;
  }
  const mode = report?.options?.samplingMode ?? report?.inPage?.config?.samplingMode;
  if (samples.length && (mode ?? 'frames') === 'frames') return 'vsync-paced';
  return 'unknown';
}

/**
 * One stability rule for hook and auto GPU timing (§6.3). Values are ms.
 * `pooled` holds per-frame statistics ({count, p50, p95, min, max?}) when the
 * capture timed every frame.
 */
export function gpuTimingStability({ perSampleMs = [], pooled = null, cadenceIntervalMs = null, kind = 'auto' } = {}) {
  const values = (Array.isArray(perSampleMs) ? perSampleMs : []).filter(Number.isFinite);
  const frameCount = Number.isFinite(pooled?.count) ? pooled.count : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  const sd = values.length ? Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length) : null;
  const cv = values.length >= 2 && mean > 0 ? sd / mean : null;
  const ratio = values.length >= 2 && min > 0 ? max / min : null;
  const p95 = Number.isFinite(pooled?.p95) ? pooled.p95 : values.length ? max : null;
  const clockSensitive = Number.isFinite(cadenceIntervalMs) && cadenceIntervalMs > 0 && p95 !== null
    ? p95 < 0.6 * cadenceIntervalMs : null;
  if (values.length < 3 && frameCount < 20) return { status: 'unknown', clockSensitive, reasons: [], cv, ratio };

  const reasons = [];
  if (frameCount >= 20 && Number.isFinite(pooled.p50)) {
    // Desktop isGpuFrameTimeStable: a wide per-frame spread on constant work
    // means the GPU clock changed mid-run.
    const wideTail = Number.isFinite(pooled.p95) && pooled.p95 - pooled.p50 > 0.5 && pooled.p95 > 1.6 * pooled.p50;
    const wideHead = Number.isFinite(pooled.min) && pooled.p50 - pooled.min > 0.5 && pooled.p50 > 2.5 * pooled.min;
    if (wideTail || wideHead) reasons.push('within-run-spread');
  }
  if (values.length >= 3) {
    // Clock state drifts between samples even when each sample looks tight.
    const median = medianOf(sorted);
    if (median >= 0.5 ? !(max <= 1.15 * min) : max - min > 0.1) reasons.push('between-sample-drift');
    if (kind === 'hook' && median >= 0.05 && ((cv ?? 0) > 0.25 || !(max <= 3 * min))) reasons.push('high-dispersion');
  }
  if (kind === 'auto') {
    // Per-sample p50s may be the midpoint of two quantized frames (0.05 ms steps).
    const checked = [...values.map(value => [value, QUANTUM_MS / 2]),
      ...[pooled?.min, pooled?.max].filter(Number.isFinite).map(value => [value, QUANTUM_MS])];
    const median = Number.isFinite(pooled?.p50) ? pooled.p50 : medianOf(sorted);
    if (checked.length >= 3 && median < 1 && checked.every(([value, step]) => isMultiple(value, step))) reasons.push('quantized');
  }
  return { status: reasons.length ? 'unstable' : 'stable', clockSensitive, reasons, cv, ratio };
}

/**
 * Hook: a sample is implausible when its GPU time exceeds its own frame time
 * (other GPU work or overlap); more than 1/3 implausible is `contended`.
 * Auto: the union p50 reaching 0.9 × the frame interval is `saturated`; that
 * value is latency, not cost.
 */
export function gpuTimingPlausibility(report, evidence) {
  const samples = report?.inPage?.samples || [];
  const cadence = cadenceOf(report);
  if (evidence?.provenance === AUTO_PROVENANCE) {
    let implausibleSamples = 0;
    let evaluated = 0;
    for (const sample of samples) {
      const gpuMs = sampleAutoGpuMs(sample);
      const interval = sampleFrameIntervalMs(sample);
      if (gpuMs === null || interval === null) continue;
      evaluated++;
      if (gpuMs >= 0.9 * interval) implausibleSamples++;
    }
    const unionMs = Number.isFinite(evidence.pooled?.p50) ? evidence.pooled.p50 : medianOf([...(evidence.perSampleMs || [])].sort((a, b) => a - b));
    const intervalMs = pooledFrameIntervalMs(report);
    const saturated = Number.isFinite(unionMs) && Number.isFinite(intervalMs)
      ? unionMs >= 0.9 * intervalMs
      : evaluated > 0 && implausibleSamples * 2 > evaluated;
    return { status: saturated ? 'saturated' : 'ok', implausibleSamples };
  }
  const values = Array.isArray(evidence?.values) ? evidence.values : [];
  let implausibleSamples = 0;
  let evaluated = 0;
  values.forEach((gpuMs, index) => {
    if (!Number.isFinite(gpuMs)) return;
    const observed = samples[index]?.measurement?.observedFrames;
    const frameTimeMs = finiteOrNull(observed?.frameTimeMs?.mean ?? samples[index]?.measurement?.frameTimeMs?.mean);
    const hz = finiteOrNull(observed?.cadence?.hz ?? cadence.hz);
    const limit = Math.max(frameTimeMs ?? 0, hz > 0 ? 1000 / hz : 0);
    if (!(limit > 0)) return;
    evaluated++;
    if (gpuMs > 1.05 * limit) implausibleSamples++;
  });
  return { status: evaluated > 0 && implausibleSamples * 3 > evaluated ? 'contended' : 'ok', implausibleSamples };
}

/**
 * Per-frame auto GPU timing (`samples[i].autoGpu`, `inPage.summary.autoGpu`)
 * as evidence in ms. Idle samples and samples without timed frames are skipped.
 */
export function collectAutoGpuEvidence(report) {
  const inPage = report?.inPage || {};
  const samples = Array.isArray(inPage.samples) ? inPage.samples : [];
  const pooledSource = inPage.summary?.autoGpu;
  const active = samples.filter(sample => sample?.autoGpu && sample.idle !== true);
  const perSampleMs = [];
  for (const sample of active) {
    const value = sampleAutoGpuMs(sample);
    if (value !== null) perSampleMs.push(value);
  }
  const total = key => Number.isFinite(pooledSource?.[key]) ? pooledSource[key]
    : active.reduce((sum, sample) => sum + (Number.isFinite(sample.autoGpu[key]) ? sample.autoGpu[key] : 0), 0);
  const frameNs = pooledSource?.frameNs;
  const pooled = Number.isFinite(frameNs?.p50) && frameNs.count > 0 ? {
    count: frameNs.count, p50: frameNs.p50 / 1e6, p95: finiteOrNull(frameNs.p95 / 1e6), min: finiteOrNull(frameNs.min / 1e6),
    mean: finiteOrNull(frameNs.mean / 1e6), ...(Number.isFinite(frameNs.max) ? { max: frameNs.max / 1e6 } : {})
  } : null;
  const available = Boolean(pooledSource) || active.length > 0;
  const timedFrames = total('timedFrames');
  const status = !available ? 'unavailable'
    : typeof pooledSource?.status === 'string' ? pooledSource.status
    : timedFrames === 0 ? 'no-frames' : total('partialFrames') > timedFrames ? 'partial' : 'ok';
  const sources = new Set(active.map(sample => sample.autoGpu.source).filter(Boolean));
  const evidence = {
    status,
    source: pooledSource?.source ?? (sources.size > 1 ? 'mixed' : [...sources][0] ?? null),
    frames: total('frames'), timedFrames, partialFrames: total('partialFrames'),
    perSampleMs, pooled, provenance: AUTO_PROVENANCE,
    stability: gpuTimingStability({ perSampleMs, pooled, cadenceIntervalMs: cadenceOf(report).intervalMs, kind: 'auto' }),
    plausibility: { status: 'ok', implausibleSamples: 0 },
    saturated: false, clockSensitive: null,
    passes: Array.isArray(pooledSource?.passes) ? pooledSource.passes : []
  };
  evidence.clockSensitive = evidence.stability.clockSensitive;
  if (perSampleMs.length || pooled) {
    evidence.plausibility = gpuTimingPlausibility(report, evidence);
    evidence.saturated = evidence.plausibility.status === 'saturated';
  }
  return evidence;
}

/** Persist only bounded provenance, not a second copy of every sample. */
export function gpuTimingMetadata(evidence) {
  if (evidence?.provenance === AUTO_PROVENANCE) {
    const { status, source, frames, timedFrames, partialFrames, provenance, stability, plausibility, saturated, clockSensitive } = evidence;
    return { status, source, frames, timedFrames, partialFrames, provenance, stability, plausibility, saturated, clockSensitive };
  }
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
  const totals = Object.fromEntries(['sampleCount', 'validSampleCount', 'timingCount', 'ambiguousSampleCount', 'negativeTimingCount', 'zeroTimingCount']
    .map(key => [key, evidence.reduce((total, item) => total + (item[key] || 0), 0)]));
  // Rounds share one provenance only when every round agrees. The worst
  // round's stability and plausibility represent the aggregate.
  const provenance = evidence.length && evidence.every(item => item.provenance === first.provenance) ? first.provenance ?? 'unknown' : 'unknown';
  const stabilities = evidence.map(item => item.stability).filter(Boolean);
  const stability = stabilities.find(item => item.status === 'unstable') ?? stabilities.find(item => item.status === 'unknown')
    ?? stabilities[0] ?? { status: 'unknown', clockSensitive: null, reasons: [], cv: null, ratio: null };
  const plausibility = { status: evidence.some(item => item.plausibility?.status === 'contended') ? 'contended' : 'ok',
    implausibleSamples: evidence.reduce((total, item) => total + (item.plausibility?.implausibleSamples || 0), 0) };
  return { schemaVersion: 2, status, scope: status === 'single-scope' ? first.scope : null, ...totals, reasons: [...reasons],
    provenance, stability, plausibility, quantized: evidence.length > 0 && evidence.every(item => item.quantized === true) };
}

/**
 * GPU timing validity entries (§3.1), each `{code, severity, message, …}`.
 * reportValidity folds these in. Called without a report (callers that push
 * straight into `issues`), only the invalid entries are returned, minus
 * zero-gpu-duration: its severity needs options.cdpAttached, and
 * reportValidity already reports it.
 */
export function gpuTimingValidityIssues(evidence, report) {
  const issues = [];
  const add = (code, severity, message, details = {}) => issues.push({ code, severity, message, ...details });
  const reasons = Array.isArray(evidence?.reasons) ? evidence.reasons : [];
  if (reasons.includes('scope-change')) add('gpu-timing-scope-drift', 'invalid', 'GPU timing scope changed within these measurements.');
  if (evidence?.status === 'invalid') add('invalid-gpu-timing', 'invalid', 'Negative GPU durations prevent valid timing evidence.',
    { count: evidence.negativeTimingCount });
  const values = (Array.isArray(evidence?.values) ? evidence.values : []).filter(Number.isFinite);
  const zeros = values.length ? values.filter(value => value === 0).length : evidence?.zeroTimingCount || 0;
  const timed = values.length || evidence?.validSampleCount || 0;
  const attached = report?.options?.cdpAttached === true;
  if (timed >= 2 && zeros === timed) {
    add('zero-gpu-duration', attached ? 'warning' : 'invalid',
      `All GPU timings are 0 ns (broken pass or failed pipeline${attached ? '; attached browser quantizes timestamps to 100 µs' : ''}).`,
      { count: zeros });
  } else if (zeros > 0 && zeros < timed) {
    add('zero-gpu-duration-partial', 'warning', `${zeros}/${timed} GPU timings are 0 ns.`, { count: zeros });
  }
  if (evidence?.quantized === true && !(timed >= 2 && zeros === timed)) {
    add('hook-timing-quantized', 'warning', 'Hook GPU timings are quantized to 100 µs; sub-ms differences are not measurable.');
  }
  if (evidence?.status === 'single-scope' && evidence.stability?.status === 'unstable') {
    add('gpu-timing-unstable', 'warning',
      `GPU timing unstable (${evidence.stability.reasons.join(', ')}); GPU rows from separate captures will not gate.`,
      { source: 'hook', reasons: evidence.stability.reasons });
  }
  if (evidence?.status === 'single-scope' && evidence.plausibility?.status === 'contended') {
    add('gpu-timing-contended', 'warning',
      `GPU timing exceeds frame time in ${evidence.plausibility.implausibleSamples}/${timed} samples (other GPU work or overlap).`,
      { count: evidence.plausibility.implausibleSamples });
  }
  return report === undefined ? issues.filter(issue => issue.severity === 'invalid' && issue.code !== 'zero-gpu-duration') : issues;
}

function hookQuantized(values) {
  if (values.length < 2 || values.every(value => value === 0)) return false;
  return medianOf([...values].sort((a, b) => a - b)) < 1 && values.every(value => isMultiple(value, QUANTUM_MS));
}

function isMultiple(value, step) {
  return Math.abs(value - Math.round(value / step) * step) <= 1e-9;
}

function medianOf(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function cadenceOf(report) {
  const cadence = report?.inPage?.summary?.cadence ?? report?.summary?.cadence
    ?? report?.inPage?.samples?.find(sample => sample?.measurement?.observedFrames?.cadence)?.measurement.observedFrames.cadence;
  const hz = finiteOrNull(cadence?.hz);
  return { hz, intervalMs: finiteOrNull(cadence?.intervalMs) ?? (hz > 0 ? 1000 / hz : null) };
}

function sampleAutoGpuMs(sample) {
  const auto = sample?.autoGpu;
  if (!auto || sample.idle === true || !(auto.timedFrames > 0) || !Number.isFinite(auto.frameNs?.p50)) return null;
  return auto.frameNs.p50 / 1e6;
}

// The page's own frame time: rAF interval, or 1000/pageFps when the page renders
// on fewer than 90% of ticks (§5.1 fpsEff).
function sampleFrameIntervalMs(sample) {
  const activity = sample?.activity;
  if (Number.isFinite(activity?.activeFrameRatio) && activity.activeFrameRatio < 0.9 && activity.pageFps > 0) return 1000 / activity.pageFps;
  const frameTime = sample?.measurement?.observedFrames?.frameTimeMs;
  return finiteOrNull(frameTime?.p50 ?? frameTime?.mean);
}

function pooledFrameIntervalMs(report) {
  const summary = report?.inPage?.summary || {};
  const activity = summary.activity;
  const pageFps = activity?.pageFps?.p50 ?? activity?.pageFps?.mean ?? activity?.pageFps;
  if (Number.isFinite(activity?.activeFrameRatio) && activity.activeFrameRatio < 0.9 && pageFps > 0) return 1000 / pageFps;
  const deltas = Array.isArray(summary.frameDeltasMs) ? summary.frameDeltasMs.filter(Number.isFinite) : [];
  if (deltas.length) return medianOf([...deltas].sort((a, b) => a - b));
  const intervals = (report?.inPage?.samples || []).filter(sample => sample?.idle !== true).map(sampleFrameIntervalMs).filter(Number.isFinite);
  return intervals.length ? medianOf(intervals.sort((a, b) => a - b)) : null;
}
