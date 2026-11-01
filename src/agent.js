/**
 * Agent-First Helpers: Token-optimized digests, actionable code guidance,
 * and Model Context Protocol (MCP) server integration for AI coding agents.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareReports, comparisonStatus, DECISION_METRICS } from "./compare.js";
import { pruneDirectory } from "./daemon.js";
import { TOOL } from "./fast-cdp-runner.js";
import { measurementLockPath, processAlive } from "./measure-lock.js";
import { applyOptionPrecedence, invalidOption, normalizeOptions, numberOption } from "./options.js";
import { formatAgentComparison, formatAgentReport } from "./output.js";
import { reportValidity } from "./validity.js";

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const LATEST_PROTOCOL_VERSION = "2025-11-25";

export const MCP_INSTRUCTIONS = "Loop: profile_webgpu baseline (label base) -> edit -> profile_webgpu with baseReportPath (screen) -> ab_compare_webgpu to confirm keep/revert. Trust status: invalid means fix the page first; unverified means confirm with ab (the screen is only a hint). quick ~2.5 s warm. Use absolute paths. inspect_webgpu_report for details.";

/**
 * Thin wrapper over output.js formatAgentReport (§7 L4b #10).
 */
export function generateAgentDigest(report, options = {}) {
  return formatAgentReport(report, options);
}

/**
 * Thin wrapper over compareReports + output.js formatAgentComparison (§7 L4b #10).
 */
export function generateAgentCompareDigest(baseReport, candidateReport, options = {}) {
  const result = compareReports(baseReport, candidateReport, options);
  return formatAgentComparison(result, { ...options, baseOptions: baseReport?.options });
}

/**
 * Standard Model Context Protocol (MCP) tool schemas (§7 L4b #1-#2, §8.4).
 * Flat inputSchema (no top-level oneOf/anyOf/allOf); tools/list <= 3 KB.
 */
export function getMcpToolDefinitions() {
  const S = { type: "string" }, N = { type: "number" }, I = { type: "integer" }, B = { type: "boolean" };
  return [
    {
      name: "profile_webgpu",
      title: "Profile WebGPU",
      description: "Profile URL or absolute file.",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          url: S, file: S, fileRoot: S, preset: S, samples: I, durationMs: N, warmup: I,
          samplingMode: S, api: S, viewport: S, deviceScaleFactor: N, hookName: S,
          waitForHook: B, waitCondition: S, waitUntil: S, timeoutMs: N, gpuTiming: B,
          allowIdle: B, readyTimeoutMs: N, cpuProfile: B, trace: B, screenshot: S,
          label: S, baseReportPath: S, primaryMetric: S, thresholdPercent: N
        }
      },
      outputSchema: { type: "object", required: ["ok", "reportPath"] }
    },
    {
      name: "compare_webgpu_reports",
      title: "Compare Reports",
      description: "Compare saved absolute report paths.",
      annotations: { idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          baseReportPath: S, candidateReportPath: S, primaryMetric: S,
          thresholdPercent: N, paired: B, allowMismatch: B
        },
        required: ["baseReportPath", "candidateReportPath"]
      },
      outputSchema: { type: "object", required: ["ok", "status"] }
    },
    {
      name: "ab_compare_webgpu",
      title: "A/B Compare",
      description: "ABBA compare URL or absolute file.",
      annotations: { openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          baseUrl: S, baseFile: S, candidateUrl: S, candidateFile: S, fileRoot: S,
          rounds: I, samples: I, durationMs: N, warmup: I, primaryMetric: S,
          thresholdPercent: N, autoInstrument: B, gpuTiming: B
        }
      },
      outputSchema: { type: "object", required: ["ok", "status"] }
    },
    {
      name: "inspect_webgpu_report",
      title: "Inspect Report",
      description: "Inspect section from absolute reportPath.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          reportPath: S, section: S, metric: S, offset: I, limit: I, runIndex: I
        },
        required: ["reportPath"]
      },
      outputSchema: { type: "object", required: ["reportPath", "section"] }
    },
    {
      name: "doctor_webgpu",
      title: "WebGPU Doctor",
      description: "Check Chrome, WebGPU, reportDir, lock.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", required: ["chrome", "webgpu", "reportDir"] }
    }
  ];
}

/**
 * Lightweight stdio JSON-RPC MCP server runner for agents.
 */
