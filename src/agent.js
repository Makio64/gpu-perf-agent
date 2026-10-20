/**
 * Agent-First Helpers: Token-optimized digests, actionable code guidance,
 * and Model Context Protocol (MCP) server integration for AI coding agents.
 */

import { analyzeReport, summarizeReport } from "./diagnostics.js";
import { compareReports, comparisonStatus } from "./compare.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeOptions, numberOption } from "./options.js";
import { formatAgentComparison, formatAgentReport, formatGpuTimingSignal } from "./output.js";
import { reportValidity } from "./validity.js";

/**
 * Generates an ultra-dense, high-signal Markdown digest for LLM context windows.
 * Includes measurements and detailed recommendations; size depends on the findings.
 */
export function generateAgentDigest(report) {
  const summary = report.summary || summarizeReport(report);
  const analysis = report.diagnostics || analyzeReport(report);
  const recs = analysis.recommendations || summary.recommendations || [];

  const verdict = report.diagnostics?.validity?.valid === false ? "INVALID" : (summary.verdict || "unknown").toUpperCase();
  const fps = summary.fps != null ? summary.fps.toFixed(1) : "--";
  const cadence = summary.cadence
    ? `${summary.cadence.hz} Hz${summary.cadence.hitRate != null ? ` (${(summary.cadence.hitRate * 100).toFixed(1)}% hits)` : ""}`
    : "unavailable";
  const frameMs = summary.frameTimeMsMean != null ? summary.frameTimeMsMean.toFixed(2) : "--";
  const p95 = summary.frameTimeMsP95 != null ? summary.frameTimeMsP95.toFixed(1) : "--";
  const gpuMs = summary.gpuFrameMsMean != null ? summary.gpuFrameMsMean.toFixed(2) : null;
  const vram = summary.trackedVram?.totalMiB;
  const texCount = summary.trackedVram?.textureCount ?? 0;
  const bufCount = summary.trackedVram?.bufferCount ?? 0;
  const leaks = summary.trackedVram?.leakedResources ?? 0;

  const pipelines = summary.pipelines || {};
  const syncCount = pipelines.syncCount ?? 0;
  const asyncCount = pipelines.asyncCount ?? 0;
  const shaderModules = pipelines.shaderModules ?? 0;

  const ops = summary.webgpuOps || {};
  const draws = ops.drawCalls != null ? Math.round(ops.drawCalls) : "--";
  const dispatches = ops.dispatchCalls != null ? Math.round(ops.dispatchCalls) : "--";
  const newBg = summary.bindGroups?.createdCount ?? 0;
  const warmup = summary.warmup || report.inPage?.warmup || null;

  const lines = [
    `# WebGPU Profiling Digest`,
    `- **Verdict**: ${verdict} | **FPS**: ${fps} (Cadence: ${cadence})`,
    `- **Frame Time**: ${frameMs}ms (p95: ${p95}ms)${gpuMs != null ? ` | **GPU Time**: ${gpuMs}ms` : ""}`,
    analysis.signal?.gpuTiming ? `- ${formatGpuTimingSignal(analysis.signal.gpuTiming)}` : null,
    `- **VRAM**: ${Number.isFinite(vram) ? vram.toFixed(1) : "--"} MiB (${bufCount} buffers, ${texCount} textures)${leaks > 0 ? ` | ⚠️ Leaked: ${leaks}` : ""}`,
    `- **Pipelines**: ${syncCount} sync creations, ${asyncCount} async, ${shaderModules} modules`,
    `- **WebGPU Ops**: ${draws} draws/frame, ${dispatches} dispatches | ${newBg} bind groups created`,
    warmup ? `- **Warmup**: ${warmup.durationMs}ms${warmup.lagSpikeMs ? ` (lag spike: ${warmup.lagSpikeMs}ms)` : ""}` : null,
    "",
    `### Actionable Recommendations (${recs.length})`
  ].filter(Boolean);

  if (recs.length === 0) {
    lines.push("✨ No performance bottlenecks detected in the available measurements.");
  } else {
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const icon = r.severity === "critical" ? "🔴" : r.severity === "warning" ? "🟡" : "ℹ️";
      lines.push(`${i + 1}. ${icon} **[${r.category.toUpperCase()}] ${r.title}**`);
      lines.push(`   - **Evidence**: ${r.evidence}`);
      lines.push(`   - **Action**: ${r.action}`);
      if (r.codeHint) {
        lines.push(`   - **Code Hint**:`);
        lines.push("     ```javascript");
        for (const codeLine of r.codeHint.split("\n")) {
          lines.push(`     ${codeLine}`);
        }
        lines.push("     ```");
      }
      if (r.agentPrompt) {
        lines.push(`   - **Agent Task**: ${r.agentPrompt}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generates a compact comparative delta between base and candidate runs.
 */
export function generateAgentCompareDigest(baseReport, candidateReport, options = {}) {
  const result = compareReports(baseReport, candidateReport, options);
  const baseSummary = baseReport.summary || summarizeReport(baseReport);
  const candSummary = candidateReport.summary || summarizeReport(candidateReport);

  const baseFps = baseSummary.fps?.toFixed(1) ?? "--";
  const candFps = candSummary.fps?.toFixed(1) ?? "--";
  const fpsDelta = (baseSummary.fps && candSummary.fps)
    ? `${((candSummary.fps - baseSummary.fps) / baseSummary.fps * 100).toFixed(1)}%`
    : null;

  const baseFrame = baseSummary.frameTimeMsMean?.toFixed(2) ?? "--";
  const candFrame = candSummary.frameTimeMsMean?.toFixed(2) ?? "--";

  const baseVram = baseSummary.trackedVram?.totalMiB?.toFixed(1) ?? "--";
  const candVram = candSummary.trackedVram?.totalMiB?.toFixed(1) ?? "--";

  const status = comparisonStatus(result, { allowMismatch: options.allowMismatch === true }).status.toUpperCase();

  const lines = [
    `# WebGPU Optimization Delta`,
    `- **Status**: ${status} (${result.summary.regressions} regressions, ${result.summary.improved} improvements)`,
    `- **Verdict**: ${baseSummary.verdict?.toUpperCase() || "?"} ➔ ${candSummary.verdict?.toUpperCase() || "?"}`,
    `- **FPS**: ${baseFps} ➔ ${candFps}${fpsDelta ? ` (${fpsDelta.startsWith("-") ? fpsDelta : "+" + fpsDelta})` : ""}`,
    `- **Frame Time**: ${baseFrame}ms ➔ ${candFrame}ms`,
    `- **VRAM**: ${baseVram} MiB ➔ ${candVram} MiB`
  ];

  if (result.recommendationDiff?.resolved?.length > 0) {
    lines.push("");
    lines.push(`### Resolved Bottlenecks (${result.recommendationDiff.resolved.length})`);
    for (const r of result.recommendationDiff.resolved) {
      lines.push(`- ✅ **[${r.category.toUpperCase()}] ${r.title}**`);
    }
  }

  if (result.recommendationDiff?.introduced?.length > 0) {
    lines.push("");
    lines.push(`### New Bottlenecks / Regressions (${result.recommendationDiff.introduced.length})`);
    for (const r of result.recommendationDiff.introduced) {
      lines.push(`- ⚠️ **[${r.category.toUpperCase()}] ${r.title}**: ${r.action}`);
    }
  }

  if (result.failures.length > 0) {
    lines.push("");
    lines.push(`### Regressed Metrics (${result.failures.length})`);
    for (const f of result.failures) {
      lines.push(`- ❌ **${f.key}**: ${f.base} ➔ ${f.candidate} (${f.deltaPercent?.toFixed(1)}%)`);
    }
  }

  return lines.join("\n");
}

/**
 * Standard Model Context Protocol (MCP) tool schemas.
 */
export function getMcpToolDefinitions() {
  return [
    {
      name: "profile_webgpu",
      description: "Profile WebGPU/WebGL with a reused browser and isolated contexts. Returns a bounded digest and saved report path; use that path for comparisons or selective inspection. Quick defaults: 6 fixed 250ms samples and 2 warmups. GPU timings require workload instrumentation.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL to profile" },
          file: { type: "string", description: "Local HTML file path to serve and profile" },
          fileRoot: { type: "string", description: "Root directory for serving local HTML and its imports" },
          preset: { type: "string", enum: ["quick", "confirm", "profile", "default"], default: "quick" },
          samples: { type: "integer", minimum: 1, maximum: 10000, description: "Override preset sample count (quick: 6)" },
          durationMs: { type: "number", minimum: 1, maximum: 3600000, description: "Override milliseconds per sample (quick: 250)" },
          warmup: { type: "integer", minimum: 0, maximum: 10000, description: "Override warmup count (quick: 2)" },
          samplingMode: { type: "string", enum: ["frames", "hook"], default: "frames", description: "Frames observes frame pacing. Hook requires a benchmark hook and samples its returned metrics without frame observation; adaptive sampling is unavailable." },
          adaptive: { type: "boolean", description: "Early-stop exploratory runs only; fixed samples support comparisons", default: false },
          autoInstrument: { type: "boolean", description: "Hook WebGPU/WebGL2 APIs to track VRAM and pipelines (default: true)", default: true },
          api: { type: "string", enum: ["auto", "webgpu", "webgl", "webgl2"], default: "auto" },
          viewport: { type: "string", description: "WIDTHxHEIGHT; keep identical across comparisons", default: "1280x720" },
          deviceScaleFactor: { type: "number", minimum: 0.1, maximum: 8, default: 1, description: "Device pixel ratio; keep identical across comparisons" },
          hookName: { type: "string", description: "Benchmark function name (default: __gpuReportBench)" },
          waitForHook: { type: "boolean", description: "Wait for the benchmark hook before sampling; defaults to true in hook mode, false in frames mode" },
          waitCondition: { type: "string", description: "JavaScript readiness expression evaluated before sampling" },
          waitConditionTimeoutMs: { type: "number", minimum: 1 },
          waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
          timeoutMs: { type: "number", minimum: 1 },
          trace: { type: "boolean", description: "Include Chrome trace summary (profile preset enables this)" },
          screenshot: { type: "boolean", description: "Save a screenshot artifact and return its path", default: false },
          includeReport: { type: "boolean", description: "Also return full raw report inline; expensive context opt-in", default: false }
        },
        additionalProperties: false,
        oneOf: [{ required: ["url"] }, { required: ["file"] }]
      }
    },
    {
      name: "inspect_webgpu_report",
      description: "Inspect bounded evidence from a saved capture, comparison, or A/B artifact without launching a browser. Request one section or exact metric instead of loading the full report. Artifact paths refer to this server's filesystem; omitted data stays in the file.",
      inputSchema: {
        type: "object",
        properties: {
          reportPath: { type: "string", description: "Saved report or comparison JSON path on this server" },
          section: { type: "string", enum: ["overview", "metrics", "samples", "errors", "environment", "instrumentation", "trace"], default: "overview" },
          metric: { type: "string", description: "Exact comparison metric key; requires section metrics" },
          offset: { type: "integer", minimum: 0, description: "Zero-based page offset", default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum selected records", default: 3 },
          runIndex: { type: "integer", minimum: 0, description: "Zero-based run in an A/B artifact" }
        },
        additionalProperties: false,
        required: ["reportPath"]
      }
    },
    {
      name: "compare_webgpu_reports",
      description: "Compare a baseline and candidate WebGPU performance report to detect regressions and verify eliminated bottlenecks.",
      inputSchema: {
        type: "object",
        properties: {
          baseReportPath: { type: "string", description: "File path to base report JSON" },
          candidateReportPath: { type: "string", description: "File path to candidate report JSON" },
          primaryMetric: { type: "string", description: "Metric key to include in the digest, even if passing. Display focus only; all metrics are still evaluated." },
          thresholdPercent: { type: "number", minimum: 0, description: "Maximum allowed regression percentage (default: 5)", default: 5 },
          paired: { type: "boolean", description: "Use only for genuinely matched samples", default: false }
        },
        additionalProperties: false,
        required: ["baseReportPath", "candidateReportPath"]
      }
    }
  ];
}

