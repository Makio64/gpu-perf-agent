#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  compareReports,
  formatCompareTable,
  loadReport,
  macOSProfilerStatus,
  recordMacOSXctrace,
  runPlaywrightReport,
  runReport,
  startReportServer,
  analyzeReport,
  formatDiagnostics
} from "./index.js";

const command = process.argv[2] || "help";

try {
  if (command === "run") {
    await runCommand(process.argv.slice(3));
  } else if (command === "compare") {
    await compareCommand(process.argv.slice(3));
  } else if (command === "doctor") {
    await doctorCommand(process.argv.slice(3));
  } else if (command === "serve") {
    await serveCommand(process.argv.slice(3));
  } else if (command === "xctrace") {
    await xctraceCommand(process.argv.slice(3));
  } else {
    printHelp();
    process.exitCode = command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}

async function runCommand(args) {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      angle: { type: "string" },
      api: { default: "auto", type: "string" },
      "chromium-arg": { multiple: true, type: "string" },
      channel: { type: "string" },
      "duration-ms": { default: "1000", type: "string" },
      "executable-path": { type: "string" },
      file: { type: "string" },
      "file-root": { type: "string" },
      gc: { type: "boolean" },
      headful: { type: "boolean" },
      hook: { default: "__gpuReportBench", type: "string" },
      out: { type: "string" },
      "raw-trace": { type: "boolean" },
      runner: { default: "fast", type: "string" },
      samples: { default: "5", type: "string" },
      timeout: { default: "60000", type: "string" },
      trace: { type: "boolean" },
      "minimal-trace": { type: "boolean" },
      "slow-frame-threshold": { type: "string" },
      "trace-out": { type: "string" },
      url: { type: "string" },
      viewport: { default: "1280x720", type: "string" },
      warmup: { default: "1", type: "string" },
      "wait-until": { default: "networkidle", type: "string" },
      "auto-instrument": { type: "boolean" },
      json: { type: "boolean" },
      screenshot: { type: "boolean" },
      "screenshot-out": { type: "string" },
      "visual-validation": { type: "boolean" }
    }
  });

  const out = path.resolve(values.out || path.join("reports", `report-${timestamp()}.json`));
  const rawTracePath = values["trace-out"]
    ? path.resolve(values["trace-out"])
    : values["raw-trace"]
      ? out.replace(/\.json$/i, ".trace.json")
      : null;

  const runner = values.runner === "playwright" ? runPlaywrightReport : runReport;
  if (!["fast", "fast-cdp", "playwright"].includes(values.runner)) {
    throw new Error('--runner must be "fast" or "playwright".');
  }

  const report = await runner({
    angle: values.angle,
    api: values.api,
    channel: values.channel,
    chromiumArgs: values["chromium-arg"] || [],
    durationMs: Number(values["duration-ms"]),
    executablePath: values["executable-path"],
    file: values.file,
    fileRoot: values["file-root"],
    gc: Boolean(values.gc),
    headful: Boolean(values.headful),
    hookName: values.hook,
    rawTracePath,
    samples: Number(values.samples),
    timeoutMs: Number(values.timeout),
    trace: Boolean(values.trace || values["raw-trace"] || values["trace-out"] || values["minimal-trace"]),
    minimalTrace: Boolean(values["minimal-trace"]),
    url: values.url,
    viewport: values.viewport,
    warmup: Number(values.warmup),
    waitUntil: values["wait-until"],
    autoInstrument: Boolean(values["auto-instrument"]),
    slowFrameThreshold: values["slow-frame-threshold"] ? Number(values["slow-frame-threshold"]) : null,
    out,
    screenshot: Boolean(values.screenshot || values["screenshot-out"]),
    screenshotOut: values["screenshot-out"],
    visualValidation: Boolean(values["visual-validation"] || values.screenshot || values["screenshot-out"])
  });

  const diagnostics = report.diagnostics || analyzeReport(report);
  report.diagnostics = diagnostics;

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));

  if (values.json) {
    console.log(JSON.stringify({
      out,
      target: report.target?.url || null,
      verdict: report.summary?.verdict || null,
      summary: report.summary || null,
      diagnostics
    }, null, 2));
    return;
  }

  console.log(`Report written: ${out}`);
  printRunSummary(report);
  console.log("\n" + formatDiagnostics(diagnostics));
}

