#!/usr/bin/env node
import { access, constants as fsConstants, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const TOOL = Object.freeze({ name: "gpu-perf-agent", version: "2.3.0" });

function relPath(targetPath, cwd = process.cwd()) {
  if (!targetPath || typeof targetPath !== "string") return "";
  const rel = path.relative(cwd, path.resolve(targetPath));
  if (!rel) return path.basename(targetPath);
  return rel.startsWith("..") ? targetPath : rel;
}

// Launch flags belong to `serve`; the rest are recomputed by the service.
const SERVER_OMITTED_KEYS = new Set(["angle", "channel", "executablePath", "headful", "chromiumArgs", "cdp", "cdpUrl", "webSocketUrl", "cdpAttached", "launchTimeoutMs"]);

function daemonDisabled(options = {}) {
  const flag = process.env.GPU_PERF_AGENT_NO_DAEMON;
  return Boolean(options.noDaemon || (flag && flag !== "0" && flag !== "false"));
}

const RUN_OPTIONS = {
  url: { type: "string", desc: "Target URL to profile." },
  file: { type: "string", desc: "Local HTML file to serve and profile." },
  "file-root": { type: "string", desc: "Serve module imports from a sibling project root." },
  out: { type: "string", desc: "Output JSON report path (default: reports/<slug>-<n>.json)." },
  label: { type: "string", desc: "Human-readable label for default report naming." },
  preset: { type: "string", desc: "quick|confirm|profile|default sampling preset." },
  api: { type: "string", desc: "auto|webgpu|webgl|webgl2 capability probe selection." },
  "sampling-mode": { type: "string", desc: "frames|hook sampling mode (frames by default)." },
  "auto-instrument": { type: "boolean", desc: "Track WebGPU/WebGL resources, draws, dispatches, and passes." },
  "no-auto-instrument": { type: "boolean", desc: "Disable automatic WebGPU/WebGL instrumentation." },
  "gpu-timing": { type: "boolean", desc: "Enable automatic WebGPU timestamp-query pass timing." },
  "no-gpu-timing": { type: "boolean", desc: "Disable automatic WebGPU timestamp-query pass timing." },
  "duration-ms": { type: "string", desc: "Per-sample duration in milliseconds." },
  samples: { type: "string", desc: "Number of measured samples." },
  warmup: { type: "string", desc: "Number of warmup samples before measurement." },
  adaptive: { type: "boolean", desc: "Stop after >=3 samples once stable (GPU p50 CV < 3%, else FPS/frame times)." },
  gc: { type: "boolean", desc: "Force GC around sampling for retained heap bracket." },
  "deep-memory": { type: "boolean", desc: "Opt in to user-agent specific memory measurements." },
  "cpu-profile": { type: "string", desc: "auto|true|false CDP CPU profiler control." },
  "no-cpu-profile": { type: "boolean", desc: "Disable automatic CDP CPU profiling on slow captures." },
  "allow-idle": { type: "boolean", desc: "Allow captures with zero observed GPU/frame work." },
  "ready-timeout": { type: "string", desc: "Timeout in ms for automatic scene readiness." },
  "network-idle-budget": { type: "string", desc: "Max ms to wait for network idle before sampling." },
  "wait-until": { type: "string", desc: "load|domcontentloaded|networkidle|commit navigation state." },
  "wait-condition": { type: "string", desc: "JS expression to await before sampling." },
  "wait-condition-timeout": { type: "string", desc: "Timeout in ms for --wait-condition." },
  "wait-for-hook": { type: "boolean", desc: "Wait for the benchmark hook after async startup." },
  "wait-for-hook-timeout": { type: "string", desc: "Timeout in ms for --wait-for-hook (default: 15000)." },
  hook: { type: "string", desc: "Window benchmark hook name (default: __gpuReportBench)." },
  "hook-name": { type: "string", desc: "Alias for --hook." },
  "slow-frame-threshold": { type: "string", desc: "Slow-frame cutoff in ms (default: 20)." },
  timeout: { type: "string", desc: "Overall navigation and sampling timeout in ms." },
  viewport: { type: "string", desc: "Viewport dimensions WIDTHxHEIGHT (default: 1280x720)." },
  "device-scale-factor": { type: "string", desc: "Device pixel ratio override." },
  context: { type: "string", desc: "isolated|shared browser storage context." },
  server: { type: "string", desc: "Reuse a running profiler HTTP service (--server URL)." },
  "no-daemon": { type: "boolean", desc: "Disable automatic warm background daemon reuse." },
  "no-lock": { type: "boolean", desc: "Disable cross-process GPU measurement lock." },
  "lock-timeout": { type: "string", desc: "Max ms to wait for the GPU measurement lock." },
  cdp: { type: "string", desc: "Attach to an existing Chrome debugging port or ws:// URL." },
  "cdp-url": { type: "string", desc: "Alias for --cdp." },
  runner: { type: "string", desc: "fast|playwright runner selection (default: fast)." },
  channel: { type: "string", desc: "Chrome channel (stable|canary|beta|dev)." },
  "executable-path": { type: "string", desc: "Explicit Chromium/Chrome binary path." },
  angle: { type: "string", desc: "ANGLE backend override." },
  headful: { type: "boolean", desc: "Launch a visible browser window." },
  "chromium-arg": { type: "string", multiple: true, desc: "Additional Chromium launch flag (repeatable)." },
  screenshot: { type: "boolean", desc: "Save a PNG screenshot beside the JSON report." },
  "screenshot-out": { type: "string", desc: "Explicit path for PNG screenshot." },
  "visual-validation": { type: "boolean", desc: "Capture screenshot for visual inspection." },
  html: { type: "boolean", desc: "Write a self-contained HTML report beside the JSON report." },
  "html-out": { type: "string", desc: "Explicit path for HTML report." },
  trace: { type: "boolean", desc: "Capture summarized Chrome trace events." },
  "minimal-trace": { type: "boolean", desc: "Capture only GPU Chrome trace categories." },
  "raw-trace": { type: "boolean", desc: "Save raw Chrome trace JSON beside the report." },
  "trace-out": { type: "string", desc: "Explicit path for raw Chrome trace JSON." },
  agent: { type: "boolean", desc: "Print concise agent digest." },
  json: { type: "boolean", desc: "Print bounded machine-readable JSON (<=1.6 KB)." },
  "json-full": { type: "boolean", desc: "Print complete uncompacted report JSON." },
  base: { type: "string", desc: "Baseline report JSON for combined capture + compare." },
  candidate: { type: "string", desc: "Candidate report JSON (when comparing two saved reports)." },
  "comparison-out": { type: "string", desc: "Output path for comparison JSON when --base is used." },
  budget: { type: "string", desc: "Budget JSON file for comparison gating." },
  threshold: { type: "string", desc: "Allowed relative regression percent (default: 5)." },
  metric: { type: "string", desc: "Explicit primary metric key for comparison." },
  paired: { type: "boolean", desc: "Treat samples as paired when comparing saved reports." },
  "allow-mismatch": { type: "boolean", desc: "Downgrade compatibility mismatches to warnings." }
};

const COMMAND_OPTIONS = {
  run: RUN_OPTIONS,
  agent: RUN_OPTIONS,
  ab: {
    "base-url": { type: "string", desc: "Baseline target URL." },
    "base-file": { type: "string", desc: "Baseline local HTML file." },
    "candidate-url": { type: "string", desc: "Candidate target URL." },
    "candidate-file": { type: "string", desc: "Candidate local HTML file." },
    "file-root": { type: "string", desc: "Root directory for serving local files." },
    out: { type: "string", desc: "Output JSON path for A/B artifact." },
    label: { type: "string", desc: "Label for default A/B report naming." },
    preset: { type: "string", desc: "quick|confirm|profile|default sampling preset." },
    rounds: { type: "string", desc: "Interleaved A/B rounds (default: 4)." },
    samples: { type: "string", desc: "Samples per round." },
    warmup: { type: "string", desc: "Warmup samples per round." },
    "duration-ms": { type: "string", desc: "Per-sample duration in ms." },
    api: { type: "string", desc: "auto|webgpu|webgl|webgl2 capability probe." },
    "sampling-mode": { type: "string", desc: "frames|hook sampling mode." },
    "auto-instrument": { type: "boolean", desc: "Enable automatic GPU instrumentation (default: true)." },
    "no-auto-instrument": { type: "boolean", desc: "Disable automatic GPU instrumentation." },
    "gpu-timing": { type: "boolean", desc: "Enable automatic GPU pass timestamp timing (default: true)." },
    "no-gpu-timing": { type: "boolean", desc: "Disable automatic GPU pass timestamp timing." },
    "allow-idle": { type: "boolean", desc: "Allow rounds with zero observed GPU work." },
    "ready-timeout": { type: "string", desc: "Readiness timeout in ms." },
    "network-idle-budget": { type: "string", desc: "Max ms to wait for network idle." },
    "wait-until": { type: "string", desc: "load|domcontentloaded|networkidle|commit." },
    "wait-condition": { type: "string", desc: "JS readiness expression." },
    "wait-condition-timeout": { type: "string", desc: "Timeout in ms for --wait-condition." },
    "wait-for-hook": { type: "boolean", desc: "Wait for benchmark hook before sampling." },
    "wait-for-hook-timeout": { type: "string", desc: "Timeout in ms for --wait-for-hook (default: 15000)." },
    hook: { type: "string", desc: "Benchmark hook name." },
    "hook-name": { type: "string", desc: "Alias for --hook." },
    "slow-frame-threshold": { type: "string", desc: "Slow-frame cutoff in ms." },
    timeout: { type: "string", desc: "Per-round timeout in ms." },
    viewport: { type: "string", desc: "Viewport dimensions WIDTHxHEIGHT." },
    "device-scale-factor": { type: "string", desc: "Device pixel ratio." },
    context: { type: "string", desc: "isolated|shared storage context." },
    channel: { type: "string", desc: "Chrome channel." },
    "executable-path": { type: "string", desc: "Explicit Chrome executable path." },
    "chromium-arg": { type: "string", multiple: true, desc: "Additional Chrome launch flag." },
    headful: { type: "boolean", desc: "Launch a visible browser window." },
    "no-lock": { type: "boolean", desc: "Disable cross-process GPU measurement lock." },
    "lock-timeout": { type: "string", desc: "Max ms to wait for GPU measurement lock." },
    budget: { type: "string", desc: "Budget JSON file." },
    threshold: { type: "string", desc: "Allowed relative regression percent (default: 5)." },
    metric: { type: "string", desc: "Primary metric key override." },
    "allow-mismatch": { type: "boolean", desc: "Allow capture/environment differences." },
    agent: { type: "boolean", desc: "Print concise agent comparison digest." },
    json: { type: "boolean", desc: "Print bounded machine-readable JSON (<=2 KB)." },
    "json-full": { type: "boolean", desc: "Print complete A/B artifact JSON." }
  },
  compare: {
    base: { type: "string", desc: "Baseline report JSON file." },
    candidate: { type: "string", desc: "Candidate report JSON file." },
    out: { type: "string", desc: "Output comparison JSON path (default: <candidate>.compare.json)." },
    budget: { type: "string", desc: "Budget JSON file." },
    threshold: { type: "string", desc: "Allowed relative regression percent (default: 5)." },
    metric: { type: "string", desc: "Primary metric key override." },
    paired: { type: "boolean", desc: "Use paired intervals for matched samples." },
    "allow-mismatch": { type: "boolean", desc: "Downgrade compatibility mismatches to warnings." },
    table: { type: "boolean", desc: "Print full ASCII comparison table." },
    agent: { type: "boolean", desc: "Print concise agent comparison digest." },
    json: { type: "boolean", desc: "Print bounded machine-readable JSON (<=2 KB)." },
    "json-full": { type: "boolean", desc: "Print complete comparison JSON." }
  },
  inspect: {
    report: { type: "string", desc: "Report, comparison, or A/B JSON file to inspect." },
    section: { type: "string", desc: "overview|metrics|samples|errors|environment|instrumentation|trace|gpu|cpu|rounds (A/B per-round pairs)." },
    metric: { type: "string", desc: "Exact metric key or prefix* (metrics section); exact key, default primary (rounds section)." },
    offset: { type: "string", desc: "Zero-based pagination offset." },
    limit: { type: "string", desc: "Page size (1..10, default: 3; rounds: 10)." },
    run: { type: "string", desc: "Zero-based A/B run index." },
    raw: { type: "boolean", desc: "Return 1 raw unprojected sample at offset." },
    changed: { type: "boolean", desc: "Filter comparison metrics to changed rows only." },
    json: { type: "boolean", desc: "Emit bounded JSON output." }
  },
  doctor: {
    quick: { type: "boolean", desc: "Check environment and Chrome binary without launching Chrome." },
    json: { type: "boolean", desc: "Emit machine-readable JSON status." },
    channel: { type: "string", desc: "Chrome channel to check." },
    "executable-path": { type: "string", desc: "Explicit Chrome executable path to check." },
    headful: { type: "boolean", desc: "Probe in a visible browser window." }
  },
  serve: {
    port: { type: "string", desc: "TCP port to listen on (default: 0)." },
    "idle-timeout-ms": { type: "string", desc: "Idle shutdown timeout in ms (0 disables)." },
    "state-file": { type: "string", desc: "Daemon state JSON file path." },
    "report-dir": { type: "string", desc: "Default directory for saved reports." },
    "max-queue": { type: "string", desc: "Max queued capture jobs (default: 8)." },
    "slow-frame-threshold": { type: "string", desc: "Default slow-frame cutoff in ms." },
    viewport: { type: "string", desc: "Default viewport WIDTHxHEIGHT." },
    angle: { type: "string", desc: "ANGLE backend for persistent Chrome." },
    "auto-instrument": { type: "boolean", desc: "Enable auto-instrumentation by default." },
    "no-auto-instrument": { type: "boolean", desc: "Disable auto-instrumentation by default." },
    "chromium-arg": { type: "string", multiple: true, desc: "Additional Chrome launch flag." },
    channel: { type: "string", desc: "Chrome channel." },
    context: { type: "string", desc: "Default context mode (isolated|shared)." },
    "executable-path": { type: "string", desc: "Explicit Chrome binary path." },
    headful: { type: "boolean", desc: "Launch persistent Chrome in headful mode." }
  },
  mcp: {
    "report-dir": { type: "string", desc: "Directory for MCP artifacts (default: GPU_PERF_REPORT_DIR)." },
    "executable-path": { type: "string", desc: "Explicit Chrome executable path." },
    channel: { type: "string", desc: "Chrome channel." },
    "chromium-arg": { type: "string", multiple: true, desc: "Additional Chrome launch flag." },
    angle: { type: "string", desc: "ANGLE backend." },
    headful: { type: "boolean", desc: "Launch Chrome visibly." },
    cdp: { type: "string", desc: "Attach to existing Chrome CDP endpoint." }
  },
  xctrace: {
    app: { type: "string", desc: "Application bundle or binary to profile." },
    file: { type: "string", desc: "Local file to open." },
    url: { type: "string", desc: "URL to open." },
    out: { type: "string", desc: "Output .trace path." },
    template: { type: "string", desc: "Instruments template (default: Metal System Trace)." },
    "time-limit": { type: "string", desc: "Recording duration (default: 15s)." }
  }
};

const rawArgv = process.argv.slice(2);
const command = rawArgv[0] || "help";
const wantsJson = rawArgv.includes("--json") || rawArgv.includes("--json-full") || command === "inspect";
if (["agent", "run", "ab", "doctor"].includes(command)) installSignalHandlers();

try {
  if (command === "--version" || command === "-v" || (rawArgv.includes("--version") && !rawArgv.some((a) => a.startsWith("--url") || a.startsWith("--file")))) {
    console.log(`${TOOL.name} ${TOOL.version}`);
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (rawArgv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
    if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
      throw Object.assign(new Error(`Unknown command "${command}". Run --help for usage.`), { code: "invalid-options" });
    }
    printHelp(command);
  } else if (command === "agent") {
    await agentCommand(rawArgv.slice(1));
  } else if (command === "run") {
    await runCommand(rawArgv.slice(1), { isAgent: false });
  } else if (command === "ab") {
    await abCommand(rawArgv.slice(1));
  } else if (command === "compare") {
    await compareCommand(rawArgv.slice(1));
  } else if (command === "inspect") {
    await inspectCommand(rawArgv.slice(1));
  } else if (command === "doctor") {
    await doctorCommand(rawArgv.slice(1));
  } else if (command === "mcp") {
    await mcpCommand(rawArgv.slice(1));
  } else if (command === "serve") {
    await serveCommand(rawArgv.slice(1));
  } else if (command === "xctrace") {
    await xctraceCommand(rawArgv.slice(1));
  } else {
    throw Object.assign(new Error(`Unknown command "${command}". Run --help for usage.`), {
      code: "invalid-options",
      hint: suggestCommandHint(command)
    });
  }
} catch (error) {
  const { formatCliError, normalizeCliError } = await import("./output.js");
  const reportPath = error?.failureReportPath ? relPath(error.failureReportPath) : undefined;
  const normalized = normalizeCliError(error);
  if (wantsJson) {
    console.log(JSON.stringify({
      ok: false,
      exitCode: 3,
      error: normalized,
      ...(reportPath ? { reportPath } : {})
    }, null, 2));
  } else {
    console.error(formatCliError(error, { reportPath }));
  }
  process.exitCode = 3;
}

function parseCommandArgs(cmd, args) {
  const schema = COMMAND_OPTIONS[cmd];
  const parseSchema = {};
  for (const [key, spec] of Object.entries(schema)) {
    parseSchema[key] = { type: spec.type, ...(spec.multiple ? { multiple: true } : {}) };
  }
  try {
    return parseArgs({ allowPositionals: false, args, options: parseSchema });
  } catch (error) {
    if (error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const match = /Unknown option '(--[^'=]+)'/.exec(error.message);
      const unknown = match ? match[1].replace(/^--/, "") : null;
      const suggestion = unknown ? closestFlag(unknown, Object.keys(schema)) : null;
      const hint = suggestion
        ? `Did you mean --${suggestion}? Run gpu-perf-agent ${cmd} --help for supported flags.`
        : `Run gpu-perf-agent ${cmd} --help for supported flags.`;
      throw Object.assign(new Error(error.message), { code: "invalid-options", hint });
    }
    throw Object.assign(new Error(error.message), { code: "invalid-options" });
  }
}

