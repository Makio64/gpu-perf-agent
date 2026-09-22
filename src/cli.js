#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compactReport, comparisonExitCode, formatAgentReport, formatAgentComparison } from "./output.js";
import { reportValidity } from "./validity.js";

const command = process.argv[2] || "help";
const wantsJson = process.argv.includes("--json");

try {
  if (process.argv.slice(3).some(arg => arg === "--help" || arg === "-h")) {
    printHelp();
  } else if (command === "agent") {
    const args = process.argv.slice(3);
    if (args.some(arg => arg === "--base" || arg.startsWith("--base="))) await compareCommand([...args, "--agent"]);
    else await runCommand(["--preset", "quick", "--auto-instrument", ...args, "--agent"]);
  } else if (command === "run") {
    await runCommand(process.argv.slice(3));
  } else if (command === "ab") {
    await abCommand(process.argv.slice(3));
  } else if (command === "compare") {
    await compareCommand(process.argv.slice(3));
  } else if (command === "doctor") {
    await doctorCommand(process.argv.slice(3));
  } else if (command === "mcp") {
    await (await import("./agent.js")).runMcpServer();
  } else if (command === "serve") {
    await serveCommand(process.argv.slice(3));
  } else if (command === "xctrace") {
    await xctraceCommand(process.argv.slice(3));
  } else {
    if (!["help", "--help", "-h"].includes(command)) throw new Error(`Unknown command "${command}". Run --help for usage.`);
    printHelp();
  }
} catch (error) {
  if (wantsJson) {
    console.log(JSON.stringify({
      error: {
        message: error?.message || String(error),
        name: error?.name || "Error",
        stack: error?.stack || null
      },
      ok: false
    }, null, 2));
  } else {
    console.error(error?.stack || error?.message || String(error));
  }
  process.exitCode = 1;
}

async function abCommand(args) {
  const { runABComparison } = await import("./ab-runner.js");
  const { formatCompareTable } = await import("./compare.js");
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      api: { default: "auto", type: "string" },
      "auto-instrument": { type: "boolean" },
      "base-file": { type: "string" },
      "base-url": { type: "string" },
      budget: { type: "string" },
      "candidate-file": { type: "string" },
      "candidate-url": { type: "string" },
      channel: { type: "string" },
      context: { type: "string" },
      "chromium-arg": { multiple: true, type: "string" },
      "duration-ms": { default: "250", type: "string" },
      "executable-path": { type: "string" },
      "file-root": { type: "string" },
      headful: { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
      rounds: { default: "4", type: "string" },
      samples: { default: "1", type: "string" },
      "slow-frame-threshold": { default: "20", type: "string" },
      threshold: { default: "5", type: "string" },
      viewport: { default: "1280x720", type: "string" },
      warmup: { default: "1", type: "string" }
    }
  });
  const base = targetOption(values["base-url"], values["base-file"], values["file-root"]);
  const candidate = targetOption(values["candidate-url"], values["candidate-file"], values["file-root"]);
  const budget = values.budget ? JSON.parse(await readFile(values.budget, "utf8")) : null;
  const result = await runABComparison({
    api: values.api,
    autoInstrument: Boolean(values["auto-instrument"]),
    base,
    budget,
    candidate,
    channel: values.channel,
    contextMode: values.context,
    chromiumArgs: values["chromium-arg"] || [],
    durationMs: Number(values["duration-ms"]),
    executablePath: values["executable-path"],
    headful: Boolean(values.headful),
    rounds: Number(values.rounds),
    samples: Number(values.samples),
    slowFrameThresholdMs: Number(values["slow-frame-threshold"]),
    thresholdPercent: Number(values.threshold),
    viewport: values.viewport,
    warmup: Number(values.warmup)
  });
  const out = path.resolve(values.out || path.join("reports", `ab-${timestamp()}.json`));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));

  if (values.json) {
    console.log(JSON.stringify({
      base: result.base,
      candidate: result.candidate,
      comparison: result.comparison,
      ok: comparisonExitCode(result.comparison) === 0,
      order: result.order,
      out
    }, null, 2));
  } else {
    console.log(`A/B report written: ${out}`);
    console.log(formatCompareTable(result.comparison));
  }
  process.exitCode = comparisonExitCode(result.comparison);
}