export async function runMcpServer(options = {}) {
  const input = options.input || options.stdin || process.stdin;
  const output = options.output || options.stdout || process.stdout;
  const reportDirectory = await resolveReportDirectory(options.reportDir || options.reportDirectory || process.env.GPU_PERF_REPORT_DIR);
  await pruneDirectory(reportDirectory).catch(() => 0);
  const maxQueue = numberOption(options.maxQueue ?? 8, "maxQueue", { min: 1, max: 1000, integer: true });
  const launchOptions = options.launchOptions || {};
  const readline = (await import("node:readline")).createInterface({ input, terminal: false });
  const tools = getMcpToolDefinitions();
  const createHarness = options.createHarness || (async () => {
    const { FastCDPHarness } = await import("./fast-cdp-runner.js");
    return FastCDPHarness.launch(launchOptions);
  });
  const pending = new Set();
  const activeRequests = new Map();
  let harnessPromise = null;
  let profileQueue = Promise.resolve();
  let profileCount = 0;
  let closing = null;
  let accepting = true;
  let aborted = false;

  function sendJsonMessage(payload) {
    if (!output.destroyed && !output.writableEnded) {
      output.write(JSON.stringify(payload) + "\n");
    }
  }

  function sendResponse(id, result, error = null) {
    sendJsonMessage({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
  }

  function sendNotification(method, params) {
    sendJsonMessage({ jsonrpc: "2.0", method, params });
  }

  async function getLiveHarness() {
    if (harnessPromise) {
      const current = await harnessPromise.catch(() => null);
      if (current && current.alive !== false && !current.cleanupError) {
        return current;
      }
      harnessPromise = null;
      if (current) {
        await current.close?.({ abort: true, timeoutMs: 1000 }).catch(() => {});
      }
    }
    const promise = Promise.resolve().then(createHarness).catch(error => {
      if (harnessPromise === promise) harnessPromise = null;
      throw error;
    });
    harnessPromise = promise;
    return promise;
  }

  async function runOnWarmHarness(runFn) {
    const current = await getLiveHarness();
    try {
      return await runFn(current);
    } catch (error) {
      const relaunchAbort = error?.code === "aborted" && error.reason === "harness-closed";
      if (error?.samplingStarted !== false || current.alive !== false || current.cleanupError || aborted) throw error;
      if (error?.code === "aborted" && !relaunchAbort) throw error;
      return runFn(await getLiveHarness());
    }
  }

  function close({ abort = false } = {}) {
    accepting = false;
    if (abort) {
      aborted = true;
      for (const entry of activeRequests.values()) {
        entry.cancelled = true;
        entry.controller.abort();
        entry.releaseSlot?.();
      }
      activeRequests.clear();
    }
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        readline.close();
        try {
          if (abort) {
            const closeHarness = async () => {
              if (!harnessPromise) return;
              const current = await harnessPromise.catch(() => null);
              if (current) await current.close?.({ abort: true, timeoutMs: 1200 }).catch(() => {});
            };
            let timer;
            await Promise.race([
              closeHarness(),
              new Promise(resolve => { timer = setTimeout(resolve, 1500); timer.unref?.(); })
            ]).finally(() => clearTimeout(timer));
          } else {
            await Promise.allSettled([...pending]);
            if (harnessPromise) {
              const current = await harnessPromise.catch(() => null);
              if (current) await current.close?.().catch(() => {});
            }
          }
        } finally {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          input.off("error", onInputError);
          output.off("error", onInputError);
          readline.off("close", onInputClose);
        }
      });
    }
    return closing;
  }

  function onSignal() {
    void close({ abort: true }).catch(() => { process.exitCode = 1; });
  }
  function onInputError() {
    void close({ abort: false }).catch(() => {});
  }
  function onInputClose() {
    if (closing) return;
    // Wait one microtask so synchronous send()+input.end() unit tests queue their lines first;
    // if an in-flight capture is running on real stdin, abort it within the 1.5s budget.
    const abortOnEof = input === process.stdin || options.abortOnEof === true;
    void close({ abort: abortOnEof }).catch(() => {});
  }

  if (input === process.stdin) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  input.on("error", onInputError);
  readline.on("error", onInputError);
  output.on("error", onInputError);
  readline.once("close", onInputClose);

  function enqueueSerialized(requestId, taskFn) {
    if (profileCount >= maxQueue) {
      throw new Error("Profiler queue is full; retry after a pending profile completes.");
    }
    profileCount += 1;
    let slotReleased = false;
    const entry = {
      id: requestId,
      controller: new AbortController(),
      status: "queued",
      cancelled: false,
      releaseSlot() {
        if (!slotReleased) {
          slotReleased = true;
          profileCount = Math.max(0, profileCount - 1);
        }
      }
    };
    if (requestId !== null && requestId !== undefined) {
      activeRequests.set(String(requestId), entry);
    }

    const job = profileQueue.then(async () => {
      if (entry.cancelled || aborted) return null;
      entry.status = "running";
      return taskFn(entry);
    });
    profileQueue = job.catch(() => {});
    return job.finally(() => {
      entry.releaseSlot();
      if (requestId !== null && requestId !== undefined) {
        activeRequests.delete(String(requestId));
      }
    });
  }

  function makeProgressEmitter(progressToken, expectedTotal, entry) {
    if (progressToken === undefined || progressToken === null) {
      return { onProgress: undefined, flushIfEmpty() {} };
    }
    let step = 0;
    const emit = (event) => {
      if (entry?.cancelled || aborted) return;
      step += 1;
      const total = Math.max(step, expectedTotal || 1);
      const message = formatProgressMessage(event, step, total);
      sendNotification("notifications/progress", {
        progressToken,
        progress: step,
        total,
        ...(message ? { message } : {})
      });
    };
    return {
      onProgress: emit,
      flushIfEmpty(warmupCount = 0, sampleCount = 0) {
        if (step > 0 || entry?.cancelled || aborted) return;
        for (let i = 0; i < warmupCount; i += 1) emit({ stage: "warmup", index: i, total: warmupCount });
        for (let i = 0; i < sampleCount; i += 1) emit({ stage: "sample", index: i, total: sampleCount });
      }
    };
  }

  async function profile(args, { requestId, progressToken } = {}) {
    const {
      includeReport,
      screenshot: rawScreenshot,
      baseReportPath,
      primaryMetric,
      thresholdPercent,
      ...requested
    } = args;

    const screenshotMode = rawScreenshot === true ? "file" : rawScreenshot === false || rawScreenshot === undefined ? "none" : rawScreenshot;
    if (!["none", "file", "inline"].includes(screenshotMode)) {
      throw invalidOption('screenshot must be "none", "file", or "inline".');
    }

    let baseReport = null;
    let resolvedBasePath = null;
    if (baseReportPath !== undefined) {
      resolvedBasePath = path.resolve(baseReportPath);
      const { loadReport } = await import("./compare.js");
      baseReport = await loadReport(resolvedBasePath);
    }

    const explicit = { ...requested };
    const mergedOptions = baseReport
      ? applyOptionPrecedence({
          explicit: { ...explicit, preset: undefined },
          base: baseReport,
          preset: requested.preset ?? "quick",
          defaults: { autoInstrument: true, adaptive: false }
        })
      : { preset: "quick", autoInstrument: true, adaptive: false, ...explicit };

    mergedOptions.screenshot = screenshotMode === "file";
    const runOptions = normalizeOptions(mergedOptions);
    if (thresholdPercent !== undefined) numberOption(thresholdPercent, "thresholdPercent", { min: 0 });

    return enqueueSerialized(requestId, async (entry) => {
      await mkdir(reportDirectory, { recursive: true });
      const stem = await nextReportStem(reportDirectory, runOptions.label);
      const reportPath = `${stem}.json`;
      if (screenshotMode === "file") runOptions.screenshotPath = `${stem}.png`;
      if (screenshotMode === "inline") runOptions.screenshotJpegPath = `${stem}.jpg`;

      const expectedSteps = (Number(runOptions.warmup) || 0) + (Number(runOptions.samples) || 0);
      const progress = makeProgressEmitter(progressToken, expectedSteps, entry);

      let report;
      try {
        report = await runOnWarmHarness(harness => harness.run(runOptions, {
          onProgress: progress.onProgress,
          signal: entry.controller.signal
        }));
        progress.flushIfEmpty(runOptions.warmup, runOptions.samples);
      } catch (error) {
        if (entry.cancelled || error?.code === "aborted") return null;
        const message = String(error?.message || error);
        report = {
          schemaVersion: 3,
          tool: TOOL,
          createdAt: new Date().toISOString(),
          options: runOptions,
          runError: {
            code: error?.code || "run-failed",
            message,
            ...(error?.hint ? { hint: error.hint } : {})
          },
          ...(error?.captureDiagnostics ? {
            pageEvents: error.captureDiagnostics.pageEvents,
            pageEventSummary: error.captureDiagnostics.pageEventSummary
          } : {}),
          summary: {
            verdict: "invalid",
            verdictReasons: [{ code: "run-failed", role: "cause", severity: "high", message }],
            warnings: [],
            warningCount: 0,
            recommendations: []
          },
          diagnostics: {
            validity: { valid: false, issues: [{ code: "run-failed", severity: "invalid", message }], warnings: [] },
            recommendations: []
          }
        };
      }
      if (entry.cancelled) return null;

      await writeFile(reportPath, JSON.stringify(report), { flag: "wx" });
      const validity = report.diagnostics?.validity || reportValidity(report);
      const recommendations = report.diagnostics?.recommendations || report.summary?.recommendations || [];
      const shownReportPath = displayPath(reportPath);
      const shownScreenshotPath = report.artifacts?.screenshotPath ? displayPath(report.artifacts.screenshotPath) : null;

      let comparisonInfo = null;
      let comparisonDigestText = null;
      if (baseReport && !report.runError) {
        const cmpResult = compareReports(baseReport, report, {
          thresholdPercent,
          primaryMetric
        });
        const cmpHeadline = comparisonStatus(cmpResult);
        const comparisonPath = `${stem}.compare.json`;
        await writeFile(comparisonPath, JSON.stringify({
          ...cmpResult,
          baseReportPath: resolvedBasePath,
          candidateReportPath: reportPath
        }));
        const shownComparisonPath = displayPath(comparisonPath);
        comparisonInfo = {
          status: cmpHeadline.status.toUpperCase(),
          exitCode: cmpHeadline.exitCode,
          primary: compactPrimary(cmpResult),
          comparisonPath: shownComparisonPath
        };
        comparisonDigestText = formatAgentComparison(cmpResult, {
          out: shownComparisonPath,
          primaryMetric,
          baseOptions: baseReport.options
        });
      }

      const digest = formatAgentReport(report, { out: shownReportPath });
      const actions = recommendations.slice(0, 3).map(item => `- ${brief(item.title)}: ${brief(item.evidence)} Action: ${brief(item.action)}`);
      if (recommendations.length > 3) actions.push(`+${recommendations.length - 3} more recommendations in report.`);
      const textParts = [digest, ...actions];
      if (!digest.includes("Report:")) textParts.push(`Report: ${shownReportPath}`);
      if (shownScreenshotPath) textParts.push(`Screenshot: ${shownScreenshotPath}`);
      if (comparisonDigestText) {
        textParts.push(`vs base ${displayPath(resolvedBasePath)}:`, comparisonDigestText);
        if (!comparisonDigestText.includes("Saved:") && !comparisonDigestText.includes("Comparison:")) {
          textParts.push(`Comparison: ${comparisonInfo.comparisonPath}`);
        }
      }

      const content = [{ type: "text", text: textParts.join("\n") }];
      if (screenshotMode === "inline" && report.artifacts?.screenshotJpegPath) {
        try {
          const jpegBytes = await readFile(report.artifacts.screenshotJpegPath);
          content.push({
            type: "image",
            data: jpegBytes.toString("base64"),
            mimeType: "image/jpeg"
          });
        } catch {
          // If screenshot file wasn't produced on a mock harness, skip image item.
        }
      }
      content.push({
        type: "resource_link",
        uri: pathToFileURL(reportPath).href,
        name: path.basename(reportPath),
        mimeType: "application/json"
      });

      const status = report.runError ? "error" : validity.valid ? "ok" : "invalid";
      const ok = validity.valid && !report.runError && (!comparisonInfo || comparisonInfo.exitCode === 0);
      const isError = !validity.valid || Boolean(report.runError) || comparisonInfo?.exitCode === 2;
      const pageEvents = compactPageEventSummary(report.pageEventSummary);

      return {
        content,
        structuredContent: {
          ok,
          status,
          reportPath: shownReportPath,
          verdict: report.summary?.verdict || (validity.valid ? null : "invalid"),
          reasons: extractReasons(report, validity),
          bottleneck: {
            class: report.summary?.bottleneck?.class ?? null,
            primaryMetric: report.summary?.bottleneck?.primaryMetric ?? null
          },
          metrics: extractMetrics(report),
          validity: {
            valid: validity.valid,
            issueCount: (validity.issues || []).length,
            issues: (validity.issues || []).slice(0, 3).map(issue => ({ code: brief(issue.code), message: brief(issue.message) })),
            warnings: (validity.warnings || []).slice(0, 3).map(warn => ({ code: brief(warn.code), message: brief(warn.message) }))
          },
          lockWaitMs: sig4(report.timings?.lockWaitMs ?? report.measurementLock?.waitedMs ?? 0) ?? 0,
          recommendationCount: recommendations.length,
          ...(pageEvents ? { pageEventSummary: pageEvents } : {}),
          ...(shownScreenshotPath ? { screenshotPath: shownScreenshotPath } : {}),
          ...(comparisonInfo ? { comparison: comparisonInfo } : {})
        },
        isError,
        ...(includeReport ? { report } : {})
      };
    });
  }

  async function abCompare(args, { requestId, progressToken } = {}) {
    const base = resolveVariantTarget(args.baseUrl, args.baseFile, args.fileRoot, "base");
    const candidate = resolveVariantTarget(args.candidateUrl, args.candidateFile, args.fileRoot, "candidate");
    const rounds = numberOption(args.rounds ?? 4, "rounds", { min: 2, max: 1000, integer: true });
    const samples = numberOption(args.samples ?? 1, "samples", { min: 1, max: 10000, integer: true });
    const durationMs = numberOption(args.durationMs ?? 250, "durationMs", { min: 1, max: 3600000 });
    const warmup = numberOption(args.warmup ?? 1, "warmup", { min: 0, max: 10000, integer: true });
    const thresholdPercent = numberOption(args.thresholdPercent ?? 5, "thresholdPercent", { min: 0 });
    const autoInstrument = args.autoInstrument ?? true;
    const gpuTiming = args.gpuTiming ?? true;
    const allowMismatch = args.allowMismatch === true;

    normalizeOptions({ ...base, samples, durationMs, warmup, autoInstrument, gpuTiming });
    normalizeOptions({ ...candidate, samples, durationMs, warmup, autoInstrument, gpuTiming });

    return enqueueSerialized(requestId, async (entry) => {
      const { runABComparison } = await import("./ab-runner.js");
      const expectedSteps = rounds * 2 * (warmup + samples);
      const progress = makeProgressEmitter(progressToken, expectedSteps, entry);
      const startedAt = performance.now();
      let abResult;
      try {
        abResult = await runOnWarmHarness(harness => runABComparison({
          base,
          candidate,
          rounds,
          samples,
          durationMs,
          warmup,
          thresholdPercent,
          primaryMetric: args.primaryMetric,
          autoInstrument,
          gpuTiming,
          allowMismatch
        }, {
          harness,
          onProgress: progress.onProgress,
          signal: entry.controller.signal
        }));
      } catch (error) {
        if (entry.cancelled || error?.code === "aborted") return null;
        throw error;
      }
      if (entry.cancelled) return null;
      const wallMs = sig4(performance.now() - startedAt) ?? 0;

      await mkdir(reportDirectory, { recursive: true });
      const comparisonPath = path.join(reportDirectory, `ab-${compactTimestamp()}-${randomBytes(2).toString("hex")}.compare.json`);
      await writeFile(comparisonPath, JSON.stringify(abResult));

      return buildComparisonResponse(abResult.comparison, {
        comparisonPath,
        primaryMetric: args.primaryMetric,
        allowMismatch,
        extraStructured: { rounds: abResult.rounds, wallMs }
      });
    });
  }

  async function doctor() {
    let writable = false;
    try {
      await mkdir(reportDirectory, { recursive: true });
      await access(reportDirectory, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }

    const lockPath = measurementLockPath();
    let lock = { held: false, holder: null, path: lockPath };
    try {
      const raw = JSON.parse(await readFile(lockPath, "utf8"));
      const alive = processAlive(raw?.pid);
      lock = {
        held: alive,
        holder: alive && raw?.pid ? { pid: raw.pid, label: raw.label ?? "" } : null,
        path: lockPath
      };
    } catch {
      // Lock file is absent when idle.
    }

    const harness = await getLiveHarness();
    const probed = typeof harness.probe === "function"
      ? await harness.probe()
      : {
          chrome: { version: null, path: null },
          webgpu: { available: false, adapter: null, timestampQuery: false },
          webgl2: { available: false, renderer: null }
        };

    const structuredContent = {
      chrome: {
        version: probed.chrome?.version ?? null,
        path: probed.chrome?.path ?? null
      },
      webgpu: {
        available: Boolean(probed.webgpu?.available),
        adapter: probed.webgpu?.adapter ?? null,
        timestampQuery: Boolean(probed.webgpu?.timestampQuery),
        ...(probed.webgpu?.error ? { error: probed.webgpu.error } : {})
      },
      webgl2: {
        available: Boolean(probed.webgl2?.available),
        renderer: probed.webgl2?.renderer ?? null,
        ...(probed.webgl2?.error ? { error: probed.webgl2.error } : {})
      },
      reportDir: {
        path: displayPath(reportDirectory),
        writable
      },
      nodeUseSystemCa: Boolean(process.env.NODE_USE_SYSTEM_CA && process.env.NODE_USE_SYSTEM_CA !== "0"),
      lock
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false
    };
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === "initialize") {
      sendResponse(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: TOOL.name, version: TOOL.version },
        instructions: MCP_INSTRUCTIONS
      });
    } else if (method === "tools/list") {
      sendResponse(id, { tools });
    } else if (method === "ping") {
      sendResponse(id, {});
    } else if (method === "tools/call") {
      const { name, arguments: rawArgs = {}, _meta } = params || {};
      const tool = tools.find(item => item.name === name);
      if (!tool) return sendResponse(id, null, { code: -32602, message: `Invalid params: unknown tool ${name}` });
      try {
        const args = normalizeToolArgs(name, rawArgs);
        validateToolArguments(name, args, tool.inputSchema);
        const progressToken = _meta?.progressToken ?? rawArgs?._meta?.progressToken;
        if (name === "profile_webgpu") {
          const response = await profile(args, { requestId: id, progressToken });
          if (response) sendResponse(id, response);
          return;
        }
        if (name === "ab_compare_webgpu") {
          const response = await abCompare(args, { requestId: id, progressToken });
          if (response) sendResponse(id, response);
          return;
        }
        if (name === "doctor_webgpu") {
          return sendResponse(id, await doctor());
        }
        if (name === "inspect_webgpu_report") {
          const inspection = await runInspect(args);
          return sendResponse(id, {
            content: [{ type: "text", text: JSON.stringify(inspection) }],
            structuredContent: inspection,
            isError: false
          });
        }
        const { loadReport } = await import("./compare.js");
        const allowMismatch = args.allowMismatch === true;
        const [base, candidate] = await Promise.all([loadReport(args.baseReportPath), loadReport(args.candidateReportPath)]);
        const result = compareReports(base, candidate, {
          thresholdPercent: args.thresholdPercent,
          paired: args.paired,
          primaryMetric: args.primaryMetric,
          allowMismatch
        });
        await mkdir(reportDirectory, { recursive: true });
        const comparisonPath = await nextComparisonPath(reportDirectory, args.candidateReportPath);
        await writeFile(comparisonPath, JSON.stringify({
          ...result,
          baseReportPath: path.resolve(args.baseReportPath),
          candidateReportPath: path.resolve(args.candidateReportPath)
        }));
        sendResponse(id, buildComparisonResponse(result, {
          comparisonPath,
          primaryMetric: args.primaryMetric,
          allowMismatch,
          baseOptions: base?.options
        }));
      } catch (error) {
        sendResponse(id, { content: [{ type: "text", text: `Error executing ${name}: ${brief(error?.message || error)}` }], isError: true });
      }
    } else {
      sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
    }
  }

  readline.on("line", line => {
    if (!accepting || !line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { return sendResponse(null, null, { code: -32700, message: "Parse error" }); }
    const hasId = Boolean(msg && typeof msg === "object" && !Array.isArray(msg) && Object.hasOwn(msg, "id"));
    const echoedId = hasId && (typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id))) ? msg.id : null;
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
        || (hasId && msg.id !== null && echoedId === null)) {
      return sendResponse(echoedId, null, { code: -32600, message: "Invalid Request" });
    }
    if (!hasId) {
      if (msg.method === "notifications/cancelled") {
        const requestId = msg.params?.requestId;
        if (requestId !== undefined && requestId !== null) {
          const entry = activeRequests.get(String(requestId));
          if (entry) {
            entry.cancelled = true;
            entry.controller.abort();
            entry.releaseSlot?.();
            activeRequests.delete(String(requestId));
          }
        }
      }
      return;
    }
    const job = handle(msg).catch(error => sendResponse(msg.id, null, { code: -32603, message: brief(error?.message || error) }));
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return { close };
}

