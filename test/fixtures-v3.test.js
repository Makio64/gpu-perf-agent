import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFixtures } from "./fixtures/v3/build.mjs";
import { convertWarm } from "./fixtures/v3/convert-warm.mjs";
import { collectGpuTimingEvidence } from "../src/gpu-timing.js";
import { reportValidity } from "../src/validity.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v3/${name}`, import.meta.url), "utf8"));
const REPORT_KEYS = ["schemaVersion", "tool", "summary", "diagnostics", "options", "timings", "target", "artifacts", "measurementLock",
  "cpuProfile", "inPage", "cdp", "pageEventSummary", "pageEvents", "trace", "browser", "host", "createdAt"];

test("checked-in v3 fixtures match build.mjs and the validity/evidence code that produced them", () => {
  for (const [name, value] of Object.entries(buildFixtures())) {
    assert.deepEqual(fixture(name), JSON.parse(JSON.stringify(value)), `${name} is stale: run node test/fixtures/v3/build.mjs`);
  }
});

test("v3 reports follow the §1 key order and carry the new top-level fields", () => {
  for (const name of ["report-capture.json", "report-saturated.json", "report-clock-sensitive.json", "report-hook-warm.json",
    "report-hook-vsync.json", "report-hookmode.json", "report-blank.json", "report-cdp-attached-zero.json"]) {
    const report = fixture(name);
    const keys = Object.keys(report);
    assert.deepEqual(keys, REPORT_KEYS.filter(key => keys.includes(key)), name);
    assert.equal(report.schemaVersion, 3);
    assert.deepEqual(report.tool, { name: "gpu-perf-agent", version: "2.2.0" });
    assert.ok(Number.isInteger(report.target.httpStatus));
    assert.equal(typeof report.measurementLock.acquired, "boolean");
    assert.deepEqual(report.diagnostics.validity, reportValidity(report));
    assert.equal(report.diagnostics.signal.gpuTiming.schemaVersion, 2);
  }
  assert.equal(fixture("report-v2.json").schemaVersion, 2);
});

test("capture samples have the §1.5 sample shape", () => {
  const example = fixture("sample-webgpu.json");
  const sample = fixture("report-capture.json").inPage.samples[2];
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(example).sort());
  assert.deepEqual(Object.keys(sample.autoGpu).sort(), Object.keys(example.autoGpu).sort());
  assert.deepEqual(Object.keys(sample.autoGpu.passes[0]).sort(), Object.keys(example.autoGpu.passes[0]).sort());
  assert.deepEqual(Object.keys(sample.instrumentation.delta).sort(), Object.keys(example.instrumentation.delta).sort());
  assert.deepEqual(Object.keys(sample.memory).sort(), Object.keys(example.memory).sort());
  const summary = fixture("report-capture.json").inPage.summary;
  for (const key of ["autoGpu", "activity", "frameDeltasMs", "perFrame", "churnSites", "gpuErrors", "offMainThread", "appGpuContexts"]) {
    assert.ok(Object.hasOwn(summary, key), key);
  }
  assert.deepEqual(Object.keys(fixture("report-capture.json").summary).sort(), Object.keys(fixture("summary.json")).sort());
});

test("convert-warm marks every measured sample as warm hook timing", () => {
  const report = fixture("report-hook-vsync.json");
  const warm = convertWarm(report);
  assert.equal(collectGpuTimingEvidence(report).provenance, "vsync-paced");
  assert.equal(collectGpuTimingEvidence(warm).provenance, "warm");
  assert.deepEqual(warm.inPage.samples[0].measurement.gpuTiming, { method: "warm", passes: 24, warmupMs: 20 });
  assert.equal(report.inPage.samples[0].measurement.gpuTiming, undefined, "the input is not mutated");
});

test("fixture bottleneck gpuMs follows the §5.1 trust rule", () => {
  for (const name of ["report-capture.json", "report-saturated.json", "report-clock-sensitive.json", "report-hook-warm.json",
    "report-hook-vsync.json", "report-hookmode.json", "report-blank.json", "report-cdp-attached-zero.json"]) {
    const report = fixture(name);
    const { bottleneck } = report.summary;
    const auto = report.diagnostics.signal.autoGpu;
    const hook = report.diagnostics.signal.gpuTiming;
    const autoTrusted = auto !== null && auto.status === "ok" && (auto.stability.status === "stable" || auto.saturated);
    const hookTrusted = ["warm", "fixed-work"].includes(hook.provenance) && hook.stability?.status === "stable";
    const source = autoTrusted ? "auto" : hookTrusted && report.summary.gpu.hook ? "hook" : null;
    assert.equal(bottleneck.gpuSource, source, name);
    if (source === null) {
      assert.equal(bottleneck.gpuMs, null, name);
      assert.equal(bottleneck.gpuShare, null, name);
    }
    if (bottleneck.gpuSaturated) assert.equal(bottleneck.headroomMs, null, name);
    else if (bottleneck.headroomMs !== null) {
      assert.equal(bottleneck.headroomMs, Math.round((bottleneck.budgetMs - Math.max(bottleneck.cpuMsPerFrame ?? 0, bottleneck.gpuMs ?? 0)) * 100) / 100, name);
    }
    if (bottleneck.class === "vsync-capped" && bottleneck.gpuMs === null) assert.match(bottleneck.reason, /GPU headroom unknown/, name);
  }
  assert.equal(fixture("report-cdp-attached-zero.json").summary.bottleneck.gpuMs, null);
  assert.equal(fixture("report-hookmode.json").summary.bottleneck.gpuMs, null);
});