async function runCommand(args) {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      adaptive: { type: "boolean" },
      cdp: { type: "string" },
      "cdp-url": { type: "string" },
      html: { type: "boolean" },
      "html-out": { type: "string" },
      "minimal-trace": { type: "boolean" },
      "visual-validation": { type: "boolean" },
      "wait-condition": { type: "string" },
      "wait-condition-timeout": { type: "string" },
      angle: { type: "string" },
      api: { default: "auto", type: "string" },
      agent: { type: "boolean" },
      "deep-memory": { type: "boolean" },
      "auto-instrument": { type: "boolean" },
      "chromium-arg": { multiple: true, type: "string" },
      channel: { type: "string" },
      context: { type: "string" },
      "device-scale-factor": { type: "string" },
      "duration-ms": { type: "string" },
      "executable-path": { type: "string" },
      file: { type: "string" },
      "file-root": { type: "string" },
      gc: { type: "boolean" },
      headful: { type: "boolean" },
      hook: { default: "__gpuReportBench", type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      preset: { type: "string" },
      "raw-trace": { type: "boolean" },
      runner: { default: "fast", type: "string" },
      server: { type: "string" },
      samples: { type: "string" },
      screenshot: { type: "boolean" },
      "screenshot-out": { type: "string" },
      "slow-frame-threshold": { type: "string" },
      timeout: { default: "60000", type: "string" },
      trace: { type: "boolean" },
      "trace-out": { type: "string" },
      url: { type: "string" },
      viewport: { default: "1280x720", type: "string" },
      warmup: { type: "string" },
      "wait-until": { default: "networkidle", type: "string" },
      "wait-for-hook": { type: "boolean" }
    }
  });

  const preset = profilingPreset(values.preset);
  const out = path.resolve(values.out || path.join("reports", `report-${timestamp()}.json`));
  const useRawTrace = Boolean(values["raw-trace"] || preset.rawTrace);
  const useTrace = Boolean(values.trace || values["minimal-trace"] || useRawTrace || values["trace-out"] || preset.trace);
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
  const htmlPath = values["html-out"] ? path.resolve(values["html-out"]) : values.html ? artifactPath(out, ".html") : null;
  if (!["fast", "fast-cdp", "playwright"].includes(values.runner)) {
    throw new Error('--runner must be "fast" or "playwright".');
  }

  if (values.server && (values.runner === "playwright" || values.cdp || values["cdp-url"] || values.angle || values.channel || values["executable-path"] || values.headful || values["chromium-arg"]?.length)) {
    throw new Error("Configure browser launch flags on serve when using --server.");
  }
  const artifactPaths = [out, rawTracePath, screenshotPath, htmlPath].filter(Boolean);
  if (new Set(artifactPaths).size !== artifactPaths.length) throw new Error("Report, HTML, screenshot and trace paths must be different.");
  const runner = values.server ? (options => runRemote(values.server, options)) : values.runner === "playwright"
    ? (await import("./runner.js")).runReport
    : (await import("./fast-cdp-runner.js")).runFastReport;
  if (values.json && values.agent && command !== "agent") throw new Error('Choose --json or --agent.');
  const report = await runner({
    adaptive: Boolean(values.adaptive),
    cdpUrl: values.cdp || values["cdp-url"],
    minimalTrace: Boolean(values["minimal-trace"]),
    waitCondition: values["wait-condition"],
    waitConditionTimeoutMs: values["wait-condition-timeout"],
    angle: values.angle,
    api: values.api,
    autoInstrument: Boolean(values["auto-instrument"]),
    channel: values.channel,
    contextMode: values.context,
    chromiumArgs: values["chromium-arg"] || [],
    deviceScaleFactor: numberOption(values["device-scale-factor"], 1),
    durationMs: numberOption(values["duration-ms"], preset.durationMs),
    executablePath: values["executable-path"],
    file: values.file ? path.resolve(values.file) : undefined,
    fileRoot: values["file-root"] ? path.resolve(values["file-root"]) : (values.file ? process.cwd() : undefined),
    gc: Boolean(values.gc || preset.gc),
    deepMemory: Boolean(values["deep-memory"]),
    headful: Boolean(values.headful),
    hookName: values.hook,
    rawTracePath,
    samples: numberOption(values.samples, preset.samples),
    screenshotPath,
    slowFrameThresholdMs: numberOption(values["slow-frame-threshold"], 20),
    timeoutMs: Number(values.timeout),
    trace: useTrace,
    url: values.url,
    viewport: values.viewport,
    warmup: numberOption(values.warmup, preset.warmup),
    waitUntil: values["wait-until"],
    waitForHook: Boolean(values["wait-for-hook"])
  });

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));
  if (htmlPath) {
    await mkdir(path.dirname(htmlPath), { recursive: true });
    const { generateHtmlReport } = await import("./html-report.js");
    await writeFile(htmlPath, generateHtmlReport(report));
  }
  process.exitCode = reportValidity(report).valid ? 0 : 2;

  if (values.json) {
    console.log(JSON.stringify({ ...compactReport(report, out), ...(htmlPath ? { htmlPath } : {}) }));
    return;
  }
  if (values.agent) {
    console.log(formatAgentReport(report, { out }));
    return;
  }

  console.log(`Report written: ${out}`);
  if (htmlPath) console.log(`HTML report written: ${htmlPath}`);
  if (screenshotPath) {
    console.log(`Screenshot written: ${screenshotPath}`);
  }
  printRunSummary(report);
}