/**
 * Lightweight stdio JSON-RPC MCP server runner for agents.
 */
export async function runMcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const reportDirectory = path.resolve(options.reportDirectory || "reports/mcp");
  const maxQueue = numberOption(options.maxQueue ?? 8, "maxQueue", { min: 1, max: 1000, integer: true });
  const readline = (await import("node:readline")).createInterface({ input, terminal: false });
  const tools = getMcpToolDefinitions();
  // A factory also allows deterministic lifecycle tests without starting a browser.
  const createHarness = options.createHarness || (async () => {
    const { FastCDPHarness } = await import("./fast-cdp-runner.js");
    return FastCDPHarness.launch();
  });
  const pending = new Set();
  let harnessPromise = null;
  let profileQueue = Promise.resolve();
  let profileCount = 0;
  let closing = null;
  let accepting = true;

  function sendResponse(id, result, error = null) {
    if (!output.destroyed && !output.writableEnded) {
      output.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n");
    }
  }

  function close() {
    accepting = false;
    if (!closing) closing = Promise.resolve().then(async () => {
      readline.close();
      try {
        await Promise.allSettled([...pending]);
        if (harnessPromise) await (await harnessPromise).close();
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        input.off("error", onInputError);
        output.off("error", onInputError);
      }
    });
    return closing;
  }
  function onSignal() { void close().catch(() => { process.exitCode = 1; }); }
  function onInputError() { void close().catch(() => {}); }
  if (input === process.stdin) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  input.on("error", onInputError);
  readline.on("error", onInputError);
  output.on("error", onInputError);
  readline.once("close", onInputError);

  async function profile(args) {
    const { includeReport, ...requested } = args;
    // Validate before creating artifacts or starting Chrome; do not coerce booleans.
    const runOptions = normalizeOptions({ preset: "quick", autoInstrument: true, adaptive: false, ...requested });
    if (profileCount >= maxQueue) throw new Error("Profiler queue is full; retry after a pending profile completes.");
    profileCount += 1;
    const job = profileQueue.then(async () => {
      const stem = path.join(reportDirectory, `profile-${randomUUID()}`);
      const reportPath = `${stem}.json`;
      if (runOptions.screenshot) runOptions.screenshotPath = `${stem}.png`;
      await mkdir(reportDirectory, { recursive: true });
      let report;
      try {
        harnessPromise ??= Promise.resolve().then(createHarness).catch(error => { harnessPromise = null; throw error; });
        report = await (await harnessPromise).run(runOptions);
      } catch (error) {
        const message = String(error?.message || error);
        report = {
          schemaVersion: 2, createdAt: new Date().toISOString(), options: runOptions,
          runError: { message, ...(error.code ? { code: error.code } : {}) },
          ...(error.captureDiagnostics ? {
            pageEvents: error.captureDiagnostics.pageEvents,
            pageEventSummary: error.captureDiagnostics.pageEventSummary
          } : {}),
          diagnostics: { validity: { valid: false, issues: [{ code: "run-failed", message }] } }
        };
      }
      // Invalid captures and runner failures remain available for diagnosis too.
      await writeFile(reportPath, JSON.stringify(report), { flag: "wx" });
      const validity = report.diagnostics?.validity || reportValidity(report);
      const recommendations = report.diagnostics?.recommendations || report.summary?.recommendations || [];
      const digest = formatAgentReport(report);
      const actions = recommendations.slice(0, 3).map(item => `- ${brief(item.title)}: ${brief(item.evidence)} Action: ${brief(item.action)}`);
      if (recommendations.length > 3) actions.push(`+${recommendations.length - 3} more recommendations in report.`);
      return {
        content: [{ type: "text", text: [digest, ...actions, `Report: ${reportPath}`, ...(report.artifacts?.screenshotPath ? [`Screenshot: ${report.artifacts.screenshotPath}`] : [])].join("\n") }],
        structuredContent: {
          ok: validity.valid,
          reportPath,
          verdict: report.summary?.verdict || null,
          validity: { valid: validity.valid, issueCount: validity.issues.length, issues: validity.issues.slice(0, 5).map(issue => ({ code: brief(issue.code), message: brief(issue.message) })) },
          recommendationCount: recommendations.length,
          ...(report.pageEventSummary ? { pageEventSummary: report.pageEventSummary } : {}),
          ...(report.artifacts?.screenshotPath ? { screenshotPath: report.artifacts.screenshotPath } : {})
        },
        isError: !validity.valid,
        ...(includeReport ? { report } : {})
      };
    });
    profileQueue = job.catch(() => {});
    try { return await job; } finally { profileCount -= 1; }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === "initialize") {
      sendResponse(id, {
        protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "gpu-perf-agent", version: "2.1.1" }
      });
    } else if (method === "tools/list") sendResponse(id, { tools });
    else if (method === "ping") sendResponse(id, {});
    else if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      const tool = tools.find(tool => tool.name === name);
      if (!tool) return sendResponse(id, null, { code: -32601, message: `Tool not found: ${name}` });
      try {
        validateToolArguments(args, tool.inputSchema);
        if (name === "profile_webgpu") return sendResponse(id, await profile(args));
        if (name === "inspect_webgpu_report") {
          const { inspectReport, validateInspectOptions } = await import("./inspect.js");
          const { reportPath, ...requested } = args;
          const inspectOptions = validateInspectOptions(requested);
          const fullPath = path.resolve(reportPath);
          const report = JSON.parse(await readFile(fullPath, "utf8"));
          const inspection = { reportPath: fullPath, ...inspectReport(report, inspectOptions) };
          return sendResponse(id, {
            content: [{ type: "text", text: JSON.stringify(inspection) }],
            structuredContent: inspection,
            isError: false
          });
        }
        const { loadReport } = await import("./compare.js");
        const [base, candidate] = await Promise.all([loadReport(args.baseReportPath), loadReport(args.candidateReportPath)]);
        const result = compareReports(base, candidate, { thresholdPercent: args.thresholdPercent, paired: args.paired, primaryMetric: args.primaryMetric });
        const { status: headline, exitCode } = comparisonStatus(result);
        const status = headline.toUpperCase();
        const comparisonPath = path.join(reportDirectory, `comparison-${randomUUID()}.json`);
        await mkdir(reportDirectory, { recursive: true });
        await writeFile(comparisonPath, JSON.stringify({ ...result, baseReportPath: path.resolve(args.baseReportPath), candidateReportPath: path.resolve(args.candidateReportPath) }), { flag: "wx" });
        const priority = { regression: 0, missing: 1, inconclusive: 2, improved: 3 };
        const changedRows = result.rows.filter(row => row.status !== "unchanged").sort((a, b) => (priority[a.status] ?? 4) - (priority[b.status] ?? 4));
        const compactRow = row => ({ key: brief(row.key), status: row.status, base: row.base, candidate: row.candidate, deltaPercent: row.deltaPercent, evidence: row.evidence, confidence95: row.confidence95 });
        const primary = args.primaryMetric ? result.rows.find(row => row.key === args.primaryMetric) : null;
        sendResponse(id, {
          content: [{ type: "text", text: `Status: ${status}\n${formatAgentComparison(result, { primaryMetric: args.primaryMetric }).slice(0, 6000)}\nComparison: ${comparisonPath}` }],
          structuredContent: {
            ok: exitCode === 0, status, exitCode, comparisonPath, summary: result.summary,
            changedRowCount: changedRows.length,
            changedRows: changedRows.slice(0, 5).map(compactRow),
            ...(args.primaryMetric ? { primaryMetric: primary ? compactRow(primary) : { key: brief(args.primaryMetric), status: "not-measured" } } : {})
          },
          isError: exitCode === 2
        });
      } catch (error) {
        sendResponse(id, { content: [{ type: "text", text: `Error executing ${name}: ${brief(error?.message || error)}` }], isError: true });
      }
    } else sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
  }

  readline.on("line", line => {
    if (!accepting || !line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { return sendResponse(null, null, { code: -32700, message: "Parse error" }); }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
        || (Object.hasOwn(msg, "id") && msg.id !== null && !["string", "number"].includes(typeof msg.id))) {
      return sendResponse(null, null, { code: -32600, message: "Invalid Request" });
    }
    // Notifications never receive a response or initiate profiling work.
    if (!Object.hasOwn(msg, "id")) return;
    const job = handle(msg).catch(error => sendResponse(msg.id, null, { code: -32603, message: brief(error?.message || error) }));
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return { close };
}

const brief = value => String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 280);

function validateToolArguments(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object.");
  for (const key of schema.required || []) if (!(key in args)) throw new TypeError(`${key} is required.`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new TypeError(`Unknown argument: ${key}.`);
    if (rule.type === "integer" ? !Number.isInteger(value) : typeof value !== rule.type) throw new TypeError(`${key} must be ${rule.type}.`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) throw new TypeError(`${key} is outside its allowed range.`);
    if (typeof value === "string" && !value.trim()) throw new TypeError(`${key} must not be empty.`);
    if (rule.enum && !rule.enum.includes(value)) throw new TypeError(`Invalid ${key}: ${value}.`);
  }
}
