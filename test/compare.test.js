import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, formatCompareTable, reportMetricSamples } from "../src/compare.js";

test("compareReports flags a statistically clear FPS regression", () => {
  const base = reportWithFps([60, 60, 60, 60]);
  const candidate = reportWithFps([50, 50, 50, 50]);
  const result = compareReports(base, candidate, { thresholdPercent: 5 });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].key, "frame.fps.mean");
  assert.equal(result.failures[0].confidence95.high, -10);
});

test("compareReports reports noisy changes as inconclusive", () => {
  const base = reportWithFps([60, 40, 60, 40]);
  const candidate = reportWithFps([50, 50, 50, 35]);
  const result = compareReports(base, candidate, { thresholdPercent: 1 });
  const fps = result.rows.find((row) => row.key === "frame.fps.mean");
  assert.equal(fps.status, "inconclusive");
  assert.equal(result.failures.length, 0);
});

test("compareReports surfaces mismatched profiling shapes", () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([60]);
  candidate.options.viewport = "1920x1080";
  const result = compareReports(base, candidate);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.differences, [{
    base: "1280x720",
    candidate: "1920x1080",
    key: "viewport"
  }]);
});

test("compareReports identifies resolved and introduced warnings", () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([60]);
  base.summary.warnings = [{ code: "heap-churn" }, { code: "frame-stutter" }];
  candidate.summary.warnings = [{ code: "frame-stutter" }, { code: "gpu-bound" }];
  const result = compareReports(base, candidate);
  assert.deepEqual(result.diagnostics.resolvedWarnings, [{ code: "heap-churn" }]);
  assert.deepEqual(result.diagnostics.introducedWarnings, [{ code: "gpu-bound" }]);
  assert.deepEqual(result.diagnostics.remainingWarnings, [{ code: "frame-stutter" }]);
});

test("reportMetricSamples extracts hook and observed-frame metrics", () => {
  const report = reportWithFps([60, 55]);
  const samples = reportMetricSamples(report);
  assert.deepEqual(samples["frame.fps.mean"], [60, 55]);
  assert.deepEqual(samples["custom.gpuMs.mean"], [4, 4]);
});

test("formatCompareTable includes confidence outcome and mismatch warning", () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([50]);
  candidate.options.durationMs = 2000;
  const output = formatCompareTable(compareReports(base, candidate));
  assert.match(output, /regressions/);
  assert.match(output, /profiling option\(s\) differ/);
});

function reportWithFps(values) {
  return {
    inPage: {
      samples: values.map((fps, index) => ({
        elapsedMs: 1000,
        index,
        measurement: { fps, gpuMs: 4 }
      })),
      summary: {
        fps: { mean: values.reduce((total, value) => total + value, 0) / values.length },
        sampleCount: values.length
      }
    },
    options: {
      api: "webgpu",
      autoInstrument: true,
      durationMs: 1000,
      runner: "fast-cdp",
      samples: values.length,
      slowFrameThresholdMs: 20,
      viewport: "1280x720",
      warmup: 1
    },
    summary: {
      verdict: "good",
      warnings: []
    }
  };
}

test('missing measurements retain their sample pairing', () => {
  const base = reportWithFps([60, 60, 60]);
  delete base.inPage.samples[1].measurement.gpuMs;
  assert.deepEqual(reportMetricSamples(base)['custom.gpuMs.mean'], [4, null, 4]);
});

test('empty reports cannot produce a compatible passing comparison', () => {
  assert.equal(compareReports({}, {}).compatibility.compatible, false);
});

test('trace, GC and pixel density differences invalidate comparisons', () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([60]);
  candidate.options.trace = true;
  candidate.options.gc = true;
  candidate.options.deviceScaleFactor = 2;
  assert.deepEqual(compareReports(base, candidate).compatibility.differences.map(d => d.key), ['deviceScaleFactor', 'gc', 'trace']);
});

test('negative or invalid thresholds fail instead of silently disabling regressions', () => {
  assert.throws(() => compareReports({}, {}, { thresholdPercent: NaN }), /thresholdPercent/);
  assert.throws(() => compareReports({}, {}, { thresholdPercent: -1 }), /thresholdPercent/);
});

