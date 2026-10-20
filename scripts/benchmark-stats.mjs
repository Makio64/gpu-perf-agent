#!/usr/bin/env node
// CPU statistics benchmark with exact-output checks; no browser or application GPU work.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { numericStats } from "../src/stats.js";

const { values } = parseArgs({ options: {
  baseline: { type: "string" },
  size: { type: "string", default: "100000" },
  repetitions: { type: "string", default: "11" }
} });
const size = Number(values.size);
const repetitions = Number(values.repetitions);
if (!values.baseline || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("Pass --baseline FILE and positive integers for --size and --repetitions.");
}
const baseline = (await import(pathToFileURL(path.resolve(values.baseline)))).numericStats;
let state = 0x1e872bf3;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x100000000;
};
const randomValues = Array.from({ length: size }, () => random() * 1000);
const cases = [
  { name: "random", data: randomValues, calls: 1 },
  { name: "sorted", data: [...randomValues].sort((a, b) => a - b), calls: 1 },
  { name: "repeated", data: Array.from({ length: size }, (_, index) => index % 23), calls: 1 },
  { name: "confirmation-15", data: randomValues.slice(0, 15), calls: 10000 }
];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const workloads = [];
for (const { name, data, calls } of cases) {
  const expected = baseline(data);
  assert.deepEqual(numericStats(data), expected);
  const run = implementation => {
    let result;
    for (let index = 0; index < calls; index += 1) result = implementation(data);
    return result;
  };
  for (let index = 0; index < 4; index += 1) {
    run(baseline);
    run(numericStats);
  }
  const raw = { baselineMs: [], currentMs: [] };
  const measure = (implementation, samples) => {
    globalThis.gc?.();
    const start = performance.now();
    const result = run(implementation);
    samples.push((performance.now() - start) / calls);
    assert.deepEqual(result, expected);
  };
  for (let index = 0; index < repetitions; index += 1) {
    if (index % 2 === 0) measure(baseline, raw.baselineMs);
    measure(numericStats, raw.currentMs);
    if (index % 2 !== 0) measure(baseline, raw.baselineMs);
  }
  const baselineMs = median(raw.baselineMs);
  const currentMs = median(raw.currentMs);
  workloads.push({ name, size: data.length, callsPerSample: calls, repetitions, baselineMs, currentMs,
    speedup: baselineMs / currentMs, outputMatchesBaseline: true, raw });
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, gcBetweenMeasurements: Boolean(globalThis.gc) },
  workloads
}, null, 2));
