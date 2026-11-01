import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "src", "cli.js");

test("package exposes gpu-perf-agent and compatibility binaries, and --version prints 2.2.0", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "gpu-perf-agent");
  assert.equal(pkg.bin["gpu-perf-agent"], "./src/cli.js");
  assert.equal(pkg.bin["webgpu-report"], "./src/cli.js");

  for (const flag of ["--version", "-v"]) {
    const res = spawnSync(process.execPath, [cli, flag], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "gpu-perf-agent 2.2.0");
  }
});

test("CLI help documents agent and cross-project workflows and all per-command flags", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--auto-instrument/);
  assert.match(result.stdout, /--preset quick\|confirm\|profile/);
  assert.match(result.stdout, /--sampling-mode frames\|hook/);
  assert.match(result.stdout, /Cross-project usage/);

  for (const command of ["agent", "run", "ab", "compare", "inspect", "doctor", "serve", "mcp", "xctrace"]) {
    const cmdHelp = spawnSync(process.execPath, [cli, command, "--help"], { encoding: "utf8" });
    assert.equal(cmdHelp.status, 0);
    assert.match(cmdHelp.stdout, /--server URL/);
  }
});

test("doctor quick emits parseable agent JSON with chrome info and NODE_USE_SYSTEM_CA warning", () => {
  const result = spawnSync(process.execPath, [cli, "doctor", "--quick", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_USE_SYSTEM_CA: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.match(output.node, /^v/);
  assert.equal(typeof output.xctrace.available, "boolean");
  assert.equal(typeof output.chrome, "object");
  assert.equal(output.nodeUseSystemCa, true);
  assert.ok(Array.isArray(output.warnings) && output.warnings.length > 0);
});

test("CLI failures exit 3 with structured error, Levenshtein flag hint, and no double Error: Error:", () => {
  const result = spawnSync(process.execPath, [cli, "run", "--preset", "unknown", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 3);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 3);
  assert.match(output.error.message, /Unknown preset/);

  const typo = spawnSync(process.execPath, [cli, "run", "--samplse", "3"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(typo.status, 3);
  assert.match(typo.stderr, /^error\[invalid-options\]:/m);
  assert.match(typo.stderr, /Did you mean --samples\?/);
  assert.doesNotMatch(typo.stderr, /Error: Error:/);
});

test("inspect CLI returns bounded selected evidence with relative reportPath and validates before reading", async () => {
  const { inspectReport } = await import("../src/inspect.js");
  const directory = await mkdtemp(path.join(tmpdir(), "gpu-inspect-"));
  try {
    const reportPath = path.join(directory, "report.json");
    const report = { inPage: { samples: [{ measurement: { gpuMs: 0 } }, { measurement: { gpuMs: 2 } }] }, trace: { raw: "x".repeat(100000) } };
    await writeFile(reportPath, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, "inspect", "--report", reportPath, "--section", "samples", "--offset", "1", "--limit", "1"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { reportPath, ...inspectReport(report, { section: "samples", offset: 1, limit: 1 }) });
    assert.ok(Buffer.byteLength(result.stdout) < 17000);
    for (const [key, value] of [["limit", "11"], ["offset", "-1"], ["offset", ""], ["run", "0.5"]]) {
      const invalid = spawnSync(process.execPath, [cli, "inspect", "--report", "/does/not/exist", `--${key}`, value], { encoding: "utf8" });
      assert.equal(invalid.status, 3);
      assert.equal(JSON.parse(invalid.stdout).ok, false);
      assert.doesNotMatch(invalid.stdout, /ENOENT/);
    }
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
    const failure = { runError: { message: "capture failed" }, diagnostics: { validity: { valid: false, issues: [{ code: "run-failed" }] } } };
    await writeFile(reportPath, JSON.stringify(failure));
    const failedCapture = spawnSync(process.execPath, [cli, "inspect", "--report", reportPath, "--section", "errors"], { encoding: "utf8" });
    assert.equal(failedCapture.status, 0, failedCapture.stderr || failedCapture.stdout);
    assert.equal(JSON.parse(failedCapture.stdout).validity.valid, false);
    assert.equal(JSON.parse(failedCapture.stdout).data.errors[0].error.message, "capture failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown commands and invalid sampling values return JSON with exit 3 without launching Chrome", () => {
  for (const args of [
    ["oops"],
    ["run", "--url", "http://localhost:1234", "--samples", "0"],
    ["run", "--url", "http://localhost:1234", "--duration-ms", "NaN"],
    ["run", "--url", "http://localhost:1234", "--sampling-mode", "invalid"],
    ["agent", "--url", "http://localhost:1234", "--sampling-mode", "hook", "--adaptive"]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 3, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test("artifact collisions are rejected before profiling", () => {
  const result = spawnSync(process.execPath, [cli, "run", "--file", "x.html", "--out", "same.json", "--screenshot-out", "same.json", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 3);
  assert.match(JSON.parse(result.stdout).error.message, /must be different/);
});

test("CLI comparison writes .compare.json artifact and cannot waive invalid measurements with --allow-mismatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gpu-compare-"));
  const file = path.join(directory, "empty.json");
  try {
    await writeFile(file, "{}");
    const result = spawnSync(process.execPath, [cli, "compare", "--base", file, "--candidate", file, "--allow-mismatch", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.validity.valid, false);
    assert.equal(output.failures.length, 0);
    const saved = JSON.parse(await readFile(path.join(directory, "empty.compare.json"), "utf8"));
    assert.equal(saved.kind, "comparison");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("A/B rejects conflicting output and invalid readiness before browser launch", () => {
  const target = ["ab", "--base-url", "http://localhost:1", "--candidate-url", "http://localhost:2"];
  for (const [args, message] of [
    [["--agent", "--json"], /Choose --json or --agent/],
    [["--wait-until", "invalid", "--json"], /waitUntil/],
    [["--device-scale-factor", "0", "--json"], /deviceScaleFactor/],
    [["--wait-condition-timeout", "0", "--json"], /waitConditionTimeoutMs/],
    [["--sampling-mode", "invalid", "--json"], /samplingMode/]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...target, ...args], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 3, result.stderr);
    assert.match(JSON.parse(result.stdout).error.message, message);
  }
});

test("CLI run and agent send their merged, validated options through --server, support agent --base, and write failure reports", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gpu-cli-hook-"));
  const requests = [];
  let shouldFail = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const options = JSON.parse(Buffer.concat(chunks));
    requests.push(options);
    response.setHeader("content-type", "application/json");
    if (shouldFail) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { code: "navigation-failed", message: "Target refused connection" } }));
      return;
    }
    response.end(JSON.stringify({
      // Like serve: options the client leaves out get the service's defaults (default preset).
      options: { samples: 5, durationMs: 1000, warmup: 1, ...options, autoInstrument: options.autoInstrument ?? false, api: options.api ?? "auto", samplingMode: options.samplingMode ?? "frames", viewport: "1280x720", deviceScaleFactor: 1 },
      inPage: {
        hook: { found: true },
        ...(options.autoInstrument ? { instrumentation: { before: {}, after: {}, delta: {} } } : {}),
        samples: [{ index: 0, elapsedMs: 100, measurement: { gpuMs: 1.5, observedFrames: { count: 6, fps: 60, frameTimeMs: { count: 6, mean: 16.67, p95: 16.7 } } } }],
        summary: { fps: { mean: 60 }, frameTimeMsMean: { mean: 16.67 }, frameTimeMsP95: { mean: 16.7 }, observedFrameCount: 6, sampleCount: 1 }
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const service = `http://127.0.0.1:${server.address().port}`;
  for (const [index, command, args] of [[0, "run", []], [1, "run", ["--sampling-mode", "hook"]], [2, "agent", ["--sampling-mode", "hook"]], [3, "run", ["--preset", "profile"]]]) {
    const child = spawn(process.execPath, [cli, command, "--url", "http://localhost:1234", "--samples", "1", "--server", service,
      "--out", path.join(directory, `${index}.json`), "--json", ...args], { cwd: root });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(status, 0, stderr || stdout);
    assert.equal(JSON.parse(stdout).ok, true);
  }
  assert.equal(requests[0].samplingMode, "frames");
  assert.equal(requests[0].waitForHook, undefined);
  // Plain run: only the typed --samples, so serve's own defaults (serve --auto-instrument,
  // viewport, context) apply; launch flags stay on serve.
  assert.deepEqual([requests[0].samples, requests[0].durationMs, requests[0].warmup, requests[0].autoInstrument, requests[0].gpuTiming, requests[0].trace],
    [1, undefined, undefined, undefined, undefined, undefined]);
  assert.equal(requests[0].viewport, undefined);
  assert.equal(requests[0].contextMode, undefined);
  assert.equal(requests[0].chromiumArgs, undefined);
  assert.equal(requests[1].samplingMode, "hook");
  assert.equal(requests[1].waitForHook, true);
  assert.equal(requests[2].samplingMode, "hook");
  assert.equal(requests[2].waitForHook, true);
  // agent: the quick preset, auto-instrument and GPU timing defaults are sent, not only typed flags.
  assert.deepEqual([requests[2].preset, requests[2].samples, requests[2].durationMs, requests[2].warmup, requests[2].autoInstrument, requests[2].gpuTiming],
    ["quick", 1, 250, 2, true, true]);
  // run --preset profile: the preset decides, including its GC and Chrome trace, but not
  // run's generic autoInstrument: false (serve --auto-instrument still applies).
  assert.deepEqual([requests[3].preset, requests[3].samples, requests[3].durationMs, requests[3].gc, requests[3].trace],
    ["profile", 1, 750, true, true]);
  assert.equal(requests[3].autoInstrument, undefined);

  const runAsync = async (cliArgs, cwdDir = root) => {
    const child = spawn(process.execPath, [cli, ...cliArgs], { cwd: cwdDir });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { status, stdout, stderr };
  };

  // Test agent <target> --base base.json combined capture + compare and label-based naming
  const basePath = path.join(directory, "0.json");
  const combined = await runAsync([
    "agent", "--url", "http://localhost:1234", "--base", basePath, "--server", service, "--label", "iter"
  ], directory);
  assert.equal(combined.status, 0, combined.stderr || combined.stdout);
  assert.match(combined.stdout, /Matched baseline: .*autoInstrument=false/);
  // Options inherited through --base reach the service, over the agent defaults.
  const inherited = requests.at(-1);
  assert.deepEqual([inherited.samples, inherited.durationMs, inherited.warmup, inherited.autoInstrument, inherited.viewport, inherited.deviceScaleFactor],
    [1, 1000, 1, false, "1280x720", 1]);
  assert.match(combined.stdout, /Saved: reports\/iter-1\.json, reports\/iter-1\.compare\.json/);

  // A profile baseline (trace: true) screened with agent --base and no --preset keeps tracing,
  // since trace is a compatibility key.
  const profiled = await runAsync([
    "agent", "--url", "http://localhost:1234", "--base", path.join(directory, "3.json"), "--server", service, "--out", path.join(directory, "prof-cand.json")
  ], directory);
  assert.equal(profiled.status, 0, profiled.stderr || profiled.stdout);
  assert.equal(requests.at(-1).trace, true);
  assert.doesNotMatch(profiled.stdout, /MISMATCH/);

  // Test runtime failure writes failure report and exits 3
  shouldFail = true;
  const failOut = path.join(directory, "fail.json");
  const failed = await runAsync([
    "run", "--url", "http://localhost:1234", "--server", service, "--out", failOut
  ], directory);
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /error\[navigation-failed\]: Target refused connection/);
  assert.match(failed.stderr, /Report: fail\.json/);
  const savedFail = JSON.parse(await readFile(failOut, "utf8"));
  assert.equal(savedFail.runError.code, "navigation-failed");
  assert.equal(savedFail.diagnostics.validity.valid, false);
});

test("CLI never reruns a warm daemon's page-level failure in-process, and falls back only when the daemon cannot take the job", async (t) => {
  const { daemonKey } = await import("../src/daemon.js");
  const directory = await mkdtemp(path.join(tmpdir(), "gpu-cli-daemon-"));
  const stateDir = path.join(directory, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let reply = null;
  let runs = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      response.end(JSON.stringify({ ok: true, alive: true, pid: process.pid }));
      return;
    }
    request.resume();
    request.on("end", () => {
      runs += 1;
      response.statusCode = reply.status;
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  // The launch options the CLI derives without launch flags. The target file does not exist,
  // so an in-process run fails fast with file-not-found instead of launching Chrome.
  const key = daemonKey({ chromiumArgs: [] });
  await writeFile(path.join(stateDir, `${key}.json`), JSON.stringify({ port: server.address().port, pid: process.pid, startedAt: new Date().toISOString(), key }));
  const runCli = async () => {
    const child = spawn(process.execPath, [cli, "run", "--file", path.join(directory, "missing.html"), "--out", path.join(directory, "report.json"), "--json"], {
      cwd: directory,
      env: { ...process.env, GPU_PERF_AGENT_STATE_DIR: stateDir, GPU_PERF_AGENT_NO_DAEMON: "0" }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { status, stderr, output: JSON.parse(stdout) };
  };

  reply = { status: 500, body: { ok: false, error: { code: "hook-timeout", message: "Timed out after 15000 ms waiting for benchmark hook __gpuReportBench (--wait-for-hook-timeout).", samplingStarted: false } } };
  const pageFailure = await runCli();
  assert.equal(pageFailure.status, 3);
  assert.equal(pageFailure.output.error.code, "hook-timeout");
  assert.equal(runs, 1);
  assert.doesNotMatch(pageFailure.stderr, /using warm profiler/);

  reply = { status: 503, body: { ok: false, error: { code: "CLOSING", message: "Server is closing." } } };
  const fallback = await runCli();
  assert.equal(fallback.status, 3);
  assert.equal(fallback.output.error.code, "file-not-found", "ran in-process after the daemon declined");
  assert.equal(runs, 2);
  assert.doesNotMatch(fallback.stderr, /using warm profiler/);

  reply = { status: 200, body: {
    options: { file: path.join(directory, "missing.html"), samples: 1, autoInstrument: false, api: "auto", samplingMode: "frames", viewport: "1280x720", deviceScaleFactor: 1 },
    inPage: {
      samples: [{ index: 0, elapsedMs: 100, measurement: { observedFrames: { count: 6, fps: 60, frameTimeMs: { count: 6, mean: 16.67, p95: 16.7 } } } }],
      summary: { fps: { mean: 60 }, frameTimeMsMean: { mean: 16.67 }, frameTimeMsP95: { mean: 16.7 }, observedFrameCount: 6, sampleCount: 1 }
    }
  } };
  const warm = await runCli();
  assert.notEqual(warm.status, 3, warm.stderr);
  assert.match(warm.stderr, new RegExp(`using warm profiler pid ${process.pid} \\(started \\d+s ago\\)`));
  assert.equal(runs, 3);
});

test("quick doctor locates xctrace without enumerating templates and handles missing tools", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gpu-doctor-"));
  const xcrun = path.join(directory, "xcrun");
  const calls = path.join(directory, "calls.jsonl");
  try {
    await writeFile(xcrun, `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); console.log(process.argv[2]==='--find'?'/mock/xctrace':'Metal System Trace');`, { mode: 0o755 });
    const env = { ...process.env, PATH: directory };
    const quick = spawnSync(process.execPath, [cli, "doctor", "--quick", "--json"], { env, encoding: "utf8" });
    assert.equal(quick.status, 0, quick.stderr);
    const result = JSON.parse(quick.stdout);
    assert.equal(result.xctrace.available, true);
    assert.equal(result.xctrace.templatesProbed, false);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse), [["--find", "xctrace"]]);
    const full = spawnSync(process.execPath, ["--input-type=module", "-e", 'import {macOSProfilerStatus} from "./src/native/macos-xctrace.js";console.log(JSON.stringify(await macOSProfilerStatus()));'], { cwd: root, env, encoding: "utf8" });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).templatesProbed, true);
    assert.deepEqual(JSON.parse(full.stdout).templates, ["Metal System Trace"]);
    await rm(xcrun);
    const missing = spawnSync(process.execPath, [cli, "doctor", "--quick", "--json"], { env, encoding: "utf8" });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).xctrace.available, false);
    assert.match(JSON.parse(missing.stdout).xctrace.xctraceError, /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