test('independent comparisons are invariant to ordering; pairing must be explicit', () => {
  const base = reportWithFps([100, 150, 200, 250]);
  const candidate = reportWithFps([80, 130, 180, 230]);
  const metric = result => result.rows.find(row => row.key === 'frame.fps.mean');
  const independent = metric(compareReports(base, candidate));
  assert.equal(independent.status, 'inconclusive');
  assert.equal(independent.evidence, 'independent-samples');
  assert.deepEqual(independent.confidence95, metric(compareReports(base, reportWithFps([230, 80, 180, 130]))).confidence95);
  const paired = metric(compareReports(base, candidate, {paired: true}));
  assert.equal(paired.status, 'regression');
  assert.equal(paired.evidence, 'paired-samples');
});

test('confidence must exceed the allowed regression, not merely zero', () => {
  const result = compareReports(reportWithFps([60, 60, 60, 60]), reportWithFps([55, 56, 57, 56]));
  const row = result.rows.find(row => row.key === 'frame.fps.mean');
  assert.ok(row.confidence95.high < 0);
  assert.ok(row.confidence95.high > -3);
  assert.equal(row.status, 'inconclusive');
});

test('missing budget metrics and lost measurements invalidate comparisons', () => {
  const base = reportWithFps([60, 60, 60]);
  const candidate = reportWithFps([60, 60, 60]);
  const missingBudget = compareReports(base, candidate, {budget: {metrics: {'custom.typo.mean': {max: 10}}}});
  assert.equal(missingBudget.validity.valid, false);
  assert.equal(missingBudget.rows.find(row => row.key === 'custom.typo.mean').status, 'missing');
  candidate.inPage.samples.forEach(sample => delete sample.measurement.gpuMs);
  assert.equal(compareReports(base, candidate).validity.valid, false);
});

test('absolute budgets evaluate new candidate metrics without requiring a baseline value', () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([60]);
  candidate.inPage.samples[0].measurement.workMs = 15;
  const options = {budget: {metrics: {'custom.workMs.mean': {max: 10}}}};
  const result = compareReports(base, candidate, options);
  assert.equal(result.validity.valid, true);
  assert.equal(result.failures[0].key, 'custom.workMs.mean');
  assert.equal(result.failures[0].base, null);
  options.budget.metrics['custom.workMs.mean'].max = 20;
  assert.equal(compareReports(base, candidate, options).failures.length, 0);
});

test('malformed and misspelled budget rules fail even for nonexistent metrics', () => {
  for (const budget of [[], {threshold: 5}, {metrics: []}, {metrics: {absent: null}},
    {defaultMaxRegressionPercent: -1}, {metrics: {absent: {max: '10'}}},
    {metrics: {absent: {max: NaN}}}, {metrics: {absent: {max: 5, min: 10}}},
    {metrics: {absent: {maxRegressionPercen: 5}}}, {metrics: {absent: {direction: 'down'}}}]) {
    assert.throws(() => compareReports({}, {}, {budget}), TypeError);
  }
});

test('explicit pairing rejects unmatched observations instead of comparing different subsets', () => {
  const base = reportWithFps([60, 60, 60, 60]);
  const candidate = reportWithFps([60, 60, 60, 60]);
  delete candidate.inPage.samples[1].measurement.gpuMs;
  const result = compareReports(base, candidate, {paired:true});
  assert.equal(result.validity.valid, false);
  assert.ok(result.validity.issues.some(issue => issue.code === 'unmatched-pairs' && issue.key === 'custom.gpuMs.mean'));
});

test('context isolation, headful rendering, and browser channel differences require acknowledgement', () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([60]);
  base.options.contextMode = 'isolated';
  candidate.options.contextMode = 'shared';
  candidate.options.headful = true;
  candidate.options.browserChannel = 'chrome-beta';
  assert.deepEqual(compareReports(base, candidate).compatibility.differences.map(item=>item.key), ['contextMode', 'headful', 'browserChannel']);
});

test('changed frame observation methods are not silently compared', () => {
  const base = reportWithFps([60]);
  const candidate = reportWithFps([60]);
  candidate.options.frameObservation = 'wall-clock';
  assert.equal(compareReports(base, candidate).compatibility.differences[0].key, 'frameObservation');
});