async function compareCommand(args) {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      base: { type: "string" },
      budget: { type: "string" },
      candidate: { type: "string" },
      json: { type: "boolean" },
      threshold: { default: "5", type: "string" }
    }
  });

  if (!values.base || !values.candidate) {
    throw new Error("compare requires --base and --candidate.");
  }

  const budget = values.budget ? JSON.parse(await readFile(values.budget, "utf8")) : null;
  const baseReport = await loadReport(values.base);
  const candReport = await loadReport(values.candidate);
  const result = compareReports(baseReport, candReport, {
    budget,
    thresholdPercent: Number(values.threshold)
  });

  if (values.json) {
    const baseDiag = analyzeReport(baseReport);
    const candDiag = analyzeReport(candReport);
    console.log(JSON.stringify({
      ...result,
      diagnostics: {
        resolvedWarnings: baseDiag.warnings.filter((w) => !candDiag.warnings.includes(w)),
        remainingWarnings: candDiag.warnings,
        baseVerdict: baseReport.summary?.verdict || null,
        candidateVerdict: candReport.summary?.verdict || null
      }
    }, null, 2));
  } else {
    console.log(formatCompareTable(result));

    const baseDiag = analyzeReport(baseReport);
    const candDiag = analyzeReport(candReport);
    const resolved = baseDiag.warnings.filter((w) => !candDiag.warnings.includes(w));
    const unresolved = candDiag.warnings;

    if (resolved.length > 0) {
      console.log("\n🟩 Resolved Bottlenecks:");
      for (const r of resolved) {
        console.log(`  - ${r}`);
      }
    }
    if (unresolved.length > 0) {
      console.log("\n⚠️ Remaining / New Bottlenecks:");
      for (const u of unresolved) {
        console.log(`  - ${u}`);
      }
    }
  }

  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
}

async function doctorCommand(args) {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      channel: { type: "string" },
      "executable-path": { type: "string" },
      headful: { type: "boolean" },
      quick: { type: "boolean" }
    }
  });

  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);

  const xctrace = await macOSProfilerStatus();
  if (xctrace.available) {
    console.log(`xctrace: ${xctrace.xctracePath}`);
    const metalTemplate = xctrace.templates.find((template) => /Metal System Trace/i.test(template));
    console.log(`Metal template: ${metalTemplate || "not listed"}`);
  } else {
    console.log(`xctrace: unavailable (${xctrace.reason || xctrace.xctraceError || "not found"})`);
  }

  if (values.quick) {
    return;
  }

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

  const webgpu = report.inPage.apiSupport.webgpu;
  const webgl2 = report.inPage.apiSupport.webgl2;
  console.log(`Chromium: ${report.browser.version?.product || report.inPage.userAgent}`);
  console.log(`WebGPU: ${webgpu.available ? "available" : "unavailable"}${webgpu.error ? ` (${webgpu.error.message || webgpu.error})` : ""}`);
  console.log(`WebGL2: ${webgl2.available ? "available" : "unavailable"}${webgl2.unmaskedRenderer ? ` (${webgl2.unmaskedRenderer})` : ""}`);
}

