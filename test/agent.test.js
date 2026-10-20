import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test('agent markdown discloses ambiguous GPU timing instead of implying a frame mean', () => {
  const report = { summary: { gpuFrameMsMean: null }, diagnostics: { recommendations: [], signal: { gpuTiming: { status: 'ambiguous', scope: null, reasons: ['scope-change'] } } } };
  const digest = generateAgentDigest(report);
  assert.match(digest, /GPU timing scope: ambiguous; aggregate GPU time unavailable \(scope-change\)/);
  assert.doesNotMatch(digest, /\*\*GPU Time\*\*:/);
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
  assert.equal(tools.length, 3);

  const profileTool = tools.find((t) => t.name === "profile_webgpu");
  assert.ok(profileTool);
  assert.equal(typeof profileTool.description, "string");
  assert.ok(profileTool.inputSchema);
  assert.equal(profileTool.inputSchema.properties.adaptive.default, false);
  assert.equal(profileTool.inputSchema.properties.preset.default, "quick");
  assert.equal(profileTool.inputSchema.properties.includeReport.default, false);
  assert.deepEqual(profileTool.inputSchema.properties.samplingMode.enum, ['frames', 'hook']);
  assert.equal(profileTool.inputSchema.properties.samplingMode.default, 'frames');
  assert.equal(profileTool.inputSchema.properties.waitForHook.default, undefined);

  const compareTool = tools.find((t) => t.name === "compare_webgpu_reports");
  assert.ok(compareTool);
  assert.deepEqual(compareTool.inputSchema.required, ["baseReportPath", "candidateReportPath"]);
  const inspectTool = tools.find(t => t.name === 'inspect_webgpu_report');
  assert.deepEqual(inspectTool.inputSchema.required, ['reportPath']);
  assert.equal(inspectTool.inputSchema.properties.limit.maximum, 10);
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
  assert.equal(listRes.result.tools.length, 3);

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

  await server.close();
});

function send(input, id, name, args) {
  input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
}

async function mcpFixture(t, createHarness, options = {}) {
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "gpu-mcp-test-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  output.on("data", chunk => messages.push(...chunk.toString().trim().split("\n").map(JSON.parse)));
  const server = await runMcpServer({ input, output, reportDirectory, createHarness, ...options });
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); await rm(reportDirectory, { recursive: true, force: true }); });
  return { input, output, server, messages, reportDirectory };
}

function measuredReport() {
  return {
    options: { samples: 1 },
    inPage: { samples: [{ measurement: { fps: 60 } }], summary: { fps: { mean: 60 } } },
    summary: { fps: 60, frameTimeMsMean: 16.7, verdict: "good" },
    diagnostics: { validity: { valid: true, issues: [] }, recommendations: [] }
  };
}

test('MCP transports hook sampling, defaults readiness and rejects adaptive hook work before launch', async t => {
  const runs = [];
  let launches = 0;
  const fixture = await mcpFixture(t, async () => {
    launches++;
    return { async run(options) { runs.push(options); return measuredReport(); }, async close() {} };
  });
  send(fixture.input, 1, 'profile_webgpu', { url: 'http://localhost', samplingMode: 'hook', adaptive: true });
  send(fixture.input, 2, 'profile_webgpu', { url: 'http://localhost', samplingMode: 'invalid' });
  assert.equal(launches, 0);
  send(fixture.input, 3, 'profile_webgpu', { url: 'http://localhost', samplingMode: 'hook' });
  send(fixture.input, 4, 'profile_webgpu', { url: 'http://localhost', samplingMode: 'hook', waitForHook: false });
  send(fixture.input, 5, 'profile_webgpu', { url: 'http://localhost' });
  await fixture.server.close();
  assert.equal(launches, 1);
  assert.deepEqual(runs.map(({ samplingMode, waitForHook }) => [samplingMode, waitForHook]), [['hook', true], ['hook', false], ['frames', undefined]]);
  assert.equal(fixture.messages.find(message => message.id === 1).result.isError, true);
  assert.match(fixture.messages.find(message => message.id === 1).result.content[0].text, /adaptive/);
  assert.equal(fixture.messages.find(message => message.id === 2).result.isError, true);
  assert.ok(fixture.messages.filter(message => message.id >= 3).every(message => message.result.isError === false));
});

