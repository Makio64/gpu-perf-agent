/**
 * Agent-First Helpers: Token-optimized digests, actionable code guidance,
 * and Model Context Protocol (MCP) server integration for AI coding agents.
 */

import { analyzeReport, summarizeReport } from "./diagnostics.js";
import { compareReports } from "./compare.js";

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
    : "uncapped";
  const frameMs = summary.frameTimeMsMean != null ? summary.frameTimeMsMean.toFixed(2) : "--";
  const p95 = summary.frameTimeMsP95 != null ? summary.frameTimeMsP95.toFixed(1) : "--";
  const gpuMs = summary.gpuFrameMsMean != null ? summary.gpuFrameMsMean.toFixed(2) : null;
  const vram = summary.trackedVram?.totalMiB ?? 0;
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
    `- **VRAM**: ${vram.toFixed(1)} MiB (${bufCount} buffers, ${texCount} textures)${leaks > 0 ? ` | ⚠️ Leaked: ${leaks}` : ""}`,
    `- **Pipelines**: ${syncCount} sync stalls, ${asyncCount} async, ${shaderModules} modules`,
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

  const status = result.validity?.valid === false || result.compatibility?.compatible === false ? "INVALID" : result.failures.length > 0 ? "REGRESSION" : result.summary.improved > 0 ? "IMPROVED" : "PASSED";

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
      description: "Profile a WebGPU or WebGL2 web application to capture frame rates, GPU pass duration, VRAM memory footprints, pipeline stalls, and bind group churn.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL to profile" },
          file: { type: "string", description: "Local HTML file path to serve and profile" },
          samples: { type: "number", description: "Number of samples (default: 3 for fast agent turnaround)", default: 3 },
          durationMs: { type: "number", description: "Duration in milliseconds per sample (default: 500)", default: 500 },
          adaptive: { type: "boolean", description: "Enable early stopping when frame rate stabilizes (default: true)", default: true },
          autoInstrument: { type: "boolean", description: "Hook WebGPU/WebGL2 APIs to track VRAM and pipelines (default: true)", default: true },
          trace: { type: "boolean", description: "Include Chrome DevTools trace summary", default: false },
          screenshot: { type: "boolean", description: "Capture a canvas screenshot for visual validation", default: false }
        },
        oneOf: [{ required: ["url"] }, { required: ["file"] }]
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
          thresholdPercent: { type: "number", description: "Maximum allowed regression percentage (default: 5)", default: 5 }
        },
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
  const readline = (await import("node:readline")).createInterface({
    input,
    output: null,
    terminal: false
  });

  const tools = getMcpToolDefinitions();

  function sendResponse(id, result, error = null) {
    const res = { jsonrpc: "2.0", id };
    if (error) {
      res.error = error;
    } else {
      res.result = result;
    }
    output.write(JSON.stringify(res) + "\n");
  }

  readline.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      const { id, method, params } = msg;

      if (method === "tools/list") {
        sendResponse(id, { tools });
        return;
      }

      if (method === "tools/call") {
        const { name, arguments: args = {} } = params || {};
        try {
          if (name === "profile_webgpu") {
            const { runFastReport: runReport } = await import("./fast-cdp-runner.js");
            const report = await runReport({
              url: args.url,
              file: args.file,
              samples: Number(args.samples ?? 3),
              durationMs: Number(args.durationMs ?? 500),
              adaptive: args.adaptive ?? true,
              autoInstrument: args.autoInstrument ?? true,
              trace: Boolean(args.trace),
              screenshot: Boolean(args.screenshot)
            });
            const digest = generateAgentDigest(report);
            sendResponse(id, {
              content: [{ type: "text", text: digest }],
              isError: report.diagnostics?.validity?.valid === false,
              report
            });
            return;
          }

          if (name === "compare_webgpu_reports") {
            const { loadReport } = await import("./compare.js");
            const base = await loadReport(args.baseReportPath);
            const cand = await loadReport(args.candidateReportPath);
            const digest = generateAgentCompareDigest(base, cand, {thresholdPercent: args.thresholdPercent});
            sendResponse(id, {
              content: [{ type: "text", text: digest }]
            });
            return;
          }

          sendResponse(id, null, { code: -32601, message: `Tool not found: ${name}` });
          return;
        } catch (toolErr) {
          sendResponse(id, {
            content: [{ type: "text", text: `Error executing ${name}: ${toolErr?.message || String(toolErr)}` }],
            isError: true
          });
          return;
        }
      }

      if (method === "initialize") {
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "gpu-perf-agent", version: "2.1.0" }
        });
        return;
      }

      // Default ping / notification handler
      if (id != null) {
        sendResponse(id, {});
      }
    } catch (err) {
      // JSON parse error or malformed input
      if (typeof output?.write === "function") {
        output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      }
    }
  });

  return {
    close() {
      readline.close();
    }
  };
}
