import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MCP_INSTRUCTIONS } from "../src/agent.js";
import {
  generateAgentCompareDigest,
  generateAgentDigest,
  getMcpToolDefinitions,
  runMcpServer
} from "../src/index.js";
import { formatAgentComparison, formatAgentReport } from "../src/output.js";

function measuredReport(overrides = {}) {
  return {
    ...overrides,
    options: { samples: 1, ...(overrides.options || {}) },
    inPage: {
      samples: [{ measurement: { fps: 60 } }],
      summary: { fps: { mean: 60 } },
      ...(overrides.inPage || {})
    },
    summary: {
      fps: 60,
      frameTimeMsMean: 16.7,
      verdict: "good",
      ...(overrides.summary || {})
    },
    diagnostics: {
      validity: { valid: true, issues: [] },
      recommendations: [],
      ...(overrides.diagnostics || {})
    }
  };
}

test("agent: generateAgentDigest is a thin wrapper over formatAgentReport", () => {
  const report = measuredReport({
    summary: {
      verdict: "excellent",
      verdictReasons: [],
      fps: 60,
      pageFps: 60,
      cadence: { hz: 60, hitRate: 1.0 },
      frameTimeMsMean: 16.67,
      frameTimeMsP95: 16.8,
      gpuFrameMsMean: 1.2,
      cpuMsPerFrame: 0.6,
      drawCallsPerFrame: 10,
      bottleneck: { class: "vsync-capped", hz: 60, budgetMs: 16.67, gpuMs: 1.2, gpuShare: 0.072, primaryMetric: "health.cpuMsPerFrame" },
      gpu: { source: "auto", frameMsP50: 1.2, frameMsP95: 1.4, timedFrames: 88, workFrames: 90, stability: { status: "stable", clockSensitive: true }, passes: [{ key: "render#0", exclusiveMs: 1.1 }] },
      trackedVram: { totalMiB: 16.0, bufferCount: 4, textureCount: 2, leakedResources: 0 },
      heap: { retainedMiBPerSec: 0 },
      findings: [],
      recommendations: []
    }
  });
  const digest = generateAgentDigest(report, { out: "reports/test-1.json" });
  assert.equal(digest, formatAgentReport(report, { out: "reports/test-1.json" }));
  assert.match(digest, /^EXCELLENT — no limiting cause/);
  assert.match(digest, /Bound: vsync-capped 60 Hz/);
  assert.match(digest, /Trust: valid/);
  assert.match(digest, /Report: reports\/test-1\.json/);
});

test("agent: generateAgentDigest surfaces invalid reports and causes concisely", () => {
  const invalidReport = {
    summary: { verdict: "invalid" },
    diagnostics: {
      validity: {
        valid: false,
        issues: [{ code: "no-gpu-work", message: "No GPU work during sampling (0 submits, 0 draws, 0 clears); hook not found." }],
        warnings: []
      }
    }
  };
  const digest = generateAgentDigest(invalidReport);
  assert.match(digest, /^INVALID — no-gpu-work:/);
  assert.match(digest, /Trust: invalid \(1 issue\)/);
  assert.match(digest, /Next: Ensure the page renders during sampling/);
});

test("agent: generateAgentCompareDigest is a thin wrapper over compareReports + formatAgentComparison", () => {
  const baseReport = measuredReport({
    summary: { verdict: "poor", fps: 30, frameTimeMsMean: 33.3, trackedVram: { totalMiB: 120 } },
    inPage: { samples: [{ measurement: { fps: 30 } }], summary: { fps: { mean: 30 }, frameTimeMsMean: { mean: 33.3 } } }
  });
  const candidateReport = measuredReport({
    summary: { verdict: "excellent", fps: 60, frameTimeMsMean: 16.6, trackedVram: { totalMiB: 45 } },
    inPage: { samples: [{ measurement: { fps: 60 } }], summary: { fps: { mean: 60 }, frameTimeMsMean: { mean: 16.6 } } }
  });

  const compareDigest = generateAgentCompareDigest(baseReport, candidateReport, { out: "reports/cmp.compare.json" });
  assert.match(compareDigest, /frame\.frameTimeMs\.mean 33\.3 → 16\.6 ms/);
  assert.match(compareDigest, /Trust: base valid, cand valid/);
  assert.match(compareDigest, /Saved: reports\/cmp\.compare\.json/);
});

