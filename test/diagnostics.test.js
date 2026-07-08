import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReport, finalizeReport, formatDiagnostics, summarizeReport } from "../src/diagnostics.js";

test("diagnostics: flags low FPS and frame time variance", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 30 },
        elapsedMs: { mean: 16.6, p95: 35.0 }
      }
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.warnings.some(w => w.includes("Low frame rate")));
  assert(analysis.warnings.some(w => w.includes("High frame time variance")));
});

test("diagnostics: flags high JS heap growth", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        jsHeapDeltaBytes: { mean: 10 * 1024 * 1024 } // 10MB per frame
      }
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.warnings.some(w => w.includes("High JS Heap churn")));
});

test("diagnostics: flags high texture memory and VRAM allocation", () => {
  const report = {
    inPage: {
      samples: [
        {
          trackedGpuMemory: {
            buffers: [
              { size: 100 * 1024 * 1024 }
            ],
            textures: [
              { size: 450 * 1024 * 1024 } // 450MB textures
            ]
          }
        }
      ]
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.warnings.some(w => w.includes("High VRAM footprint")));
  assert(analysis.warnings.some(w => w.includes("Texture memory is high")));
});

test("diagnostics: flags large buffer count", () => {
  const report = {
    inPage: {
      trackedGpuMemory: {
        buffers: Array.from({ length: 250 }, () => ({ size: 1024 }))
      }
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.warnings.some(w => w.includes("Large buffer count")));
});

test("diagnostics: produces clean output for healthy report", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        elapsedMs: { mean: 16.6, p95: 18.0 },
        jsHeapDeltaBytes: { mean: 0 }
      }
    }
  };

  const analysis = analyzeReport(report);
  assert.equal(analysis.warnings.length, 0);
  assert(analysis.highlights.some(h => h.includes("Excellent frame rate")));
  
  const formatted = formatDiagnostics(analysis);
  assert(formatted.includes("No significant bottlenecks"));
});

test("summary: healthy report gets excellent verdict and flat metrics", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        frameTimeMsMean: { mean: 16.4 },
        frameTimeMsP95: { mean: 17.1 },
        elapsedMs: { mean: 1000, p95: 1001 },
        jsHeapDeltaBytes: { mean: 0 },
        sampleCount: 5
      }
    }
  };

  const summary = summarizeReport(report);
  assert.equal(summary.verdict, "excellent");
  assert.equal(summary.fps, 60);
  assert.equal(summary.frameTimeMsMean, 16.4);
  assert.equal(summary.frameTimeMsP95, 17.1);
  assert.equal(summary.sampleCount, 5);
  assert.equal(summary.warningCount, 0);
});

test("summary: low fps or heap churn gets poor verdict", () => {
  const slow = summarizeReport({
    inPage: { summary: { fps: { mean: 24 } } }
  });
  assert.equal(slow.verdict, "poor");

  const leaky = summarizeReport({
    inPage: {
      summary: {
        fps: { mean: 60 },
        elapsedMs: { mean: 1000, p95: 1001 },
        jsHeapDeltaBytes: { mean: 10 * 1024 * 1024 }
      }
    }
  });
  assert.equal(leaky.verdict, "poor");
  assert(leaky.jsHeapGrowthMBPerSec > 5);
});

test("summary: moderate fps gets needs-work verdict", () => {
  const summary = summarizeReport({
    inPage: { summary: { fps: { mean: 50 } } }
  });
  assert.equal(summary.verdict, "needs-work");
});

test("finalizeReport attaches summary and diagnostics in place", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        elapsedMs: { mean: 1000, p95: 1001 }
      },
      samples: [{ gpuTimeNs: 4_000_000 }]
    }
  };

  const finalized = finalizeReport(report);
  assert.equal(finalized, report);
  assert.equal(report.summary.verdict, "excellent");
  assert.equal(report.summary.gpuFrameMsMean, 4);
  assert(Array.isArray(report.diagnostics.warnings));
  assert(Array.isArray(report.summary.warnings));
});
