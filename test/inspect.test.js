import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectReport, validateInspectOptions, INSPECT_MAX_BYTES, INSPECT_SECTIONS } from '../src/inspect.js';
import { compareReports, reportEnvironment, reportMetrics } from '../src/compare.js';
import { runABComparison } from '../src/ab-runner.js';

function capture() {
  return {
    options: { samples: 5, samplingMode: 'hook', api: 'webgpu' },
    summary: { fps: null, gpuFrameMsMean: 0, sampleCount: 5 },
    diagnostics: { validity: { valid: true, issues: [] }, signal: { sampleCount: 5, gpuTimingSamples: 5 } },
    inPage: {
      hook: { found: true },
      samples: Array.from({ length: 5 }, (_, index) => ({ index: index + 10, elapsedMs: index, measurement: { gpuMs: 0, customBatch: { pixels: index * 16 } } })),
      summary: { gpuTimeNs: { mean: 0 }, sampleCount: 5 },
      instrumentation: { before: { bytes: 0 }, after: { bytes: 12 }, delta: { bytes: 12 } },
    },
    browser: { version: { product: 'Chrome/1' } },
    trace: { captured: true, summary: { durationMs: 0, gpu: { eventCount: 0 } } },
  };
}

function comparison() {
  return {
    summary: { total: 4, regressions: 0, improved: 1, inconclusive: 1, passed: 1, missing: 1 },
    validity: { valid: false, issues: [{ code: 'missing-metric' }] },
    compatibility: { compatible: true, differences: [], environment: { checkedKeys: ['host.platform'], unverifiedKeys: ['browser.version.product'] } },
    rows: [
      { key: 'health.gpuFrameMs.mean', base: 0, candidate: 0, status: 'pass', evidence: 'independent-samples', confidence95: { low: 0, high: 0 } },
      { key: 'custom.batch.mean', base: 10, candidate: 5, status: 'improved', evidence: 'paired-samples', confidence95: { low: -6, high: -4 } },
      { key: 'custom.noise.mean', base: 10, candidate: 9, status: 'inconclusive' },
      { key: 'custom.missing.mean', base: 0, candidate: null, status: 'missing' },
    ],
  };
}

test('inspection validates options independently of report I/O', () => {
  assert.deepEqual(validateInspectOptions(), { section: 'overview', offset: 0, limit: 3 });
  assert.deepEqual(validateInspectOptions({ section: 'samples', offset: 2, limit: 10, runIndex: 0 }), { section: 'samples', offset: 2, limit: 10, runIndex: 0 });
  for (const options of [null, [], 4, { section: 'arbitrary.path' }, { limit: 0 }, { limit: 11 }, { offset: -1 }, { offset: 0.2 }, { offset: '1' }, { runIndex: -1 }, { runIndex: Infinity }, { metric: 'health.gpuFrameMs.mean' }, { section: 'metrics', metric: '' }, { section: 'metrics', metric: 'x'.repeat(1025) }, { section: 'metrics', metric: 'x', offset: 1 }, { section: 'trace', offset: 1 }, { unknown: true }]) {
    assert.throws(() => validateInspectOptions(options), TypeError, JSON.stringify(options));
  }
  for (const value of [null, 0, false, 'report', []]) assert.throws(() => inspectReport(value), /Report must be an object/);
});

test('metric keys match comparison extraction and distinguish zero from missing', () => {
  const report = capture();
  const expected = reportMetrics(report);
  const custom = inspectReport(report, { section: 'metrics', metric: 'custom.customBatch.pixels.mean' });
  assert.deepEqual(custom.data.rows, [{ key: 'custom.customBatch.pixels.mean', value: expected['custom.customBatch.pixels.mean'], present: true }]);
  const zero = inspectReport(report, { section: 'metrics', metric: 'health.gpuFrameMs.mean' });
  assert.deepEqual(zero.data.rows, [{ key: 'health.gpuFrameMs.mean', value: 0, present: true }]);
  const missing = inspectReport(report, { section: 'metrics', metric: 'health.no-such-metric.mean' });
  assert.deepEqual(missing.data.rows, [{ key: 'health.no-such-metric.mean', value: null, present: false }]);
  assert.equal(missing.totals.rows, Object.keys(expected).length);
  assert.deepEqual(missing.selection.indices, []);
  assert.equal(missing.omissions.items, Object.keys(expected).length);
});