const brief = value => String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 280);

function sig4(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0) return 0;
  return Number(value.toPrecision(4));
}

function roundDeep(value) {
  if (typeof value === "number") return sig4(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]));
  }
  return value;
}

function displayPath(targetPath, cwd = process.cwd()) {
  if (!targetPath || typeof targetPath !== "string") return targetPath;
  const resolved = path.resolve(targetPath);
  const rel = path.relative(cwd, resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return resolved;
}

function compactTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

async function resolveReportDirectory(explicitDir) {
  const candidates = [
    explicitDir ? path.resolve(explicitDir) : path.resolve("reports/mcp"),
    path.join(os.tmpdir(), "gpu-perf-agent", "reports")
  ];
  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true });
      await access(candidate, constants.W_OK);
      return candidate;
    } catch {
      // Fall back to os.tmpdir() when cwd is not writable.
    }
  }
  return candidates[0];
}

async function nextReportStem(reportDir, label = null) {
  if (label) {
    for (let index = 1; index < 100000; index += 1) {
      const candidate = path.join(reportDir, `${label}-${index}`);
      try {
        await stat(`${candidate}.json`);
      } catch {
        return candidate;
      }
    }
  }
  return path.join(reportDir, `profile-${compactTimestamp()}-${randomBytes(2).toString("hex")}`);
}

