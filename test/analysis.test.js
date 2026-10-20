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
  assert.equal(result.summary.bottleneck.class, "vsync-capped");
  assert.equal(result.summary.gpu.source, "hook");
  assert.equal(result.summary.gpu.provenance, "vsync-paced");
  assert.equal(result.summary.bottleneck.gpuMs, null, "a vsync-paced hook timing is not trusted as cost");
  assert.equal(result.diagnostics.signal.gpuTimingSamples, 2);
  assert.equal(result.diagnostics.signal.autoGpu, null);
});

test("analyzeReport emits causes, symptoms and legacy views for a slow page", () => {
  const report = healthyReport();
  report.inPage.summary.fps.mean = 24;
  report.inPage.summary.frameTimeMsMean.mean = 40;
  report.inPage.summary.frameTimeMsP95.p95 = 60;
  report.inPage.slowFrames = Array.from({ length: 7 }, () => ({ timestamp: 1, frameDurationMs: 60 }));
  report.cdp = { before: { performanceMetrics: { Timestamp: 1, TaskDuration: 0, ThreadTime: 0 } },
    after: { performanceMetrics: { Timestamp: 2, TaskDuration: 0.95, ThreadTime: 0.9 } } };
  const result = analyzeReport(report);
  const codes = result.summary.findings.map(finding => finding.code);
  assert.equal(result.summary.verdict, "poor");
  assert.equal(result.summary.bottleneck.class, "cpu-bound");
  assert.ok(codes.includes("cpu-bound"));
  assert.ok(codes.includes("stutter"));
  assert.ok(codes.includes("low-fps"));
  assert.equal(result.summary.findings.find(finding => finding.code === "cpu-bound").severity, "high");
  assert.deepEqual(result.summary.verdictReasons.map(reason => reason.code), ["cpu-bound", "stutter"]);
  assert.ok(result.summary.warnings.every(warning => warning.recommendation));
  assert.ok(result.summary.warnings.some(warning => warning.code === "low-fps"), "symptoms stay in the legacy warnings view");
  assert.ok(!result.summary.warnings.some(warning => warning.code === "gpu-timing-unavailable"), "info findings are not warnings");
  assert.equal(result.summary.warningCount, result.summary.warnings.length);
  assert.equal(result.summary.recommendations[0].id, "cpu-bound");
});

test("finalizeReport upgrades schema without mutating the input", () => {
  const report = healthyReport();
  const finalized = finalizeReport(report);
  assert.equal(finalized.schemaVersion, 3);
  assert.equal(finalized.summary.verdict, "excellent");
  assert.equal(report.summary, undefined);
  assert.deepEqual(Object.keys(finalized).slice(0, 4), ["schemaVersion", "summary", "diagnostics", "options"]);
});

test("missing frame signal is reported instead of receiving a healthy verdict", () => {
  const report = healthyReport();
  report.inPage.hook.found = false;
  report.inPage.summary.observedFrameCount = 0;
  report.inPage.summary.fps = null;
  const result = analyzeReport(report);
  assert.equal(result.summary.verdict, "unknown");
  assert.equal(result.summary.bottleneck.class, "unknown");
  assert.ok(result.summary.warnings.some((warning) => warning.code === "limited-signal"));
  report.inPage.hook.found = true;
  assert.ok(analyzeReport(report).summary.warnings.some((warning) => warning.code === "limited-frame-signal"));
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
        cadence: { hz: 60, intervalMs: 16.67, hitRate: 1 },
        frameTimeMsMax: { max: 18 },
        frameTimeMsMean: { mean: 16.67 },
        frameTimeMsP95: { mean: 17, p95: 17 },
        instrumentationCounters: {},
        observedFrameCount: 60,
        sampleCount: 2,
        slowFrameCount: 0
      }
    },
    options: { autoInstrument: false, slowFrameThresholdMs: 20 },
    pageEvents: []
  };
}

test('benchmark-hook exceptions appear in diagnostics and invalidate the verdict', () => {
  const result = analyzeReport({ inPage: {
    samples: [{ index: 0, error: { message: 'hook failed' } }],
    summary: { fps: { mean: 60 }, observedFrameCount: 20 }
  } });
  assert.equal(result.diagnostics.sampleErrors[0].message, 'hook failed');
  assert.ok(result.diagnostics.validity.issues.some(issue => issue.code === 'sample-errors'));
  assert.equal(result.summary.verdict, 'invalid');
  assert.deepEqual(result.summary.verdictReasons, []);
});
