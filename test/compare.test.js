import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, formatCompareTable, reportMetricSamples } from "../src/compare.js";
import { finalizeReport } from "../src/analysis.js";
import { numericStats } from "../src/stats.js";

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

test('hook and frame sampling are incompatible while old frame reports remain comparable', () => {
  const base = reportWithFps([60, 60, 60]);
  const candidate = reportWithFps([60, 60, 60]);
  candidate.options.samplingMode = 'frames';
  assert.equal(compareReports(base, candidate).compatibility.compatible, true);
  candidate.options.samplingMode = 'hook';
  candidate.inPage.hook = { found: true };
  const result = compareReports(base, candidate);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.differences, [{ key: 'samplingMode', base: 'frames', candidate: 'hook' }]);
  delete candidate.options.samplingMode;
  candidate.inPage.config = { samplingMode: 'hook' };
  assert.equal(compareReports(base, candidate).compatibility.compatible, false);
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

test('noisy GPU aggregate changes use repeated evidence instead of claiming a threshold-only win', () => {
  const base = reportWithGpuTimes([8, 16, 8, 16]);
  const candidate = reportWithGpuTimes([7, 15, 7, 15]);
  const result = compareReports(base, candidate);
  for (const key of gpuMeanKeys) {
    const row = result.rows.find(row => row.key === key);
    assert.equal(row.status, 'inconclusive', key);
    assert.equal(row.evidence, 'independent-samples', key);
    assert.ok(row.confidence95.low < 0 && row.confidence95.high > 0, key);
    assert.equal(row.baseStats.count, 4, key);
  }
});

test('consistent GPU improvements receive confidence intervals in their reported units', () => {
  const result = compareReports(reportWithGpuTimes([10, 10, 10, 10]), reportWithGpuTimes([8, 8, 8, 8]));
  for (const key of gpuMeanKeys) {
    const row = result.rows.find(row => row.key === key);
    assert.equal(row.status, 'improved', key);
    assert.equal(row.evidence, 'independent-samples', key);
    const expectedDelta = key === 'health.gpuFrameMs.mean' ? -2 : -2e6;
    assert.equal(row.confidence95.low, expectedDelta, key);
    assert.equal(row.confidence95.high, expectedDelta, key);
  }
});

test('GPU timing evidence preserves zero measurements and missing sample positions', () => {
  const samples = reportMetricSamples(reportWithGpuTimes([0, null, 4]));
  for (const key of gpuMeanKeys) {
    assert.deepEqual(samples[key], key === 'health.gpuFrameMs.mean' ? [0, null, 4] : [0, null, 4e6], key);
  }
  const result = compareReports(reportWithGpuTimes([0, 0, 0]), reportWithGpuTimes([0, 0, 0]), { paired: true });
  for (const key of gpuMeanKeys) {
    const row = result.rows.find(row => row.key === key);
    assert.equal(row.status, 'pass', key);
    assert.equal(row.evidence, 'paired-samples', key);
    assert.equal(row.baseStats.count, 3, key);
  }
});

test('explicit GPU pairing rejects a missing observation in every aggregate metric', () => {
  const result = compareReports(reportWithGpuTimes([4, 4, 4, 4]), reportWithGpuTimes([4, null, 4, 4]), { paired: true });
  assert.equal(result.validity.valid, false);
  for (const key of gpuMeanKeys) {
    assert.ok(result.validity.issues.some(issue => issue.code === 'unmatched-pairs' && issue.key === key), key);
  }
});

test('health GPU evidence recognizes nested timing aliases and normalizes nanoseconds', () => {
  for (const key of ['gpuMs', 'gpuFrameMs', 'gpuTimeMs', 'gpuDurationMs', 'gpuNs', 'gpuTimeNs', 'gpuDurationNs', 'GPUMS']) {
    const ns = /Ns$/.test(key);
    const report = reportWithGpuMeasurements([0, 4, 8].map(value => ({ frame: { [key]: ns ? value * 1e6 : value } })));
    assert.deepEqual(reportMetricSamples(report)['health.gpuFrameMs.mean'], [0, 4, 8], key);
    assert.equal(report.summary.gpuFrameMsMean, 4, key);
  }
});

test('multiple or changing GPU timing scopes suppress health comparisons', () => {
  const scenarios = [
    values => values.map(value => ({ passes: [{ gpuMs: value }, { gpuMs: value + 2 }] })),
    values => values.map((value, index) => index % 2 ? { shadow: { gpuMs: value } } : { main: { gpuMs: value } })
  ];
  for (const measurements of scenarios) {
    const base = reportWithGpuMeasurements(measurements([10, 10, 10, 10]));
    const candidate = reportWithGpuMeasurements(measurements([8, 8, 8, 8]));
    assert.equal(reportMetricSamples(base)['health.gpuFrameMs.mean'], undefined);
    const row = compareReports(base, candidate, { paired: true }).rows.find(row => row.key === 'health.gpuFrameMs.mean');
    assert.equal(row, undefined);
    assert.equal(base.summary.gpuFrameMsMean, null);
    assert.equal(base.summary.gpuFrameMsP95, null);
    assert.equal(base.diagnostics.signal.gpuTiming.status, 'ambiguous');
  }
});

test('different single GPU scopes across captures invalidate and suppress health comparisons', () => {
  const base = reportWithGpuMeasurements([10, 10, 10].map(gpuMs => ({ main: { gpuMs } })));
  const candidate = reportWithGpuMeasurements([8, 8, 8].map(gpuMs => ({ shadow: { gpuMs } })));
  const result = compareReports(base, candidate, { paired: true });
  assert.equal(result.rows.find(row => row.key === 'health.gpuFrameMs.mean'), undefined);
  assert.equal(result.validity.valid, false);
  assert.ok(result.validity.issues.some(issue => issue.code === 'gpu-timing-scope-mismatch'));
  assert.equal(result.compatibility.compatible, false);
});

const gpuMeanKeys = ['gpu.durationNs.mean', 'gpu.computeDurationNs.mean', 'gpu.renderDurationNs.mean', 'health.gpuFrameMs.mean'];

function reportWithGpuTimes(values) {
  return reportWithGpuMeasurements(values.map(value => value === null ? {} : {
    gpuTimeNs: value * 1e6,
    computeTimeNs: value * 1e6,
    renderTimeNs: value * 1e6
  }));
}

function reportWithGpuMeasurements(measurements) {
  const report = reportWithFps(measurements.map(() => 60));
  report.inPage.samples.forEach((sample, index) => {
    sample.measurement = { fps: 60, ...measurements[index] };
  });
  for (const key of ['gpuTimeNs', 'computeTimeNs', 'renderTimeNs']) {
    report.inPage.summary[key] = numericStats(measurements.map(measurement => measurement[key]));
  }
  return finalizeReport(report);
}

test('known browser, GPU, driver and host changes invalidate otherwise matching captures', () => {
  const changes = [
    ['browser.version.product', 'Chrome/154.0.1'],
    ['browser.version.revision', '@different-build'],
    ['browser.version.jsVersion', '16.0'],
    ['browser.systemInfo.gpu.devices.0.driverVersion', '16.0'],
    ['browser.systemInfo.gpu.devices.0.deviceId', 42],
    ['browser.systemInfo.gpu.auxAttributes.glImplementationParts', '(gl=egl-angle,angle=vulkan)'],
    ['browser.systemInfo.gpu.featureStatus.webgpu', 'disabled_software'],
    ['inPage.apiSupport.webgpu.adapter.vendor', 'nvidia'],
    ['inPage.apiSupport.webgpu.adapter.isFallbackAdapter', true],
    ['inPage.apiSupport.webgl2.unmaskedRenderer', 'ANGLE (SwiftShader)'],
    ['host.arch', 'x64'],
    ['host.release', '25.0.0'],
    ['host.cpus', ['Different CPU', 'Different CPU']],
    ['host.totalmem', 16 * 1024 ** 3]
  ];
  for (const [key, value] of changes) {
    const base = reportWithEnvironment();
    const candidate = structuredClone(base);
    const parts = key.split('.');
    parts.slice(0, -1).reduce((object, part) => object[part], candidate)[parts.at(-1)] = value;
    const { compatibility } = compareReports(base, candidate);
    assert.equal(compatibility.compatible, false, key);
    assert.deepEqual(compatibility.differences.map(item => item.key), [key]);
  }
});

test('ephemeral browser state, target URLs and independent switch ordering do not invalidate captures', () => {
  const base = reportWithEnvironment();
  const candidate = structuredClone(base);
  candidate.browser.pid = 456;
  candidate.browser.executablePath = '/another/install/Chrome';
  candidate.browser.systemInfo.commandLine = 'Chrome --user-data-dir=/tmp/another --remote-debugging-port=456';
  candidate.host.hostname = 'renamed-host';
  candidate.host.node = 'v24.19.0';
  candidate.host.freemem = 100;
  candidate.host.loadavg = [2, 3, 4];
  candidate.target = { url: 'http://localhost:4321/candidate', root: '/tmp/candidate' };
  candidate.options.chromiumArgs = ['--user-data-dir', '/tmp/new-profile', '--remote-debugging-port=456',
    '--window-size=1280,720', '--use-angle', 'metal', '--headless=new', 'http://localhost:4321/candidate'];
  const { compatibility } = compareReports(base, candidate);
  assert.equal(compatibility.compatible, true);
  assert.ok(compatibility.environment.checkedKeys.includes('options.chromiumArgs'));
});

test('launch comparison preserves separate values, repeated switch precedence and non-URL positional arguments', () => {
  const cases = [
    [['--use-angle', 'metal'], ['--use-angle', 'vulkan']],
    [['--use-angle=metal', '--use-angle=vulkan'], ['--use-angle=vulkan', '--use-angle=metal']],
    [['unclassified-value-a'], ['unclassified-value-b']],
    [[], ['--disable-gpu']]
  ];
  for (const [baseArgs, candidateArgs] of cases) {
    const base = reportWithEnvironment();
    const candidate = structuredClone(base);
    base.options.chromiumArgs = baseArgs;
    candidate.options.chromiumArgs = candidateArgs;
    assert.deepEqual(compareReports(base, candidate).compatibility.differences.map(item => item.key), ['options.chromiumArgs']);
  }
});

test('old and redacted metadata remain unverified while other known differences still fail', () => {
  const old = reportWithFps([60, 60, 60]);
  const current = reportWithEnvironment();
  const oldComparison = compareReports(old, current).compatibility;
  assert.equal(oldComparison.compatible, true);
  assert.ok(oldComparison.environment.unverifiedKeys.includes('browser.version.product'));
  assert.ok(oldComparison.environment.unverifiedKeys.includes('options.chromiumArgs'));
  assert.equal(oldComparison.environment.checkedKeys.length, 0);

  const base = reportWithEnvironment();
  const candidate = structuredClone(base);
  base.inPage.apiSupport.webgpu.adapter = {};
  candidate.inPage.apiSupport.webgpu.adapter.description = '';
  candidate.browser.version.product = 'Chrome/154.0.1';
  const { compatibility } = compareReports(base, candidate);
  assert.deepEqual(compatibility.differences.map(item => item.key), ['browser.version.product']);
  assert.ok(compatibility.environment.unverifiedKeys.includes('inPage.apiSupport.webgpu.adapter.vendor'));
});

test('attached-browser launch arguments are unverified when actual argv was not captured', () => {
  const base = reportWithEnvironment();
  const candidate = structuredClone(base);
  for (const report of [base, candidate]) {
    report.options.cdpAttached = true;
    report.options.chromiumArgs = [];
  }
  const { compatibility } = compareReports(base, candidate);
  assert.equal(compatibility.compatible, true);
  assert.ok(compatibility.environment.unverifiedKeys.includes('options.chromiumArgs'));
  assert.ok(!compatibility.environment.checkedKeys.includes('options.chromiumArgs'));
});

function reportWithEnvironment() {
  const report = reportWithFps([60, 60, 60]);
  report.browser = {
    pid: 123,
    executablePath: '/Applications/Chrome',
    version: { product: 'Chrome/153.0.1', revision: '@same-build', jsVersion: '15.3' },
    systemInfo: {
      commandLine: 'Chrome --user-data-dir=/tmp/base --remote-debugging-port=123',
      gpu: {
        devices: [{ vendorId: 4203, deviceId: 0, deviceString: 'Apple M3 Max', driverVendor: 'Apple', driverVersion: '15.8' }],
        auxAttributes: { glImplementationParts: '(gl=egl-angle,angle=metal)' },
        featureStatus: { webgpu: 'enabled' }
      }
    }
  };
  report.host = { platform: 'darwin', arch: 'arm64', release: '24.6.0', cpus: ['Apple M3 Max', 'Apple M3 Max'], totalmem: 32 * 1024 ** 3 };
  report.inPage.apiSupport = {
    webgpu: { available: true, adapter: { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false } },
    webgl2: { available: true, unmaskedRenderer: 'ANGLE (Apple M3 Max)' }
  };
  report.options.chromiumArgs = ['--headless=new', '--use-angle=metal', '--window-size=1280,720',
    '--user-data-dir=/tmp/base', '--remote-debugging-port=123', 'about:blank'];
  return report;
}
