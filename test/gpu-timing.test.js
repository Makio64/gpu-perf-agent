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
  assert.deepEqual(report.diagnostics.signal.gpuTiming, { schemaVersion: 2, status: 'single-scope', scope: 'frame',
    sampleCount: 3, validSampleCount: 2, timingCount: 2, ambiguousSampleCount: 0, negativeTimingCount: 0, reasons: [],
    provenance: 'unknown', stability: { status: 'unknown', clockSensitive: null, reasons: [], cv: 1, ratio: null },
    plausibility: { status: 'ok', implausibleSamples: 0 }, zeroTimingCount: 1, quantized: false });
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
  // §4.2: a row present on one side only is unverified (missing-base/missing-candidate), never a decision.
  assert.deepEqual(result.rows.find(row => row.key === health)?.reasons, ['missing-candidate']);
  assert.equal(result.rows.find(row => row.key === health).status, 'unverified');
  // §4.1 dedupe: the base's gpuMs feeds the health row, so custom.gpuMs.mean exists on the candidate only.
  assert.deepEqual(result.rows.find(row => row.key === 'custom.gpuMs.mean').reasons, ['missing-base']);
  assert.equal(result.rows.find(row => row.key === 'custom.passes.0.gpuMs.mean').status, 'unverified');
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
      // Fewer than 4 matched pairs never gate (§4.2 paired rule).
      assert.deepEqual(result.rows.find(row => row.key === key).reasons, ['too-few-rounds']);
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
  assert.deepEqual(result.rows.find(row => row.key === health)?.reasons, ['missing-candidate']);
});

