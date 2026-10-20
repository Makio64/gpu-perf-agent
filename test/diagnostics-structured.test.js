import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReport, summarizeReport } from "../src/diagnostics.js";

const cadence = { hz: 60, intervalMs: 16.67, hitRate: 1 };

test("diagnostics: pipelines created before sampling are info, never a stall", () => {
  const report = {
    inPage: {
      summary: { fps: { mean: 60 }, cadence, elapsedMs: { mean: 1000, p95: 1001 } },
      samples: [{ measurement: { trackedGpuMemory: { pipelines: { syncCount: 3, asyncCount: 0 } } } }]
    }
  };
  const analysis = analyzeReport(report);
  assert.ok(!analysis.findings.some(item => item.code === "pipeline-sync-stall"));
  const startup = analysis.findings.find(item => item.code === "startup-sync-pipelines");
  assert.equal(startup.role, "info");
  assert.equal(startup.value, 3);
  assert.match(startup.message, /created at startup/);
  assert.equal(summarizeReport(report).verdict, "excellent");
});

test("diagnostics: sync pipelines created during sampling are a stall", () => {
  const report = {
    inPage: {
      summary: { fps: { mean: 60 }, cadence, observedFrameCount: 60 },
      instrumentation: { delta: { "webgpu.createRenderPipeline": 2, "webgpu.queueSubmits": 60 },
        after: { counters: { "webgpu.createRenderPipeline": 5 }, resources: { pipelines: { syncCount: 5, asyncCount: 0, shaderModules: 1 } } } }
    }
  };
  const analysis = analyzeReport(report);
  const stall = analysis.findings.find(item => item.code === "pipeline-sync-stall");
  assert.deepEqual([stall.role, stall.severity, stall.value], ["cause", "medium", 2]);
  assert.match(stall.next, /Async/);
  assert.equal(analysis.findings.find(item => item.code === "startup-sync-pipelines").value, 3);
  assert.equal(summarizeReport(report).verdict, "needs-work");
});

test("diagnostics: cumulative bind-group counts do not assert render-loop churn", () => {
  const report = {
    inPage: {
      summary: { fps: { mean: 60 }, cadence, elapsedMs: { mean: 1000, p95: 1001 } },
      samples: [{ measurement: { trackedGpuMemory: { bindGroups: { createdCount: 85 } } } }]
    }
  };
  assert.ok(!analyzeReport(report).findings.some(item => item.code === "bind-group-churn"));
});

test("diagnostics: per-sample creations in two or more samples are churn", () => {
  const sample = delta => ({ instrumentation: { delta }, measurement: {} });
  const report = {
    inPage: {
      summary: { fps: { mean: 60 }, cadence, observedFrameCount: 30 },
      instrumentation: { delta: { "webgpu.createBindGroup": 30, "webgpu.createBuffer": 3, "webgpu.queueSubmits": 30 } },
      samples: [sample({ "webgpu.createBindGroup": 15, "webgpu.createBuffer": 3 }), sample({ "webgpu.createBindGroup": 15 })]
    }
  };
  const codes = analyzeReport(report).findings.map(item => item.code);
  assert.ok(codes.includes("bind-group-churn"));
  assert.ok(!codes.includes("resource-churn"), "buffers were created in one sample only");
});

test("diagnostics: draw-call pressure is a symptom when CPU-bound and info otherwise", () => {
  const report = busy => ({
    inPage: { summary: { fps: { mean: busy ? 45 : 60 }, cadence, observedFrameCount: 10 },
      instrumentation: { delta: { "webgpu.drawCalls": 12000, "webgpu.queueSubmits": 10 } } },
    cdp: { before: { performanceMetrics: { Timestamp: 0, TaskDuration: 0, ThreadTime: 0 } },
      after: { performanceMetrics: { Timestamp: 1, TaskDuration: busy ? 0.95 : 0.1, ThreadTime: busy ? 0.9 : 0.1 } } }
  });
  const cpu = analyzeReport(report(true)).findings.find(item => item.code === "draw-call-pressure");
  assert.deepEqual([cpu.role, cpu.value], ["symptom", 1200]);
  const idle = analyzeReport(report(false)).findings.find(item => item.code === "draw-call-pressure");
  assert.equal(idle.role, "info");
});

test("diagnostics: non-critical failed requests are info with the URL to fix", () => {
  const report = {
    target: { url: "http://127.0.0.1:1/index.html", documentUrl: "http://127.0.0.1:1/index.html" },
    inPage: { summary: { fps: { mean: 60 }, cadence } },
    pageEvents: [{ type: "httperror", url: "https://cdn.example/logo.png", resourceType: "Image", status: 404 }]
  };
  const finding = analyzeReport(report).findings.find(item => item.code === "page-errors");
  assert.equal(finding.role, "info");
  assert.match(finding.next, /cdn\.example\/logo\.png/);
});

test("diagnostics: GPU timing state is reported as info", () => {
  const unavailable = analyzeReport({ options: { autoInstrument: true }, inPage: { summary: { fps: { mean: 60 }, cadence, appGpuContexts: { webgpuDevices: 1 } } } });
  assert.ok(unavailable.findings.some(item => item.code === "gpu-timing-unavailable" && item.role === "info"));
  const unstable = analyzeReport({ inPage: { summary: { fps: { mean: 60 }, cadence },
    samples: [0.86, 1.49, 1.83].map(gpuMs => ({ measurement: { gpuMs } })) } });
  assert.ok(unstable.findings.some(item => item.code === "gpu-timing-unstable"));
});