async function compareCommand(args) {
  const { compareReports, formatCompareTable, loadReport } = await import("./compare.js");
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "allow-mismatch": { type: "boolean" },
      agent: { type: "boolean" },
      base: { type: "string" },
      budget: { type: "string" },
      candidate: { type: "string" },
      json: { type: "boolean" },
      paired: { type: "boolean" },
      threshold: { default: "5", type: "string" }
    }
  });

  if (!values.base || !values.candidate) {
    throw new Error("compare requires --base and --candidate.");
  }

  const budget = values.budget ? JSON.parse(await readFile(values.budget, "utf8")) : null;
  const [baseReport, candidateReport] = await Promise.all([loadReport(values.base), loadReport(values.candidate)]);
  const result = compareReports(baseReport, candidateReport, {
    budget,
    paired: Boolean(values.paired),
    thresholdPercent: Number(values.threshold)
  });

  process.exitCode = comparisonExitCode(result, { allowMismatch: values["allow-mismatch"] });
  if (values.json) {
    console.log(JSON.stringify({ ok: process.exitCode === 0, ...result }));
  } else if (values.agent) {
    console.log(formatAgentComparison(result));
  } else {
    console.log(formatCompareTable(result));
  }


}

async function doctorCommand(args) {
  const { macOSProfilerStatus } = await import("./native/macos-xctrace.js");
  const { runFastReport: runReport } = await import("./fast-cdp-runner.js");
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      channel: { type: "string" },
      "executable-path": { type: "string" },
      headful: { type: "boolean" },
      json: { type: "boolean" },
      quick: { type: "boolean" }
    }
  });

  const status = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    xctrace: await macOSProfilerStatus()
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
  if (status.xctrace.available) {
    console.log(`xctrace: ${status.xctrace.xctracePath}`);
    const metalTemplate = status.xctrace.templates.find((template) => /Metal System Trace/i.test(template));
    console.log(`Metal template: ${metalTemplate || "not listed"}`);
  } else {
    console.log(`xctrace: unavailable (${status.xctrace.reason || status.xctrace.xctraceError || "not found"})`);
  }
  if (status.browser) {
    console.log(`Chromium: ${status.browser.version?.product || "available"}`);
    console.log(`WebGPU: ${status.webgpu.available ? "available" : "unavailable"}${status.webgpu.error ? ` (${status.webgpu.error.message || status.webgpu.error})` : ""}`);
    console.log(`WebGL2: ${status.webgl2.available ? "available" : "unavailable"}${status.webgl2.unmaskedRenderer ? ` (${status.webgl2.unmaskedRenderer})` : ""}`);
  }
}