async function agentCommand(args) {
  const { values } = parseCommandArgs("agent", args);
  const hasTarget = Boolean(values.url || values.file);
  if (values.base && !hasTarget) {
    await compareCommand([...args, "--agent"]);
    return;
  }
  await runCommand(args, { isAgent: true });
}

async function runCommand(args, { isAgent = false } = {}) {
  const { values } = parseCommandArgs(isAgent ? "agent" : "run", args);
  if (values.json && values.agent && !isAgent) {
    throw Object.assign(new Error("Choose --json or --agent."), { code: "invalid-options" });
  }
  const runnerName = values.runner || "fast";
  if (!["fast", "fast-cdp", "playwright"].includes(runnerName)) {
    throw Object.assign(new Error('--runner must be "fast" or "playwright".'), { code: "invalid-options" });
  }
  if (values.server && (runnerName === "playwright" || values.cdp || values["cdp-url"] || values.angle || values.channel || values["executable-path"] || values.headful || values["chromium-arg"]?.length)) {
    throw Object.assign(new Error("Configure browser launch flags on serve when using --server."), { code: "invalid-options" });
  }
  const [
    { applyOptionPrecedence, BASE_INHERITED_OPTION_KEYS, normalizeOptions, PROFILING_PRESETS },
    { compactComparison, compactReport, comparisonExitCode, formatAgentReport, formatCaptureAndCompare },
    { reportValidity }
  ] = await Promise.all([import("./options.js"), import("./output.js"), import("./validity.js")]);

  // Build explicit options map (only flags explicitly passed by caller).
  const explicit = buildExplicitRunOptions(values);
  let baseReport = null;
  let overrides = [];
  let effectiveInput;

  if (values.base) {
    const { loadReport } = await import("./compare.js");
    baseReport = await loadReport(values.base);
    const presetName = values.preset || (isAgent ? "quick" : "default");
    const defaultOpts = {
      ...PROFILING_PRESETS[presetName],
      autoInstrument: isAgent,
      gpuTiming: true,
      api: "auto",
      samplingMode: "frames",
      viewport: "1280x720",
      deviceScaleFactor: 1,
      waitUntil: "networkidle",
      hookName: "__gpuReportBench"
    };
    const mergedOptions = applyOptionPrecedence({
      explicit,
      base: baseReport,
      preset: presetName,
      defaults: { autoInstrument: isAgent }
    });
    for (const key of BASE_INHERITED_OPTION_KEYS) {
      if (explicit[key] === undefined && baseReport?.options?.[key] != null && baseReport.options[key] !== defaultOpts[key]) {
        const flagMap = {
          autoInstrument: baseReport.options.autoInstrument ? "--no-auto-instrument" : "--auto-instrument",
          gpuTiming: baseReport.options.gpuTiming ? "--no-gpu-timing" : "--gpu-timing",
          api: `--api <api>`,
          samplingMode: `--sampling-mode <mode>`
        };
        overrides.push({ key, value: baseReport.options[key], flag: flagMap[key] || null });
      }
    }
    effectiveInput = {
      ...mergedOptions,
      url: values.url,
      file: values.file ? path.resolve(values.file) : undefined,
      fileArg: values.file,
      fileRoot: values["file-root"] ? path.resolve(values["file-root"]) : undefined,
      cdpUrl: values.cdp || values["cdp-url"],
      channel: values.channel,
      executablePath: values["executable-path"],
      chromiumArgs: values["chromium-arg"] || [],
      label: values.label
    };
  } else {
    const presetName = values.preset || (isAgent ? "quick" : "default");
    effectiveInput = {
      ...explicit,
      preset: presetName,
      autoInstrument: explicit.autoInstrument !== undefined ? explicit.autoInstrument : isAgent,
      url: values.url,
      file: values.file ? path.resolve(values.file) : undefined,
      fileArg: values.file,
      fileRoot: values["file-root"] ? path.resolve(values["file-root"]) : undefined,
      cdpUrl: values.cdp || values["cdp-url"],
      channel: values.channel,
      executablePath: values["executable-path"],
      chromiumArgs: values["chromium-arg"] || [],
      label: values.label
    };
  }

  const out = values.out
    ? path.resolve(values.out)
    : await resolveDefaultOutPath({ label: values.label, file: values.file, url: values.url });
  const useRawTrace = Boolean(values["raw-trace"] || effectiveInput.rawTrace);
  // A named preset's trace (profile) applies; with --base and no --preset the baseline's trace
  // decides (trace is a compatibility key, so a difference would be a mismatch).
  const presetTrace = values.base
    ? !values.preset && baseReport?.options?.trace === true
    : PROFILING_PRESETS[effectiveInput.preset]?.trace === true;
  const useTrace = Boolean(values.trace || values["minimal-trace"] || useRawTrace || values["trace-out"] || effectiveInput.trace || presetTrace);
  const rawTracePath = values["trace-out"]
    ? path.resolve(values["trace-out"])
    : useRawTrace
      ? artifactPath(out, ".trace.json")
      : null;
  const screenshotPath = values["screenshot-out"]
    ? path.resolve(values["screenshot-out"])
    : (values.screenshot || values["visual-validation"])
      ? artifactPath(out, ".png")
      : null;
  const htmlPath = values["html-out"]
    ? path.resolve(values["html-out"])
    : values.html
      ? artifactPath(out, ".html")
      : null;
  const comparisonOut = values.base
    ? (values["comparison-out"] ? path.resolve(values["comparison-out"]) : artifactPath(out, ".compare.json"))
    : null;

  const artifactPaths = [out, rawTracePath, screenshotPath, htmlPath, comparisonOut].filter(Boolean);
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw Object.assign(new Error("Report, HTML, screenshot and trace paths must be different."), { code: "invalid-options" });
  }

  // Validate options before launching Chrome or contacting server.
  const validated = normalizeOptions({
    ...effectiveInput,
    trace: useTrace,
    rawTrace: useRawTrace,
    rawTracePath,
    screenshot: Boolean(screenshotPath),
    screenshotPath
  });

  let report;
  try {
    if (values.server) {
      // Plain `run --server` sends only typed flags so serve's own defaults (--auto-instrument) apply.
      const commandDecides = isAgent || Boolean(baseReport) || Boolean(values.preset);
      // run --preset adds only the preset's values, not run's generic autoInstrument: false.
      const decided = isAgent || baseReport
        ? effectiveInput
        : { ...explicit, preset: values.preset, url: values.url, file: effectiveInput.file, fileRoot: effectiveInput.fileRoot, label: values.label };
      report = await runRemote(values.server, buildServerPayload(decided, validated, PROFILING_PRESETS, { commandDecides }));
    } else if (runnerName === "playwright") {
      const { runReport } = await import("./runner.js");
      report = await runReport(validated);
    } else {
      report = await runWithOptionalDaemon(validated, values);
    }
  } catch (error) {
    await writeFailureReport(out, validated, error).catch(() => {});
    if (error && typeof error === "object") error.failureReportPath = out;
    throw error;
  }

  if (!report.summary || !report.diagnostics) {
    const { finalizeReport } = await import("./analysis.js");
    report = finalizeReport(report, validated);
  }

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));
  if (htmlPath) {
    await mkdir(path.dirname(htmlPath), { recursive: true });
    const { generateHtmlReport } = await import("./html-report.js");
    await writeFile(htmlPath, generateHtmlReport(report));
  }

  if (baseReport) {
    const { compareReports } = await import("./compare.js");
    const budget = values.budget ? JSON.parse(await readFile(values.budget, "utf8")) : null;
    const allowMismatch = Boolean(values["allow-mismatch"]);
    const comparison = compareReports(baseReport, report, {
      budget,
      primaryMetric: values.metric,
      allowMismatch,
      paired: Boolean(values.paired),
      thresholdPercent: values.threshold !== undefined ? numberOption(values.threshold, 5) : 5
    });
    comparison.baseReportPath = relPath(path.resolve(values.base));
    comparison.candidateReportPath = relPath(out);
    comparison.baseFile = baseReport?.target?.file || null;
    comparison.candidateFile = report?.target?.file || null;
    comparison.baseUrl = baseReport?.target?.url || null;
    comparison.candidateUrl = report?.target?.url || null;

    await mkdir(path.dirname(comparisonOut), { recursive: true });
    await writeFile(comparisonOut, JSON.stringify(comparison, null, 2));

    const valid = reportValidity(report).valid;
    process.exitCode = !valid ? 2 : comparisonExitCode(comparison, { allowMismatch });

    if (values["json-full"]) {
      console.log(JSON.stringify({
        ok: process.exitCode === 0,
        exitCode: process.exitCode,
        reportPath: relPath(out),
        comparisonPath: relPath(comparisonOut),
        overrides,
        report,
        comparison
      }, null, 2));
      return;
    }
    if (values.json) {
      console.log(JSON.stringify({
        ok: process.exitCode === 0,
        exitCode: process.exitCode,
        reportPath: relPath(out),
        comparisonPath: relPath(comparisonOut),
        overrides,
        capture: compactReport(report, out),
        comparison: compactComparison(comparison, comparisonOut, { allowMismatch })
      }));
      return;
    }
    console.log(formatCaptureAndCompare(report, comparison, {
      out,
      comparisonOut,
      baseReportPath: values.base,
      overrides,
      baseOptions: baseReport.options,
      allowMismatch
    }));
    return;
  }

  process.exitCode = reportValidity(report).valid ? 0 : 2;

  if (values["json-full"]) {
    console.log(JSON.stringify({
      ok: process.exitCode === 0,
      out: relPath(out),
      ...(htmlPath ? { htmlPath: relPath(htmlPath) } : {}),
      report
    }, null, 2));
    return;
  }
  if (values.json) {
    console.log(JSON.stringify({
      ...compactReport(report, out),
      ...(htmlPath ? { htmlPath } : {})
    }));
    return;
  }
  console.log(formatAgentReport(report, { out }));
}