async function nextComparisonPath(reportDir, candidateReportPath) {
  const baseName = path.basename(String(candidateReportPath || "comparison"), ".json").replace(/[^A-Za-z0-9._-]/g, "_");
  const primaryCandidate = path.join(reportDir, `${baseName}.compare.json`);
  try {
    await stat(primaryCandidate);
    return path.join(reportDir, `${baseName}-${compactTimestamp()}-${randomBytes(2).toString("hex")}.compare.json`);
  } catch {
    return primaryCandidate;
  }
}

function extractReasons(report, validity) {
  if (!validity.valid) {
    return (validity.issues || []).slice(0, 3).map(issue => brief(issue.code));
  }
  const verdictReasons = report.summary?.verdictReasons;
  if (Array.isArray(verdictReasons) && verdictReasons.length > 0) {
    return verdictReasons.slice(0, 3).map(item => brief(item.code));
  }
  const recs = report.diagnostics?.recommendations || report.summary?.recommendations || [];
  return recs.slice(0, 3).map(item => brief(item.id || item.code));
}

function extractMetrics(report) {
  const s = report.summary || {};
  const signal = report.diagnostics?.signal || {};
  const gpuStableStatus = s.gpu?.stability?.status ?? signal.autoGpu?.stability?.status ?? signal.gpuTiming?.stability?.status ?? null;
  const clockSensitive = s.gpu?.stability?.clockSensitive ?? signal.autoGpu?.clockSensitive ?? signal.gpuTiming?.stability?.clockSensitive ?? null;
  return {
    fps: sig4(s.fps),
    pageFps: sig4(s.pageFps ?? s.fps),
    frameMs: sig4(s.frameTimeMsMean),
    frameP95Ms: sig4(s.frameTimeMsP95),
    gpuMs: sig4(s.bottleneck?.gpuMs ?? s.gpu?.frameMsP50 ?? s.gpuFrameMsMean),
    gpuSource: s.gpu?.source ?? s.bottleneck?.gpuSource ?? null,
    gpuSaturated: Boolean(s.bottleneck?.gpuSaturated || s.gpu?.plausibility?.status === "saturated"),
    gpuStable: gpuStableStatus ? gpuStableStatus === "stable" : null,
    clockSensitive: typeof clockSensitive === "boolean" ? clockSensitive : null,
    cpuMsPerFrame: sig4(s.cpuMsPerFrame),
    vramMiB: sig4(s.trackedVram?.totalMiB),
    drawsPerFrame: sig4(s.drawCallsPerFrame ?? s.webgpuOps?.drawCalls),
    retainedHeapMiBPerSec: sig4(s.heap?.retainedMiBPerSec ?? s.jsHeapGrowthMBPerSec)
  };
}

function compactPageEventSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const counts = summary.counts && typeof summary.counts === "object"
    ? Object.fromEntries(Object.entries(summary.counts).filter(([, v]) => Number.isFinite(v) && v > 0))
    : {};
  const hasActivity = (Number(summary.total) || 0) > 0 || (Number(summary.dropped) || 0) > 0 || Object.keys(counts).length > 0;
  if (!hasActivity) return null;
  const { limits, retainedCounts, ...rest } = summary;
  return rest;
}

function compactRow(row) {
  const ci = row.confidence95
    ? {
        low: sig4(row.confidence95.low),
        high: sig4(row.confidence95.high),
        ...(row.confidence95.method ? { method: row.confidence95.method } : {})
      }
    : null;
  return {
    key: brief(row.key),
    status: row.status,
    base: sig4(row.base),
    candidate: sig4(row.candidate),
    deltaPercent: sig4(row.deltaPercent),
    evidence: row.evidence ?? null,
    confidence95: ci,
    ...(row.screen != null ? { screen: row.screen } : {}),
    ...(Array.isArray(row.reasons) && row.reasons.length ? { reasons: row.reasons } : {})
  };
}

function compactPrimary(result) {
  if (!result?.primary) return null;
  const row = result.primary.row;
  return {
    key: result.primary.key ?? row?.key ?? null,
    selection: result.primary.selection ?? null,
    ...(row ? compactRow(row) : {
      status: "unverified",
      base: null,
      candidate: null,
      deltaPercent: null,
      evidence: null,
      confidence95: null,
      screen: null
    })
  };
}

