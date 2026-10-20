import assert from "node:assert/strict";
import test from "node:test";
import { aggregateReports, alternatingOrder } from "../src/ab-runner.js";
import { compareReports } from "../src/compare.js";
import { reportValidity } from "../src/validity.js";

test("alternatingOrder produces ABBA ordering to reduce drift", () => {
  assert.deepEqual(alternatingOrder(4).map((entry) => entry.variant), [
    "base", "candidate", "candidate", "base",
    "base", "candidate", "candidate", "base"
  ]);
});

test("aggregateReports builds metric samples and keeps the worst verdict", () => {
  const aggregate = aggregateReports([
    syntheticReport(60, "excellent", []),
    syntheticReport(58, "needs-work", [{ code: "frame-jitter" }])
  ]);
  assert.equal(aggregate.aggregateMetrics["frame.fps.mean"], 59);
  assert.deepEqual(aggregate.metricSamples["frame.fps.mean"], [60, 58]);
  assert.equal(aggregate.summary.verdict, "needs-work");
  assert.deepEqual(aggregate.summary.warnings, [{ code: "frame-jitter" }]);
});

test("aggregateReports rejects empty input", () => {
  assert.throws(() => aggregateReports([]), /empty report list/);
});

function syntheticReport(fps, verdict, warnings) {
  return {
    inPage: {
      samples: [{ elapsedMs: 100, measurement: { fps } }],
      summary: { fps: { mean: fps } }
    },
    options: {
      durationMs: 100,
      runner: "fast-cdp",
      samples: 1,
      viewport: "320x180",
      warmup: 1
    },
    summary: { verdict, warnings }
  };
}

test('A/B aggregation preserves failed rounds and missing metric evidence', async () => {
  const { reportValidity } = await import('../src/validity.js');
  const good = syntheticReport(60, 'good', []);
  const bad = syntheticReport(60, 'poor', []);
  bad.inPage.samples[0].error = {message: 'device lost'};
  const aggregate = aggregateReports([good, bad]);
  assert.equal(reportValidity(aggregate).valid, false);
  assert.equal(reportValidity(aggregate).issues[0].round, 1);
  delete bad.inPage.samples[0].error;
  good.inPage.samples[0].measurement.gpuMs = 5;
  const missing = aggregateReports([good, bad]);
  assert.equal(reportValidity(missing).valid, false);
  assert.deepEqual(missing.metricSamples['custom.gpuMs.mean'], [5, null]);
});

test('invalid A/B budgets are rejected before browser launch', async () => {
  const { runABComparison } = await import('../src/ab-runner.js');
  await assert.rejects(runABComparison({base: 'http://localhost:1', candidate: 'http://localhost:2', executablePath: '/nonexistent/chrome', budget: {metrics: {missing: {max: '5'}}}}), /must be a finite/);
});

test('A/B aggregation retains environment witnesses for cross-variant comparison', () => {
  const base = aggregateReports([environmentReport('Chrome/153'), environmentReport('Chrome/153')]);
  const candidate = aggregateReports([environmentReport('Chrome/154'), environmentReport('Chrome/154')]);
  const comparison = compareReports(base, candidate, { paired: true });
  assert.equal(comparison.compatibility.compatible, false);
  assert.deepEqual(comparison.compatibility.differences.map(item => item.key), ['browser.version.product']);
  assert.equal(base.roundEnvironments.length, 2);
  assert.equal(base.environment.values['browser.version.product'], 'Chrome/153');
});

test('environment drift invalidates its A/B round without hiding other failures', () => {
  const first = environmentReport('Chrome/153');
  const changed = environmentReport('Chrome/154');
  changed.inPage.samples[0].error = { message: 'benchmark failed' };
  const aggregate = aggregateReports([first, changed]);
  assert.equal(reportValidity(aggregate).valid, false);
  assert.ok(aggregate.roundValidity[1].issues.some(issue => issue.code === 'sample-errors'));
  const drift = aggregate.roundValidity[1].issues.find(issue => issue.code === 'environment-drift');
  assert.deepEqual(drift.differences.map(item => item.key), ['browser.version.product']);
  assert.equal(aggregate.environment.values['browser.version.product'], 'Chrome/153');
});

test('unknown early-round metadata does not conceal later environment drift', () => {
  const unknown = syntheticReport(60, 'good', []);
  const aggregate = aggregateReports([unknown, environmentReport('Chrome/153'), environmentReport('Chrome/154')]);
  assert.equal(aggregate.roundValidity[0].valid, true);
  assert.equal(aggregate.roundValidity[1].valid, true);
  assert.equal(aggregate.roundValidity[2].valid, false);
  assert.ok(aggregate.roundValidity[2].issues.some(issue => issue.code === 'environment-drift'));
});

