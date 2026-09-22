import assert from "node:assert/strict";
import test from "node:test";
import { aggregateReports, alternatingOrder } from "../src/ab-runner.js";

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
