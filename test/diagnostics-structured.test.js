import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReport, summarizeReport } from "../src/diagnostics.js";

test("diagnostics: flags synchronous pipeline creation as critical", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        elapsedMs: { mean: 1000, p95: 1001 }
      },
      samples: [
        {
          measurement: {
            trackedGpuMemory: {
              pipelines: {
                syncCount: 3,
                asyncCount: 0
              }
            }
          }
        }
      ]
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.recommendations.some(r => r.id === "pipeline-sync-stall" && r.severity === "critical"));
  assert(analysis.warnings.some(w => w.includes("Synchronous pipeline creation detected")));

  const summary = summarizeReport(report, analysis);
  assert.equal(summary.verdict, "poor"); // Critical recommendation results in poor verdict
});

test("diagnostics: flags bind group churn", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        elapsedMs: { mean: 1000, p95: 1001 }
      },
      samples: [
        {
          measurement: {
            trackedGpuMemory: {
              bindGroups: {
                createdCount: 85
              }
            }
          }
        }
      ]
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.recommendations.some(r => r.id === "bind-group-churn" && r.severity === "warning"));
  assert(analysis.warnings.some(w => w.includes("High bind group churn")));
});

test("diagnostics: flags unstable display cadence", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 55 },
        cadence: {
          hz: 60,
          intervalMs: 16.67,
          hitRate: 0.65 // Only 65% hit rate
        }
      }
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.recommendations.some(r => r.id === "unstable-cadence"));
});

test("diagnostics: flags compute-bound workloads", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 40 },
        elapsedMs: { mean: 1000, p95: 1001 }
      },
      samples: [
        {
          measurement: {
            computeTimeNs: 18_000_000, // 18ms compute
            renderTimeNs: 3_000_000    // 3ms render
          }
        }
      ]
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.recommendations.some(r => r.id === "compute-bound"));
});

test("diagnostics: flags high draw call pressure", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 45 },
        drawCalls: { mean: 650 }
      }
    }
  };

  const analysis = analyzeReport(report);
  assert(analysis.recommendations.some(r => r.id === "draw-call-pressure"));
  assert(analysis.warnings.some(w => w.includes("High draw call count")));
});