test('metric and sample pages disclose total counts and original array indices', () => {
  const report = capture();
  const samples = inspectReport(report, { section: 'samples', offset: 2, limit: 2 });
  assert.equal(samples.totals.samples, 5);
  assert.deepEqual(samples.selection.indices, [{ source: 'inPage.samples', index: 2 }, { source: 'inPage.samples', index: 3 }]);
  assert.deepEqual(samples.data.samples.map(sample => sample.index), [12, 13]);
  assert.equal(samples.omissions.items, 3);
  assert.equal(samples.data.samples[0].measurement.gpuMs, 0);
  const metrics = inspectReport(report, { section: 'metrics', offset: 1, limit: 2 });
  assert.deepEqual(metrics.selection.indices.map(entry => entry.index), [1, 2]);
  assert.equal(metrics.data.rows.length, 2);
  assert.equal(metrics.omissions.items, metrics.totals.rows - 2);
  assert.equal(inspectReport(report, { section: 'samples', offset: 5 }).data.samples.length, 0);
  assert.throws(() => inspectReport(report, { section: 'samples', offset: 6 }), RangeError);
});

test('comparison artifacts expose the actual selected row and its uncertainty', () => {
  const report = comparison();
  const result = inspectReport(report, { section: 'metrics', metric: 'custom.batch.mean' });
  assert.equal(result.source.kind, 'comparison');
  assert.equal(result.validity.valid, false);
  assert.equal(result.totals.rows, 4);
  assert.deepEqual(result.selection.indices, [{ source: 'rows', index: 1 }]);
  assert.deepEqual(result.data.rows[0].confidence95, { low: -6, high: -4 });
  assert.equal(result.data.rows[0].evidence, 'paired-samples');
  assert.equal(result.data.rows[0].present, true);
  const missingSide = inspectReport(report, { section: 'metrics', metric: 'custom.missing.mean' }).data.rows[0];
  assert.equal(missingSide.present, true);
  assert.equal(missingSide.basePresent, true);
  assert.equal(missingSide.candidatePresent, false);
  assert.equal(missingSide.base, 0);
  const absent = inspectReport(report, { section: 'metrics', metric: 'absent' }).data.rows[0];
  assert.deepEqual(absent, { key: 'absent', present: false, basePresent: false, candidatePresent: false, base: null, candidate: null });
  assert.equal(inspectReport(report, { section: 'environment' }).data.environment.unverifiedKeys[0], 'browser.version.product');
  assert.throws(() => inspectReport(report, { section: 'errors' }), /requires a capture report/);
});

test('exact comparison metrics retain compatibility and missing metadata stays unknown', () => {
  const report = comparison();
  report.compatibility.compatible = false;
  report.compatibility.differences = [{ key: 'samplingMode', base: 'frames', candidate: 'hook' }];
  const view = inspectReport(report, { section: 'metrics', metric: 'custom.batch.mean' });
  assert.deepEqual(view.compatibility, { compatible: false, differenceCount: 1, unverifiedKeyCount: 1 });
  assert.equal(view.data.rows[0].status, 'improved');
  assert.deepEqual(inspectReport({ rows: [] }, { section: 'metrics' }).compatibility, { compatible: null, differenceCount: null, unverifiedKeyCount: null });
  assert.equal(inspectReport({ rows: [] }).validity.valid, null);
});

test('A/B overview is bounded and runIndex selects exactly one raw capture', () => {
  const artifact = { comparison: comparison(), runs: Array.from({ length: 6 }, (_, index) => ({ round: Math.floor(index / 2), sequence: index, variant: index % 2 ? 'candidate' : 'base', report: capture() })) };
  const overview = inspectReport(artifact);
  assert.equal(overview.totals.runs, 6);
  assert.equal(overview.totals.samples, null);
  assert.equal(overview.data.runs.length, 3);
  assert.equal(overview.omissions.items, 3);
  assert.deepEqual(overview.selection.indices, [0, 1, 2].map(index => ({ source: 'runs', index })));
  const selected = inspectReport(artifact, { runIndex: 3, section: 'samples', offset: 1, limit: 1 });
  assert.equal(selected.source.path, 'runs[3].report');
  assert.equal(selected.source.runIndex, 3);
  assert.equal(selected.totals.samples, 5);
  assert.deepEqual(selected.data.run, { index: 3, round: 1, sequence: 3, variant: 'candidate' });
  assert.equal(selected.data.samples[0].index, 11);
  for (const section of ['samples', 'errors', 'instrumentation', 'trace']) assert.throws(() => inspectReport(artifact, { section }), /select runIndex/);
  assert.throws(() => inspectReport(artifact, { runIndex: 6 }), /existing A\/B run/);
  assert.throws(() => inspectReport(capture(), { runIndex: 0 }), /existing A\/B run/);
  assert.throws(() => inspectReport({ runs: [{ report: null }] }, { runIndex: 0 }), /Selected A\/B run report/);
});