function buildComparisonResponse(result, { comparisonPath, primaryMetric, allowMismatch = false, baseOptions, extraStructured = {} } = {}) {
  const { status: headline, exitCode } = comparisonStatus(result, { allowMismatch });
  const status = headline.toUpperCase();
  const shownPath = displayPath(comparisonPath);
  const priority = { regression: 0, missing: 1, inconclusive: 2, improved: 3, unverified: 4, changed: 5 };
  const rows = result.rows || [];
  const changedRows = rows
    .filter(row => row.status !== "unchanged")
    .sort((a, b) => (priority[a.status] ?? 6) - (priority[b.status] ?? 6));
  const decisionRows = rows
    .filter(row => row.gated || Object.hasOwn(DECISION_METRICS, row.key) || /^custom\..+\.mean$/.test(row.key))
    .sort((a, b) => (priority[a.status] ?? 6) - (priority[b.status] ?? 6))
    .slice(0, 5)
    .map(compactRow);
  const explicitPrimary = primaryMetric ? rows.find(row => row.key === primaryMetric) : null;
  const digestText = formatAgentComparison(result, { out: shownPath, primaryMetric, baseOptions }).slice(0, 6000);
  const textLines = [`Status: ${status}`, digestText];
  if (!digestText.includes("Comparison:") && !digestText.includes("Saved:")) {
    textLines.push(`Comparison: ${shownPath}`);
  }

  return {
    content: [
      { type: "text", text: textLines.join("\n") },
      {
        type: "resource_link",
        uri: pathToFileURL(comparisonPath).href,
        name: path.basename(comparisonPath),
        mimeType: "application/json"
      }
    ],
    structuredContent: {
      ok: exitCode === 0,
      status,
      exitCode,
      mode: result.mode || "separate",
      primary: compactPrimary(result),
      decisionRows,
      workEquivalence: roundDeep(result.workEquivalence || { status: "same", differences: [] }),
      comparisonPath: shownPath,
      summary: result.summary,
      changedRowCount: changedRows.length,
      changedRows: changedRows.slice(0, 5).map(compactRow),
      ...(primaryMetric ? { primaryMetric: explicitPrimary ? compactRow(explicitPrimary) : { key: brief(primaryMetric), status: "not-measured" } } : {}),
      ...extraStructured
    },
    isError: exitCode === 2
  };
}