test("agent: getMcpToolDefinitions returns 5 compact flat MCP schemas within 3 KB", () => {
  const tools = getMcpToolDefinitions();
  assert.equal(Array.isArray(tools), true);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["profile_webgpu", "compare_webgpu_reports", "ab_compare_webgpu", "inspect_webgpu_report", "doctor_webgpu"]
  );

  for (const tool of tools) {
    assert.equal(typeof tool.title, "string");
    assert.ok(tool.title.length > 0);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.annotations && typeof tool.annotations === "object");
    assert.ok(tool.inputSchema && tool.inputSchema.type === "object");
    assert.equal(tool.inputSchema.oneOf, undefined);
    assert.equal(tool.inputSchema.anyOf, undefined);
    assert.equal(tool.inputSchema.allOf, undefined);
    assert.ok(tool.outputSchema && tool.outputSchema.type === "object");
  }

  const compareTool = tools.find((t) => t.name === "compare_webgpu_reports");
  assert.deepEqual(compareTool.inputSchema.required, ["baseReportPath", "candidateReportPath"]);
  const inspectTool = tools.find((t) => t.name === "inspect_webgpu_report");
  assert.deepEqual(inspectTool.inputSchema.required, ["reportPath"]);

  const wirePayload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });
  assert.ok(Buffer.byteLength(wirePayload) <= 3072, `tools/list wire size ${Buffer.byteLength(wirePayload)} > 3072`);
  assert.ok(MCP_INSTRUCTIONS.length <= 500, `instructions length ${MCP_INSTRUCTIONS.length} > 500`);
});

test("agent: runMcpServer handles initialize (2025-11-25 + instructions + version), tools/list, ping, and -32602 unknown tool", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputLines = [];
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  output.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (line) outputLines.push(line);
    }
  });

  const server = await runMcpServer({ input, output });

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outputLines.length, 1);
  const initRes = JSON.parse(outputLines[0]);
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.protocolVersion, "2025-11-25");
  assert.equal(initRes.result.serverInfo.name, "gpu-perf-agent");
  assert.equal(initRes.result.serverInfo.version, pkg.version);
  assert.equal(initRes.result.instructions, MCP_INSTRUCTIONS);
  assert.ok(initRes.result.instructions.length <= 500);

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outputLines.length, 2);
  const listRes = JSON.parse(outputLines[1]);
  assert.equal(listRes.id, 2);
  assert.equal(listRes.result.tools.length, 5);
  assert.ok(Buffer.byteLength(outputLines[1]) <= 3072);

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
  assert.equal(errorRes.error.code, -32602);

  await server.close();
});

function send(input, id, name, args, extraParams = {}) {
  input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...extraParams } }) + "\n");
}

async function mcpFixture(t, createHarness, options = {}) {
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "gpu-mcp-test-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  output.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      if (line) messages.push(JSON.parse(line));
    }
  });
  const server = await runMcpServer({ input, output, reportDirectory, createHarness, ...options });
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); await rm(reportDirectory, { recursive: true, force: true }); });
  return { input, output, server, messages, reportDirectory };
}

test("MCP transports hook sampling, defaults readiness and rejects adaptive hook work before launch", async t => {
  const runs = [];
  let launches = 0;
  const fixture = await mcpFixture(t, async () => {
    launches++;
    return { async run(options) { runs.push(options); return measuredReport(); }, async close() {} };
  });
  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost", samplingMode: "hook", adaptive: true });
  send(fixture.input, 2, "profile_webgpu", { url: "http://localhost", samplingMode: "invalid" });
  assert.equal(launches, 0);
  send(fixture.input, 3, "profile_webgpu", { url: "http://localhost", samplingMode: "hook" });
  send(fixture.input, 4, "profile_webgpu", { url: "http://localhost", samplingMode: "hook", waitForHook: false });
  send(fixture.input, 5, "profile_webgpu", { url: "http://localhost" });
  await fixture.server.close();
  assert.equal(launches, 1);
  assert.deepEqual(runs.map(({ samplingMode, waitForHook }) => [samplingMode, waitForHook]), [["hook", true], ["hook", false], ["frames", undefined]]);
  assert.equal(fixture.messages.find(message => message.id === 1).result.isError, true);
  assert.match(fixture.messages.find(message => message.id === 1).result.content[0].text, /adaptive/);
  assert.equal(fixture.messages.find(message => message.id === 2).result.isError, true);
  assert.ok(fixture.messages.filter(message => message.id >= 3).every(message => message.result.isError === false));
});

