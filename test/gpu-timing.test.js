import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeReport } from '../src/analysis.js';
import { aggregateReports } from '../src/ab-runner.js';
import { compareReports, reportMetrics, reportMetricSamples } from '../src/compare.js';
import { collectGpuTimingEvidence, gpuTimingMetadata } from '../src/gpu-timing.js';
import { comparisonExitCode } from '../src/output.js';
import { reportValidity } from '../src/validity.js';

const health = 'health.gpuFrameMs.mean';
const repeat = measurement => Array.from({ length: 3 }, () => structuredClone(measurement));
function capture(measurements) {
  return finalizeReport({ options: { samplingMode: 'hook', samples: measurements.length, durationMs: 1, warmup: 0 },
    inPage: { hook: { found: true }, config: { samplingMode: 'hook' },
      samples: measurements.map(measurement => ({ elapsedMs: 1, measurement })),
      summary: { sampleCount: measurements.length, observedFrameCount: 0 } } });
}

test('one stable scope keeps aliases, zero durations and missing sample positions', () => {
  const report = capture([{ frame: { gpuMs: 0 } }, {}, { frame: { gpuTimeNs: 4e6 } }]);
  assert.equal(report.summary.gpuFrameMsMean, 2);
  assert.deepEqual(reportMetricSamples(report)[health], [0, null, 4]);
  assert.deepEqual(report.diagnostics.signal.gpuTiming, { schemaVersion: 1, status: 'single-scope', scope: 'frame',
    sampleCount: 3, validSampleCount: 2, timingCount: 2, ambiguousSampleCount: 0, negativeTimingCount: 0, reasons: [] });
  const paired = compareReports(report, report, { paired: true });
  assert.ok(paired.validity.issues.some(issue => issue.code === 'unmatched-pairs' && issue.key === health));
});

test('empty and dotted keys preserve custom timing prefix scope semantics', () => {
  const report = capture([{ '': { '': { gpuMs: 0 } } }, { gpuTimeNs: 4e6 }, { '': { gpuDurationMs: 8 } }]);
  assert.equal(report.diagnostics.signal.gpuTiming.scope, '');
  assert.equal(report.summary.gpuFrameMsMean, 4);
  const nested = capture([{ frame: { gpuMs: 2 } }, { 'frame.gpuMs': 4 }, { '': { frame: { gpuTimeNs: 6e6 } } }]);
  assert.equal(nested.diagnostics.signal.gpuTiming.scope, 'frame');
  assert.equal(nested.summary.gpuFrameMsMean, 4);
});

test('adding per-pass timings cannot create a health gain from unchanged aggregate timing', () => {
  const base = capture(repeat({ gpuMs: 12 }));
  const candidate = capture(repeat({ gpuMs: 12, passes: [{ gpuMs: 2 }, { gpuMs: 2 }] }));
  const timing = candidate.diagnostics.signal.gpuTiming;
  assert.equal(candidate.summary.gpuFrameMsMean, null);
  assert.equal(candidate.summary.gpuFrameMsP95, null);
  assert.equal(candidate.diagnostics.signal.gpuTimingSamples, 0);
  assert.equal(timing.status, 'ambiguous');
  assert.equal(timing.timingCount, 9);
  assert.equal(timing.ambiguousSampleCount, 3);
  assert.deepEqual(timing.reasons, ['multiple-timings']);
  assert.ok(candidate.summary.warnings.some(warning => warning.code === 'ambiguous-gpu-timing'));
  const result = compareReports(base, candidate);
  assert.equal(result.rows.find(row => row.key === health)?.status, 'missing');
  assert.equal(result.rows.find(row => row.key === 'custom.gpuMs.mean').status, 'pass');
  assert.equal(result.rows.find(row => row.key === 'custom.passes.0.gpuMs.mean'), undefined); // new optional metric
  assert.equal(result.rows.some(row => row.key === health && row.status === 'improved'), false);
});