async function abCommand(args) {
  const [{ runABComparison }, { compactComparison, comparisonExitCode, formatAgentComparison }] = await Promise.all([
    import("./ab-runner.js"),
    import("./output.js")
  ]);
  const { values } = parseCommandArgs("ab", args);
  if (values.json && values.agent) {
    throw Object.assign(new Error("Choose --json or --agent."), { code: "invalid-options" });
  }
  const base = targetOption(values["base-url"], values["base-file"], values["file-root"]);
  const candidate = targetOption(values["candidate-url"], values["candidate-file"], values["file-root"]);
  const budget = values.budget ? JSON.parse(await readFile(values.budget, "utf8")) : null;
  const allowMismatch = Boolean(values["allow-mismatch"]);
  const autoInstrument = values["no-auto-instrument"] ? false : values["auto-instrument"] !== false;
  const gpuTiming = values["no-gpu-timing"] ? false : values["gpu-timing"] !== false;

  const result = await runABComparison({
    api: values.api || "auto",
    autoInstrument,
    gpuTiming,
    allowMismatch,
    primaryMetric: values.metric,
    preset: values.preset,
    base,
    budget,
    candidate,
    channel: values.channel,
    contextMode: values.context,
    chromiumArgs: values["chromium-arg"] || [],
    deviceScaleFactor: values["device-scale-factor"],
    ...(values["duration-ms"] !== undefined ? { durationMs: numberOption(values["duration-ms"], 250) } : {}),
    executablePath: values["executable-path"],
    headful: Boolean(values.headful),
    hookName: values["hook-name"] || values.hook,
    rounds: values.rounds !== undefined ? numberOption(values.rounds, 4) : 4,
    ...(values.samples !== undefined ? { samples: numberOption(values.samples, 1) } : {}),
    samplingMode: values["sampling-mode"],
    slowFrameThresholdMs: values["slow-frame-threshold"] !== undefined ? numberOption(values["slow-frame-threshold"], 20) : 20,
    thresholdPercent: values.threshold !== undefined ? numberOption(values.threshold, 5) : 5,
    timeoutMs: values.timeout,
    viewport: values.viewport || "1280x720",
    ...(values.warmup !== undefined ? { warmup: numberOption(values.warmup, 1) } : {}),
    waitCondition: values["wait-condition"],
    waitConditionTimeoutMs: values["wait-condition-timeout"],
    waitForHook: values["wait-for-hook"],
    waitForHookTimeoutMs: values["wait-for-hook-timeout"],
    waitUntil: values["wait-until"],
    readyTimeoutMs: values["ready-timeout"],
    allowIdle: values["allow-idle"],
    networkIdleBudgetMs: values["network-idle-budget"],
    measureLock: values["no-lock"] ? false : undefined,
    lockTimeoutMs: values["lock-timeout"],
    label: values.label
  });

  const out = values.out
    ? path.resolve(values.out)
    : await resolveDefaultOutPath({
      label: values.label || "ab",
      file: values["candidate-file"] || values["base-file"],
      url: values["candidate-url"] || values["base-url"],
      prefix: "ab"
    });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));

  process.exitCode = comparisonExitCode(result.comparison, { allowMismatch });

  if (values["json-full"]) {
    console.log(JSON.stringify({
      base: result.base,
      candidate: result.candidate,
      comparison: result.comparison,
      ok: process.exitCode === 0,
      order: result.order,
      out: relPath(out)
    }, null, 2));
    return;
  }
  if (values.json) {
    console.log(JSON.stringify({
      ...compactComparison(result.comparison, out, { allowMismatch }),
      out: relPath(out)
    }));
    return;
  }
  console.log(formatAgentComparison(result.comparison, {
    out,
    primaryMetric: values.metric,
    allowMismatch
  }));
}