test("MCP reuses one browser, serializes profiles, persists compact evidence and drains on EOF", async t => {
  let launches = 0, active = 0, peak = 0, closes = 0;
  const runs = [];
  const report = measuredReport();
  report.trace = { rawEvents: Array.from({ length: 2000 }, (_, index) => ({ index, args: "x".repeat(100) })) };
  const fixture = await mcpFixture(t, async () => {
    launches++;
    return {
      async run(options) {
        active++; peak = Math.max(peak, active); runs.push(options);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return { ...report, artifacts: { screenshotPath: options.screenshotPath } };
      },
      async close() { assert.equal(active, 0); closes++; }
    };
  });
  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost", screenshot: true });
  send(fixture.input, 2, "profile_webgpu", { file: "index.html", fileRoot: ".", deviceScaleFactor: 2, preset: "confirm", includeReport: true, api: "webgpu", waitForHook: true, waitCondition: "ready" });
  fixture.input.end();
  await fixture.server.close();
  assert.equal(launches, 1);
  assert.equal(peak, 1);
  assert.equal(closes, 1);
  assert.equal(fixture.messages.length, 2);
  assert.equal(runs[0].samples, 6);
  assert.equal(runs[0].durationMs, 250);
  assert.equal(runs[0].warmup, 2);
  assert.equal(runs[0].adaptive, false);
  assert.equal(runs[1].samples, 15);
  assert.equal(runs[1].durationMs, 500);
  assert.equal(runs[1].waitForHook, true);
  assert.equal(runs[1].api, "webgpu");
  assert.equal(runs[1].fileRoot, ".");
  assert.equal(runs[1].deviceScaleFactor, 2);
  const [first, second] = fixture.messages.map(message => message.result);
  assert.equal(first.report, undefined);
  assert.deepEqual(second.report.trace, report.trace);
  assert.equal(first.structuredContent.ok, true);
  assert.notEqual(first.structuredContent.reportPath, second.structuredContent.reportPath);
  assert.equal(first.structuredContent.screenshotPath, runs[0].screenshotPath);
  assert.match(first.content[0].text, /Report: .*profile-.*\.json/);
  assert.deepEqual(JSON.parse(await readFile(first.structuredContent.reportPath, "utf8")).trace, report.trace);
  const compactBytes = Buffer.byteLength(JSON.stringify(first));
  const fullBytes = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: generateAgentDigest(report) }], report }));
  assert.ok(compactBytes < fullBytes / 100, `${compactBytes} / ${fullBytes} bytes`);
});

test("MCP persists invalid captures and runner failures and can recover after a failed launch", async t => {
  let launches = 0, runs = 0;
  const fixture = await mcpFixture(t, async () => {
    if (++launches === 1) throw new Error("Chrome launch failed");
    return {
      async run() {
        runs++;
        if (runs === 1) return { diagnostics: { validity: { valid: false, issues: [{ code: "no-measurements", message: "No numeric measurements" }] } } };
        return measuredReport();
      },
      async close() {}
    };
  });
  for (let id = 1; id <= 3; id++) send(fixture.input, id, "profile_webgpu", { url: "http://localhost" });
  await fixture.server.close();
  assert.equal(launches, 2);
  assert.equal(fixture.messages.length, 3);
  for (const message of fixture.messages.slice(0, 2)) {
    assert.equal(message.result.isError, true);
    const saved = JSON.parse(await readFile(message.result.structuredContent.reportPath, "utf8"));
    assert.equal(saved.diagnostics.validity.valid, false);
  }
  assert.match(fixture.messages[0].result.content[0].text, /Chrome launch failed/);
  assert.equal(fixture.messages[2].result.isError, false);
});

