import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  generateAgentDigest,
  generateAgentCompareDigest,
  getMcpToolDefinitions,
  runMcpServer
} from "../src/index.js";

test("agent: generateAgentDigest produces compact markdown for healthy report", () => {
  const report = {
    summary: {
      verdict: "excellent",
      fps: 60.0,
      cadence: { hz: 60, hitRate: 1.0 },
      frameTimeMsMean: 16.5,
      frameTimeMsP95: 16.6,
      gpuFrameMsMean: 3.2,
      trackedVram: { totalMiB: 12.5, bufferCount: 4, textureCount: 2, leakedResources: 0 },
      pipelines: { syncCount: 0, asyncCount: 2, shaderModules: 2 },
      webgpuOps: { drawCalls: 25, dispatchCalls: 0 },
      bindGroups: { createdCount: 0 }
    },
    diagnostics: {
      recommendations: []
    }
  };

  const digest = generateAgentDigest(report);
  assert.match(digest, /# WebGPU Profiling Digest/);
  assert.match(digest, /Verdict\*\*: EXCELLENT/);
  assert.match(digest, /FPS\*\*: 60\.0/);
  assert.match(digest, /Cadence: 60 Hz/);
  assert.match(digest, /Frame Time\*\*: 16\.50ms/);
  assert.match(digest, /GPU Time\*\*: 3\.20ms/);
  assert.match(digest, /VRAM\*\*: 12\.5 MiB/);
  assert.match(digest, /No performance bottlenecks detected/);
});

test("agent: generateAgentDigest renders critical recommendations with code hints and agent prompts", () => {
  const report = {
    summary: {
      verdict: "poor",
      fps: 22.4,
      frameTimeMsMean: 44.6,
      frameTimeMsP95: 55.0,
      trackedVram: { totalMiB: 450.0, bufferCount: 120, textureCount: 40, leakedResources: 5 },
      pipelines: { syncCount: 3, asyncCount: 0, shaderModules: 3 },
      webgpuOps: { drawCalls: 450, dispatchCalls: 12 },
      bindGroups: { createdCount: 85 }
    },
    diagnostics: {
      recommendations: [
        {
          id: "pipeline-sync-stall",
          category: "pipeline",
          severity: "critical",
          title: "Synchronous Pipeline Compilation",
          evidence: "3 sync pipelines created",
          action: "Replace createRenderPipeline with createRenderPipelineAsync",
          codeHint: "const pipeline = await device.createRenderPipelineAsync(desc);",
          agentPrompt: "Search for device.createRenderPipeline and replace with createRenderPipelineAsync."
        }
      ]
    }
  };

  const digest = generateAgentDigest(report);
  assert.match(digest, /Verdict\*\*: POOR/);
  assert.match(digest, /FPS\*\*: 22\.4/);
  assert.match(digest, /⚠️ Leaked: 5/);
  assert.match(digest, /🔴 \*\*\[PIPELINE\] Synchronous Pipeline Compilation\*\*/);
  assert.match(digest, /Code Hint/);
  assert.match(digest, /createRenderPipelineAsync/);
  assert.match(digest, /Agent Task\*\*: Search for device\.createRenderPipeline/);
});

test("agent: generateAgentCompareDigest outputs clear delta between base and candidate", () => {
  const baseReport = {
    summary: {
      verdict: "poor",
      fps: 30.0,
      frameTimeMsMean: 33.3,
      trackedVram: { totalMiB: 120.0 }
    },
    diagnostics: {
      recommendations: [
        { id: "pipeline-sync-stall", category: "pipeline", title: "Sync Pipeline", action: "Use async" },
        { id: "bind-group-churn", category: "bindgroup", title: "Bind Group Churn", action: "Pool bind groups" }
      ]
    },
    inPage: { summary: { fps: { mean: 30 }, frameTimeMsMean: { mean: 33.3 } } }
  };

  const candidateReport = {
    summary: {
      verdict: "excellent",
      fps: 60.0,
      frameTimeMsMean: 16.6,
      trackedVram: { totalMiB: 45.0 }
    },
    diagnostics: {
      recommendations: []
    },
    inPage: { summary: { fps: { mean: 60 }, frameTimeMsMean: { mean: 16.6 } } }
  };

  const compareDigest = generateAgentCompareDigest(baseReport, candidateReport);
  assert.match(compareDigest, /# WebGPU Optimization Delta/);
  assert.match(compareDigest, /Verdict\*\*: POOR ➔ EXCELLENT/);
  assert.match(compareDigest, /FPS\*\*: 30\.0 ➔ 60\.0 \(\+100\.0%\)/);
  assert.match(compareDigest, /VRAM\*\*: 120\.0 MiB ➔ 45\.0 MiB/);
  assert.match(compareDigest, /Resolved Bottlenecks \(2\)/);
  assert.match(compareDigest, /✅ \*\*\[PIPELINE\] Sync Pipeline\*\*/);
  assert.match(compareDigest, /✅ \*\*\[BINDGROUP\] Bind Group Churn\*\*/);
});

test("agent: getMcpToolDefinitions returns valid MCP schemas", () => {
  const tools = getMcpToolDefinitions();
  assert.equal(Array.isArray(tools), true);
  assert.equal(tools.length, 2);

  const profileTool = tools.find((t) => t.name === "profile_webgpu");
  assert.ok(profileTool);
  assert.equal(typeof profileTool.description, "string");
  assert.ok(profileTool.inputSchema);
  assert.equal(profileTool.inputSchema.properties.adaptive.default, true);
  assert.equal(profileTool.inputSchema.properties.samples.default, 3);

  const compareTool = tools.find((t) => t.name === "compare_webgpu_reports");
  assert.ok(compareTool);
  assert.deepEqual(compareTool.inputSchema.required, ["baseReportPath", "candidateReportPath"]);
});

import { PassThrough } from "node:stream";

test("agent: runMcpServer handles initialize, tools/list, and ping JSON-RPC", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputLines = [];

  output.on("data", (chunk) => {
    outputLines.push(chunk.toString("utf8"));
  });

  const server = await runMcpServer({ input, output });

  // 1. Test initialize
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outputLines.length, 1);
  const initRes = JSON.parse(outputLines[0]);
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.serverInfo.name, "gpu-perf-agent");

  // 2. Test tools/list
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outputLines.length, 2);
  const listRes = JSON.parse(outputLines[1]);
  assert.equal(listRes.id, 2);
  assert.equal(listRes.result.tools.length, 2);

  // 3. Test unknown tool
  input.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "non_existent_tool", arguments: {} }
  }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outputLines.length, 3);
  const errorRes = JSON.parse(outputLines[2]);
  assert.equal(errorRes.id, 3);
  assert.equal(errorRes.error.code, -32601);

  server.close();
});