test('health metric inspection explains withheld GPU timing evidence', () => {
  const artifact = comparison();
  artifact.rows = artifact.rows.filter(row => row.key !== 'health.gpuFrameMs.mean');
  artifact.gpuTiming = {
    base: { schemaVersion: 1, status: 'ambiguous', scope: null, timingCount: 9, reasons: ['multiple-timings'] },
    candidate: { schemaVersion: 1, status: 'ambiguous', scope: null, timingCount: 9, reasons: ['multiple-timings'] }
  };
  const result = inspectReport(artifact, { section: 'metrics', metric: 'health.gpuFrameMs.mean' });
  assert.equal(result.data.rows[0].present, false);
  assert.deepEqual(result.data.gpuTiming, artifact.gpuTiming);
  assert.deepEqual(inspectReport(artifact).data.gpuTiming, artifact.gpuTiming);
  delete artifact.gpuTiming;
  assert.equal(inspectReport(artifact, { section: 'metrics', metric: 'health.gpuFrameMs.mean' }).data.gpuTiming, null);
});

test('errors retain failure stubs, sample origins and exact source event counters', () => {
  const report = capture();
  report.runError = { code: 'LOAD_FAILED', message: 'Navigation failed' };
  report.inPage.samples[2].error = { message: 'oracle failed' };
  report.pageEvents = [{ type: 'console.log', text: 'hello' }, { type: 'pageerror', error: { message: 'crash' } }, { type: 'console.error', text: 'bad' }, { type: 'requestfailed', failure: 'offline' }];
  report.pageEventSummary = { total: 100, retained: 4, dropped: 96, truncated: 2, counts: { console: 1, consoleError: 20, pageerror: 30, requestfailed: 40, log: 8, logError: 1 }, retainedCounts: { console: 1, consoleError: 1, pageerror: 1, requestfailed: 1, log: 0, logError: 0 } };
  const result = inspectReport(report, { section: 'errors' });
  assert.deepEqual(result.selection.indices, [{ source: 'runError', index: null }, { source: 'inPage.samples', index: 2 }, { source: 'pageEvents', index: 1 }]);
  assert.equal(result.data.errors[0].error.code, 'LOAD_FAILED');
  assert.equal(result.data.errors[1].error.message, 'oracle failed');
  assert.deepEqual(result.totals.pageEvents, report.pageEventSummary);
  assert.equal(result.totals.errors.runtimeAndNetwork, 70);
  assert.equal(result.totals.errors.retainedPage, 3);
  assert.equal(result.totals.errors.samples, 1);
  assert.equal(result.omissions.items, 2);
  assert.equal(result.omissions.sourceItems, 96);
  const second = inspectReport(report, { section: 'errors', offset: 3 });
  assert.deepEqual(second.selection.indices.map(entry => entry.index), [2, 3]);
});

test('failure-only artifacts and missing optional evidence do not turn into measured zero', () => {
  const failure = { runError: { message: 'Chrome launch failed' }, diagnostics: { validity: { valid: false, issues: [{ code: 'run-failed' }] } } };
  const result = inspectReport(failure, { section: 'errors' });
  assert.equal(result.validity.valid, false);
  assert.equal(result.totals.samples, null);
  assert.equal(result.totals.pageEvents, null);
  assert.equal(result.totals.errors.samples, null);
  assert.equal(result.totals.errors.runtimeAndNetwork, null);
  assert.equal(result.data.errors[0].error.message, 'Chrome launch failed');
  assert.deepEqual(inspectReport(failure, { section: 'samples' }).data, { present: false, samples: null });
  assert.deepEqual(inspectReport(failure, { section: 'trace' }).data, { present: false, trace: null });
  assert.equal(inspectReport(failure, { section: 'instrumentation' }).data.present, false);
  assert.equal(inspectReport(failure, { section: 'environment' }).data.present, false);
  assert.equal(inspectReport({ diagnostics: { sampleErrors: [{ index: 10, message: 'hook failed' }] } }, { section: 'errors' }).data.errors[0].source, 'diagnostics.sampleErrors');
});