test('partial A/B environment metadata stays unverified and still catches known differences', () => {
  const unknown = syntheticReport(60, 'good', []);
  const base = aggregateReports([unknown, environmentReport('Chrome/153')]);
  const matching = aggregateReports([environmentReport('Chrome/153'), environmentReport('Chrome/153')]);
  const changed = aggregateReports([environmentReport('Chrome/154'), environmentReport('Chrome/154')]);
  assert.equal(reportValidity(base).valid, true);
  const comparison = compareReports(base, matching);
  assert.equal(comparison.compatibility.compatible, true);
  assert.ok(comparison.compatibility.environment.unverifiedKeys.includes('browser.version.product'));
  assert.ok(!comparison.compatibility.environment.checkedKeys.includes('browser.version.product'));
  assert.equal(compareReports(base, changed).compatibility.compatible, false);
});

test('fresh contexts and browser processes do not create A/B environment drift', () => {
  const base = environmentReport('Chrome/153');
  const candidate = environmentReport('Chrome/153');
  base.browser.pid = 123;
  candidate.browser.pid = 456;
  base.options.chromiumArgs = ['--user-data-dir=/tmp/base', '--remote-debugging-port=123', '--use-angle=metal', 'http://localhost:1111'];
  candidate.options.chromiumArgs = ['--use-angle', 'metal', '--user-data-dir', '/tmp/candidate', '--remote-debugging-port=456', 'http://localhost:2222'];
  const aggregate = aggregateReports([base, candidate]);
  assert.equal(reportValidity(aggregate).valid, true);
  assert.deepEqual(aggregate.roundEnvironments[0], aggregate.roundEnvironments[1]);
});

test('aggregation rejects capture settings drift including hook/frame sampling', () => {
  const first = syntheticReport(60, 'good', []);
  const changed = syntheticReport(60, 'good', []);
  changed.options.samplingMode = 'hook';
  changed.inPage.hook = { found: true };
  changed.options.durationMs = 150;
  const aggregate = aggregateReports([first, changed]);
  assert.equal(reportValidity(aggregate).valid, false);
  const drift = aggregate.roundValidity[1].issues.find(issue => issue.code === 'capture-options-drift');
  assert.deepEqual(drift.differences.map(item => item.key), ['durationMs', 'samplingMode']);
  assert.equal(aggregate.roundValidity[0].valid, true);
  changed.options.durationMs = first.options.durationMs;
  changed.options.samplingMode = 'frames';
  assert.equal(reportValidity(aggregateReports([first, changed])).valid, true);
});

test('aggregation preserves hook mode declared only in direct injected results', () => {
  const frames = syntheticReport(60, 'good', []);
  const hook = syntheticReport(60, 'good', []);
  delete frames.options;
  delete hook.options;
  hook.inPage.config = { samplingMode: 'hook' };
  hook.inPage.hook = { found: true };
  const hookAggregate = aggregateReports([hook, structuredClone(hook)]);
  const frameAggregate = aggregateReports([frames, structuredClone(frames)]);
  assert.equal(hookAggregate.options.samplingMode, 'hook');
  assert.equal(reportValidity(hookAggregate).valid, true);
  assert.equal(compareReports(frameAggregate, hookAggregate).compatibility.compatible, false);
  assert.equal(reportValidity(aggregateReports([frames, hook])).valid, false);
});

function environmentReport(product) {
  const report = syntheticReport(60, 'good', []);
  report.browser = { version: { product } };
  return report;
}

test('per-round values are the median of each round\'s per-sample values (§4.6)', () => {
  const round = frameTimes => {
    const report = syntheticReport(60, 'good', []);
    report.inPage.samples = frameTimes.map((mean, index) => ({ index, elapsedMs: 100, measurement: { fps: 1000 / mean, observedFrames: { frameTimeMs: { mean, count: 6 } } } }));
    report.inPage.summary.frameTimeMsMean = { mean: frameTimes.reduce((total, value) => total + value, 0) / frameTimes.length };
    return report;
  };
  const aggregate = aggregateReports([round([16, 17, 40]), round([20, 21, 22])]);
  assert.deepEqual(aggregate.metricSamples['frame.frameTimeMs.mean'], [17, 21]);
  assert.equal(aggregate.aggregateMetrics['frame.frameTimeMs.mean'], 19);
  // One sample per round is that round's own value.
  assert.deepEqual(aggregateReports([round([16]), round([18])]).metricSamples['frame.frameTimeMs.mean'], [16, 18]);
});