async function compareCommand(args) {
  const [{ compareReports, formatCompareTable, loadReport }, { compactComparison, comparisonExitCode, formatAgentComparison }] = await Promise.all([
    import("./compare.js"),
    import("./output.js")
  ]);
  const { values } = parseCommandArgs("compare", args);

  if (!values.base || !values.candidate) {
    throw Object.assign(new Error("compare requires --base and --candidate."), { code: "invalid-options" });
  }

  const allowMismatch = Boolean(values["allow-mismatch"]);
  const budget = values.budget ? JSON.parse(await readFile(values.budget, "utf8")) : null;
  const [baseReport, candidateReport] = await Promise.all([loadReport(values.base), loadReport(values.candidate)]);
  const result = compareReports(baseReport, candidateReport, {
    budget,
    paired: Boolean(values.paired),
    primaryMetric: values.metric,
    allowMismatch,
    thresholdPercent: values.threshold !== undefined ? numberOption(values.threshold, 5) : 5
  });

  const out = values.out
    ? path.resolve(values.out)
    : artifactPath(path.resolve(values.candidate), ".compare.json");
  result.baseReportPath = relPath(path.resolve(values.base));
  result.candidateReportPath = relPath(path.resolve(values.candidate));
  result.baseFile = baseReport?.target?.file || null;
  result.candidateFile = candidateReport?.target?.file || null;
  result.baseUrl = baseReport?.target?.url || null;
  result.candidateUrl = candidateReport?.target?.url || null;

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));

  process.exitCode = comparisonExitCode(result, { allowMismatch });
  if (values["json-full"]) {
    console.log(JSON.stringify({ ok: process.exitCode === 0, comparisonPath: relPath(out), ...result }, null, 2));
  } else if (values.json) {
    console.log(JSON.stringify(compactComparison(result, out, { allowMismatch })));
  } else if (values.table) {
    console.log(formatCompareTable(result));
  } else {
    console.log(formatAgentComparison(result, {
      out,
      primaryMetric: values.metric,
      baseOptions: baseReport?.options,
      allowMismatch
    }));
  }
}