test('legacy diagnostic-only errors remain visible even when raw samples are empty', () => {
  const report = { inPage: { samples: [] }, diagnostics: { sampleErrors: [{ index: 10, message: 'hook failed' }], pageErrors: [{ message: 'legacy runtime failure' }] } };
  const result = inspectReport(report, { section: 'errors' });
  assert.equal(result.totals.errors.samples, 1);
  assert.equal(result.totals.errors.retainedPage, 1);
  assert.deepEqual(result.selection.indices, [{ source: 'diagnostics.sampleErrors', index: 0 }, { source: 'diagnostics.pageErrors', index: 0 }]);
  assert.equal(result.data.errors[1].error.message, 'legacy runtime failure');
});

test('fresh capture failures override stale saved validity without hiding the discrepancy', () => {
  const report = {
    inPage: { samples: [{ measurement: { gpuMs: 1 }, error: { message: 'failed' } }] },
    diagnostics: { validity: { valid: true, issues: [] } },
    pageEventSummary: { counts: { pageerror: 2 } },
  };
  const result = inspectReport(report, { section: 'errors' });
  assert.equal(result.validity.valid, false);
  assert.equal(result.validity.savedValid, true);
  assert.equal(result.validity.currentValid, false);
  assert.ok(result.data.validity.issues.some(issue => issue.code === 'sample-errors'));
  assert.ok(result.data.validity.issues.some(issue => issue.code === 'runtime-errors'));
  const savedInvalid = capture();
  for (const sample of savedInvalid.inPage.samples) sample.measurement.gpuMs = 0.5; // all-zero GPU timings are invalid (§3.1)
  savedInvalid.diagnostics.validity = { valid: false, issues: [{ code: 'saved-oracle-failure' }] };
  assert.equal(inspectReport(savedInvalid).validity.valid, false);
  assert.equal(inspectReport(savedInvalid).validity.currentValid, true);
  const runFailed = capture();
  runFailed.runError = { message: 'runner failed after sampling' };
  assert.equal(inspectReport(runFailed).validity.valid, false);
  assert.equal(inspectReport(runFailed).validity.savedValid, true);
});

test('unknown error totals stay null while explicit complete zero counters stay zero', () => {
  const partial = inspectReport({ pageEventSummary: { total: 10, counts: { console: 10 } } }, { section: 'errors' });
  assert.equal(partial.totals.errors.runtimeAndNetwork, null);
  assert.equal(partial.totals.errors.retainedRuntimeAndNetwork, null);
  const representative = inspectReport({ pageEvents: [{ type: 'pageerror' }] }, { section: 'errors' });
  assert.equal(representative.totals.errors.runtimeAndNetwork, null);
  assert.equal(representative.totals.errors.retainedRuntimeAndNetwork, 1);
  const counted = inspectReport({ pageEventSummary: { counts: { pageerror: 0, requestfailed: 0 } } }, { section: 'errors' });
  assert.equal(counted.totals.errors.runtimeAndNetwork, 0);
  const complete = inspectReport({ pageEvents: [], pageEventSummary: { total: 0, retained: 0, dropped: 0 } }, { section: 'errors' });
  assert.equal(complete.totals.errors.runtimeAndNetwork, 0);
});

test('API, instrumentation and trace errors preserve details and source paths', () => {
  const report = {
    options: { samples: 1, trace: true, autoInstrument: true, api: 'webgpu' },
    inPage: {
      samples: [{ measurement: { gpuMs: 1 } }],
      instrumentation: { after: { errors: [{ message: 'instrumentation hook failed' }] } },
      apiSupport: { webgpu: { available: false, error: { message: 'adapter lost' } } },
    },
    diagnostics: { instrumentation: { errors: [{ message: 'duplicate instrumentation hook failure' }] } },
    trace: { captured: false, error: { message: 'CDP tracing failed' } },
  };
  const view = inspectReport(report, { section: 'errors' });
  assert.equal(view.validity.valid, false);
  assert.deepEqual(view.selection.indices.map(entry => entry.source), ['inPage.instrumentation.after.errors', 'inPage.apiSupport.webgpu.error', 'trace.error']);
  assert.deepEqual(view.data.errors.map(entry => entry.error.message), ['instrumentation hook failed', 'adapter lost', 'CDP tracing failed']);
  assert.equal(view.totals.errors.selectedSource, 3);
});

