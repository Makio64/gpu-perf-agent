import assert from "node:assert/strict";
import test from "node:test";
import { generateHtmlReport } from "../src/html-report.js";
import { finalizeReport } from "../src/diagnostics.js";

test("html-report: generates valid self-contained HTML document", () => {
  const report = finalizeReport({
    target: "http://localhost:8080/test.html",
    timestamp: "2026-09-20T12:00:00.000Z",
    inPage: {
      apiSupport: {
        webgpu: {
          available: true,
          adapter: {
            vendor: "apple",
            architecture: "apple-m3"
          }
        }
      },
      summary: {
        fps: { mean: 59.8 },
        cadence: { hz: 60, intervalMs: 16.67, hitRate: 0.98 },
        frameTimeMsMean: { mean: 16.5 },
        frameTimeMsP95: { mean: 16.9 },
        frameTimeMsP99: { mean: 17.2 },
        gpuTimeNs: { mean: 6_200_000 },
        computeTimeNs: { mean: 1_200_000 },
        renderTimeNs: { mean: 5_000_000 },
        drawCalls: { mean: 45 },
        dispatchCalls: { mean: 2 }
      },
      samples: [
        { measurement: { frameTimeMs: { mean: 16.2 } } },
        { measurement: { frameTimeMs: { mean: 16.5 } } },
        { measurement: { frameTimeMs: { mean: 16.7 } } }
      ],
      slowFrames: []
    }
  });

  const html = generateHtmlReport(report);

  assert(html.startsWith("<!doctype html>"));
  assert(html.includes("<html lang=\"en\">"));
  assert(html.includes("WebGPU Performance Report"));
  assert(html.includes("VERDICT: EXCELLENT"));
  assert(html.includes("apple apple-m3"));
  assert(html.includes("59.8"));
  assert(html.includes("FPS"));
  assert(html.includes("60 Hz"));
  assert(html.includes("16.50"));
  assert(html.includes("chart-svg"));
  assert(html.includes("Optimization Recommendations"));
  assert(html.includes("View Complete JSON Report"));
});

test("html-report: renders recommendation cards and slow frames table when present", () => {
  const report = finalizeReport({
    target: "http://localhost:8080/heavy.html",
    inPage: {
      summary: {
        fps: { mean: 32 },
        drawCalls: { mean: 550 }
      },
      samples: [
        {
          measurement: {
            trackedGpuMemory: {
              pipelines: { syncCount: 2, asyncCount: 1 }
            }
          }
        }
      ],
      slowFrames: [
        {
          timestamp: 1200,
          frameDurationMs: 42.5,
          stats: { drawCalls: 550, renderPasses: 3, computePasses: 1, syncPipelines: 2, bindGroupsCreated: 5 }
        }
      ]
    }
  });

  const html = generateHtmlReport(report);

  assert(html.includes("VERDICT: POOR"));
  assert(html.includes("data-severity=\"critical\""));
  assert(html.includes("Synchronous Pipeline Compilation"));
  assert(html.includes("Slow Frame Timeline"));
  assert(html.includes("42.5ms"));
});