async function inspectCommand(args) {
  const { inspectReport, validateInspectOptions } = await import("./inspect.js");
  const { values } = parseCommandArgs("inspect", args);
  if (!values.report?.trim()) {
    throw Object.assign(new Error("inspect requires --report FILE."), { code: "invalid-options" });
  }
  const num = (value) => (value === undefined ? undefined : value.trim() ? Number(value) : NaN);
  const options = validateInspectOptions({
    section: values.section,
    metric: values.metric,
    offset: num(values.offset),
    limit: num(values.limit),
    runIndex: num(values.run),
    ...(values.raw !== undefined ? { raw: Boolean(values.raw) } : {}),
    ...(values.changed !== undefined ? { changed: Boolean(values.changed) } : {})
  });
  const resolved = path.resolve(values.report);
  const report = JSON.parse(await readFile(resolved, "utf8"));
  const displayPath = relPath(resolved);
  console.log(JSON.stringify({ reportPath: displayPath, ...inspectReport(report, options) }));
}

async function doctorCommand(args) {
  const { macOSProfilerStatus } = await import("./native/macos-xctrace.js");
  const { runFastReport: runReport } = await import("./fast-cdp-runner.js");
  const { values } = parseCommandArgs("doctor", args);

  const chrome = await resolveQuickChrome({
    executablePath: values["executable-path"],
    channel: values.channel
  });
  const nodeUseSystemCa = Boolean(process.env.NODE_USE_SYSTEM_CA);
  const warnings = [];
  if (nodeUseSystemCa) {
    warnings.push("NODE_USE_SYSTEM_CA is set; TLS/keychain access may stall Node or Chrome startup.");
  }

  const status = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    chrome,
    nodeUseSystemCa,
    ...(warnings.length ? { warnings } : {}),
    xctrace: await macOSProfilerStatus({ includeTemplates: !values.quick })
  };

  if (!values.quick) {
    const report = await runReport({
      channel: values.channel,
      durationMs: 150,
      executablePath: values["executable-path"],
      file: fileURLToPath(new URL("../examples/doctor.html", import.meta.url)),
      headful: Boolean(values.headful),
      samples: 1,
      trace: false,
      waitUntil: "load",
      warmup: 0
    });
    status.browser = report.browser;
    status.webgpu = report.inPage.apiSupport.webgpu;
    status.webgl2 = report.inPage.apiSupport.webgl2;
  }

  if (values.json) {
    console.log(JSON.stringify({ ok: true, ...status }, null, 2));
    return;
  }

  console.log(`Node: ${status.node}`);
  console.log(`Platform: ${status.platform}`);
  if (chrome.path) {
    console.log(`Chrome: ${chrome.path} (${chrome.source})`);
  } else {
    console.log("Chrome: unavailable");
  }
  if (nodeUseSystemCa) {
    console.log(`Warning: ${warnings[0]}`);
  }
  if (status.xctrace.available) {
    console.log(`xctrace: ${status.xctrace.xctracePath}`);
    if (status.xctrace.templatesProbed) {
      const metalTemplate = status.xctrace.templates.find((template) => /Metal System Trace/i.test(template));
      console.log(`Metal template: ${metalTemplate || "not listed"}`);
    }
  } else {
    console.log(`xctrace: unavailable (${status.xctrace.reason || status.xctrace.xctraceError || "not found"})`);
  }
  if (status.browser) {
    console.log(`Chromium: ${status.browser.version?.product || "available"}`);
    console.log(`WebGPU: ${status.webgpu.available ? "available" : "unavailable"}${status.webgpu.error ? ` (${status.webgpu.error.message || status.webgpu.error})` : ""}`);
    console.log(`WebGL2: ${status.webgl2.available ? "available" : "unavailable"}${status.webgl2.unmaskedRenderer ? ` (${status.webgl2.unmaskedRenderer})` : ""}`);
  }
}

