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