test("MCP reuses one browser, serializes profiles, persists compact evidence with resource_link and drains on close", async t => {
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
  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost", screenshot: "file" });
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
  assert.equal(runs[0].cpuProfile, "auto");
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
  assert.equal(first.structuredContent.status, "ok");
  assert.notEqual(first.structuredContent.reportPath, second.structuredContent.reportPath);
  assert.equal(first.structuredContent.screenshotPath, runs[0].screenshotPath);
  assert.match(first.content[0].text, /Report: .*profile-\d{8}-\d{6}-[0-9a-f]{4}\.json/);
  const linkItem = first.content.find(item => item.type === "resource_link");
  assert.ok(linkItem);
  assert.equal(linkItem.mimeType, "application/json");
  assert.ok(linkItem.uri.startsWith("file://"));
  assert.deepEqual(JSON.parse(await readFile(first.structuredContent.reportPath, "utf8")).trace, report.trace);
  const compactBytes = Buffer.byteLength(JSON.stringify(first));
  const fullBytes = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: generateAgentDigest(report) }], report }));
  assert.ok(compactBytes < fullBytes / 50, `${compactBytes} / ${fullBytes} bytes`);
});

test("MCP profile_webgpu supports inline JPEG screenshots, label naming, and baseReportPath one-call compare with option inheritance", async t => {
  const runs = [];
  const fixture = await mcpFixture(t, async () => ({
    async run(options) {
      runs.push(options);
      if (options.screenshotJpegPath) {
        await writeFile(options.screenshotJpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      return measuredReport({
        options,
        summary: {
          ...measuredReport().summary,
          frameTimeMsMean: options.label === "base" ? 20.0 : 12.0
        },
        inPage: {
          samples: [{ measurement: { fps: 60, frameTimeMs: options.label === "base" ? 20.0 : 12.0 } }],
          summary: { fps: { mean: 60 }, frameTimeMsMean: { mean: options.label === "base" ? 20.0 : 12.0 } }
        },
        artifacts: options.screenshotJpegPath ? { screenshotJpegPath: options.screenshotJpegPath } : {}
      });
    },
    async close() {}
  }));

  send(fixture.input, 1, "profile_webgpu", {
    url: "http://localhost",
    label: "base",
    samples: 9,
    durationMs: 400,
    warmup: 3,
    api: "webgl2",
    gpuTiming: false,
    cpuProfile: true,
    screenshot: "inline"
  });
  for (let i = 0; i < 200 && !fixture.messages.some(m => m.id === 1); i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  const baseRes = fixture.messages.find(m => m.id === 1).result;
  assert.equal(baseRes.isError, false);
  assert.match(baseRes.structuredContent.reportPath, /base-1\.json$/);
  const imageItem = baseRes.content.find(item => item.type === "image");
  assert.ok(imageItem);
  assert.equal(imageItem.mimeType, "image/jpeg");
  assert.equal(Buffer.from(imageItem.data, "base64").toString("hex"), "ffd8ffd9");
  assert.equal(runs[0].cpuProfile, true);

  // Candidate call with baseReportPath inherits samples/durationMs/warmup/api/gpuTiming from base even though preset defaults to quick
  send(fixture.input, 2, "profile_webgpu", {
    url: "http://localhost",
    label: "cand",
    baseReportPath: baseRes.structuredContent.reportPath
  });
  await fixture.server.close();

  assert.equal(runs[1].samples, 9);
  assert.equal(runs[1].durationMs, 400);
  assert.equal(runs[1].warmup, 3);
  assert.equal(runs[1].api, "webgl2");
  assert.equal(runs[1].gpuTiming, false);

  const candRes = fixture.messages.find(m => m.id === 2).result;
  assert.ok(candRes.structuredContent.comparison);
  assert.match(candRes.structuredContent.comparison.comparisonPath, /cand-1\.compare\.json$/);
  assert.match(candRes.content[0].text, /vs .*base-1\.json:/);
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
  assert.equal(fixture.messages[0].result.structuredContent.status, "error");
  assert.equal(fixture.messages[1].result.structuredContent.status, "invalid");
  assert.match(fixture.messages[0].result.content[0].text, /Chrome launch failed/);
  assert.equal(fixture.messages[2].result.isError, false);
  assert.equal(fixture.messages[2].result.structuredContent.status, "ok");
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
  assert.match(result.content[0].text, /10000 page\/network errors/);
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

test("MCP abortOnEof aborts in-flight work, drops queued jobs without responses, and exits within 1.5s", { timeout: 2000 }, async t => {
  let abortCalled = false;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const fixture = await mcpFixture(t, async () => ({
    async run(_options, { signal } = {}) {
      startedResolve();
      await new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { code: "aborted" })), { once: true });
      });
      return measuredReport();
    },
    async close(opts) {
      if (opts?.abort) abortCalled = true;
    }
  }), { abortOnEof: true });

  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost" });
  send(fixture.input, 2, "profile_webgpu", { url: "http://localhost" });
  await started;
  const t0 = performance.now();
  fixture.input.end();
  await fixture.server.close({ abort: true });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1500, `Expected shutdown < 1500ms, got ${elapsed}ms`);
  assert.equal(abortCalled, true);
  assert.equal(fixture.messages.length, 0);
});