test('environment projection matches real comparison and capture APIs', () => {
  const baseline = capture();
  baseline.host = { platform: 'darwin', arch: 'arm64', cpus: ['Apple M3'], totalmem: 0 };
  baseline.options.chromiumArgs = ['--remote-debugging-port=9222', '--disable-gpu-vsync'];
  baseline.inPage.apiSupport = { webgpu: { adapter: { vendor: 'apple', isFallbackAdapter: false } } };
  const candidate = structuredClone(baseline);
  candidate.browser.version.product = 'Chrome/2';
  const result = compareReports(baseline, candidate);
  const inspected = inspectReport(result, { section: 'environment' });
  assert.deepEqual(inspected.data.environment.checkedKeys, result.compatibility.environment.checkedKeys.slice(0, 10));
  assert.deepEqual(inspected.data.environment.unverifiedKeys, result.compatibility.environment.unverifiedKeys.slice(0, 10));
  assert.deepEqual(inspected.data.differences, result.compatibility.differences);
  assert.equal(inspected.validity.valid, result.validity.valid);
  const raw = inspectReport(baseline, { section: 'environment' });
  assert.deepEqual(raw.data.environment, reportEnvironment(baseline));
  assert.equal(raw.data.environment['host.totalmem'], 0);
  assert.equal(raw.data.environment['inPage.apiSupport.webgpu.adapter.isFallbackAdapter'], false);
  assert.ok(inspected.omissions.items > 0);
});

test('instrumentation and trace preserve zeros and unavailable fields', () => {
  const report = capture();
  const instrumentation = inspectReport(report, { section: 'instrumentation' });
  assert.equal(instrumentation.data.present, true);
  assert.equal(instrumentation.data.instrumentation.before.bytes, 0);
  assert.equal(instrumentation.data.diagnostics, null);
  const trace = inspectReport(report, { section: 'trace' });
  assert.equal(trace.data.present, true);
  assert.equal(trace.data.trace.summary.gpu.eventCount, 0);
});

test('inspection never mutates inputs or lets truncated object keys collide', () => {
  const report = capture();
  report.inPage.samples[0].measurement = { regular: 0, ['x'.repeat(600)]: 42, ['x'.repeat(600) + 'other']: 43 };
  const before = structuredClone(report);
  const result = inspectReport(report, { section: 'samples', limit: 1 });
  assert.equal(result.data.samples[0].measurement.regular, 0);
  assert.equal(result.omissions.fields, 2);
  assert.equal(result.omissions.strings, 2);
  assert.deepEqual(report, before);
  result.data.samples[0].measurement.regular = 10;
  assert.equal(report.inPage.samples[0].measurement.regular, 0);
});

test('nested arrays and strings remain bounded and disclose omitted evidence', () => {
  const report = capture();
  report.inPage.samples = Array.from({ length: 20 }, (_, index) => ({ index, measurement: { gpuMs: 0, text: '\u0000🧪'.repeat(5000), rows: Array.from({ length: 50 }, () => ({ text: 'x'.repeat(5000), data: Array(100).fill(2) })) } }));
  const result = inspectReport(report, { section: 'samples', limit: 10 });
  assert.equal(result.totals.samples, 20);
  assert.equal(result.selection.indices.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= INSPECT_MAX_BYTES);
  assert.ok(result.omissions.strings > 0);
  assert.ok(result.omissions.stringCharacters > 0);
  assert.ok(result.omissions.items >= 10);
  assert.equal(result.data.samples[0].measurement.gpuMs, 0);
});