async function runInspect(args) {
  const { inspectReport, validateInspectOptions, INSPECT_SECTIONS } = await import("./inspect.js");
  const { reportPath, ...requested } = args;
  const section = requested.section ?? "overview";
  const limit = requested.limit ?? 2;
  const offset = requested.offset ?? 0;

  if (!INSPECT_SECTIONS.includes(section) && (section === "gpu" || section === "cpu")) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be an integer >= 0.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError("limit must be an integer from 1 to 10.");
    if (requested.metric !== undefined) throw new TypeError('metric requires section "metrics".');
    const fullPath = path.resolve(reportPath);
    const artifact = JSON.parse(await readFile(fullPath, "utf8"));
    let report = artifact;
    if (requested.runIndex !== undefined) {
      if (!Array.isArray(artifact.runs) || requested.runIndex >= artifact.runs.length) {
        throw new RangeError("runIndex does not select an existing A/B run.");
      }
      report = artifact.runs[requested.runIndex]?.report;
    }
    const rawData = section === "gpu"
      ? (report?.summary?.gpu ?? report?.inPage?.summary?.autoGpu ?? null)
      : (report?.cpuProfile ?? null);
    return {
      reportPath: displayPath(fullPath),
      section,
      data: roundDeep(rawData)
    };
  }

  const inspectOptions = validateInspectOptions({ ...requested, section, limit, offset });
  const fullPath = path.resolve(reportPath);
  const report = JSON.parse(await readFile(fullPath, "utf8"));
  const inspected = inspectReport(report, inspectOptions);
  return { reportPath: displayPath(fullPath), ...inspected };
}