test('changing timing mixture preserves exact named metrics and invalidates pooled evidence', () => {
  const measurements = mainCount => Array.from({ length: 6 }, (_, index) => index < mainCount ? { main: { gpuMs: 10 } } : { shadow: { gpuMs: 1 } });
  const base = capture(measurements(5));
  const candidate = capture(measurements(1));
  assert.deepEqual(base.diagnostics.signal.gpuTiming.reasons, ['scope-change']);
  assert.equal(base.diagnostics.validity.valid, false);
  for (const [first, second] of [[base, candidate], [aggregateReports([base, base, base]), aggregateReports([candidate, candidate, candidate])]]) {
    const result = compareReports(first, second, { paired: true });
    assert.equal(result.rows.find(row => row.key === health), undefined);
    for (const key of ['custom.main.gpuMs.mean', 'custom.shadow.gpuMs.mean']) {
      assert.equal(result.rows.find(row => row.key === key).status, 'pass');
    }
    assert.equal(result.validity.valid, false);
    assert.equal(comparisonExitCode(result, { allowMismatch: true }), 2);
  }
});

test('raw legacy measurements override stale pooled summaries, samples and provenance', () => {
  const single = capture(repeat({ gpuMs: 12 }));
  single.summary.gpuFrameMsMean = 1;
  single.aggregateMetrics = { [health]: 2 };
  single.metricSamples = { [health]: [1, 1, 1] };
  assert.equal(reportMetrics(single)[health], 12);
  assert.deepEqual(reportMetricSamples(single)[health], [12, 12, 12]);
  const mixed = capture(repeat({ gpuMs: 12, pass: { gpuMs: 2 } }));
  mixed.summary.gpuFrameMsMean = 7;
  mixed.aggregateMetrics = { [health]: 7 };
  mixed.metricSamples = { [health]: [7, 7, 7] };
  mixed.diagnostics.signal.gpuTiming = single.diagnostics.signal.gpuTiming;
  assert.equal(reportMetrics(mixed)[health], undefined);
  assert.equal(reportMetricSamples(mixed)[health], undefined);
  assert.equal(compareReports(mixed, mixed).rows.find(row => row.key === health), undefined);
});

test('public reportMetrics remains a unary mapper and does not cache mutable reports', () => {
  const reports = [capture(repeat({ gpuMs: 0 })), capture(repeat({ gpuMs: 12 }))];
  assert.deepEqual(reports.map(reportMetrics), reports.map(report => reportMetrics(report)));
  assert.deepEqual(reportMetrics(reports[1], { schemaVersion: 1, status: 'unavailable', values: [] }), reportMetrics(reports[1]));
  reports[1].inPage.samples[0].measurement.pass = { gpuMs: 1 };
  assert.equal(reportMetrics(reports[1])[health], undefined);
});

test('stale null or nonfinite health scalars recompute consistently from raw observations', () => {
  for (const stale of [null, NaN, Infinity]) {
    const report = capture(repeat({ gpuMs: 0 }));
    report.summary.gpuFrameMsMean = stale;
    assert.equal(reportMetrics(report)[health], 0);
    assert.equal(compareReports(report, report).rows.find(row => row.key === health).base, 0);
  }
  const report = capture(repeat({ gpuMs: 0 }));
  delete report.summary.gpuFrameMsMean;
  assert.equal(reportMetrics(report)[health], undefined);
  assert.equal(compareReports(report, report).rows.find(row => row.key === health), undefined);
});

test('negative durations suppress every health sample, retain exact custom data and invalidate comparison', () => {
  const base = capture(repeat({ gpuMs: 12 }));
  const candidate = capture([{ gpuMs: 12 }, { gpuMs: -1 }, { gpuMs: 12 }]);
  assert.equal(candidate.summary.gpuFrameMsMean, null);
  assert.equal(candidate.summary.gpuFrameMsP95, null);
  assert.equal(candidate.diagnostics.signal.gpuTiming.status, 'invalid');
  assert.equal(candidate.diagnostics.signal.gpuTiming.negativeTimingCount, 1);
  assert.equal(candidate.diagnostics.validity.valid, false);
  assert.equal(reportMetricSamples(candidate)[health], undefined);
  assert.deepEqual(reportMetricSamples(candidate)['custom.gpuMs.mean'], [12, -1, 12]);
  const result = compareReports(base, candidate);
  assert.equal(comparisonExitCode(result, { allowMismatch: true }), 2);
  assert.equal(result.rows.find(row => row.key === health)?.status, 'missing');
});