async function xctraceCommand(args) {
  const { recordMacOSXctrace } = await import("./native/macos-xctrace.js");
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      app: { type: "string" },
      file: { type: "string" },
      out: { type: "string" },
      template: { default: "Metal System Trace", type: "string" },
      "time-limit": { default: "15s", type: "string" },
      url: { type: "string" }
    }
  });

  const result = await recordMacOSXctrace({
    app: values.app,
    file: values.file,
    out: values.out,
    template: values.template,
    timeLimit: values["time-limit"],
    url: values.url
  });
  console.log(`xctrace output: ${result.output}`);
}

async function serveCommand(args) {
  const { startReportServer } = await import("./report-server.js");
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      angle: { type: "string" },
      "auto-instrument": { type: "boolean" },
      "chromium-arg": { multiple: true, type: "string" },
      channel: { type: "string" },
      context: { type: "string" },
      "executable-path": { type: "string" },
      headful: { type: "boolean" },
      port: { default: "0", type: "string" },
      "max-queue": { default: "8", type: "string" },
      "slow-frame-threshold": { default: "20", type: "string" },
      viewport: { default: "1280x720", type: "string" }
    }
  });

  const server = await startReportServer({
    angle: values.angle,
    autoInstrument: Boolean(values["auto-instrument"]),
    channel: values.channel,
    contextMode: values.context,
    chromiumArgs: values["chromium-arg"] || [],
    executablePath: values["executable-path"],
    headful: Boolean(values.headful),
    port: Number(values.port),
    maxQueue: Number(values["max-queue"]),
    slowFrameThresholdMs: Number(values["slow-frame-threshold"]),
    viewport: values.viewport
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

function profilingPreset(name = "default") {
  const presets = {
    confirm: { durationMs: 500, gc: false, rawTrace: false, samples: 15, trace: false, warmup: 4 },
    default: { durationMs: 1000, gc: false, rawTrace: false, samples: 5, trace: false, warmup: 1 },
    profile: { durationMs: 750, gc: true, rawTrace: true, samples: 8, trace: true, warmup: 2 },
    quick: { durationMs: 250, gc: false, rawTrace: false, samples: 6, trace: false, warmup: 2 }
  };
  if (!Object.hasOwn(presets, name)) {
    throw new Error(`Unknown preset "${name}". Expected quick, confirm, profile, or default.`);
  }
  return presets[name];
}

function printRunSummary(report) {
  const summary = report.summary || {};
  const validity = reportValidity(report);
  if (!validity.valid) console.warn(`INVALID: ${validity.issues.map(issue => issue.message).join(" ")}`);
  const lines = [`verdict ${summary.verdict || "unknown"}`];
  if (summary.fps != null) {
    lines.push(`fps ${summary.fps.toFixed(2)}`);
  }
  if (summary.frameTimeMsP95 != null) {
    lines.push(`frame p95 ${summary.frameTimeMsP95.toFixed(2)} ms`);
  }
  if (summary.gpuFrameMsMean != null) {
    lines.push(`GPU ${summary.gpuFrameMsMean.toFixed(2)} ms`);
  }
  if (summary.trackedVram?.totalMiB != null) {
    lines.push(`tracked GPU ${summary.trackedVram.totalMiB.toFixed(2)} MiB`);
  }
  console.log(lines.join(" | "));
  for (const warning of summary.warnings || []) {
    console.warn(`[${warning.severity}] ${warning.message} ${warning.recommendation}`);
  }
  for (const warning of report.inPage?.warnings || []) {
    console.warn(`warning: ${warning}`);
  }
}

function printHelp() {
  console.log(`gpu-perf-agent

Usage:
  gpu-perf-agent agent --url http://localhost:5173 --out reports/base.json
  gpu-perf-agent agent --base reports/base.json --candidate reports/candidate.json
  gpu-perf-agent doctor [--quick] [--json]
  gpu-perf-agent run --url http://localhost:5173 --auto-instrument --out reports/run.json --json
  gpu-perf-agent ab --base-url http://localhost:4173 --candidate-url http://localhost:5173 --json
  gpu-perf-agent run --file examples/webgpu-clear.html --preset quick --screenshot
  gpu-perf-agent serve --port 9099 --auto-instrument
  gpu-perf-agent compare --base reports/base.json --candidate reports/candidate.json --json
  gpu-perf-agent xctrace --url http://localhost:5173 --time-limit 15s

Agent-oriented run options:
  --api auto|webgpu|webgl|webgl2   Select capability probes; auto checks WebGPU and WebGL2.
  --preset quick|confirm|profile  Standardized sampling shapes for iteration and confirmation.
  --auto-instrument              Track WebGPU/WebGL buffers, textures, draws, dispatches, and uploads.
  --server URL                   Reuse a running profiler service (avoids Chrome startup).
  --context isolated|shared      Fresh job storage by default; shared opts into persistent state.
  --agent                        Print a concise digest with measured signal and top actions.
  --wait-for-hook                 Wait for the benchmark hook after asynchronous app startup.
  --deep-memory                  Opt in to expensive user-agent memory measurements.
  --json                         Print stable machine-readable output instead of human summaries.
  --screenshot                   Save a PNG beside the JSON report for visual verification.
  --slow-frame-threshold MS      Slow-frame cutoff. Default: 20 ms.
  --adaptive                    Stop after at least 3 samples when FPS CV < 1.5%.
  --cdp <port|url>               Attach to Chrome; leave it running on exit.
  --html / --html-out <path>     Write a self-contained HTML report.
  --wait-condition <expression>  Wait for page readiness before sampling.
  --minimal-trace                Capture only GPU tracing categories.
  --trace / --raw-trace          Capture summarized / raw Chrome tracing data.
  --runner fast|playwright       Direct CDP is the default; Playwright requires an optional install.
  --file-root DIR                Serve module imports from a sibling project root.
  --chromium-arg=ARG             Repeat for project-specific Chrome flags.

Comparison options:
  --paired                      Use paired intervals only for explicitly matched samples.
  --allow-mismatch              Allow different capture options; invalid data still exits 2.
  --budget FILE                 Validate required metrics and absolute or relative limits.
  --threshold PERCENT           Allowed relative change (default 5).

Exit codes: 0 completed, 1 regression or command error, 2 invalid measurements/options mismatch.
Inconclusive changes are reported separately and do not fail the default regression gate.

Cross-project usage:
  cd ../your-project
  node ../WebGPUOptimizerReport/src/cli.js run --url http://localhost:5173 --preset quick --auto-instrument --json

Persistent mode keeps Chrome alive and is the fastest loop for optimization agents.
`);
}

function targetOption(url, file, fileRoot) {
  if (url && file) throw new Error("Choose a URL or file for each target, not both.");
  if (url) {
    return { url };
  }
  if (file) {
    return { file, fileRoot };
  }
  return null;
}

function numberOption(value, fallback) {
  const number = value == null ? Number(fallback) : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Expected a non-negative number, received "${value}".`);
  }
  return number;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function artifactPath(out, extension) {
  return /\.json$/i.test(out) ? out.replace(/\.json$/i, extension) : `${out}${extension}`;
}

async function runRemote(serverUrl, options) {
  const { normalizeOptions } = await import("./options.js");
  const normalized = normalizeOptions(options);
  for (const key of ["angle", "channel", "chromiumArgs", "executablePath", "headful"]) delete normalized[key];
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--server must be an HTTP(S) URL.");
  url.pathname = "/run";
  url.search = "";
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(normalized)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Profiler server returned HTTP ${response.status}.`);
  return result;
}