async function mcpCommand(args) {
  const { runMcpServer } = await import("./agent.js");
  const { values } = parseCommandArgs("mcp", args);
  const reportDir = values["report-dir"] || process.env.GPU_PERF_REPORT_DIR || undefined;
  const launchOptions = {
    ...(values["executable-path"] ? { executablePath: values["executable-path"] } : {}),
    ...(values.channel ? { channel: values.channel } : {}),
    ...(values["chromium-arg"]?.length ? { chromiumArgs: values["chromium-arg"] } : {}),
    ...(values.angle ? { angle: values.angle } : {}),
    ...(values.headful ? { headful: true } : {}),
    ...(values.cdp ? { cdpUrl: values.cdp } : {})
  };
  await runMcpServer({
    ...(reportDir ? { reportDir, reportDirectory: reportDir } : {}),
    ...(Object.keys(launchOptions).length ? { launchOptions } : {})
  });
}

async function xctraceCommand(args) {
  const { recordMacOSXctrace } = await import("./native/macos-xctrace.js");
  const { values } = parseCommandArgs("xctrace", args);

  const result = await recordMacOSXctrace({
    app: values.app,
    file: values.file,
    out: values.out,
    template: values.template || "Metal System Trace",
    timeLimit: values["time-limit"] || "15s",
    url: values.url
  });
  console.log(`xctrace output: ${result.output}`);
}

