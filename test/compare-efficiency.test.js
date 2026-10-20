import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, reportMetrics, reportMetricSamples } from "../src/compare.js";
import { numericStats, independentDifferenceStats } from "../src/stats.js";

const report = values => ({ inPage: { samples: values.map(value => ({ measurement: { pass: { gpuMs: value } } })) } });

test("custom metrics emit only the per-sample mean row, with independent public statistics and sample arrays", () => {
  const base = report([2, 3, 6, 4]);
  const result = compareReports(base, report([1, 3, 5, 2]));
  const mean = result.rows.find(row => row.key === "custom.pass.gpuMs.mean");
  assert.deepEqual(mean.baseStats, numericStats([2, 3, 6, 4]));
  for (const suffix of ["p95", "max"]) assert.equal(result.rows.find(row => row.key === `custom.pass.gpuMs.${suffix}`), undefined);
  mean.baseStats.mean = 1234;
  assert.equal(compareReports(base, report([1, 3, 5, 2])).rows.find(row => row.key === "custom.pass.gpuMs.mean").baseStats.mean, 3.75);
  const samples = reportMetricSamples(base);
  assert.deepEqual(Object.keys(samples).filter(key => key.startsWith("custom.")), ["custom.pass.gpuMs.mean"]);
  samples["custom.pass.gpuMs.mean"][0] = 1000;
  assert.equal(reportMetricSamples(base)["custom.pass.gpuMs.mean"][0], 2);
});

test("explicit custom sample overrides do not replace capture summaries", () => {
  const base = report([2, 3, 6, 4]);
  const candidate = report([1, 3, 5, 2]);
  base.metricSamples = { "custom.pass.gpuMs.mean": [10, null, 30, 20] };
  candidate.metricSamples = { "custom.pass.gpuMs.mean": [5, 9, 12, 8] };
  candidate.aggregateMetrics = { "custom.pass.gpuMs.mean": 8.5 };
  const result = compareReports(base, candidate);
  const mean = result.rows.find(row => row.key === "custom.pass.gpuMs.mean");
  assert.equal(mean.base, 3.75);
  assert.equal(mean.candidate, 8.5);
  assert.deepEqual(mean.baseStats, numericStats([10, null, 30, 20]));
  const { low, high } = independentDifferenceStats([10, null, 30, 20], [5, 9, 12, 8]).confidence95;
  assert.deepEqual(mean.confidence95, { low, high, method: "welch-t" });
});

test("legacy scalar zero summaries retain their historical distinction from raw samples", () => {
  const base = { inPage: { samples: [0, 2, -0, 4].map(measurement => ({ measurement })) } };
  const candidate = { inPage: { samples: [0, 1, 0, 3].map(measurement => ({ measurement })) } };
  assert.equal(reportMetrics(base)["custom.value.mean"], 3);
  const row = compareReports(base, candidate).rows.find(row => row.key === "custom.value.mean");
  assert.equal(row.base, 3);
  assert.equal(row.candidate, 2);
  assert.deepEqual(row.baseStats, numericStats([0, 2, -0, 4]));
  const zeros = { inPage: { samples: [{ measurement: 0 }, { measurement: -0 }] } };
  assert.deepEqual(reportMetrics(zeros), {});
  assert.equal(compareReports(zeros, zeros).summary.total, 0);
});

test("custom summaries omit noisy subtrees, profiler telemetry and clocks while preserving sparse, dotted and nested paths", () => {
  const measurement = { stages: [, { durationMs: 2 }], "odd.path": { durationMs: 3 },
    observedFrames: { samples: [16, 17], custom: { durationMs: 100 } },
    "embedded.fps": { durationMs: 100 }, cpuMs: 4, totalResources: { bytes: 100 },
    trackedGpuMemory: { totalBytes: 100 }, gpuTiming: { passes: 24 }, phase: { atMs: 5 }, timestampNs: 7 };
  const input = { inPage: { samples: [{ measurement }] } };
  assert.deepEqual(Object.keys(reportMetrics(input)), [
    "custom.stages.1.durationMs.mean", "custom.odd.path.durationMs.mean", "custom.cpuMs.mean"
  ]);
  const first = compareReports(input, input);
  input.inPage.samples[0].measurement.cpuMs = 9;
  const next = compareReports(input, input);
  assert.equal(first.rows.find(row => row.key === "custom.cpuMs.mean").base, 4);
  assert.equal(next.rows.find(row => row.key === "custom.cpuMs.mean").base, 9);
});
