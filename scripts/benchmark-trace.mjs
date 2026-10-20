#!/usr/bin/env node
// Deterministic synthetic trace CPU benchmark; does not measure application GPU performance.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  baseline: { type: "string" },
  events: { type: "string", default: "250000" },
  repetitions: { type: "string", default: "9" }
} });
const eventCount = Number(values.events);
const repetitions = Number(values.repetitions);
if (!Number.isSafeInteger(eventCount) || eventCount < 1 || !Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("--events and --repetitions must be positive safe integers.");
}
const root = fileURLToPath(new URL("..", import.meta.url));
const current = await import(pathToFileURL(path.join(root, "src/trace.js")));
const baseline = values.baseline
  ? await import(pathToFileURL(path.join(path.resolve(values.baseline), "src/trace.js"))) : null;
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

function createTrace(gpuEvery) {
  return { traceEvents: Array.from({ length: eventCount }, (_, index) => {
    if (index % 100 === 0) return {
      cat: "disabled-by-default-memory-infra", name: "periodic dump", ph: "v", ts: index * 20,
      args: { dumps: { gpu_memory: { bytes: { value: 1048576 + index * 16 } } } }
    };
    return {
      cat: index % gpuEvery === 0 ? "gpu" : "devtools.timeline",
      name: index % 20 === 0 ? "DrawFrame" : index % gpuEvery === 0 ? `WebGPU.Submit${index % 7}` : `Task${index % 31}`,
      ph: index % 9 === 0 ? "B" : "X", ts: index * 20, dur: (index * 7919) % 40000
    };
  }) };
}

const workloads = [];
for (const [name, gpuEvery] of [["mixed", 7], ["gpu-heavy", 2]]) {
  const trace = createTrace(gpuEvery);
  const expected = current.summarizeTrace(trace);
  if (baseline) assert.deepEqual(expected, baseline.summarizeTrace(trace));
  for (let warmup = 0; warmup < 3; warmup += 1) {
    baseline?.summarizeTrace(trace);
    current.summarizeTrace(trace);
  }
  const raw = { baselineMs: [], currentMs: [] };
  const measure = (implementation, samples) => {
    globalThis.gc?.();
    const started = performance.now();
    const summary = implementation.summarizeTrace(trace);
    samples.push(performance.now() - started);
    assert.deepEqual(summary, expected);
  };
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    // Alternate execution order so warm caches and machine drift favor neither version.
    if (repetition % 2 === 0 && baseline) measure(baseline, raw.baselineMs);
    measure(current, raw.currentMs);
    if (repetition % 2 !== 0 && baseline) measure(baseline, raw.baselineMs);
  }
  const baselineMs = baseline ? median(raw.baselineMs) : null;
  const currentMs = median(raw.currentMs);
  workloads.push({ name, eventCount, repetitions, baselineMs, currentMs,
    speedup: baseline ? baselineMs / currentMs : null, outputMatchesBaseline: Boolean(baseline), raw });
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
    gcBetweenMeasurements: Boolean(globalThis.gc) },
  workloads
}, null, 2));
