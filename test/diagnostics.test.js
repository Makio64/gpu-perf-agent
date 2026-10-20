import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReport, finalizeReport, formatDiagnostics, summarizeReport } from "../src/diagnostics.js";

const cadence = { hz: 60, intervalMs: 16.67, hitRate: 1 };

test("diagnostics: low FPS is one rate cause plus symptoms, never a second rule set", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 30 },
        cadence: { hz: 60, intervalMs: 16.67, hitRate: 0.5 },
        elapsedMs: { mean: 1000, p95: 1000 },
        frameTimeMsMean: { mean: 33.3 },
        frameTimeMsP95: { mean: 45.0 },
        observedFrameCount: 30
      }
    }
  };
  const analysis = analyzeReport(report);
  const codes = analysis.findings.map(finding => finding.code);
  assert.deepEqual(codes.filter(code => ["gpu-bound", "cpu-bound", "frame-rate-below-refresh"].includes(code)), ["frame-rate-below-refresh"]);
  assert.ok(codes.includes("low-fps"));
  assert.ok(codes.includes("frame-jitter"));
  assert.ok(codes.includes("unstable-cadence"));
  assert.ok(Math.abs(analysis.recommendations.find(item => item.id === "frame-jitter").value - (45 - 33.3)) < 1e-6);
  assert.ok(analysis.findings.find(finding => finding.code === "frame-rate-below-refresh").aliases.includes("low-frame-rate"));
});

test('diagnostics: varying whole-sample durations do not fabricate frame stutter', () => {
  for (const frameStats of [{}, { frameTimeMsMean: { mean: 16.6 }, frameTimeMsP95: { mean: 17 } }]) {
    const report = { inPage: { summary: { fps: { mean: 60 }, cadence, elapsedMs: { mean: 250, p95: 500 }, ...frameStats } } };
    const codes = analyzeReport(report).findings.map(finding => finding.code);
    assert.ok(!codes.includes("stutter"));
    assert.ok(!codes.includes("frame-jitter"));
  }
});

test('diagnostics: screenshot size establishes capture only, never visual fidelity or blankness', () => {
  for (const screenshotSize of [100, 4999, 5000, 100000]) {
    const result = analyzeReport({ screenshotSize, inPage: { summary: { fps: { mean: 60 }, cadence } } });
    assert.equal(result.recommendations.length, 0);
    const highlight = result.highlights.find(item => /Screenshot captured/.test(item));
    assert.match(highlight, /visual correctness has not been checked/);
    assert.doesNotMatch(result.highlights.join(' '), /Passed|rendered content successfully/);
  }
  const failed = analyzeReport({ screenshotError: 'capture failed', inPage: { summary: { fps: { mean: 60 }, cadence } } });
  assert.ok(failed.highlights.some(item => /Screenshot capture failed: capture failed/.test(item)));
});

test('diagnostics: zero GPU timings remain measured and cannot inflate a duration average', () => {
  const report = { inPage: { summary: { fps: { mean: 60 }, cadence }, samples: [
    { measurement: { gpuTimeNs: 0 }, gpuTimeNs: 50_000_000 },
    { measurement: { gpuTimeNs: 20_000_000 } },
    { measurement: { gpuTimeNs: Infinity } },
    { measurement: { gpuTimeNs: '20000000' } }
  ] } };
  const summary = summarizeReport(report);
  assert.equal(summary.gpuFrameMsMean, 10);
  assert.equal(summary.gpu.source, "hook");
  assert.equal(summary.bottleneck.gpuMs, null, "vsync-paced hook timing is not trusted as cost");
  assert.ok(!summary.findings.some(item => item.code === 'gpu-near-budget'));
});