test("MCP relaunches a dead harness on the next call and retries once when Chrome died before sampling", async t => {
  let launches = 0;
  const harnesses = [];
  const fixture = await mcpFixture(t, async () => {
    launches++;
    const h = {
      alive: true,
      async run() {
        if (launches === 1) {
          h.alive = false;
          throw Object.assign(new Error("Pipe closed"), { samplingStarted: false });
        }
        return measuredReport();
      },
      async close() { h.alive = false; }
    };
    harnesses.push(h);
    return h;
  });

  send(fixture.input, 1, "profile_webgpu", { url: "http://localhost" });
  await fixture.server.close();
  assert.equal(launches, 2);
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].result.isError, false);
});

test("MCP notifications/cancelled drops queued jobs and aborts running jobs without responses, and emits progress notifications", async t => {
  let unblockFirst;
  let firstStartedResolve;
  const firstStarted = new Promise(r => { firstStartedResolve = r; });
  const firstGate = new Promise(r => { unblockFirst = r; });

  const fixture = await mcpFixture(t, async () => ({
    async run(options, { onProgress, signal } = {}) {
      if (options.label === "slow") {
        firstStartedResolve();
        await Promise.race([
          firstGate,
          new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled"), { code: "aborted" })), { once: true }))
        ]);
      }
      for (let i = 0; i < (options.warmup || 0); i++) onProgress?.({ stage: "warmup", index: i, total: options.warmup });
      for (let i = 0; i < (options.samples || 0); i++) onProgress?.({ stage: "sample", index: i, total: options.samples });
      return measuredReport({ options });
    },
    async close() {}
  }));

  send(fixture.input, "req-running", "profile_webgpu", { url: "http://localhost", label: "slow" });
  send(fixture.input, "req-queued", "profile_webgpu", { url: "http://localhost", label: "queued" });
  await firstStarted;

  // Cancel both the queued and running jobs
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "req-queued" } }) + "\n");
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "req-running" } }) + "\n");
  unblockFirst();

  // Send a subsequent request with _meta.progressToken
  send(fixture.input, "req-after", "profile_webgpu", { url: "http://localhost", warmup: 2, samples: 3 }, { _meta: { progressToken: "tok-1" } });
  await fixture.server.close();

  assert.equal(fixture.messages.find(m => m.id === "req-running"), undefined);
  assert.equal(fixture.messages.find(m => m.id === "req-queued"), undefined);
  const afterRes = fixture.messages.find(m => m.id === "req-after");
  assert.ok(afterRes);
  assert.equal(afterRes.result.isError, false);

  const progressMsgs = fixture.messages.filter(m => m.method === "notifications/progress" && m.params?.progressToken === "tok-1");
  assert.ok(progressMsgs.length >= 5, `Expected >= 5 progress notifications, got ${progressMsgs.length}`);
  assert.equal(progressMsgs[0].params.progress, 1);
  assert.equal(progressMsgs[0].params.total, 5);
});

