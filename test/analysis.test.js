import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReport, finalizeReport } from "../src/analysis.js";

test("analyzeReport creates the stable top-level agent summary", () => {
  const result = analyzeReport(healthyReport());
  assert.equal(result.summary.verdict, "excellent");
  assert.equal(result.summary.fps, 60);
  assert.equal(result.summary.frameTimeMsP95, 17);
  assert.equal(result.summary.gpuFrameMsMean, 4);
  assert.equal(result.summary.trackedVram.totalMiB, 2);
  assert.equal(result.diagnostics.signal.gpuTimingSamples, 2);
});

test("analyzeReport emits actionable bottleneck diagnostics", () => {
  const report = healthyReport();
  report.inPage.summary.fps.mean = 24;
  report.inPage.summary.frameTimeMsMean.mean = 30;
  report.inPage.summary.frameTimeMsP95.p95 = 60;
  report.inPage.summary.slowFrameCount = 7;
  report.inPage.memory.delta.performanceMemory.usedJSHeapSize = 40 * 1024 * 1024;
  report.inPage.samples[0].measurement.gpuMs = 30;
  report.inPage.samples[1].measurement.gpuMs = 30;
  const result = analyzeReport(report);
  const codes = result.summary.warnings.map((warning) => warning.code);
  assert.equal(result.summary.verdict, "poor");
  assert.ok(codes.includes("low-fps"));
  assert.ok(codes.includes("frame-stutter"));
  assert.ok(codes.includes("gpu-bound"));
  assert.ok(codes.includes("heap-churn"));
  assert.ok(result.summary.warnings.every((warning) => warning.recommendation));
});

test("finalizeReport upgrades schema without mutating the input", () => {
  const report = healthyReport();
  const finalized = finalizeReport(report);
  assert.equal(finalized.schemaVersion, 2);
  assert.equal(finalized.summary.verdict, "excellent");
  assert.equal(report.summary, undefined);
});

test("missing frame signal is reported instead of receiving a healthy verdict", () => {
  const report = healthyReport();
  report.inPage.hook.found = false;
  report.inPage.summary.observedFrameCount = 0;
  report.inPage.summary.fps = null;
  const result = analyzeReport(report);
  assert.equal(result.summary.verdict, "needs-work");
  assert.ok(result.summary.warnings.some((warning) => warning.code === "limited-signal"));
});

function healthyReport() {
  return {
    inPage: {
      hook: { found: true },
      instrumentation: {
        after: { counters: {}, errors: [], resources: { totalBytes: 2 * 1024 * 1024, totalResources: 2 } },
        before: { counters: {}, errors: [], resources: { totalBytes: 2 * 1024 * 1024, totalResources: 2 } },
        delta: {}
      },
      memory: {
        after: {
          trackedGpuMemory: {
            byKind: {
              buffer: { bytes: 1024 * 1024, count: 1 },
              texture: { bytes: 1024 * 1024, count: 1 }
            },
            totalBytes: 2 * 1024 * 1024,
            totalResources: 2
          }
        },
        before: {
          trackedGpuMemory: {
            byKind: {
              buffer: { bytes: 1024 * 1024, count: 1 },
              texture: { bytes: 1024 * 1024, count: 1 }
            },
            totalBytes: 2 * 1024 * 1024,
            totalResources: 2
          }
        },
        delta: { performanceMemory: { usedJSHeapSize: 0 } }
      },
      samples: [
        { elapsedMs: 500, measurement: { gpuMs: 4 } },
        { elapsedMs: 500, measurement: { gpuMs: 4 } }
      ],
      summary: {
        fps: { mean: 60 },
        frameTimeMsMax: { max: 18 },
        frameTimeMsMean: { mean: 16.67 },
        frameTimeMsP95: { mean: 17, p95: 17 },
        instrumentationCounters: {},
        observedFrameCount: 60,
        sampleCount: 2,
        slowFrameCount: 0
      }
    },
    options: { autoInstrument: true, slowFrameThresholdMs: 20 },
    pageEvents: []
  };
}

test('benchmark-hook exceptions appear in diagnostics and prevent a healthy verdict', () => {
  const result = analyzeReport({ inPage: {
    samples: [{ index: 0, error: { message: 'hook failed' } }],
    summary: { fps: { mean: 60 }, observedFrameCount: 20 }
  } });
  assert.equal(result.diagnostics.sampleErrors[0].message, 'hook failed');
  assert.ok(result.summary.warnings.some(w => w.code === 'page-errors'));
  assert.equal(result.summary.verdict, 'needs-work');
});
