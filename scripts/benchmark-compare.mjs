#!/usr/bin/env node
// Exact-output CPU comparison benchmark. Does not launch browsers or GPU work.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as current from "../src/compare.js";
import { numericStats } from "../src/stats.js";

const { values } = parseArgs({ options: {
  baseline: { type: "string" },
  repetitions: { type: "string", default: "9" }
} });
const repetitions = Number(values.repetitions);
if (!values.baseline || !Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("Pass --baseline FILE and a positive integer for --repetitions.");
}
const baseline = await import(pathToFileURL(path.resolve(values.baseline)));

function capture(count, passes, shift = 0, missing = false) {
  const samples = Array.from({ length: count }, (_, index) => {
    const measurement = {
      fps: 57 + (index * 7 % 11) - shift,
      frameTimeMs: { mean: 16 + index % 3 + shift / 10 },
      gpuTimeNs: (4 + (index * 3 % 7) / 10 + shift / 5) * 1e6,
      observedFrames: { frameCount: 61, samples: Array.from({ length: 60 }, (_, frame) => 15 + (frame * 7 + index) % 13) },
      passes: {}
    };
    for (let pass = 0; pass < passes; pass++) {
      measurement.passes[`pass${pass}`] = {
        gpuMs: 0.1 + pass / 100 + (index * (pass + 3) % 17) / 100 + shift / 100,
        cpuMs: 0.05 + pass / 200 + (index * (pass + 5) % 13) / 100 + shift / 200,
        bytes: 1024 * (pass + 1) + index * 32
      };
      if (missing && index % 4 === 1 && pass % 7 === 0) delete measurement.passes[`pass${pass}`].gpuMs;
    }
    return { index, elapsedMs: 1000 + index, measurement,
      memory: { delta: { performanceMemory: { usedJSHeapSize: index * 1024 }, trackedGpuMemoryBytes: index * 256 } } };
  });
  return {
    options: { samples: count, api: "webgpu", durationMs: 1000, viewport: "1280x720", warmup: 1 },
    inPage: { samples, summary: { fps: numericStats(samples.map(sample => sample.measurement.fps)),
      gpuTimeNs: numericStats(samples.map(sample => sample.measurement.gpuTimeNs)) } },
    summary: { warnings: [], verdict: "good" },
    diagnostics: { recommendations: [{ id: "pipeline-sync-stall", value: 2, title: "Pipeline", action: "Cache" }] }
  };
}

function aggregate(count, metrics, shift = 0) {
  const metricSamples = {};
  const aggregateMetrics = {};
  for (let metric = 0; metric < metrics; metric++) {
    const key = `custom.pass${metric}.${["mean", "p95", "max"][metric % 3]}`;
    metricSamples[key] = Array.from({ length: count }, (_, index) => 10 + metric / 10 + (index * (metric + 3) % 17) / 10 + shift);
    aggregateMetrics[key] = numericStats(metricSamples[key]).mean;
  }
  return { metricSamples, aggregateMetrics, roundValidity: Array.from({ length: count }, () => ({ valid: true, issues: [] })) };
}

const budget = { defaultMaxRegressionPercent: 3, metrics: {
  "custom.passes.pass0.gpuMs.mean": { max: 0.22, maxRegressionPercent: 4 },
  "custom.absent.mean": { max: 1 },
  "frame.fps.mean": { direction: "higher", min: 50 }
} };
const captureBase = capture(15, 24);
const captureCandidate = capture(15, 24, 3);
const missingBase = capture(30, 48, 0, true);
const missingCandidate = capture(30, 48, 1, true);
missingCandidate.metricSamples = { "custom.passes.pass1.gpuMs.mean": [0.2, null, 0.5, 0.3, 0.4] };
missingCandidate.aggregateMetrics = { "custom.passes.pass1.gpuMs.mean": 0.35 };
const workloads = [
  { name: "capture-independent", base: captureBase, candidate: captureCandidate, options: { budget }, calls: 20 },
  { name: "capture-paired-missing-overrides", base: missingBase, candidate: missingCandidate, options: { paired: true, budget }, calls: 8 },
  { name: "aggregate-independent", base: aggregate(30, 240), candidate: aggregate(30, 240, 1), options: {}, calls: 15 },
  { name: "aggregate-paired", base: aggregate(30, 240), candidate: aggregate(30, 240, 1), options: { paired: true }, calls: 15 },
  { name: "capture-report-metrics", base: captureBase, candidate: captureCandidate, options: {}, calls: 80, operation: "reportMetrics" }
];

// Exercise legacy scalar values, missing paths and explicit overrides too.
const edgeCases = [
  [{}, {}],
  [{ inPage: { samples: [{ measurement: 0 }, { measurement: 2 }, { measurement: -0 }] } }, { inPage: { samples: [{ measurement: 0 }] } }],
  [{ inPage: { samples: [{ measurement: { value: 0, gpuMs: 2 } }, { measurement: null }, { measurement: { gpuMs: 3 } }] } }, captureCandidate],
  [aggregate(1, 5), aggregate(1, 5, 1)]
];
for (const [base, candidate] of edgeCases) {
  for (const paired of [true, false]) assert.deepEqual(current.compareReports(base, candidate, { paired }), baseline.compareReports(base, candidate, { paired }));
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const { name, base, candidate, options, calls, operation = "compareReports" } of workloads) {
  const original = structuredClone({ base, candidate });
  const expected = baseline[operation](base, candidate, options);
  assert.deepEqual(current[operation](base, candidate, options), expected);
  assert.equal(JSON.stringify(current[operation](base, candidate, options)), JSON.stringify(expected));
  for (const report of [base, candidate]) {
    assert.deepEqual(current.reportMetrics(report), baseline.reportMetrics(report));
    assert.deepEqual(current.reportMetricSamples(report), baseline.reportMetricSamples(report));
  }
  const run = implementation => {
    let result;
    for (let index = 0; index < calls; index++) result = implementation[operation](base, candidate, options);
    return result;
  };
  for (let index = 0; index < 3; index++) { run(baseline); run(current); }
  const raw = { baselineMs: [], currentMs: [] };
  const measure = (implementation, samples) => {
    globalThis.gc?.();
    const start = performance.now();
    const result = run(implementation);
    samples.push((performance.now() - start) / calls);
    assert.deepEqual(result, expected);
  };
  for (let index = 0; index < repetitions; index++) {
    if (index % 2 === 0) measure(baseline, raw.baselineMs);
    measure(current, raw.currentMs);
    if (index % 2 !== 0) measure(baseline, raw.baselineMs);
  }
  assert.deepEqual({ base, candidate }, original);
  const baselineMs = median(raw.baselineMs);
  const currentMs = median(raw.currentMs);
  results.push({ name, operation, rows: expected.rows?.length ?? Object.keys(expected).length, callsPerSample: calls, repetitions, baselineMs, currentMs,
    speedup: baselineMs / currentMs, outputMatchesBaseline: true,
    confidenceRows: expected.rows?.filter(row => row.confidence95).length ?? null, raw });
}
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, gcBetweenMeasurements: Boolean(globalThis.gc) }, workloads: results }, null, 2));