test('stable scope aggregates preserve exact paired health confidence and counts', () => {
  const base = aggregateReports(Array.from({ length: 3 }, () => capture(repeat({ gpuMs: 10 }))));
  const candidate = aggregateReports(Array.from({ length: 3 }, () => capture(repeat({ gpuMs: 8 }))));
  assert.equal(base.gpuTiming.status, 'single-scope');
  assert.equal(base.gpuTiming.scope, '');
  assert.equal(base.gpuTiming.sampleCount, 9);
  assert.deepEqual(base.metricSamples[health], [10, 10, 10]);
  const result = compareReports(base, candidate, { paired: true });
  const row = result.rows.find(row => row.key === health);
  assert.equal(row.status, 'improved');
  assert.equal(row.evidence, 'paired-samples');
  assert.deepEqual(row.confidence95, { low: -2, high: -2, margin: 0, method: 'student-t' });
  assert.equal(result.gpuTiming.base.scope, '');
  assert.equal(result.validity.valid, true);
  assert.equal(result.compatibility.compatible, true);
  assert.equal(comparisonExitCode(result), 0);
});

test('different single scopes invalidate capture and aggregate comparisons even with allowMismatch', () => {
  const main = capture(repeat({ main: { gpuMs: 10 }, shadow: { valueMs: 8 } }));
  const shadow = capture(repeat({ main: { valueMs: 10 }, shadow: { gpuMs: 8 } }));
  for (const [base, candidate] of [[main, shadow], [aggregateReports([main, main, main]), aggregateReports([shadow, shadow, shadow])]]) {
    const result = compareReports(base, candidate, { paired: true });
    assert.equal(result.rows.find(row => row.key === health), undefined);
    assert.ok(result.validity.issues.some(issue => issue.code === 'gpu-timing-scope-mismatch'));
    assert.equal(result.compatibility.compatible, false);
    assert.equal(comparisonExitCode(result, { allowMismatch: true }), 2);
  }
  const drifted = aggregateReports([main, shadow, main]);
  assert.equal(drifted.gpuTiming.status, 'ambiguous');
  assert.equal(drifted.aggregateMetrics[health], undefined);
  assert.equal(drifted.metricSamples[health], undefined);
  assert.equal(reportValidity(drifted).valid, false);
  assert.ok(drifted.roundValidity[1].issues.some(issue => issue.code === 'gpu-timing-scope-drift'));
});

test('scope-less legacy aggregates cannot restore health scalar or confidence through metricSamples', () => {
  const legacy = { inPage: { samples: [] }, aggregateMetrics: { [health]: 10, 'custom.gpuMs.mean': 10 },
    metricSamples: { [health]: [10, 10, 10], 'custom.gpuMs.mean': [10, 10, 10] },
    roundValidity: [{ valid: true, issues: [] }, { valid: true, issues: [] }, { valid: true, issues: [] }] };
  assert.equal(reportMetrics(legacy)[health], undefined);
  assert.equal(reportMetricSamples(legacy)[health], undefined);
  const result = compareReports(legacy, legacy, { paired: true });
  assert.equal(result.rows.find(row => row.key === health), undefined);
  assert.equal(result.rows.find(row => row.key === 'custom.gpuMs.mean').evidence, 'paired-samples');
  assert.equal(result.gpuTiming.base.status, 'unverified');
  assert.deepEqual(result.gpuTiming.base.reasons, ['missing-provenance']);
});

test('persisted provenance has bounded reasons and excludes raw positional values', () => {
  const evidence = collectGpuTimingEvidence(capture(repeat({ frame: { gpuMs: 1 } })));
  assert.equal(Object.hasOwn(gpuTimingMetadata(evidence), 'values'), false);
  assert.equal(Object.hasOwn(gpuTimingMetadata(evidence), 'source'), false);
  const saved = { ...gpuTimingMetadata(evidence), reasons: ['unexpected', 'scope-change', 'scope-change'] };
  assert.deepEqual(collectGpuTimingEvidence({ gpuTiming: saved }).reasons, ['scope-change']);
});