test('stable scope aggregates preserve exact paired health confidence and counts', () => {
  // Paired rows gate from 4 rounds (§4.2).
  const base = aggregateReports(Array.from({ length: 4 }, () => capture(repeat({ gpuMs: 10 }))));
  const candidate = aggregateReports(Array.from({ length: 4 }, () => capture(repeat({ gpuMs: 8 }))));
  assert.equal(base.gpuTiming.status, 'single-scope');
  assert.equal(base.gpuTiming.scope, '');
  assert.equal(base.gpuTiming.sampleCount, 12);
  assert.deepEqual(base.metricSamples[health], [10, 10, 10, 10]);
  const result = compareReports(base, candidate, { paired: true });
  const row = result.rows.find(row => row.key === health);
  assert.equal(row.status, 'improved');
  assert.equal(row.evidence, 'paired-samples');
  assert.deepEqual(row.confidence95, { low: -2, high: -2, method: 'paired-t' });
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

// ---- 2.2.0: provenance, stability, plausibility, auto evidence (§6.3)
import { readFileSync } from 'node:fs';
import { aggregateGpuTimingEvidence, collectAutoGpuEvidence, gpuTimingPlausibility, gpuTimingProvenance, gpuTimingStability,
  gpuTimingValidityIssues } from '../src/gpu-timing.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v3/${name}`, import.meta.url), 'utf8'));
const framesReport = (measurements, extra = {}) => ({ options: { samplingMode: 'frames', samples: measurements.length, ...extra },
  inPage: { summary: { cadence: { hz: 60, intervalMs: 16.67 } },
    samples: measurements.map(measurement => ({ measurement: { ...measurement,
      observedFrames: { type: 'raf', frameCount: 16, frameTimeMs: { mean: 16.67, p50: 16.7 }, cadence: { hz: 60, intervalMs: 16.67 } } } })) } });

test('stability flags the Desktop clock-scaling spread but not stable or sub-0.5 ms spreads', () => {
  const pooled = ({ count = 60, min, p50, p95 }) => ({ count, min, p50, p95 });
  assert.equal(gpuTimingStability({ pooled: pooled({ min: 26.1, p50: 27, p95: 30.1 }) }).status, 'stable');
  const downClocked = gpuTimingStability({ pooled: pooled({ min: 0.72, p50: 6.98, p95: 12.5 }) });
  assert.equal(downClocked.status, 'unstable');
  assert.deepEqual(downClocked.reasons, ['within-run-spread']);
  assert.equal(gpuTimingStability({ pooled: pooled({ min: 0.02, p50: 0.06, p95: 0.12 }) }).status, 'stable',
    'sub-0.5ms spreads are noise, not clock changes');
});

test('stability flags between-sample drift the pooled rule misses', () => {
  const drift = gpuTimingStability({ perSampleMs: [0.86, 1.49, 1.83], pooled: { count: 45, min: 0.8, p50: 1.49, p95: 1.9 } });
  assert.equal(drift.status, 'unstable');
  assert.deepEqual(drift.reasons, ['between-sample-drift']);
  assert.equal(drift.ratio, 1.83 / 0.86);
  assert.equal(gpuTimingStability({ perSampleMs: [0.12, 0.2, 0.25] }).status, 'unstable', 'sub-0.5 ms medians use an absolute 0.1 ms bound');
  assert.equal(gpuTimingStability({ perSampleMs: [0.12, 0.15, 0.2] }).status, 'stable');
});

test('a saturated 8.41-8.49 ms sample set is stable; light pages are clock-sensitive at 60 Hz', () => {
  const saturated = gpuTimingStability({ perSampleMs: [8.41, 8.45, 8.49, 8.43, 8.47, 8.44], pooled: { count: 88, min: 8.38, p50: 8.45, p95: 8.6 },
    cadenceIntervalMs: 16.67 });
  assert.equal(saturated.status, 'stable');
  assert.equal(saturated.clockSensitive, true, '8.6 ms < 0.6 x 16.67 ms');
  for (const value of [1.65, 6.5]) {
    assert.equal(gpuTimingStability({ perSampleMs: [value, value, value], cadenceIntervalMs: 16.67 }).clockSensitive, true);
  }
  assert.equal(gpuTimingStability({ perSampleMs: [13.9, 13.9, 13.9], cadenceIntervalMs: 16.67 }).clockSensitive, false);
  assert.equal(gpuTimingStability({ perSampleMs: [1, 1, 1] }).clockSensitive, null, 'unknown cadence');
});

test('stability is unknown with too little data and applies the hook dispersion rule only to hook values', () => {
  assert.deepEqual(gpuTimingStability({ perSampleMs: [1, 2] }), { status: 'unknown', clockSensitive: null, reasons: [], cv: 1 / 3, ratio: 2 });
  assert.equal(gpuTimingStability({ pooled: { count: 19, min: 1, p50: 5, p95: 9 } }).status, 'unknown');
  const values = [0.06, 0.07, 0.3, 0.065];
  assert.deepEqual(gpuTimingStability({ perSampleMs: values, kind: 'hook' }).reasons, ['between-sample-drift', 'high-dispersion']);
  assert.deepEqual(gpuTimingStability({ perSampleMs: values, kind: 'auto' }).reasons, ['between-sample-drift']);
});

test('auto stability marks 100 µs-quantized timings below 1 ms as unstable', () => {
  const quantized = gpuTimingStability({ perSampleMs: [0.1, 0.15, 0.1, 0.2], pooled: { count: 60, min: 0.1, max: 0.2, p50: 0.1, p95: 0.2 } });
  assert.deepEqual(quantized.reasons, ['quantized']);
  assert.equal(gpuTimingStability({ perSampleMs: [0.1031, 0.1042, 0.1012], pooled: { count: 60, min: 0.1, p50: 0.103, p95: 0.11 } }).status, 'stable');
  assert.equal(gpuTimingStability({ perSampleMs: [1.2, 1.2, 1.2], pooled: { count: 60, min: 1.1, max: 1.3, p50: 1.2, p95: 1.3 } }).status, 'stable',
    'quantization only matters below 1 ms');
});

test('provenance comes from the majority hook method, else the sampling mode', () => {
  const warm = framesReport(Array.from({ length: 3 }, () => ({ gpuTimeNs: 1.6e6, gpuTiming: { method: 'warm', passes: 24 } })));
  assert.equal(gpuTimingProvenance(warm), 'warm');
  assert.equal(collectGpuTimingEvidence(warm).provenance, 'warm');
  const fixed = framesReport([{ gpuMs: 1, gpuTiming: { method: 'fixed-work' } }, { gpuMs: 1, gpuTiming: { method: 'fixed-work' } }, { gpuMs: 1 }]);
  assert.equal(gpuTimingProvenance(fixed), 'fixed-work');
  const minority = framesReport([{ gpuMs: 1, gpuTiming: { method: 'warm' } }, { gpuMs: 1 }, { gpuMs: 1 }]);
  assert.equal(gpuTimingProvenance(minority), 'vsync-paced');
  assert.equal(gpuTimingProvenance({ options: { samplingMode: 'hook' }, inPage: { samples: [{ measurement: { gpuMs: 1 } }] } }), 'unknown');
  assert.equal(gpuTimingProvenance(fixture('report-hook-vsync.json')), 'vsync-paced');
  assert.equal(gpuTimingProvenance(fixture('report-hook-warm.json')), 'warm');
});

test('hook evidence v2 records zero timings, quantization, stability and plausibility', () => {
  const evidence = collectGpuTimingEvidence(framesReport([{ gpuMs: 0 }, { gpuMs: 0.1 }, { gpuMs: 0.2 }, { gpuMs: 0.1 }]));
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.zeroTimingCount, 1);
  assert.equal(evidence.quantized, true);
  assert.equal(collectGpuTimingEvidence(framesReport([{ gpuMs: 0.1012 }, { gpuMs: 0.2 }])).quantized, false);
  assert.equal(collectGpuTimingEvidence(framesReport([{ gpuMs: 0 }, { gpuMs: 0 }])).quantized, false, 'all-zero is zero-gpu-duration');
  const vsync = collectGpuTimingEvidence(fixture('report-hook-vsync.json'));
  assert.equal(vsync.stability.status, 'unstable');
  assert.ok(vsync.stability.reasons.includes('high-dispersion'));
  assert.equal(collectGpuTimingEvidence(fixture('report-hook-warm.json')).stability.status, 'stable');
});

test('idle samples are excluded from hook evidence', () => {
  const report = framesReport([{ gpuMs: 1 }, { gpuMs: 50 }, { gpuMs: 1 }]);
  report.inPage.samples[1].idle = true;
  const evidence = collectGpuTimingEvidence(report);
  assert.deepEqual(evidence.values, [1, null, 1]);
  assert.equal(evidence.validSampleCount, 2);
});

test('hook plausibility is contended when more than a third of samples exceed their frame time', () => {
  const report = framesReport([{ gpuMs: 26 }, { gpuMs: 3 }, { gpuMs: 30 }, { gpuMs: 18 }, { gpuMs: 3 }, { gpuMs: 3 }]);
  assert.deepEqual(gpuTimingPlausibility(report, collectGpuTimingEvidence(report)), { status: 'contended', implausibleSamples: 3 });
  const third = framesReport([{ gpuMs: 26 }, { gpuMs: 3 }, { gpuMs: 30 }, { gpuMs: 3 }, { gpuMs: 3 }, { gpuMs: 17.5 }]);
  assert.deepEqual(collectGpuTimingEvidence(third).plausibility, { status: 'ok', implausibleSamples: 2 }, 'exactly 1/3 is not more than 1/3; 17.5 <= 1.05 x 16.67');
  const hookMode = { options: { samplingMode: 'hook' }, inPage: { samples: [{ measurement: { gpuMs: 90 } }, { measurement: { gpuMs: 90 } }] } };
  assert.deepEqual(collectGpuTimingEvidence(hookMode).plausibility, { status: 'ok', implausibleSamples: 0 }, 'no frame time to compare');
});

test('auto evidence pools per-frame union timing and flags saturation', () => {
  const capture = collectAutoGpuEvidence(fixture('report-capture.json'));
  assert.equal(capture.status, 'ok');
  assert.equal(capture.provenance, 'auto.frame-busy');
  assert.equal(capture.perSampleMs.length, 6);
  assert.equal(capture.timedFrames, 88);
  assert.ok(Math.abs(capture.pooled.p50 - 8.41) < 0.05);
  assert.equal(capture.stability.status, 'stable');
  assert.deepEqual(capture.plausibility, { status: 'ok', implausibleSamples: 0 });
  assert.equal(capture.saturated, false);
  assert.equal(capture.passes[0].key, 'render#0');
  const saturated = collectAutoGpuEvidence(fixture('report-saturated.json'));
  assert.equal(saturated.saturated, true);
  assert.deepEqual(saturated.plausibility, { status: 'saturated', implausibleSamples: 6 });
  assert.equal(collectAutoGpuEvidence(fixture('report-clock-sensitive.json')).clockSensitive, true);
  assert.equal(collectAutoGpuEvidence(fixture('report-cdp-attached-zero.json')).stability.reasons[0], 'quantized');
  const blank = collectAutoGpuEvidence(fixture('report-blank.json'));
  assert.equal(blank.status, 'no-frames');
  assert.deepEqual(blank.perSampleMs, []);
  assert.equal(collectAutoGpuEvidence(fixture('report-hookmode.json')).status, 'unavailable');
  assert.equal(collectAutoGpuEvidence(fixture('report-v2.json')).status, 'unavailable');
});

test('auto evidence skips idle and untimed samples and uses the page frame time for saturation', () => {
  const report = fixture('report-capture.json');
  report.inPage.samples[0].idle = true;
  report.inPage.samples[1].autoGpu.timedFrames = 0;
  assert.equal(collectAutoGpuEvidence(report).perSampleMs.length, 4);
  // A page that renders every other tick has a 33 ms frame; 17 ms of GPU is not saturated there.
  const half = fixture('report-saturated.json');
  half.inPage.summary.activity = { pageFps: { p50: 30 }, activeFrameRatio: 0.5 };
  for (const sample of half.inPage.samples) sample.activity = { ...sample.activity, pageFps: 30, activeFrameRatio: 0.5 };
  assert.equal(collectAutoGpuEvidence(half).saturated, false);
});

// The saturated fixture (GPU 17.35 ms at a steady 60 fps) with every auto frame time scaled to a pooled p50 of `ms`.
const autoGpuAt = ms => {
  const report = fixture('report-saturated.json');
  const scale = ms * 1e6 / report.inPage.summary.autoGpu.frameNs.p50;
  const scaleNs = frameNs => { for (const key of ['p50', 'p95', 'mean', 'min', 'max']) frameNs[key] *= scale; };
  scaleNs(report.inPage.summary.autoGpu.frameNs);
  for (const sample of report.inPage.samples) scaleNs(sample.autoGpu.frameNs);
  return report;
};

test('auto plausibility is contended when the union far exceeds the frame interval while frames land on time', () => {
  // cyprus base2: GPU p50 26.5 ms at a steady 60 fps with 0 slow frames.
  const contended = collectAutoGpuEvidence(autoGpuAt(26.5));
  assert.deepEqual(contended.plausibility, { status: 'contended', implausibleSamples: 6 });
  assert.equal(contended.saturated, false);
  assert.equal(contended.stability.status, 'stable', 'stable timing is still contended');
  assert.deepEqual(gpuTimingMetadata(contended).plausibility, contended.plausibility);
  // Up to 1.2 x the interval a saturated union is latency (the fixture reads 1.04 x).
  assert.equal(collectAutoGpuEvidence(autoGpuAt(19.9)).plausibility.status, 'saturated');
  // Older reports without frame deltas: the pooled mean and the observer's slow count.
  const older = autoGpuAt(26.5);
  delete older.inPage.summary.frameDeltasMs;
  assert.equal(collectAutoGpuEvidence(older).plausibility.status, 'contended');
  older.inPage.summary.slowFrameCount = 3;
  assert.equal(collectAutoGpuEvidence(older).plausibility.status, 'saturated', '3/90 slow frames is more than 2%');
});

test('auto plausibility stays saturated when frames miss the interval (a GPU-bound page)', () => {
  // Every third frame misses vsync: the mean is 22 ms and a third of frames are slow.
  const late = autoGpuAt(26.5);
  late.inPage.summary.frameDeltasMs = late.inPage.summary.frameDeltasMs.map((value, index) => index % 3 ? value : 33.3);
  assert.deepEqual(collectAutoGpuEvidence(late).plausibility, { status: 'saturated', implausibleSamples: 6 });
  // Mean within 1.05 x the interval, but 3/90 frames slower than 1.5 x the interval.
  const hitches = autoGpuAt(26.5);
  hitches.inPage.summary.frameDeltasMs = hitches.inPage.summary.frameDeltasMs.map((value, index) => index < 3 ? 26 : value);
  assert.equal(collectAutoGpuEvidence(hitches).saturated, true);
  // A page that renders every other tick has a 33 ms frame: 36 ms of GPU is saturated there, not contended,
  // although the rAF ticks are on time.
  const half = autoGpuAt(36);
  half.inPage.summary.activity = { pageFps: { p50: 30 }, activeFrameRatio: 0.5 };
  for (const sample of half.inPage.samples) sample.activity = { ...sample.activity, pageFps: 30, activeFrameRatio: 0.5 };
  assert.equal(collectAutoGpuEvidence(half).plausibility.status, 'saturated');
});

test('signal metadata is bounded; saved v1 and v2 evidence round-trip', () => {
  const auto = gpuTimingMetadata(collectAutoGpuEvidence(fixture('report-capture.json')));
  assert.deepEqual(Object.keys(auto), ['status', 'source', 'frames', 'timedFrames', 'partialFrames', 'provenance', 'stability',
    'plausibility', 'saturated', 'clockSensitive']);
  const warm = gpuTimingMetadata(collectGpuTimingEvidence(fixture('report-hook-warm.json')));
  const restored = collectGpuTimingEvidence({ gpuTiming: warm });
  assert.equal(restored.source, 'saved');
  assert.equal(restored.provenance, 'warm');
  assert.deepEqual(restored.stability, warm.stability);
  const v1 = collectGpuTimingEvidence({ gpuTiming: { schemaVersion: 1, status: 'single-scope', scope: '', sampleCount: 3,
    validSampleCount: 3, timingCount: 3, ambiguousSampleCount: 0, negativeTimingCount: 0, reasons: [], provenance: 'warm' } });
  assert.equal(v1.status, 'single-scope');
  assert.equal(v1.provenance, 'unknown', 'v1 evidence predates provenance');
  assert.equal(v1.stability.status, 'unknown');
  const forged = collectGpuTimingEvidence({ gpuTiming: { ...warm, provenance: 'magic', stability: { status: 'great' } } });
  assert.equal(forged.provenance, 'unknown');
  assert.equal(forged.stability.status, 'unknown');
});

test('aggregated evidence keeps one provenance only when every round agrees', () => {
  const warm = collectGpuTimingEvidence(fixture('report-hook-warm.json'));
  const vsync = collectGpuTimingEvidence(fixture('report-hook-vsync.json'));
  const same = aggregateGpuTimingEvidence([warm, warm]);
  assert.equal(same.schemaVersion, 2);
  assert.equal(same.provenance, 'warm');
  const mixed = aggregateGpuTimingEvidence([warm, vsync]);
  assert.equal(mixed.provenance, 'unknown');
  assert.equal(mixed.stability.status, 'unstable');
});

test('GPU timing validity entries carry severity; legacy callers receive only invalid entries', () => {
  const zeros = framesReport([{ gpuMs: 0 }, { gpuMs: 0 }, { gpuMs: 0 }]);
  const evidence = collectGpuTimingEvidence(zeros);
  assert.deepEqual(gpuTimingValidityIssues(evidence, zeros).map(issue => [issue.code, issue.severity]), [['zero-gpu-duration', 'invalid']]);
  assert.deepEqual(gpuTimingValidityIssues(evidence), [], 'reportValidity reports zero-gpu-duration; legacy callers must not duplicate it');
  const negative = collectGpuTimingEvidence(framesReport([{ gpuMs: -1 }, { gpuMs: 1 }, { gpuMs: 1 }]));
  assert.deepEqual(gpuTimingValidityIssues(negative).map(issue => issue.code), ['invalid-gpu-timing']);
  const attached = framesReport([{ gpuMs: 0 }, { gpuMs: 0 }, { gpuMs: 0 }], { cdpAttached: true });
  const entry = gpuTimingValidityIssues(collectGpuTimingEvidence(attached), attached)[0];
  assert.equal(entry.severity, 'warning');
  assert.match(entry.message, /attached browser quantizes timestamps to 100 µs/);
  assert.deepEqual(gpuTimingValidityIssues(collectGpuTimingEvidence(attached)), [],
    'without the report, cdpAttached is unknown, so the legacy form cannot invalidate an attached capture');
  const vsync = fixture('report-hook-vsync.json');
  assert.deepEqual(gpuTimingValidityIssues(collectGpuTimingEvidence(vsync), vsync).map(issue => issue.code), ['gpu-timing-unstable']);
  assert.deepEqual(gpuTimingValidityIssues(collectGpuTimingEvidence(vsync)), []);
  const single = framesReport([{ gpuMs: 0 }]);
  assert.deepEqual(gpuTimingValidityIssues(collectGpuTimingEvidence(single), single), [], 'one zero is not evidence of a broken pass');
});