async function serveCommand(args) {
  const { startReportServer } = await import("./report-server.js");
  const { values } = parseCommandArgs("serve", args);

  const autoInstrument = values["no-auto-instrument"] ? false : Boolean(values["auto-instrument"]);
  const server = await startReportServer({
    angle: values.angle,
    autoInstrument,
    channel: values.channel,
    contextMode: values.context,
    chromiumArgs: values["chromium-arg"] || [],
    executablePath: values["executable-path"],
    headful: Boolean(values.headful),
    port: Number(values.port ?? 0),
    maxQueue: Number(values["max-queue"] ?? 8),
    slowFrameThresholdMs: Number(values["slow-frame-threshold"] ?? 20),
    viewport: values.viewport || "1280x720",
    ...(values["idle-timeout-ms"] !== undefined ? { idleTimeoutMs: Number(values["idle-timeout-ms"]) } : {}),
    ...(values["state-file"] ? { stateFile: path.resolve(values["state-file"]) } : {}),
    ...(values["report-dir"] ? { reportDir: path.resolve(values["report-dir"]) } : {})
  });

  console.log(`gpu-perf-agent server listening: ${server.url}`);
  console.log("POST /run with the same options as the Node API. POST /close to stop.");

  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function buildExplicitRunOptions(values) {
  const explicit = {};
  if (values.api !== undefined) explicit.api = values.api;
  if (values["sampling-mode"] !== undefined) explicit.samplingMode = values["sampling-mode"];
  if (values["no-auto-instrument"]) explicit.autoInstrument = false;
  else if (values["auto-instrument"] !== undefined) explicit.autoInstrument = Boolean(values["auto-instrument"]);
  if (values["no-gpu-timing"]) explicit.gpuTiming = false;
  else if (values["gpu-timing"] !== undefined) explicit.gpuTiming = Boolean(values["gpu-timing"]);
  if (values["duration-ms"] !== undefined) explicit.durationMs = Number(values["duration-ms"]);
  if (values.samples !== undefined) explicit.samples = Number(values.samples);
  if (values.warmup !== undefined) explicit.warmup = Number(values.warmup);
  if (values.adaptive !== undefined) explicit.adaptive = Boolean(values.adaptive);
  if (values.gc !== undefined) explicit.gc = Boolean(values.gc);
  if (values["deep-memory"] !== undefined) explicit.deepMemory = Boolean(values["deep-memory"]);
  if (values["no-cpu-profile"]) explicit.cpuProfile = false;
  else if (values["cpu-profile"] !== undefined) {
    explicit.cpuProfile = values["cpu-profile"] === "true" ? true : values["cpu-profile"] === "false" ? false : values["cpu-profile"];
  }
  if (values["allow-idle"] !== undefined) explicit.allowIdle = Boolean(values["allow-idle"]);
  if (values["ready-timeout"] !== undefined) explicit.readyTimeoutMs = Number(values["ready-timeout"]);
  if (values["network-idle-budget"] !== undefined) explicit.networkIdleBudgetMs = Number(values["network-idle-budget"]);
  if (values["wait-until"] !== undefined) explicit.waitUntil = values["wait-until"];
  if (values["wait-condition"] !== undefined) explicit.waitCondition = values["wait-condition"];
  if (values["wait-condition-timeout"] !== undefined) explicit.waitConditionTimeoutMs = Number(values["wait-condition-timeout"]);
  if (values["wait-for-hook"] !== undefined) explicit.waitForHook = Boolean(values["wait-for-hook"]);
  if (values["wait-for-hook-timeout"] !== undefined) explicit.waitForHookTimeoutMs = Number(values["wait-for-hook-timeout"]);
  if (values["hook-name"] !== undefined || values.hook !== undefined) explicit.hookName = values["hook-name"] || values.hook;
  if (values["slow-frame-threshold"] !== undefined) explicit.slowFrameThresholdMs = Number(values["slow-frame-threshold"]);
  if (values.timeout !== undefined) explicit.timeoutMs = Number(values.timeout);
  if (values.viewport !== undefined) explicit.viewport = values.viewport;
  if (values["device-scale-factor"] !== undefined) explicit.deviceScaleFactor = Number(values["device-scale-factor"]);
  if (values.context !== undefined) explicit.contextMode = values.context;
  if (values.angle !== undefined) explicit.angle = values.angle;
  if (values.headful !== undefined) explicit.headful = Boolean(values.headful);
  if (values["no-lock"]) explicit.measureLock = false;
  if (values["lock-timeout"] !== undefined) explicit.lockTimeoutMs = Number(values["lock-timeout"]);
  if (values.trace !== undefined) explicit.trace = Boolean(values.trace);
  if (values["minimal-trace"] !== undefined) explicit.minimalTrace = Boolean(values["minimal-trace"]);
  if (values["raw-trace"] !== undefined) explicit.rawTrace = Boolean(values["raw-trace"]);
  return explicit;
}

/**
 * What this command decided (explicit flags, the preset's values, command defaults such as
 * agent's auto-instrument, options inherited through --base), as validated. Options left to
 * the generic defaults keep the service's own (serve --viewport, --context, ...). Without
 * `commandDecides` (plain `run` with no --preset or --base) only typed flags are decided.
 */
function buildServerPayload(decided, validated, presets, { commandDecides = true } = {}) {
  const keys = new Set([
    ...Object.keys(decided).filter((key) => decided[key] !== undefined),
    ...(commandDecides ? [...Object.keys(presets?.[validated.preset] ?? {}), "gpuTiming", "trace"] : []),
    ...(validated.trace ? ["trace"] : []),
    "samplingMode", "waitForHook", "rawTracePath", "screenshotPath"
  ]);
  const payload = {};
  for (const key of keys) {
    if (!SERVER_OMITTED_KEYS.has(key) && validated[key] != null) payload[key] = validated[key];
  }
  return payload;
}

async function runWithOptionalDaemon(validated, values) {
  const skipDaemon = daemonDisabled({ noDaemon: values["no-daemon"] })
    || Boolean(values.cdp || values["cdp-url"] || values.headful || values.runner === "playwright");
  if (!skipDaemon) {
    const { runViaDaemon } = await import("./daemon.js");
    // null: no daemon could be reached or started, or its browser died, so run in-process.
    // Page-level failures are thrown: a rerun would load the page twice.
    const res = await runViaDaemon(validated, {
      // Called after the daemon returned a report.
      onReuse(info) {
        if (info?.pid) {
          const ageS = info.startedAt ? Math.max(0, Math.round((Date.now() - new Date(info.startedAt).getTime()) / 1000)) : null;
          const ageText = ageS != null ? (ageS >= 60 ? `${Math.round(ageS / 60)}m` : `${ageS}s`) : "warm";
          process.stderr.write(`using warm profiler pid ${info.pid} (started ${ageText} ago)\n`);
        }
      }
    });
    if (res) return res;
  }
  const { runFastReport } = await import("./fast-cdp-runner.js");
  return runFastReport(validated);
}

async function writeFailureReport(out, validated, error) {
  const [{ finalizeReport }, { normalizeCliError }] = await Promise.all([import("./analysis.js"), import("./output.js")]);
  const normalized = normalizeCliError(error);
  const failed = finalizeReport({
    tool: TOOL,
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    target: {
      source: validated.file ? "file-server" : "url",
      url: validated.url || null,
      file: validated.file || null,
      root: validated.fileRoot || null
    },
    options: validated,
    runError: normalized,
    ...(error?.pageEvents ? { pageEvents: error.pageEvents } : {}),
    ...(error?.pageEventSummary ? { pageEventSummary: error.pageEventSummary } : {})
  }, validated);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(failed, null, 2));
}

