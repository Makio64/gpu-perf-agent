import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReport, summarizeReport } from "../src/diagnostics.js";

test("diagnostics: pipeline counts request investigation without asserting measured stalls", () => {
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
  const issue = analysis.recommendations.find(r => r.id === "pipeline-sync-stall");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.value, 3);
  assert.match(issue.evidence, /duration and frame impact were not measured/);
  assert.match(issue.action, /measure their timing/);
  assert.doesNotMatch(issue.evidence, /compilation.*detected|stall.*detected/);
  assert(analysis.warnings.some(w => w.includes("Synchronous pipeline creation detected")));

  const summary = summarizeReport(report, analysis);
  assert.equal(summary.verdict, "needs-work");
});

test("diagnostics: cumulative bind-group counts do not assert render-loop churn", () => {
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
  const issue = analysis.recommendations.find(r => r.id === 'bind-group-churn');
  assert.match(issue.evidence, /total can include setup and warmup/);
  assert.match(issue.action, /per-sample creation deltas/);
  assert(analysis.warnings.some(w => w.includes("High recorded bind group count")));
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

test('diagnostics: compute/render comparisons retain zero measurements and preserve workload coverage', () => {
  const report = { inPage: { samples: [
    { measurement: { computeTimeNs: 0, renderTimeNs: 0 } },
    { measurement: { computeTimeNs: 18_000_000, renderTimeNs: 3_000_000 } }
  ] } };
  assert.equal(analyzeReport(report).recommendations.some(item => item.id === 'compute-bound'), false);
  report.inPage.samples[0].measurement = { computeTimeNs: 20_000_000, renderTimeNs: 4_000_000 };
  const issue = analyzeReport(report).recommendations.find(item => item.id === 'compute-bound');
  assert.equal(issue.value, 19);
  assert.match(issue.action, /preserving the dispatch workload and results/);
  assert.doesNotMatch(issue.action + issue.agentPrompt, /reduce dispatch|align workgroups to 32 or 64/);
});

test('diagnostics: high GPU duration retains scope and recommends optimizations with unchanged output', () => {
  const result = analyzeReport({ inPage: { samples: [{ measurement: { gpuTimeNs: 20_000_000 } }] } });
  const issue = result.recommendations.find(item => item.id === 'high-gpu-time');
  assert.equal(issue.value, 20);
  assert.match(issue.evidence, /scope is defined by the workload/);
  assert.doesNotMatch(issue.evidence, /per frame/);
  assert.match(issue.action, /preserving the workload and rendered output/);
  assert.doesNotMatch(issue.action + issue.agentPrompt, /reduce lights|simplify geometry|lower shadow/);
});

test('diagnostics: long Chrome GPU-thread events remain evidence, not proven GPU execution stalls', () => {
  const result = analyzeReport({ trace: { summary: { gpu: { completeDurationMs: { mean: 20 } } } } });
  const issue = result.recommendations.find(item => item.id === 'chrome-trace-gpu-task');
  assert.equal(issue.value, 20);
  assert.match(issue.action, /CPU work or waiting/);
  assert.doesNotMatch(issue.agentPrompt, /is stalled/);
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