test("diagnostics: retained heap growth, not raw heap deltas, is a leak", () => {
  const report = {
    inPage: {
      summary: { fps: { mean: 60 }, cadence, observedFrameCount: 120, jsHeapDeltaBytes: { mean: 10 * 1024 * 1024 } },
      samples: [{ elapsedMs: 1000, memory: { delta: { performanceMemory: { usedJSHeapSize: 10 * 1024 * 1024 } } } },
        { elapsedMs: 1000, memory: { delta: { performanceMemory: { usedJSHeapSize: 10 * 1024 * 1024 } } } }],
      memory: { retained: { available: true, method: "gc-bracket", deltaBytes: 6 * 1024 * 1024, windowMs: 2000 } }
    }
  };
  const summary = summarizeReport(report);
  assert.equal(summary.heap.method, "gc-bracket");
  assert.equal(summary.heap.retainedMiBPerSec, 3);
  assert.equal(summary.jsHeapGrowthMBPerSec, 3);
  assert.equal(summary.findings.find(item => item.code === "heap-leak").severity, "medium");
  assert.ok(summary.findings.some(item => item.code === "heap-churn" && item.role === "info"));
  delete report.inPage.memory;
  const unavailable = summarizeReport(report);
  assert.equal(unavailable.heap.method, "unavailable");
  assert.ok(!unavailable.findings.some(item => item.code === "heap-leak"));
});

test("diagnostics: high tracked VRAM and live-resource growth are causes", () => {
  const tracked = (totalBytes, totalResources) => ({ totalBytes, totalResources, byKind: { texture: { bytes: totalBytes, count: totalResources } } });
  const report = { inPage: { summary: { fps: { mean: 60 }, cadence },
    memory: { before: { trackedGpuMemory: tracked(1024, 1) }, after: { trackedGpuMemory: tracked(1100 * 1024 * 1024, 4) } } } };
  const summary = summarizeReport(report);
  assert.equal(summary.findings.find(item => item.code === "high-vram").severity, "high");
  assert.equal(summary.findings.find(item => item.code === "gpu-resource-growth").value, 3);
  assert.equal(summary.verdict, "needs-work");
});

test("diagnostics: produces clean output for a healthy report", () => {
  const analysis = analyzeReport({ inPage: { summary: { fps: { mean: 60 }, cadence, elapsedMs: { mean: 16.6, p95: 18.0 }, jsHeapDeltaBytes: { mean: 0 } } } });
  assert.equal(analysis.warnings.length, 0);
  assert.equal(analysis.recommendations.length, 0);
  assert.match(formatDiagnostics(analysis), /No significant bottlenecks/);
  const busy = analyzeReport({ inPage: { summary: { fps: { mean: 30 }, cadence, observedFrameCount: 30 } } });
  const formatted = formatDiagnostics(busy);
  assert.match(formatted, /\[medium\] \[RENDERING\]/);
  assert.match(formatted, /Action:/);
});

test("summary: healthy report gets an excellent verdict and flat metrics", () => {
  const summary = summarizeReport({
    inPage: {
      summary: {
        fps: { mean: 60 },
        cadence,
        frameTimeMsMean: { mean: 16.4 },
        frameTimeMsP95: { mean: 17.1 },
        elapsedMs: { mean: 1000, p95: 1001 },
        jsHeapDeltaBytes: { mean: 0 },
        sampleCount: 5
      }
    }
  });
  assert.equal(summary.verdict, "excellent");
  assert.equal(summary.fps, 60);
  assert.equal(summary.frameTimeMsMean, 16.4);
  assert.equal(summary.frameTimeMsP95, 17.1);
  assert.equal(summary.sampleCount, 5);
  assert.equal(summary.warningCount, 0);
  assert.equal(summary.bottleneck.class, "vsync-capped");
});

test("summary: below half refresh is poor, a moderate drop needs work", () => {
  assert.equal(summarizeReport({ inPage: { summary: { fps: { mean: 24 }, cadence } } }).verdict, "poor");
  assert.equal(summarizeReport({ inPage: { summary: { fps: { mean: 50 }, cadence } } }).verdict, "needs-work");
  assert.equal(summarizeReport({ inPage: { summary: { fps: { mean: 58 }, cadence } } }).verdict, "excellent", "within 5% of refresh");
});

test("finalizeReport (compatibility) attaches summary and diagnostics in place", () => {
  const report = {
    inPage: {
      summary: { fps: { mean: 60 }, cadence, elapsedMs: { mean: 1000, p95: 1001 } },
      samples: [{ measurement: { gpuTimeNs: 4_000_000 } }]
    }
  };
  const finalized = finalizeReport(report);
  assert.equal(finalized, report);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.summary.verdict, "excellent");
  assert.equal(report.summary.gpuFrameMsMean, 4);
  assert(Array.isArray(report.diagnostics.warnings));
  assert(Array.isArray(report.summary.findings));
});