async function xctraceCommand(args) {
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
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      angle: { type: "string" },
      "chromium-arg": { multiple: true, type: "string" },
      channel: { type: "string" },
      "executable-path": { type: "string" },
      headful: { type: "boolean" },
      port: { default: "0", type: "string" },
      viewport: { default: "1280x720", type: "string" }
    }
  });

  const server = await startReportServer({
    angle: values.angle,
    channel: values.channel,
    chromiumArgs: values["chromium-arg"] || [],
    executablePath: values["executable-path"],
    headful: Boolean(values.headful),
    port: Number(values.port),
    viewport: values.viewport
  });

  console.log(`gpu-perf-agent server listening: ${server.url}`);
  console.log("POST /run with the same options as the CLI run command. POST /close to stop.");

  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function printRunSummary(report) {
  const summary = report.inPage.summary;
  const lines = [];
  if (report.summary?.verdict) {
    lines.push(`verdict ${report.summary.verdict}`);
  }
  if (summary.fps?.mean != null) {
    lines.push(`fps mean ${summary.fps.mean.toFixed(2)}`);
  }
  if (summary.frameTimeMsMean?.mean != null) {
    lines.push(`frame mean ${summary.frameTimeMsMean.mean.toFixed(2)} ms`);
  }
  if (summary.maxJitter?.mean != null) {
    lines.push(`jitter mean ${summary.maxJitter.mean.toFixed(2)} ms`);
  }
  if (summary.trackedGpuTotalBytes?.max != null) {
    lines.push(`tracked GPU max ${(summary.trackedGpuTotalBytes.max / 1024 / 1024).toFixed(2)} MiB`);
  }
  if (summary.leakCount?.max != null && summary.leakCount.max > 0) {
    lines.push(`leaks ${summary.leakCount.max} (created ${summary.createdCount?.max || 0}, released ${summary.releasedCount?.max || 0})`);
  }
  if (report.trace.summary?.gpu?.eventCount != null) {
    lines.push(`trace GPU events ${report.trace.summary.gpu.eventCount}`);
  }
  if (lines.length > 0) {
    console.log(lines.join(" | "));
  }
  for (const warning of report.inPage.warnings || []) {
    console.warn(`warning: ${warning}`);
  }
  if (report.inPage.slowFrames && report.inPage.slowFrames.length > 0) {
    console.warn(`\n⚠️  Slow Frames Detected (${report.inPage.slowFrames.length}):`);
    for (const f of report.inPage.slowFrames.slice(0, 10)) {
      const stats = f.stats || {};
      console.warn(`  - Frame took ${f.frameDurationMs.toFixed(2)}ms. Ops: passes=${(stats.renderPasses || 0) + (stats.computePasses || 0)}, draws=${stats.drawCalls || 0}, dispatches=${stats.dispatchCalls || 0}, setPipelines=${stats.setPipelineCalls || 0}, setBindGroups=${stats.setBindGroupCalls || 0}, copies=${stats.copyBufferCalls || 0}`);
    }
    if (report.inPage.slowFrames.length > 10) {
      console.warn(`  ... and ${report.inPage.slowFrames.length - 10} more slow frames.`);
    }
  }
}

function printHelp() {
  console.log(`gpu-perf-agent

Usage:
  gpu-perf-agent doctor [--quick]
  gpu-perf-agent run --url http://localhost:5173/bench.html --out reports/run.json [--trace]
  gpu-perf-agent run --file examples/webgl2-draw.html --samples 5 --duration-ms 1000
  gpu-perf-agent serve --port 9099
  gpu-perf-agent compare --base reports/base.json --candidate reports/candidate.json [--budget budget.json]
  gpu-perf-agent xctrace --url http://localhost:5173/bench.html --time-limit 15s

Key run options:
  --api webgpu|webgl2|auto     Label passed to the page hook.
  --hook NAME                  Page hook name. Default: __gpuReportBench.
  --trace                      Capture Chrome trace summary.
  --minimal-trace              Capture minimal GPU-only trace (faster post-processing).
  --raw-trace                  Save raw Chrome trace JSON next to the report.
  --gc                         Collect JS heap snapshots after forced GC.
  --channel chrome             Use installed Chrome instead of bundled Chromium.
  --file-root DIR              Static server root for --file module imports.
  --angle metal                Pass --use-angle=metal for WebGL experiments.
  --runner fast|playwright     Use direct CDP by default, Playwright if needed.
  --auto-instrument            Enable automatic monkey-patching of WebGPU/WebGL2 APIs.
  --json                       Print a machine-readable summary + diagnostics to stdout.
  --slow-frame-threshold MS    Frame duration threshold in ms to flag slow frames. Default: 20.
  --screenshot                 Capture a screenshot of the page/canvas.
  --screenshot-out PATH        File path to save the screenshot.
  --visual-validation          Verify screenshot is not blank (size > 5KB).

Default runner:
  The CLI uses the fast direct-CDP runner. Import runPlaywrightReport()
  from the package only when you need Playwright compatibility.

Persistent mode:
  gpu-perf-agent serve launches Chrome once and accepts POST /run JSON jobs.
  This is the fastest path for agents running optimization loops.

Agent loop recipe:
  1. gpu-perf-agent doctor --quick
  2. gpu-perf-agent run --url URL --auto-instrument --out reports/base.json --json
  3. (apply an optimization)
  4. gpu-perf-agent run --url URL --auto-instrument --out reports/candidate.json --json
  5. gpu-perf-agent compare --base reports/base.json --candidate reports/candidate.json --json
  Every report contains a top-level "summary" with a verdict
  (excellent | good | needs-work | poor) plus warnings to act on.
`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