test('aggregates carry what paired gating needs: refresh state, bottleneck, work and auto GPU state', async () => {
  const { readFileSync } = await import('node:fs');
  const capture = JSON.parse(readFileSync(new URL('./fixtures/v3/report-capture.json', import.meta.url), 'utf8'));
  const aggregate = aggregateReports([capture, structuredClone(capture)]);
  assert.equal(aggregate.schemaVersion, 3);
  assert.equal(aggregate.summary.bottleneck.primaryMetric, 'health.autoGpuFrameMs.p50');
  assert.equal(aggregate.summary.fps, capture.inPage.summary.fps.mean);
  assert.equal(aggregate.summary.perFrame.drawCalls, 200);
  assert.equal(aggregate.autoGpu.saturated, false);
  assert.equal(aggregate.autoGpu.provenance, 'auto.frame-busy');
  assert.equal(reportValidity(aggregate).valid, true);
});

test('runABComparison uses a passed harness without launching or closing it, with ab defaults', async () => {
  const { readFileSync } = await import('node:fs');
  const { runABComparison } = await import('../src/ab-runner.js');
  const capture = JSON.parse(readFileSync(new URL('./fixtures/v3/report-capture.json', import.meta.url), 'utf8'));
  const calls = [];
  const progress = [];
  const harness = {
    async run(options, context) {
      calls.push({ options, context });
      context.onProgress?.({ stage: 'sample', index: 0, total: 1 });
      return structuredClone(capture);
    },
    async close() { throw new Error('a shared harness must not be closed'); }
  };
  const controller = new AbortController();
  const result = await runABComparison({ base: { url: 'http://127.0.0.1:1/a.html' }, candidate: { url: 'http://127.0.0.1:1/b.html' }, rounds: 4 },
    { harness, onProgress: event => progress.push(event), signal: controller.signal });
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(call => call.options.url.endsWith('a.html') ? 'base' : 'candidate'), alternatingOrder(4).map(entry => entry.variant));
  for (const { options, context } of calls) {
    assert.equal(options.autoInstrument, true);
    assert.equal(options.gpuTiming, true);
    assert.equal(options.samples, 1);
    assert.equal(context.signal, controller.signal);
  }
  assert.equal(progress.length, 8);
  assert.deepEqual(Object.keys(progress[0]).sort(), ['index', 'round', 'rounds', 'stage', 'total', 'variant']);
  assert.equal(result.comparison.mode, 'paired');
  assert.equal(result.comparison.kind, 'comparison');
  assert.equal(result.comparison.status, 'unchanged');
  assert.equal(result.comparison.exitCode, 0);

  const explicit = await runABComparison({ base: 'http://127.0.0.1:1/a.html', candidate: 'http://127.0.0.1:1/b.html', rounds: 2,
    autoInstrument: false, gpuTiming: false }, { harness });
  assert.equal(calls.at(-1).options.autoInstrument, false);
  assert.equal(calls.at(-1).options.gpuTiming, false);
  assert.ok(explicit.comparison.rows.filter(row => row.gated && row.evidence !== 'deterministic').every(row => row.status === 'unverified'), 'two rounds never gate');

  // §2 precedence: a named preset beats the ab defaults; an explicit value beats the preset.
  await runABComparison({ base: 'http://127.0.0.1:1/a.html', candidate: 'http://127.0.0.1:1/b.html', rounds: 2, preset: 'confirm' }, { harness });
  assert.deepEqual([calls.at(-1).options.samples, calls.at(-1).options.durationMs, calls.at(-1).options.warmup], [15, 500, 4]);
  await runABComparison({ base: 'http://127.0.0.1:1/a.html', candidate: 'http://127.0.0.1:1/b.html', rounds: 2, preset: 'confirm', samples: 3 }, { harness });
  assert.deepEqual([calls.at(-1).options.samples, calls.at(-1).options.durationMs], [3, 500]);

  controller.abort();
  await assert.rejects(runABComparison({ base: 'http://127.0.0.1:1/a.html', candidate: 'http://127.0.0.1:1/b.html' }, { harness, signal: controller.signal }),
    error => error.code === 'aborted');
});

test('aggregated rounds never append GPU timing issues twice', () => {
  const round = () => {
    const report = syntheticReport(60, 'good', []);
    report.inPage.samples[0].measurement.gpuMs = -1;
    return report;
  };
  const aggregate = aggregateReports([round(), round()]);
  for (const validity of aggregate.roundValidity) {
    assert.equal(validity.issues.filter(issue => issue.code === 'invalid-gpu-timing').length, 1);
  }
});
