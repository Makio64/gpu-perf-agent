import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, formatCompareTable, reportMetrics } from "../src/compare.js";

test("compare: extracts new WebGPU and frame percentiles metrics", () => {
  const report = {
    inPage: {
      summary: {
        fps: { mean: 60, p95: 59.5 },
        frameTimeMsMean: { mean: 16.4 },
        frameTimeMsP95: { mean: 17.2 },
        frameTimeMsP99: { mean: 18.5 },
        gpuTimeNs: { mean: 5_000_000 },
        computeTimeNs: { mean: 1_000_000 },
        renderTimeNs: { mean: 4_000_000 },
        drawCalls: { mean: 50 },
        dispatchCalls: { mean: 4 }
      },
      warmup: {
        durationMs: 120,
        lagSpikeMs: 45
      }
    }
  };

  const metrics = reportMetrics(report);
  assert.equal(metrics["frame.fps.p95"], 59.5);
  assert.equal(metrics["frame.frameTimeMs.p95"], 17.2);
  assert.equal(metrics["frame.frameTimeMs.p99"], 18.5);
  assert.equal(metrics["gpu.durationNs.mean"], 5_000_000);
  assert.equal(metrics["gpu.computeDurationNs.mean"], 1_000_000);
  assert.equal(metrics["gpu.renderDurationNs.mean"], 4_000_000);
  assert.equal(metrics["webgpu.drawCalls.mean"], 50);
  assert.equal(metrics["webgpu.dispatchCalls.mean"], 4);
  assert.equal(metrics["warmup.durationMs"], 120);
});

test("compare: diffs resolved and introduced optimization recommendations", () => {
  const baseReport = {
    diagnostics: {
      recommendations: [
        { id: "pipeline-sync-stall", category: "pipeline", title: "Synchronous Pipeline Compilation", action: "Use async" },
        { id: "high-vram-footprint", category: "memory", title: "High VRAM", action: "Compress textures" }
      ]
    },
    inPage: { summary: { fps: { mean: 40 } } }
  };

  const candidateReport = {
    diagnostics: {
      recommendations: [
        { id: "high-vram-footprint", category: "memory", title: "High VRAM", action: "Compress textures" },
        { id: "bind-group-churn", category: "bindgroup", title: "High Bind Group Churn", evidence: "50 created", action: "Pool bind groups" }
      ]
    },
    inPage: { summary: { fps: { mean: 58 } } }
  };

  const result = compareReports(baseReport, candidateReport);
  assert.equal(result.recommendationDiff.resolved.length, 1);
  assert.equal(result.recommendationDiff.resolved[0].id, "pipeline-sync-stall");

  assert.equal(result.recommendationDiff.introduced.length, 1);
  assert.equal(result.recommendationDiff.introduced[0].id, "bind-group-churn");

  const table = formatCompareTable(result);
  assert(table.includes("Resolved Optimization Recommendations"));
  assert(table.includes("Synchronous Pipeline Compilation"));
  assert(table.includes("New Bottlenecks / Recommendations Introduced"));
  assert(table.includes("High Bind Group Churn"));
});