test("MCP preserves bounded page evidence when readiness fails", async t => {
  const captureDiagnostics = {
    pageEvents: [{ type: "pageerror", error: { message: "workload initialization failed" } }],
    pageEventSummary: { total: 10000, retained: 1, dropped: 9999, truncated: 0, counts: { pageerror: 10000 } }
  };
  const fixture = await mcpFixture(t, async () => ({
    async run() { throw Object.assign(new Error("Readiness timed out"), { captureDiagnostics }); },
    async close() {}
  }));
  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost" });
  await fixture.server.close();
  const result = fixture.messages[0].result;
  assert.equal(result.isError, true);
  const saved = JSON.parse(await readFile(result.structuredContent.reportPath, "utf8"));
  assert.deepEqual(saved.pageEvents, captureDiagnostics.pageEvents);
  assert.deepEqual(saved.pageEventSummary, captureDiagnostics.pageEventSummary);
  assert.deepEqual(result.structuredContent.pageEventSummary, captureDiagnostics.pageEventSummary);
  assert.match(result.content[0].text, /9999 dropped/);
  assert.match(saved.runError.message, /Readiness timed out/);
});

test("MCP input EOF automatically closes the browser after accepted jobs finish", { timeout: 1000 }, async t => {
  let notifyClosed;
  const closed = new Promise(resolve => { notifyClosed = resolve; });
  const fixture = await mcpFixture(t, async () => ({
    async run() { await new Promise(resolve => setImmediate(resolve)); return measuredReport(); },
    async close() { notifyClosed(); }
  }));
  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost" });
  send(fixture.input, 2, "profile_webgpu", { url: "http://localhost" });
  fixture.input.end();
  await closed;
  assert.equal(fixture.messages.length, 2);
  assert.ok(fixture.messages.every(message => !message.result.isError));
});

test("MCP input errors close the browser without losing accepted results", { timeout: 1000 }, async t => {
  let notifyClosed;
  const closed = new Promise(resolve => { notifyClosed = resolve; });
  const fixture = await mcpFixture(t, async () => ({
    async run() { return measuredReport(); },
    async close() { notifyClosed(); }
  }));
  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost" });
  fixture.input.emit("error", new Error("Input disconnected"));
  await closed;
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].result.isError, false);
});

test("MCP validates arguments without launching and rejects excess queued work", async t => {
  let launches = 0;
  const fixture = await mcpFixture(t, async () => {
    launches++;
    return { async run() { return measuredReport(); }, async close() {} };
  }, { maxQueue: 1 });
  const invalid = [
    {}, { url: "http://localhost", file: "index.html" },
    { url: "http://localhost", adaptive: "false" },
    { url: "http://localhost", samples: -1 },
    { url: "http://localhost", samples: 1.2 },
    { url: "http://localhost", screenshotPath: "overwrite.png" },
    { url: "file:///index.html" },
    { url: "http://localhost", includeReport: "true" }
  ];
  invalid.forEach((args, index) => send(fixture.input, index, "profile_webgpu", args));
  assert.equal(launches, 0);
  send(fixture.input, 20, "profile_webgpu", { url: "http://localhost" });
  send(fixture.input, 21, "profile_webgpu", { url: "http://localhost" });
  await fixture.server.close();
  assert.equal(launches, 1);
  assert.equal(fixture.messages.length, invalid.length + 2);
  for (const message of fixture.messages.filter(message => message.id !== 20)) assert.equal(message.result.isError, true);
  assert.match(fixture.messages.find(message => message.id === 21).result.content[0].text, /queue is full/);
});

test("MCP comparison uses saved reports and exposes invalid comparisons as errors", async t => {
  const fixture = await mcpFixture(t, () => { throw new Error("Must not launch"); });
  const basePath = path.join(fixture.reportDirectory, "base.json");
  const candidatePath = path.join(fixture.reportDirectory, "candidate.json");
  await writeFile(basePath, JSON.stringify(measuredReport()));
  await writeFile(candidatePath, JSON.stringify({ inPage: {} }));
  send(fixture.input, 1, "compare_webgpu_reports", { baseReportPath: basePath, candidateReportPath: candidatePath });
  await fixture.server.close();
  assert.equal(fixture.messages[0].result.isError, true);
  assert.equal(fixture.messages[0].result.structuredContent.status, "INVALID");
  assert.equal(fixture.messages[0].result.structuredContent.exitCode, 2);
  assert.match(fixture.messages[0].result.content[0].text, /INVALID/);
  const saved = JSON.parse(await readFile(fixture.messages[0].result.structuredContent.comparisonPath, "utf8"));
  assert.equal(saved.validity.valid, false);
  assert.equal(saved.baseReportPath, basePath);
  assert.ok(saved.rows.length > 0);
});