test("MCP ab_compare_webgpu runs on the warm harness and doctor_webgpu reports environment & lock status", async t => {
  let launches = 0;
  let probeCalled = 0;
  const fixture = await mcpFixture(t, async () => {
    launches++;
    return {
      alive: true,
      async probe() {
        probeCalled++;
        return {
          chrome: { version: "HeadlessChrome/130.0", path: "/Applications/Chrome" },
          webgpu: { available: true, adapter: "Apple M3", timestampQuery: true },
          webgl2: { available: true, renderer: "ANGLE Metal" }
        };
      },
      async run(options, { onProgress } = {}) {
        onProgress?.({ stage: "warmup", index: 0, total: 1 });
        onProgress?.({ stage: "sample", index: 0, total: 1 });
        const mean = String(options.url || "").includes("cand") ? 10 : 20;
        return measuredReport({
          options,
          summary: { ...measuredReport().summary, frameTimeMsMean: mean },
          inPage: {
            samples: [{ measurement: { fps: 60, frameTimeMs: mean }, frameTimeStats: { mean } }],
            summary: { fps: { mean: 60 }, frameTimeMsMean: { mean } }
          }
        });
      },
      async close() {}
    };
  });

  send(fixture.input, 1, "doctor_webgpu", {});
  send(fixture.input, 2, "ab_compare_webgpu", {
    baseUrl: "http://localhost/base",
    candidateUrl: "http://localhost/cand",
    rounds: 2,
    samples: 1,
    warmup: 1,
    durationMs: 100
  }, { _meta: { progressToken: "ab-tok" } });
  await fixture.server.close();

  assert.equal(launches, 1);
  assert.equal(probeCalled, 1);

  const docRes = fixture.messages.find(m => m.id === 1).result;
  assert.equal(docRes.isError, false);
  assert.equal(docRes.structuredContent.webgpu.available, true);
  assert.equal(docRes.structuredContent.webgpu.timestampQuery, true);
  assert.equal(docRes.structuredContent.reportDir.writable, true);
  assert.equal(typeof docRes.structuredContent.lock.held, "boolean");

  const abRes = fixture.messages.find(m => m.id === 2).result;
  assert.ok(abRes);
  assert.equal(abRes.result?.isError ?? abRes.isError, false);
  assert.equal(abRes.structuredContent.rounds, 2);
  assert.equal(typeof abRes.structuredContent.wallMs, "number");
  assert.match(abRes.structuredContent.comparisonPath, /ab-\d{8}-\d{6}-[0-9a-f]{4}\.compare\.json$/);
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

test("MCP inspects saved metrics, gpu, and cpu sections without launching Chrome or inlining full captures", async t => {
  const fixture = await mcpFixture(t, () => { throw new Error("Inspection must not launch Chrome"); });
  const reportPath = path.join(fixture.reportDirectory, "large.json");
  const report = measuredReport({
    cpuProfile: { classification: "main-thread-bound", top: [{ fn: "updateParticles", selfMsPerFrame: 4.2 }] }
  });
  report.inPage.samples[0].measurement.gpuMs = 0;
  report.trace = { raw: "x".repeat(100000) };
  await writeFile(reportPath, JSON.stringify(report));
  send(fixture.input, 1, "inspect_webgpu_report", { reportPath, section: "metrics", metric: "custom.gpuMs.mean" });
  send(fixture.input, 2, "inspect_webgpu_report", { reportPath, section: "metrics", metric: "custom.absent.mean" });
  send(fixture.input, 3, "inspect_webgpu_report", { reportPath: "/does/not/exist", section: "metrics", limit: 11 });
  send(fixture.input, 4, "inspect_webgpu_report", { reportPath, section: "gpu" });
  send(fixture.input, 5, "inspect_webgpu_report", { reportPath, section: "cpu" });
  await fixture.server.close();
  const { inspectReport } = await import("../src/inspect.js");
  for (const [id, metric] of [[1, "custom.gpuMs.mean"], [2, "custom.absent.mean"]]) {
    const result = fixture.messages.find(message => message.id === id).result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { reportPath, ...inspectReport(report, { section: "metrics", metric, limit: 2 }) });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 17000);
    assert.equal(result.report, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  const invalid = fixture.messages.find(message => message.id === 3).result;
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /limit/);
  assert.doesNotMatch(invalid.content[0].text, /ENOENT/);

  const gpuRes = fixture.messages.find(message => message.id === 4).result;
  assert.equal(gpuRes.isError, false);
  assert.equal(gpuRes.structuredContent.section, "gpu");
  assert.ok(gpuRes.structuredContent.data);

  const cpuRes = fixture.messages.find(message => message.id === 5).result;
  assert.equal(cpuRes.isError, false);
  assert.equal(cpuRes.structuredContent.section, "cpu");
  assert.ok(cpuRes.structuredContent.data);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
});

test("MCP comparison retains bounded metric evidence and complete saved statistics", async t => {
  const fixture = await mcpFixture(t, () => { throw new Error("Must not launch"); });
  const basePath = path.join(fixture.reportDirectory, "base.json");
  const candidatePath = path.join(fixture.reportDirectory, "candidate.json");
  const base = measuredReport(), candidate = measuredReport();
  base.aggregateMetrics = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`custom.metric${index}.mean`, 100]));
  candidate.aggregateMetrics = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`custom.metric${index}.mean`, 50]));
  base.metricSamples = Object.fromEntries(Object.keys(base.aggregateMetrics).map(key => [key, [99, 100, 101]]));
  candidate.metricSamples = Object.fromEntries(Object.keys(candidate.aggregateMetrics).map(key => [key, [49, 50, 51]]));
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