function resolveVariantTarget(url, file, fileRoot, label) {
  if (url && file) throw invalidOption(`Choose exactly one ${label} target: ${label}Url or ${label}File.`);
  if (!url && !file) throw invalidOption(`A ${label} target is required: pass ${label}Url or ${label}File.`);
  if (url) return { url };
  return { file, ...(fileRoot ? { fileRoot } : {}) };
}

function formatProgressMessage(event, step, total) {
  if (!event || typeof event !== "object") return `step ${step}/${total}`;
  const prefix = event.round !== undefined ? `round ${event.round + 1}/${event.rounds} (${event.variant}) ` : "";
  if (event.stage === "sample" && Number.isInteger(event.index)) {
    return `${prefix}sample ${event.index + 1}/${event.total || total}`;
  }
  if (event.stage === "warmup" && Number.isInteger(event.index)) {
    return `${prefix}warmup ${event.index + 1}/${event.total || total}`;
  }
  return `${prefix}${event.stage || "progress"}`;
}

function normalizeToolArgs(name, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;
  const args = { ...rawArgs };
  delete args._meta;
  if (name === "profile_webgpu" && typeof args.screenshot === "boolean") {
    args.screenshot = args.screenshot ? "file" : "none";
  }
  return args;
}

const EXTRA_TOOL_PROPERTIES = Object.freeze({
  profile_webgpu: Object.freeze({
    adaptive: { type: "boolean" },
    autoInstrument: { type: "boolean" },
    waitConditionTimeoutMs: { type: "number" },
    networkIdleBudgetMs: { type: "number" },
    includeReport: { type: "boolean" }
  }),
  ab_compare_webgpu: Object.freeze({
    allowMismatch: { type: "boolean" }
  })
});

function validateToolArguments(name, args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object.");
  for (const key of schema.required || []) if (!(key in args)) throw new TypeError(`${key} is required.`);
  const extra = EXTRA_TOOL_PROPERTIES[name] || {};
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key] || extra[key];
    if (!rule) throw new TypeError(`Unknown argument: ${key}.`);
    if (rule.type === "integer" ? !Number.isInteger(value) : typeof value !== rule.type) throw new TypeError(`${key} must be ${rule.type}.`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) throw new TypeError(`${key} is outside its allowed range.`);
    if (typeof value === "string" && !value.trim()) throw new TypeError(`${key} must not be empty.`);
    if (rule.enum && !rule.enum.includes(value)) throw new TypeError(`Invalid ${key}: ${value}.`);
  }
}