function slugify(input, fallback = "report") {
  if (!input || typeof input !== "string") return fallback;
  const cleaned = input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

async function resolveDefaultOutPath({ label, file, url, prefix = "report", dir = "reports" } = {}) {
  let baseSlug = prefix;
  if (label) {
    baseSlug = slugify(label, prefix);
  } else if (file) {
    const ext = path.extname(file);
    const stem = path.basename(file, ext);
    baseSlug = slugify(stem === "index" ? path.basename(path.dirname(path.resolve(file))) || stem : stem, prefix);
  } else if (url) {
    try {
      const parsed = new URL(url);
      const pathPart = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.(html?|php)$/i, "");
      const hostPart = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)
        ? (parsed.port ? `localhost-${parsed.port}` : "localhost")
        : parsed.hostname;
      baseSlug = slugify(pathPart ? `${hostPart}-${pathPart}` : hostPart, prefix);
    } catch {
      baseSlug = slugify(url, prefix);
    }
  }
  const absDir = path.resolve(dir);
  const existing = await readdir(absDir).catch(() => []);
  const escaped = baseSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-(\\d+)\\.json$`);
  let maxN = 0;
  for (const name of existing) {
    const m = re.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > maxN) maxN = n;
    }
  }
  return path.join(absDir, `${baseSlug}-${maxN + 1}.json`);
}

async function resolveQuickChrome({ executablePath, channel } = {}) {
  const check = async (candidate) => {
    if (!candidate) return null;
    if (path.isAbsolute(candidate)) {
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        return null;
      }
    }
    const paths = (process.env.PATH || "").split(path.delimiter);
    for (const dir of paths) {
      const full = path.join(dir, candidate);
      try {
        await access(full, fsConstants.X_OK);
        return full;
      } catch {
        // continue
      }
    }
    return null;
  };

  if (executablePath) {
    const found = await check(executablePath);
    return { path: found, source: found ? "flag" : null };
  }
  for (const envKey of ["CHROME_PATH", "CHROMIUM_PATH"]) {
    if (process.env[envKey]) {
      const found = await check(process.env[envKey]);
      if (found) return { path: found, source: "env" };
    }
  }
  const systemCandidates = process.platform === "darwin"
    ? [
      ...(channel === "canary" ? ["/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"] : []),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const cand of systemCandidates) {
    const found = await check(cand);
    if (found) return { path: found, source: "system" };
  }
  return { path: null, source: null };
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const temp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = temp;
    }
  }
  return dp[m];
}

function closestFlag(input, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = levenshtein(input, cand);
    if (d < bestDist && d <= 4) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

function suggestCommandHint(input) {
  const best = closestFlag(input, Object.keys(COMMAND_OPTIONS));
  return best
    ? `Did you mean "${best}"? Run gpu-perf-agent --help for commands.`
    : "Run gpu-perf-agent --help for supported commands.";
}

function printHelp(cmd = null) {
  const formatFlags = (schema) => Object.entries(schema)
    .map(([flag, spec]) => {
      const arg = spec.type === "string" ? (flag.includes("url") || flag === "server" ? " URL" : flag.includes("file") || flag === "out" || flag === "report" || flag === "budget" ? " FILE" : " VALUE") : "";
      const left = `  --${flag}${arg}`;
      return `${left.padEnd(34)} ${spec.desc || ""}`;
    })
    .join("\n");

  if (cmd && COMMAND_OPTIONS[cmd]) {
    console.log(`${TOOL.name} ${cmd} (v${TOOL.version})

Usage:
  gpu-perf-agent ${cmd} [options]

Options for ${cmd}:
${formatFlags(COMMAND_OPTIONS[cmd])}

Persistent service & cross-project usage:
  --server URL                      Reuse a running profiler service (avoids Chrome startup).
`);
    return;
  }

  console.log(`${TOOL.name} v${TOOL.version}

Usage:
  gpu-perf-agent agent --url http://localhost:5173
  gpu-perf-agent agent --file index.html --base reports/base-1.json
  gpu-perf-agent run --url http://localhost:5173 --preset quick --auto-instrument --json
  gpu-perf-agent ab --base-file base.html --candidate-file cand.html
  gpu-perf-agent compare --base reports/base-1.json --candidate reports/cand-1.json
  gpu-perf-agent inspect --report reports/base-1.json --section overview
  gpu-perf-agent doctor [--quick] [--json]
  gpu-perf-agent serve --port 9099 --auto-instrument
  gpu-perf-agent mcp [--report-dir reports]
  gpu-perf-agent xctrace --url http://localhost:5173 --time-limit 15s

Agent & Run Options:
  --preset quick|confirm|profile    Standardized sampling shapes for iteration and confirmation.
  --sampling-mode frames|hook       Frames by default; hook requires a benchmark hook.
  --auto-instrument                 Track WebGPU/WebGL buffers, textures, draws, dispatches, and passes.
${formatFlags(RUN_OPTIONS)}

A/B Options:
${formatFlags(COMMAND_OPTIONS.ab)}

Inspect Options:
${formatFlags(COMMAND_OPTIONS.inspect)}

Serve & MCP Options:
${formatFlags(COMMAND_OPTIONS.serve)}

Exit codes: 0 ok/improved/unchanged, 1 regression, 2 invalid capture or compatibility mismatch, 3 CLI/runner error.

Cross-project usage:
  cd ../your-project
  node ../WebGPUOptimizerReport/src/cli.js agent --url http://localhost:5173 --preset quick
`);
}

function targetOption(url, file, fileRoot) {
  if (url && file) throw Object.assign(new Error("Choose a URL or file for each target, not both."), { code: "invalid-options" });
  if (url) return { url };
  if (file) return { file, ...(fileRoot ? { fileRoot } : {}) };
  return null;
}

function numberOption(value, fallback) {
  const number = value == null ? Number(fallback) : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw Object.assign(new Error(`Expected a non-negative number, received "${value}".`), { code: "invalid-options" });
  }
  return number;
}

function artifactPath(out, extension) {
  return /\.json$/i.test(out) ? out.replace(/\.json$/i, extension) : `${out}${extension}`;
}

async function runRemote(serverUrl, payload) {
  const { requestJson } = await import("./http-client.js");
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("--server must be an HTTP(S) URL."), { code: "invalid-options" });
  }
  url.pathname = "/run";
  url.search = "";
  const timeoutMs = Number(payload.timeoutMs ?? 60000) + Number(payload.lockTimeoutMs ?? 60000) + 30000;
  const { status, json: result } = await requestJson(url, {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs
  });
  if (status < 200 || status >= 300) {
    throw Object.assign(new Error(result?.error?.message || `Profiler server returned HTTP ${status}.`), {
      code: result?.error?.code || "command-failed",
      hint: result?.error?.hint
    });
  }
  return result;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, async () => {
      try {
        const { closeAllHarnesses } = await import("./fast-cdp-runner.js");
        await closeAllHarnesses({ timeoutMs: 2000 });
      } finally {
        process.exit(128 + (osConstants.signals[signal] ?? 0));
      }
    });
  }
}