test("MCP distinguishes parse errors, echoes valid id on -32600 invalid requests, and ignores notifications", async t => {
  const fixture = await mcpFixture(t, () => { throw new Error("Must not launch"); });
  fixture.input.write("{bad json\nnull\n[]\n");
  fixture.input.write(JSON.stringify({ jsonrpc: "1.0", id: "bad-ver", method: "ping" }) + "\n");
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", id: 42, method: 123 }) + "\n");
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) + "\n");
  fixture.input.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "unknown" }) + "\n");
  await fixture.server.close();
  assert.deepEqual(fixture.messages.map(message => [message.id, message.error.code]), [
    [null, -32700],
    [null, -32600],
    [null, -32600],
    ["bad-ver", -32600],
    [42, -32600],
    [10, -32601]
  ]);
});

test("probeBrowser navigates to a secure http://127.0.0.1 page and doctor_webgpu forwards webgpu.error", async t => {
  const { probeBrowser } = await import("../src/fast-cdp-runner.js");
  const navigatedUrls = [];
  const mockBrowserSession = {
    async send(method) {
      if (method === "Browser.getVersion") return { product: "HeadlessChrome/131.0", userAgent: "UA" };
      if (method === "Target.createBrowserContext") return { browserContextId: "ctx-1" };
      if (method === "Target.createTarget") return { targetId: "tgt-1" };
      if (method === "Target.attachToTarget") return { sessionId: "sess-1" };
      if (method === "Target.disposeBrowserContext") return {};
      return {};
    },
    session() {
      return {
        async send(method, params) {
          if (method === "Page.navigate") {
            navigatedUrls.push(params.url);
            return { frameId: "frame-1" };
          }
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  webgpu: { available: false, adapter: null, timestampQuery: false, error: "navigator.gpu.requestAdapter returned null" },
                  webgl2: { available: true, renderer: "ANGLE Metal" }
                }
              }
            };
          }
          return {};
        },
        dispose() {}
      };
    }
  };

  const probed = await probeBrowser(mockBrowserSession, { executablePath: "/Applications/Chrome" }, {
    probeUrl: "http://127.0.0.1:43210/examples/doctor.html"
  });
  assert.deepEqual(navigatedUrls, ["http://127.0.0.1:43210/examples/doctor.html"]);
  assert.equal(probed.webgpu.error, "navigator.gpu.requestAdapter returned null");

  const fixture = await mcpFixture(t, async () => ({
    alive: true,
    async probe() {
      return probed;
    },
    async close() {}
  }));
  send(fixture.input, 1, "doctor_webgpu", {});
  await fixture.server.close();
  const docRes = fixture.messages.find(m => m.id === 1).result;
  assert.equal(docRes.structuredContent.webgpu.available, false);
  assert.equal(docRes.structuredContent.webgpu.error, "navigator.gpu.requestAdapter returned null");
});
