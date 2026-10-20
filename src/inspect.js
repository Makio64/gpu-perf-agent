import { reportEnvironment, reportMetrics } from './compare.js';
import { pageErrorCounts, reportValidity } from './validity.js';

export const INSPECT_SECTIONS = Object.freeze(['overview', 'metrics', 'samples', 'errors', 'environment', 'instrumentation', 'trace', 'gpu', 'cpu']);
export const INSPECT_MAX_BYTES = 16 * 1024;

/** Validate selectors before reading an artifact. This API does not perform I/O. */
export function validateInspectOptions(options = {}) {
  object(options, 'Inspection options');
  for (const key of Object.keys(options)) {
    if (!['section', 'metric', 'offset', 'limit', 'runIndex', 'raw', 'changed'].includes(key)) {
      throw new TypeError(`Unknown inspection option: ${key}.`);
    }
  }
  const { section = 'overview', metric, offset = 0, limit = 3, runIndex, raw, changed } = options;
  if (!INSPECT_SECTIONS.includes(section)) throw new TypeError(`section must be one of ${INSPECT_SECTIONS.join(', ')}.`);
  integer(offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  integer(limit, 'limit', 1, 10);
  if (runIndex !== undefined) integer(runIndex, 'runIndex', 0, Number.MAX_SAFE_INTEGER);
  if (raw !== undefined && typeof raw !== 'boolean') throw new TypeError('raw must be a boolean.');
  if (changed !== undefined && typeof changed !== 'boolean') throw new TypeError('changed must be a boolean.');
  if (metric !== undefined) {
    if (typeof metric !== 'string' || !metric.trim() || metric.length > 1024) throw new TypeError('metric must be a non-empty exact key of at most 1024 characters.');
    if (section !== 'metrics') throw new TypeError('metric requires section "metrics".');
    if (offset !== 0) throw new TypeError('An exact metric selection requires offset 0.');
  }
  if (offset !== 0 && !['metrics', 'samples', 'errors'].includes(section)) throw new TypeError('offset requires metrics, samples, or errors.');
  return {
    section,
    ...(metric === undefined ? {} : { metric }),
    offset,
    limit,
    ...(runIndex === undefined ? {} : { runIndex }),
    ...(raw === undefined ? {} : { raw }),
    ...(changed === undefined ? {} : { changed })
  };
}

/** Inspect a parsed saved artifact. Parsing the artifact is the caller's responsibility. */
export function inspectReport(artifact, options = {}) {
  const selected = validateInspectOptions(options);
  object(artifact, 'Report');
  const runs = Array.isArray(artifact.runs) ? artifact.runs : null;
  let report = artifact;
  let path = '$';
  let run;
  if (selected.runIndex !== undefined) {
    if (!runs || selected.runIndex >= runs.length) throw new RangeError('runIndex does not select an existing A/B run.');
    run = runs[selected.runIndex];
    object(run?.report, 'Selected A/B run report');
    report = run.report;
    path = `runs[${selected.runIndex}].report`;
  }
  const comparison = Array.isArray(report.rows) ? report : Array.isArray(report.comparison?.rows) ? report.comparison : null;
  if (comparison && !['overview', 'metrics', 'environment'].includes(selected.section)) {
    throw new TypeError(`${selected.section} requires a capture report; select runIndex for an A/B artifact.`);
  }
  // An A/B artifact with no comparison must not masquerade as an empty capture.
  if (runs && selected.runIndex === undefined && !comparison) throw new TypeError('A/B artifact has no comparison; select runIndex.');

  const samples = Array.isArray(report.inPage?.samples) ? report.inPage.samples : null;
  const captureStatus = comparison ? null : captureValidity(report);
  const validity = comparison ? comparison.validity ?? null : captureStatus.validity;
  const result = {
    section: selected.section,
    source: { kind: runs ? 'ab' : comparison ? 'comparison' : 'capture', path, ...(selected.runIndex === undefined ? {} : { runIndex: selected.runIndex }) },
    selection: { ...selected, indices: [] },
    totals: { runs: runs?.length ?? null, samples: samples?.length ?? null, rows: comparison?.rows.length ?? null },
    validity: { valid: typeof validity?.valid === 'boolean' ? validity.valid : null, issueCount: Array.isArray(validity?.issues) ? validity.issues.length : null, ...captureStatus?.disagreement },
    ...(comparison ? { compatibility: {
      compatible: typeof comparison.compatibility?.compatible === 'boolean' ? comparison.compatibility.compatible : null,
      differenceCount: Array.isArray(comparison.compatibility?.differences) ? comparison.compatibility.differences.length : null,
      unverifiedKeyCount: Array.isArray(comparison.compatibility?.environment?.unverifiedKeys) ? comparison.compatibility.environment.unverifiedKeys.length : null,
    } } : {}),
    data: null,
    omissions: { items: 0, fields: 0, values: 0, strings: 0, stringCharacters: 0, sourceItems: 0 },
  };
  let data;

  if (selected.section === 'overview') {
    if (comparison) {
      const shownRuns = (runs || []).slice(0, selected.limit).map((entry, index) => ({ index, round: entry.round, sequence: entry.sequence, variant: entry.variant, durationMs: entry.durationMs, validity: entry.report?.diagnostics?.validity, verdict: entry.report?.summary?.verdict }));
      result.selection.indices = shownRuns.map(({ index }) => ({ source: 'runs', index }));
      result.omissions.items += (runs?.length || 0) - shownRuns.length;
      data = { summary: comparison.summary ?? null, validity, compatibility: comparison.compatibility ?? null, gpuTiming: comparison.gpuTiming ?? null, runs: runs ? shownRuns : null };
    } else {
      data = { validity, signal: report.diagnostics?.signal ?? null, summary: overviewSummary(report.summary), sampling: report.inPage?.sampling ?? report.inPage?.config ?? null, timings: report.timings ?? null, runError: report.runError ?? null };
    }
  } else if (selected.section === 'metrics') {
    const allRows = comparison ? comparison.rows : Object.entries(reportMetrics(report)).map(([key, value]) => ({ key, value }));
    const rows = selected.changed && comparison
      ? allRows.filter(row => row.status !== 'unchanged' && row.status !== 'pass')
      : allRows;
    result.totals.rows = rows.length;
    let indices;
    const isPrefix = typeof selected.metric === 'string' && selected.metric.endsWith('*');
    if (selected.metric === undefined) {
      indices = pageIndices(rows.length, selected);
    } else if (isPrefix) {
      const prefix = selected.metric.slice(0, -1);
      indices = rows.map((row, idx) => row.key.startsWith(prefix) ? idx : -1).filter(idx => idx !== -1).slice(0, selected.limit);
    } else {
      indices = [rows.findIndex(row => row.key === selected.metric)].filter(index => index !== -1);
    }
    result.selection.indices = indices.map(index => ({ source: comparison ? (report === comparison ? 'rows' : 'comparison.rows') : 'reportMetrics', index }));
    result.omissions.items += rows.length - indices.length;
    const projected = indices.map(index => comparison ? comparisonRow(rows[index]) : { ...rows[index], present: true });
    if (selected.metric !== undefined && !isPrefix && !indices.length) projected.push(comparison
      ? { key: selected.metric, present: false, basePresent: false, candidatePresent: false, base: null, candidate: null }
      : { key: selected.metric, present: false, value: null });
    data = { rows: projected, ...(comparison && selected.metric === 'health.gpuFrameMs.mean' ? { gpuTiming: comparison.gpuTiming ?? null } : {}) };
  } else if (selected.section === 'samples') {
    const effective = selected.raw ? { ...selected, limit: Math.min(selected.limit, 1) } : selected;
    const indices = pageIndices(samples?.length ?? 0, effective);
    result.selection.indices = indices.map(index => ({ source: 'inPage.samples', index }));
    result.omissions.items += (samples?.length || 0) - indices.length;
    if (samples === null) {
      data = { present: false, samples: null };
    } else {
      const selectedSamples = indices.map(index => selected.raw ? samples[index] : slimSample(samples[index]));
      const table = {
        cols: ['i', 'ms', 'fps', 'frameMs', 'p95', 'gpuMs', 'heapKiB', 'draws', 'submits', 'err'],
        rows: indices.map(index => sampleTableRow(samples[index], index))
      };
      data = { present: true, samples: selectedSamples, table };
    }
  } else if (selected.section === 'errors') {
    const errors = [];
    if (report.runError != null) errors.push({ source: 'runError', index: null, error: report.runError });
    let sampleErrorCount = null;
    if (samples) {
      sampleErrorCount = 0;
      samples.forEach((sample, index) => {
        if (sample?.error) { sampleErrorCount++; errors.push({ source: 'inPage.samples', index, error: sample.error }); }
      });
    }
    if (!sampleErrorCount && Array.isArray(report.diagnostics?.sampleErrors)) {
      sampleErrorCount = report.diagnostics.sampleErrors.length;
      report.diagnostics.sampleErrors.forEach((error, index) => errors.push({ source: 'diagnostics.sampleErrors', index, error }));
    }
    const fromPageEvents = Array.isArray(report.pageEvents);
    const events = fromPageEvents ? report.pageEvents : Array.isArray(report.diagnostics?.pageErrors) ? report.diagnostics.pageErrors : null;
    let retainedPageErrors = events ? 0 : null;
    events?.forEach((event, index) => {
      if (!fromPageEvents || isPageError(event)) {
        retainedPageErrors++;
        errors.push({ source: fromPageEvents ? 'pageEvents' : 'diagnostics.pageErrors', index, error: event });
      }
    });
    const instrumentation = report.inPage?.instrumentation?.after?.errors;
    const instrumentationErrors = Array.isArray(instrumentation) ? instrumentation : report.diagnostics?.instrumentation?.errors;
    if (Array.isArray(instrumentationErrors)) instrumentationErrors.forEach((error, index) => errors.push({ source: Array.isArray(instrumentation) ? 'inPage.instrumentation.after.errors' : 'diagnostics.instrumentation.errors', index, error }));
    let apiErrors = report.inPage?.apiSupport ? 0 : null;
    for (const api of ['webgpu', 'webgl', 'webgl2']) {
      const error = report.inPage?.apiSupport?.[api]?.error;
      if (error != null) { apiErrors++; errors.push({ source: `inPage.apiSupport.${api}.error`, index: null, error }); }
    }
    if (report.trace?.error != null) errors.push({ source: 'trace.error', index: null, error: report.trace.error });
    const pageEvents = pageEventTotals(report.pageEventSummary);
    const runtimeAndNetwork = runtimeNetworkCounts(events, fromPageEvents, pageEvents);
    result.totals.pageEvents = pageEvents;
    result.totals.errors = {
      run: report.runError == null ? 0 : 1, samples: sampleErrorCount, retainedPage: retainedPageErrors,
      instrumentation: Array.isArray(instrumentationErrors) ? instrumentationErrors.length : null,
      api: apiErrors, trace: report.trace == null ? null : report.trace.error == null ? 0 : 1,
      runtimeAndNetwork: runtimeAndNetwork.exact, retainedRuntimeAndNetwork: runtimeAndNetwork.retained,
      selectedSource: errors.length,
    };
    // Source loss is separate from pagination/copy omissions. Counts remain exact.
    result.omissions.sourceItems = pageEvents?.dropped ?? 0;
    const indices = pageIndices(errors.length, selected);
    result.selection.indices = indices.map(index => ({ source: errors[index].source, index: errors[index].index }));
    result.omissions.items += errors.length - indices.length;
    data = { errors: indices.map(index => errors[index]), validity };
  } else if (selected.section === 'environment') {
    const environment = comparison ? null : reportEnvironment(report);
    data = comparison
      ? { present: comparison.compatibility?.environment != null, environment: comparison.compatibility?.environment ?? null, differences: comparison.compatibility?.differences ?? null }
      : { present: Object.keys(environment).length > 0, environment, options: report.options ?? null, unverifiedKeys: report.environment?.unverifiedKeys ?? null };
  } else if (selected.section === 'instrumentation') {
    data = { present: report.inPage?.instrumentation != null || report.diagnostics?.instrumentation != null, instrumentation: report.inPage?.instrumentation ?? null, diagnostics: report.diagnostics?.instrumentation ?? null };
  } else if (selected.section === 'gpu') {
    const gpu = report.summary?.gpu ?? null;
    const autoGpu = report.inPage?.summary?.autoGpu ?? report.diagnostics?.signal?.autoGpu ?? null;
    const hookGpu = report.diagnostics?.signal?.gpuTiming ?? null;
    data = {
      present: gpu != null || autoGpu != null || hookGpu != null,
      gpu,
      autoGpu: slimStatsTree(autoGpu),
      hookGpu
    };
  } else if (selected.section === 'cpu') {
    const cpuProfile = report.cpuProfile ?? null;
    const cpuMsPerFrame = report.summary?.cpuMsPerFrame ?? null;
    const mainThreadBusy = report.summary?.mainThreadBusy ?? null;
    data = {
      present: cpuProfile != null || cpuMsPerFrame != null || mainThreadBusy != null,
      cpuMsPerFrame,
      mainThreadBusy,
      cpuProfile,
      cdpSamples: report.cdp?.samples ?? null
    };
  } else {
    data = { present: report.trace != null, trace: report.trace ?? null };
  }
  if (run) data.run = { index: selected.runIndex, round: run.round, sequence: run.sequence, variant: run.variant };

  // Bound copied evidence, not the input. Selectors, totals and omission counts are
  // outside this payload. Reserve room for counters growing during compaction.
  const state = { remaining: INSPECT_MAX_BYTES - Buffer.byteLength(JSON.stringify(result)) - 512, nodes: 256, omissions: result.omissions };
  result.data = boundedCopy(data, state);
  return result;
}

function roundNum(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function slimSample(sample) {
  if (!sample || typeof sample !== 'object') return sample;
  if (!('autoGpu' in sample) && !('memory' in sample) && !('instrumentation' in sample)) return sample;
  const { memory, instrumentation, autoGpu, ...rest } = sample;
  return {
    ...rest,
    ...(autoGpu ? { autoGpu: { gpuBusyMs: autoGpu.gpuBusyMs ?? null, timedFrames: autoGpu.timedFrames ?? null } } : {}),
    ...(memory?.delta ? { memoryDelta: memory.delta } : {}),
    ...(instrumentation?.delta ? { instrumentationDelta: instrumentation.delta } : {})
  };
}

function sampleTableRow(sample, idx) {
  const m = sample?.measurement || {};
  const obs = m.observedFrames || {};
  const inst = sample?.instrumentation?.delta || {};
  const fps = roundNum(obs.fps ?? m.fps?.mean ?? m.fps, 1);
  const frameMs = roundNum(obs.frameTimeMs?.mean ?? m.frameTimeMs?.mean ?? m.frameTimeMs, 2);
  const p95 = roundNum(obs.frameTimeMs?.p95 ?? m.frameTimeMs?.p95, 2);
  const gpuMs = roundNum(
    sample?.autoGpu?.gpuBusyMs ?? m.gpuMs ?? (Number.isFinite(m.gpuTimeNs) ? m.gpuTimeNs / 1e6 : null),
    3
  );
  const usedDelta = sample?.memory?.delta?.performanceMemory?.usedJSHeapSize;
  const heapKiB = roundNum(Number.isFinite(usedDelta) ? usedDelta / 1024 : null, 1);
  const draws = inst['webgpu.drawCalls'] ?? inst['webgl2.drawCalls'] ?? null;
  const submits = inst['webgpu.queueSubmits'] ?? null;
  return [
    sample?.index ?? idx,
    roundNum(sample?.elapsedMs, 1),
    fps,
    frameMs,
    p95,
    gpuMs,
    heapKiB,
    draws,
    submits,
    sample?.error ? 1 : 0
  ];
}

function slimStatsTree(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(slimStatsTree);
  if ('count' in value && 'mean' in value && 'p50' in value && ('min' in value || 'max' in value || 'stdev' in value)) {
    return {
      n: value.count,
      mean: roundNum(value.mean, 4),
      p50: roundNum(value.p50, 4),
      cv: roundNum(value.cv, 4),
      ci95: value.ci95 ?? null
    };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, slimStatsTree(v)]));
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}.`);
}

function pageIndices(total, { offset, limit }) {
  if (offset > total) throw new RangeError(`offset ${offset} exceeds the available item count ${total}.`);
  return Array.from({ length: Math.min(limit, total - offset) }, (_, index) => offset + index);
}

function comparisonRow(row) {
  const { key, base, candidate, present, basePresent, candidatePresent, ...evidence } = row;
  return { key, present: true, basePresent: Number.isFinite(base), candidatePresent: Number.isFinite(candidate), base: base ?? null, candidate: candidate ?? null, ...evidence };
}

function captureValidity(report) {
  const current = reportValidity(report);
  const saved = report.diagnostics?.validity;
  const savedValid = typeof saved?.valid === 'boolean' ? saved.valid : null;
  const issues = current.issues.slice();
  if (savedValid === false) {
    // Current checks have the freshest counts for the same issue codes. Retain
    // additional saved invalidity without duplicating those current issues.
    const currentCodes = new Set(issues.map(issue => issue.code).filter(Boolean));
    for (const issue of Array.isArray(saved.issues) ? saved.issues : []) {
      if (!issue?.code || !currentCodes.has(issue.code)) issues.push(issue);
    }
    if (!issues.length) issues.push({ code: 'saved-invalid', message: 'The saved capture is marked invalid.' });
  }
  if (report.runError != null && !issues.some(issue => issue?.code === 'run-failed')) issues.push({ code: 'run-failed', message: 'The capture contains a saved run error.' });
  const valid = current.valid && savedValid !== false && report.runError == null;
  return {
    validity: { valid, issues },
    disagreement: savedValid !== null && (savedValid !== current.valid || savedValid !== valid) ? { savedValid, currentValid: current.valid } : {},
  };
}

function runtimeNetworkCounts(events, fromPageEvents, summary) {
  const retained = events ? pageErrorCounts({ pageEvents: events }).total : null;
  const runtime = summary?.counts.pageerror;
  const network = summary?.counts.requestfailed;
  const http = summary?.counts.httpError ?? 0;
  const rendering = summary?.counts.renderingError ?? 0;
  const reported = runtime != null && network != null ? runtime + network + http + rendering : null;
  // A representative list gives only a lower bound. A complete source or both
  // category counters is needed to assert an exact total, including zero.
  const complete = fromPageEvents && summary?.dropped === 0 && summary.retained === events.length && summary.total === events.length;
  const exact = reported !== null && (retained === null || reported >= retained) ? reported : complete ? retained : null;
  return { exact, retained };
}

function isPageError(event) {
  return ['pageerror', 'requestfailed', 'httperror', 'console.error', 'console.assert'].includes(event?.type) || (event?.type === 'log.entry' && event.level === 'error');
}

function pageEventTotals(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const baseCategories = ['console', 'consoleError', 'pageerror', 'requestfailed', 'log', 'logError'];
  const extraCategories = ['httpError', 'renderingError'].filter(key => summary.counts && key in summary.counts);
  const categories = [...baseCategories, ...extraCategories];
  const result = {
    total: count(summary.total),
    retained: count(summary.retained),
    dropped: count(summary.dropped),
    truncated: count(summary.truncated),
    counts: Object.fromEntries(categories.map(key => [key, count(summary.counts?.[key])])),
  };
  if (summary.retainedCounts !== undefined) {
    result.retainedCounts = Object.fromEntries(baseCategories.map(key => [key, count(summary.retainedCounts?.[key])]));
  }
  return result;
}

function overviewSummary(summary) {
  if (!summary) return null;
  // Primary measurements precede potentially large prose/custom fields.
  const keys = ['verdict', 'fps', 'frameTimeMsMean', 'frameTimeMsP95', 'gpuFrameMsMean', 'sampleCount', 'observedFrameCount', 'slowFrameCount'];
  return Object.fromEntries([...keys.filter(key => Object.hasOwn(summary, key)).map(key => [key, summary[key]]), ...Object.entries(summary).filter(([key]) => !keys.includes(key))]);
}

function boundedCopy(value, state, depth = 0) {
  const omitted = reason => {
    const marker = { omitted: true, reason };
    state.omissions.values++;
    state.remaining -= Buffer.byteLength(JSON.stringify(marker));
    return marker;
  };
  if (depth > 6 || state.nodes-- <= 0) return omitted('depth-or-node-limit');
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    const scalar = value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value;
    state.remaining -= Buffer.byteLength(JSON.stringify(scalar));
    return scalar;
  }
  if (typeof value === 'string') {
    const max = Math.min(1024, Math.max(16, state.remaining - 128));
    let text = value;
    if (Buffer.byteLength(JSON.stringify(text)) > max) {
      let low = 0, high = Math.min(value.length, max);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(`${value.slice(0, middle)}…`)) <= max) low = middle;
        else high = middle - 1;
      }
      text = `${value.slice(0, low)}…`;
      state.omissions.strings++;
      state.omissions.stringCharacters += value.length - low;
    }
    state.remaining -= Buffer.byteLength(JSON.stringify(text));
    return text;
  }
  if (Array.isArray(value)) {
    const out = [];
    state.remaining -= 2;
    for (let index = 0; index < Math.min(value.length, 10) && state.remaining >= 128; index++) {
      state.remaining--;
      out.push(boundedCopy(value[index], state, depth + 1));
    }
    state.omissions.items += value.length - out.length;
    return out;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    const out = [];
    state.remaining -= 2;
    for (let index = 0; index < entries.length; index++) {
      const [key, item] = entries[index];
      const cost = Buffer.byteLength(JSON.stringify(key)) + 2;
      // Never shorten object keys: shortening can collide with another key.
      if (cost > 512) { state.omissions.fields++; state.omissions.strings++; state.omissions.stringCharacters += key.length; continue; }
      if (out.length >= 32 || state.remaining < cost + 128) { state.omissions.fields += entries.length - index; break; }
      state.remaining -= cost;
      out.push([key, boundedCopy(item, state, depth + 1)]);
    }
    return Object.fromEntries(out);
  }
  return omitted('unsupported-value');
}