test('MCP inspects saved metrics without launching Chrome or inlining full captures', async t => {
  const fixture = await mcpFixture(t, () => { throw new Error('Inspection must not launch Chrome'); });
  const reportPath = path.join(fixture.reportDirectory, 'large.json');
  const report = measuredReport();
  report.inPage.samples[0].measurement.gpuMs = 0;
  report.trace = { raw: 'x'.repeat(100000) };
  await writeFile(reportPath, JSON.stringify(report));
  send(fixture.input, 1, 'inspect_webgpu_report', { reportPath, section: 'metrics', metric: 'custom.gpuMs.mean' });
  send(fixture.input, 2, 'inspect_webgpu_report', { reportPath, section: 'metrics', metric: 'custom.absent.mean' });
  send(fixture.input, 3, 'inspect_webgpu_report', { reportPath: '/does/not/exist', section: 'metrics', limit: 11 });
  await fixture.server.close();
  const { inspectReport } = await import('../src/inspect.js');
  for (const [id, metric] of [[1, 'custom.gpuMs.mean'], [2, 'custom.absent.mean']]) {
    const result = fixture.messages.find(message => message.id === id).result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { reportPath, ...inspectReport(report, { section: 'metrics', metric }) });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 17000);
    assert.equal(result.report, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  const invalid = fixture.messages.find(message => message.id === 3).result;
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /limit/);
  assert.doesNotMatch(invalid.content[0].text, /ENOENT/);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report);
});

test("MCP comparison retains bounded metric evidence and complete saved statistics", async t => {
  const fixture = await mcpFixture(t, () => { throw new Error("Must not launch"); });
  const basePath = path.join(fixture.reportDirectory, "base.json");
  const candidatePath = path.join(fixture.reportDirectory, "candidate.json");
  const base = measuredReport(), candidate = measuredReport();
  base.aggregateMetrics = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`custom.metric${index}.mean`, 100]));
  candidate.aggregateMetrics = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`custom.metric${index}.mean`, 50]));
  base.metricSamples = Object.fromEntries(Object.keys(base.aggregateMetrics).map(key => [key, [99, 100, 101]]));
  candidate.metricSamples = Object.fromEntries(Object.keys(base.aggregateMetrics).map(key => [key, [49, 50, 51]]));
  await writeFile(basePath, JSON.stringify(base));
  await writeFile(candidatePath, JSON.stringify(candidate));
  send(fixture.input, 1, "compare_webgpu_reports", { baseReportPath: basePath, candidateReportPath: candidatePath, primaryMetric: "custom.metric9.mean" });
  await fixture.server.close();
  const result = fixture.messages[0].result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, "IMPROVED");
  assert.equal(result.structuredContent.changedRowCount, 10);
  assert.equal(result.structuredContent.changedRows.length, 5);
  assert.equal(result.structuredContent.primaryMetric.key, "custom.metric9.mean");
  assert.equal(result.structuredContent.primaryMetric.evidence, "independent-samples");
  assert.match(result.content[0].text, /custom\.metric9\.mean/);
  assert.equal(result.structuredContent.changedRows[0].evidence, "independent-samples");
  assert.ok(result.structuredContent.changedRows[0].confidence95.high < 0);
  const saved = JSON.parse(await readFile(result.structuredContent.comparisonPath, "utf8"));
  assert.equal(saved.rows.filter(row => row.status === "improved").length, 10);
});

test("MCP distinguishes parse errors, invalid requests and notifications", async t => {
  const fixture = await mcpFixture(t, () => { throw new Error("Must not launch"); });
  fixture.input.write('{bad json\nnull\n[]\n');
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) + "\n");
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "unknown" }) + "\n");
  await fixture.server.close();
  assert.deepEqual(fixture.messages.map(message => message.error.code), [-32700, -32600, -32600, -32601]);
});

test("legacy digest distinguishes unavailable measurements from zero and compilation from stalls", () => {
  const digest = generateAgentDigest({ summary: {}, diagnostics: { recommendations: [] } });
  assert.match(digest, /VRAM\*\*: -- MiB/);
  assert.match(digest, /Cadence: unavailable/);
  assert.match(digest, /sync creations/);
});