test('byte limit includes large selectors, multi-byte strings and escaped keys', () => {
  const metric = '\u0000'.repeat(1024);
  const report = comparison();
  report.rows.push({ key: metric, base: 0, candidate: 1, note: '😀\u0000'.repeat(10000), nested: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${'🧪'.repeat(80)}${index}`, 'a'.repeat(1000)])) });
  const result = inspectReport(report, { section: 'metrics', metric });
  assert.equal(result.selection.metric, metric);
  assert.equal(result.data.rows[0].base, 0);
  assert.equal(result.data.rows[0].basePresent, true);
  assert.equal(result.totals.rows, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= INSPECT_MAX_BYTES);
  assert.ok(result.omissions.strings > 0);
});

test('overview retains invalidity even when issue evidence needs clipping', () => {
  const report = capture();
  for (const sample of report.inPage.samples) sample.measurement.gpuMs = 0.5; // all-zero GPU timings are invalid (§3.1)
  report.diagnostics.validity = { valid: false, issues: Array.from({ length: 1000 }, () => ({ message: 'x'.repeat(10000), reasons: Array(100).fill({ why: 'x'.repeat(10000) }) })) };
  const result = inspectReport(report);
  assert.deepEqual(result.validity, { valid: false, issueCount: 1000, savedValid: false, currentValid: true });
  assert.ok(result.omissions.items > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= INSPECT_MAX_BYTES);
  assert.equal(INSPECT_SECTIONS.length, 10);
});

test('gpu and cpu sections, sample table projection, raw sample mode, and prefix/changed metrics', () => {
  const report = {
    summary: {
      cpuMsPerFrame: 1.4,
      mainThreadBusy: 0.12,
      gpu: { source: 'auto', frameMsP50: 4.2, passes: [{ key: 'render#0', exclusiveMs: 4.1 }] }
    },
    cpuProfile: { classification: 'mixed', top: [{ fn: 'step', kind: 'app', selfMsPerFrame: 0.8 }] },
    inPage: {
      samples: [
        { index: 0, elapsedMs: 250, autoGpu: { gpuBusyMs: 4.2, timedFrames: 15, passes: [{ key: 'render#0' }] }, measurement: { observedFrames: { fps: 60, frameTimeMs: { mean: 16.67, p95: 16.8 } } }, memory: { before: { a: 1 }, delta: { performanceMemory: { usedJSHeapSize: 2048 } } }, instrumentation: { delta: { 'webgpu.drawCalls': 100, 'webgpu.queueSubmits': 15 } } },
        { index: 1, elapsedMs: 251, autoGpu: { gpuBusyMs: 4.3, timedFrames: 15, passes: [{ key: 'render#0' }] }, measurement: { observedFrames: { fps: 60, frameTimeMs: { mean: 16.65, p95: 16.7 } } } }
      ],
      summary: { autoGpu: { pooled: { count: 30, mean: 4.25, p50: 4.2, min: 4.0, max: 4.5, stdev: 0.1, cv: 0.02 } } }
    },
    pageEventSummary: { total: 2, retained: 2, dropped: 0, truncated: 0, counts: { console: 0, consoleError: 0, pageerror: 1, requestfailed: 0, log: 0, logError: 0, httpError: 1, renderingError: 0 } }
  };

  const gpuView = inspectReport(report, { section: 'gpu' });
  assert.equal(gpuView.data.present, true);
  assert.equal(gpuView.data.gpu.frameMsP50, 4.2);
  assert.equal(gpuView.data.autoGpu.pooled.n, 30);

  const cpuView = inspectReport(report, { section: 'cpu' });
  assert.equal(cpuView.data.present, true);
  assert.equal(cpuView.data.cpuMsPerFrame, 1.4);
  assert.equal(cpuView.data.cpuProfile.top[0].fn, 'step');

  const samplesView = inspectReport(report, { section: 'samples', limit: 2 });
  assert.deepEqual(samplesView.data.table.cols, ['i', 'ms', 'fps', 'frameMs', 'p95', 'gpuMs', 'heapKiB', 'draws', 'submits', 'err']);
  assert.equal(samplesView.data.table.rows.length, 2);
  assert.equal(samplesView.data.samples[0].memory, undefined);

  const rawSample = inspectReport(report, { section: 'samples', offset: 0, raw: true });
  assert.equal(rawSample.data.samples.length, 1);
  assert.deepEqual(rawSample.data.samples[0].memory.before, { a: 1 });

  const errView = inspectReport(report, { section: 'errors' });
  assert.equal(errView.totals.pageEvents.retainedCounts, undefined);
  assert.equal(errView.totals.pageEvents.counts.httpError, 1);
  assert.equal(errView.totals.errors.runtimeAndNetwork, 2);

  const cmp = comparison();
  const changedMetrics = inspectReport(cmp, { section: 'metrics', changed: true });
  assert.ok(changedMetrics.data.rows.every(r => r.status !== 'pass' && r.status !== 'unchanged'));
  const prefixMetrics = inspectReport(cmp, { section: 'metrics', metric: 'custom.*' });
  assert.equal(prefixMetrics.data.rows.length, 3);
});

// One single-sample capture per A/B run; `custom.gpuMs.mean` is the explicit primary.
function abRound(gpuMs, fps) {
  return {
    inPage: { samples: [{ elapsedMs: 100, measurement: { fps, gpuMs } }], summary: { fps: { mean: fps } } },
    options: { durationMs: 100, runner: 'fast-cdp', samples: 1, viewport: '320x180', warmup: 1 },
    summary: { verdict: 'good', warnings: [] },
  };
}

// A real ab artifact, as saved: runABComparison on a stub harness, then a JSON round trip.
async function abArtifact(rounds) {
  const queue = { base: rounds.map(round => round.base), candidate: rounds.map(round => round.candidate) };
  const harness = {
    async run(options) { return abRound(...queue[options.url.endsWith('a.html') ? 'base' : 'candidate'].shift()); },
    async close() {},
  };
  const result = await runABComparison({ base: 'http://127.0.0.1:1/a.html', candidate: 'http://127.0.0.1:1/b.html', rounds: rounds.length,
    primaryMetric: 'custom.gpuMs.mean' }, { harness });
  return JSON.parse(JSON.stringify(result));
}

test('rounds section validates its selectors and defaults to a whole-A/B page', () => {
  assert.deepEqual(validateInspectOptions({ section: 'rounds' }), { section: 'rounds', offset: 0, limit: 10 });
  assert.deepEqual(validateInspectOptions({ section: 'rounds', metric: 'frame.fps.mean', offset: 2, limit: 4 }),
    { section: 'rounds', metric: 'frame.fps.mean', offset: 2, limit: 4 });
  assert.equal(validateInspectOptions({ section: 'metrics' }).limit, 3);
  assert.ok(INSPECT_SECTIONS.includes('rounds'));
  for (const [options, message] of [
    [{ section: 'rounds', runIndex: 0 }, /omit runIndex/],
    [{ section: 'rounds', metric: 'frame.*' }, /exact metric key, not a prefix/],
  ]) {
    assert.throws(() => validateInspectOptions(options), error => error instanceof TypeError && error.code === 'invalid-options' && message.test(error.message), JSON.stringify(options));
  }
  assert.throws(() => validateInspectOptions({ section: 'trace', metric: 'frame.fps.mean' }), /metric requires section "metrics" or "rounds"/);
  assert.throws(() => validateInspectOptions({ section: 'rounds', limit: 11 }), TypeError);
});

test('rounds section pairs each A/B round for the primary metric with sign count and median delta', async () => {
  // [gpuMs, fps] per side and round; base and candidate run in ABBA order.
  const artifact = await abArtifact([
    { base: [10, 60], candidate: [8, 61] },
    { base: [12, 59], candidate: [12.5, 58] },
    { base: [11, 60], candidate: [9, 60] },
    { base: [13, 58], candidate: [10, 59] },
  ]);
  const before = structuredClone(artifact);
  const view = inspectReport(artifact, { section: 'rounds' });
  assert.deepEqual(artifact, before);
  assert.equal(view.source.kind, 'ab');
  assert.equal(view.totals.rounds, 4);
  assert.equal(view.totals.runs, 8);
  assert.equal(view.omissions.items, 0);
  // ABBA: round 1 ran the candidate first, so its base is run 3 and its candidate run 2.
  assert.deepEqual(view.selection.indices, [
    { source: 'rounds', index: 0, runs: { base: 0, candidate: 1 } },
    { source: 'rounds', index: 1, runs: { base: 3, candidate: 2 } },
    { source: 'rounds', index: 2, runs: { base: 4, candidate: 5 } },
    { source: 'rounds', index: 3, runs: { base: 7, candidate: 6 } },
  ]);
  const { data } = view;
  assert.equal(data.metric, 'custom.gpuMs.mean');
  assert.equal(data.metric, artifact.comparison.primary.key);
  assert.equal(data.primary, true);
  assert.equal(data.present, true);
  assert.equal(data.unit, 'ms');
  assert.equal(data.direction, 'lower');
  assert.deepEqual(data.table.cols, ['round', 'base', 'candidate', 'delta', 'ratio']);
  assert.deepEqual(data.table.rows, [[0, 10, 8, -2, 0.8], [1, 12, 12.5, 0.5, 1.0417], [2, 11, 9, -2, 0.8182], [3, 13, 10, -3, 0.7692]]);
  assert.deepEqual(data.signs, { pairs: 4, candidateBetter: 3, candidateWorse: 1, tied: 0, text: 'candidate faster in 3 of 4 rounds' });
  assert.equal(data.medianDelta, -2);
  // Per-round values are the ones the paired comparison averaged.
  const row = artifact.comparison.rows.find(item => item.key === data.metric);
  const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
  assert.equal(mean(data.table.rows.map(cells => cells[1])), row.base);
  assert.equal(mean(data.table.rows.map(cells => cells[2])), row.candidate);
  assert.deepEqual(data.comparison, { base: row.base, candidate: row.candidate, delta: row.delta, deltaPercent: row.deltaPercent,
    status: row.status, evidence: 'paired-samples', confidence95: row.confidence95 });

  // A higher-is-better metric counts the candidate faster when it is higher; equal rounds are ties.
  const fps = inspectReport(artifact, { section: 'rounds', metric: 'frame.fps.mean' }).data;
  assert.equal(fps.primary, false);
  assert.equal(fps.direction, 'higher');
  assert.deepEqual(fps.table.rows.map(cells => cells[3]), [1, -1, 0, 1]);
  assert.deepEqual(fps.signs, { pairs: 4, candidateBetter: 2, candidateWorse: 1, tied: 1, text: 'candidate faster in 2 of 4 rounds' });
  assert.equal(fps.medianDelta, 0.5);
});

test('rounds pages stay bounded while the sign count and median cover every round', async () => {
  const artifact = await abArtifact(Array.from({ length: 13 }, (_, round) => ({ base: [10 + round, 60], candidate: [round % 3 ? 9 + round : 12 + round, 60] })));
  const first = inspectReport(artifact, { section: 'rounds' });
  assert.equal(first.totals.rounds, 13);
  assert.equal(first.data.table.rows.length, 10);
  assert.equal(first.omissions.items, 3);
  assert.deepEqual(first.data.signs, { pairs: 13, candidateBetter: 8, candidateWorse: 5, tied: 0, text: 'candidate faster in 8 of 13 rounds' });
  assert.equal(first.data.medianDelta, -1);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= INSPECT_MAX_BYTES);
  const last = inspectReport(artifact, { section: 'rounds', offset: 10, limit: 2 });
  assert.deepEqual(last.data.table.rows.map(cells => cells[0]), [10, 11]);
  assert.deepEqual(last.selection.indices.map(entry => entry.index), [10, 11]);
  assert.equal(last.omissions.items, 11);
  assert.deepEqual(last.data.signs, first.data.signs);
  assert.throws(() => inspectReport(artifact, { section: 'rounds', offset: 14 }), RangeError);
});

test('rounds section rejects non-A/B reports as invalid options and keeps unmeasured metrics distinct', async () => {
  for (const report of [capture(), comparison(), { runs: null, rows: [] }]) {
    assert.throws(() => inspectReport(report, { section: 'rounds' }),
      error => error instanceof TypeError && error.code === 'invalid-options' && /requires an A\/B artifact/.test(error.message));
  }
  const artifact = await abArtifact([{ base: [10, 60], candidate: [9, 60] }, { base: [11, 60], candidate: [10, 60] }]);
  const absent = inspectReport(artifact, { section: 'rounds', metric: 'custom.absent.mean' });
  assert.equal(absent.totals.rounds, 2);
  assert.deepEqual(absent.selection.indices, []);
  assert.equal(absent.omissions.items, 0);
  assert.deepEqual(absent.data, { metric: 'custom.absent.mean', primary: false, present: false, unit: null, direction: null,
    signs: { pairs: 0, candidateBetter: null, candidateWorse: null, tied: 0, text: null }, medianDelta: null, comparison: null,
    table: { cols: ['round', 'base', 'candidate', 'delta', 'ratio'], rows: [] } });

  // Without a comparison row the direction is unknown: deltas, but no better/worse verdict.
  // A non-time unit says "better", not "faster".
  const noPrimary = structuredClone(artifact);
  noPrimary.comparison.primary = null;
  noPrimary.comparison.rows = noPrimary.comparison.rows.filter(row => row.key !== 'custom.gpuMs.mean');
  assert.throws(() => inspectReport(noPrimary, { section: 'rounds' }), error => error.code === 'invalid-options' && /pass metric/.test(error.message));
  const unknown = inspectReport(noPrimary, { section: 'rounds', metric: 'custom.gpuMs.mean' }).data;
  assert.deepEqual(unknown.table.rows.map(cells => cells[3]), [-1, -1]);
  assert.deepEqual(unknown.signs, { pairs: 2, candidateBetter: null, candidateWorse: null, tied: 0, text: null });
  noPrimary.comparison.rows.push({ key: 'custom.gpuMs.mean', unit: 'count', direction: 'lower' });
  assert.equal(inspectReport(noPrimary, { section: 'rounds', metric: 'custom.gpuMs.mean' }).data.signs.text, 'candidate better in 2 of 2 rounds');
});
