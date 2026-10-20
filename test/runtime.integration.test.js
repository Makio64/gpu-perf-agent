import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FastCDPHarness, runFastReport } from "../src/fast-cdp-runner.js";
import { startFixtureServer } from "./fixtures/servers/fixture-server.mjs";

// L2 runtime: network idle, document status, progress, lock, teardown and transports.
const enabled = process.env.GPU_PERF_BROWSER_TESTS === "1";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const examples = fileURLToPath(new URL("../examples/", import.meta.url));
const quick = { samples: 2, warmup: 1, durationMs: 150, timeoutMs: 20000 };

let server;
let harness;
let lockDir;
test.before(async () => {
  if (!enabled) return;
  lockDir = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-lock-it-"));
  process.env.GPU_PERF_AGENT_LOCK_DIR = lockDir;
  server = await startFixtureServer();
  harness = await FastCDPHarness.launch({ autoInstrument: true });
});
test.after(async () => {
  await harness?.close();
  await server?.close();
  if (lockDir) await rm(lockDir, { recursive: true, force: true });
});

test("EventSource never holds network idle", { skip: !enabled }, async () => {
  const started = performance.now();
  const report = await harness.run({ ...quick, url: `${server.url}/sse.html` });
  assert.ok(performance.now() - started < 3500, `took ${performance.now() - started} ms`);
  assert.ok(["idle", "overlapped"].includes(report.timings.networkIdle.status), JSON.stringify(report.timings.networkIdle));
  assert.ok(report.timings.networkIdle.waitedMs < 1000);
  assert.ok(!(report.diagnostics?.validity?.warnings ?? []).some(warning => warning.code === "network-not-idle"));
});

test("a never-ending long poll continues after the budget and names the pending URL", { skip: !enabled }, async () => {
  const report = await harness.run({ ...quick, url: `${server.url}/long-poll.html`, networkIdleBudgetMs: 1500 });
  const idle = report.timings.networkIdle;
  assert.equal(idle.status, "budget-exceeded");
  assert.ok(idle.pending.some(request => request.url.endsWith("/poll") && request.type === "Fetch" && request.ageMs > 0), JSON.stringify(idle));
  assert.ok(idle.pending.length <= 3);
});

test("a delayed 3 s asset is still waited for (sequential readiness)", { skip: !enabled }, async () => {
  const report = await harness.run({ ...quick, url: `${server.url}/delayed-fetch.html?ms=3000`, waitCondition: "true" });
  assert.equal(report.timings.networkIdle.status, "idle");
  assert.ok(report.timings.networkIdle.waitedMs >= 2900, JSON.stringify(report.timings.networkIdle));
  assert.ok(report.timings.networkIdleWaitMs >= 2900);
});

test("the idle flag reaches the page during warmup when idle overlaps sampling", { skip: !enabled }, async () => {
  // ~1.6 s of evaluation: the post-load fetch (600 ms) has long finished by the last sample.
  const report = await harness.run({ ...quick, samples: 3, warmup: 2, durationMs: 400, url: `${server.url}/idle-flag.html` });
  assert.equal(report.inPage.samples.at(-1).measurement.idleFlag, true);
  const idle = report.timings.networkIdle;
  // This page sends no sample-start, so warmup end falls back to the evaluation start; the
  // fetch was then still pending unless the in-page warmup held for the flag.
  if (idle.status === "budget-exceeded") {
    assert.ok(idle.pending.some(request => request.url.includes("/delayed?ms=600")), JSON.stringify(idle));
    assert.ok(idle.waitedMs < idle.budgetMs, JSON.stringify(idle));
  } else {
    assert.equal(idle.status, "overlapped", JSON.stringify(idle));
    assert.ok(idle.waitedMs >= 550, JSON.stringify(idle));
  }
});

test("network idle is classified against warmup end (first sample-start)", { skip: !enabled }, async () => {
  // Idle (~100 ms fetch + quiet window) lands inside a ~1.2 s warmup: overlapped.
  const overlapped = await harness.run({ ...quick, samples: 2, warmup: 3, durationMs: 400, url: `${server.url}/progress.html?fetch=100` });
  assert.equal(overlapped.timings.networkIdle.status, "overlapped", JSON.stringify(overlapped.timings.networkIdle));
  assert.deepEqual(overlapped.timings.networkIdle.pending, []);
  // Sampling starts with a 2 s fetch pending: budget-exceeded, with what was pending at
  // sample-start and the time waited until then, not the full budget.
  const pendingAtSampling = await harness.run({ ...quick, samples: 2, warmup: 0, durationMs: 150, url: `${server.url}/progress.html?fetch=2000` });
  const idle = pendingAtSampling.timings.networkIdle;
  assert.equal(idle.status, "budget-exceeded", JSON.stringify(idle));
  assert.ok(idle.pending.some(request => request.url.includes("/delayed?ms=2000")), JSON.stringify(idle));
  assert.ok(idle.waitedMs < 1500 && idle.budgetMs === 10000, JSON.stringify(idle));
});

test("captures that end before network idle leave no timers keeping Node alive", { skip: !enabled, timeout: 60000 }, async () => {
  // A child process runs one capture of a never-ending long poll and must exit right after.
  const script = `import { runFastReport } from ${JSON.stringify(new URL("../src/fast-cdp-runner.js", import.meta.url).href)};
    const report = await runFastReport({ samples: 2, warmup: 0, durationMs: 150, timeoutMs: 20000, measureLock: false, url: ${JSON.stringify(`${server.url}/long-poll.html`)} });
    process.stdout.write(JSON.stringify(report.timings.networkIdle) + "\\n");
    globalThis.reportedAt = performance.now();
    process.on("exit", () => process.stderr.write("exit-lag " + (performance.now() - globalThis.reportedAt).toFixed(0) + "\\n"));`;
  const { stderr, stdout } = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_USE_SYSTEM_CA;
    execFile(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 30000 }, (error, out, err) => error ? reject(Object.assign(error, { stderr: err })) : resolve({ stdout: out, stderr: err }));
  });
  assert.equal(JSON.parse(stdout).status, "budget-exceeded");
  const lag = Number(/exit-lag (\d+)/.exec(stderr)?.[1]);
  assert.ok(lag < 1500, `process exited ${lag} ms after the report: ${stderr}`);
});

test("the network-idle budget pauses while the page is frozen for the measurement lock", { skip: !enabled, timeout: 60000 }, async () => {
  // A live holder (this process) keeps the lock for 3 s, longer than the 2 s budget.
  const lockPath = path.join(lockDir, "measure.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, label: "test-holder", since: Date.now(), nonce: "test" }));
  const releaseTimer = setTimeout(() => rm(lockPath, { force: true }), 3000);
  try {
    const report = await harness.run({ ...quick, samples: 2, warmup: 4, durationMs: 400, networkIdleBudgetMs: 2000, url: `${server.url}/progress.html?fetch=600` });
    const idle = report.timings.networkIdle;
    assert.equal(report.measurementLock.frozenWhileWaiting, true);
    assert.ok(report.timings.lockWaitMs >= 2500, String(report.timings.lockWaitMs));
    assert.equal(idle.status, "overlapped", JSON.stringify(idle));
    assert.ok(idle.pausedMs >= 2000 && idle.waitedMs < 2000, JSON.stringify(idle));
  } finally {
    clearTimeout(releaseTimer);
    await rm(lockPath, { force: true });
  }
});

test("close({abort}) stops a job that is waiting for the measurement lock", { skip: !enabled, timeout: 60000 }, async () => {
  const lockPath = path.join(lockDir, "measure.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, label: "test-holder", since: Date.now(), nonce: "test" }));
  const own = await FastCDPHarness.launch({});
  try {
    const events = [];
    const running = own.run({ ...quick, url: `${server.url}/progress.html`, lockTimeoutMs: 30000 }, { onProgress: event => events.push(event.stage) });
    while (!events.includes("lock-wait")) await new Promise(resolve => setTimeout(resolve, 50));
    const abortedAt = performance.now();
    await own.close({ abort: true, timeoutMs: 1000 });
    await assert.rejects(running, { code: "aborted" });
    assert.ok(performance.now() - abortedAt < 3000, `${performance.now() - abortedAt} ms`);
  } finally {
    await own.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
});

test("dedicated workers do not hold network idle", { skip: !enabled }, async () => {
  // Sequential readiness, so the idle wait finishes (or hits the budget) before sampling.
  for (const page of ["w2/index.html", "worker.html"]) {
    const report = await harness.run({ ...quick, url: `${server.url}/${page}`, waitCondition: "true" });
    assert.equal(report.timings.networkIdle.status, "idle", `${page}: ${JSON.stringify(report.timings.networkIdle)}`);
    assert.ok(report.timings.networkIdle.waitedMs < 3000, `${page}: ${JSON.stringify(report.timings.networkIdle)}`);
  }
});

test("a 404 script during the first navigation is recorded with its URL", { skip: !enabled }, async () => {
  const report = await harness.run({ ...quick, url: `${server.url}/script-404.html` });
  const events = JSON.stringify(report.pageEvents);
  assert.match(events, /missing-module\.js/);
});

test("navigation timeouts carry a code, the pending URLs and a hint", { skip: !enabled }, async () => {
  await assert.rejects(harness.run({ ...quick, url: `${server.url}/poll`, waitUntil: "load", timeoutMs: 1500 }), (error) => {
    assert.equal(error.code, "navigation-timeout");
    assert.match(error.message, /\/poll/);
    assert.match(error.hint, /--wait-until load/);
    return true;
  });
  await assert.rejects(harness.run({ ...quick, url: "http://127.0.0.1:9/" }), { code: "navigation-failed" });
  await assert.rejects(harness.run({ ...quick, url: `${server.url}/sse.html`, waitCondition: "false", waitConditionTimeoutMs: 200 }), { code: "condition-timeout" });
  await assert.rejects(harness.run({ ...quick, url: `${server.url}/sse.html`, waitForHook: true, timeoutMs: 1500 }), { code: "hook-timeout" });
});

test("the main document status and final URL are recorded", { skip: !enabled }, async () => {
  const missing = await harness.run({ ...quick, url: `${server.url}/status/404/page.html`, waitUntil: "load" });
  assert.equal(missing.target.httpStatus, 404);
  assert.equal(missing.target.documentUrl, `${server.url}/status/404/page.html`);
  const ok = await harness.run({ ...quick, file: path.join(examples, "webgl2-draw.html") });
  assert.equal(ok.target.httpStatus, 200);
  assert.equal(ok.target.root, path.dirname(examples.replace(/[/\\]$/, "")));
});

test("timings, tool and options follow the v3 schema", { skip: !enabled }, async () => {
  const fresh = await FastCDPHarness.launch({});
  try {
    const first = await fresh.run({ ...quick, url: `${server.url}/sse.html`, label: "base" });
    const second = await fresh.run({ ...quick, url: `${server.url}/sse.html` });
    assert.ok(first.timings.launchMs > 0);
    assert.equal(first.timings.harnessReused, false);
    assert.equal(second.timings.launchMs, 0);
    assert.equal(second.timings.harnessReused, true);
    for (const key of ["pageSetupMs", "navigationMs", "networkIdleWaitMs", "lockWaitMs", "readyWaitMs", "samplingMs", "cpuProfileMs", "totalMs"]) {
      assert.equal(typeof first.timings[key], "number", key);
    }
    assert.deepEqual(first.timings.anomalies, []);
    assert.equal(first.tool.name, "gpu-perf-agent");
    assert.equal(first.options.label, "base");
    for (const key of ["gpuTiming", "readyTimeoutMs", "allowIdle", "networkIdleBudgetMs", "cpuProfile", "measureLock", "cdpAttached"]) {
      assert.ok(key in first.options, key);
    }
    assert.equal(first.measurementLock.acquired, true);
    assert.equal(first.measurementLock.path, path.join(lockDir, "measure.lock"));
  } finally { await fresh.close(); }
});

test("progress binding events reach onProgress and drive per-sample CDP metrics", { skip: !enabled }, async () => {
  const events = [];
  const report = await harness.run({ ...quick, samples: 3, warmup: 0, url: `${server.url}/progress.html` }, { onProgress: event => events.push(event) });
  assert.deepEqual(events.filter(event => event.stage === "sample").map(event => event.index), [0, 1, 2]);
  assert.equal(events[0].stage, "navigate");
  assert.equal(events.at(-1).stage, "analyze");
  assert.equal(report.cdp.samples.length, 3);
  for (const sample of report.cdp.samples) {
    assert.ok(sample.endTs > sample.startTs);
    assert.ok(sample.threadTimeS > 0 && sample.taskDurationS > 0, JSON.stringify(sample));
  }
});

test("two concurrent captures serialize their sampling windows; the waiter is frozen", { skip: !enabled, timeout: 60000 }, async () => {
  const second = await FastCDPHarness.launch({});
  try {
    const options = { ...quick, samples: 4, warmup: 0, durationMs: 200, url: `${server.url}/progress.html` };
    const [a, b] = await Promise.all([harness.run(options), second.run(options)]);
    const window = report => {
      const times = report.inPage.samples.map(sample => sample.measurement);
      return [Math.min(...times.map(time => time.startedAt)), Math.max(...times.map(time => time.endedAt))];
    };
    const [first, last] = [a, b].sort((x, y) => window(x)[0] - window(y)[0]);
    assert.ok(window(first)[1] <= window(last)[0], `overlap: ${window(first)} vs ${window(last)}`);
    assert.ok(last.timings.lockWaitMs > 0);
    assert.equal(last.measurementLock.frozenWhileWaiting, true);
    assert.deepEqual(last.measurementLock.holder?.pid, process.pid);
  } finally { await second.close(); }
});

test("an aborted capture rejects with code aborted and the harness keeps working", { skip: !enabled }, async () => {
  const controller = new AbortController();
  const started = performance.now();
  const running = harness.run({ ...quick, samples: 20, durationMs: 500, url: `${server.url}/sse.html` }, {
    signal: controller.signal,
    onProgress: event => { if (event.stage === "analyze") assert.fail("should not finish"); }
  });
  setTimeout(() => controller.abort(), 1200);
  await assert.rejects(running, { code: "aborted" });
  assert.ok(performance.now() - started < 5000);
  const report = await harness.run({ ...quick, url: `${server.url}/sse.html` });
  assert.ok(report.summary);
});

test("a page flooding errors does not block Chrome on stderr", { skip: !enabled, timeout: 60000 }, async () => {
  const report = await harness.run({ ...quick, samples: 3, url: `${server.url}/stderr-spam.html`, timeoutMs: 30000 });
  assert.ok(report.inPage.samples.length === 3);
  assert.equal(typeof harness.stderrTail(), "string");
});

test("screenshotJpegPath writes a JPEG at most 640 px wide", { skip: !enabled }, async () => {
  const file = path.join(lockDir, "inline.jpg");
  const report = await harness.run({ ...quick, url: `${server.url}/sse.html`, screenshotJpegPath: file });
  assert.equal(report.artifacts.screenshotJpegPath, file);
  const bytes = await readFile(file);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
  let width = null;
  for (let offset = 2; offset < bytes.length - 9 && width === null;) {
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) width = bytes.readUInt16BE(offset + 7);
    else offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  assert.ok(width > 0 && width <= 640, `width ${width}`);
});

test("probe() reports the browser, WebGPU and WebGL2", { skip: !enabled }, async () => {
  const probe = await harness.probe();
  assert.match(probe.chrome.version, /Chrome|Chromium|Edg/);
  assert.equal(typeof probe.webgpu.available, "boolean");
  assert.equal(typeof probe.webgl2.available, "boolean");
  if (probe.webgpu.available) assert.equal(typeof probe.webgpu.timestampQuery, "boolean");
});

test("--cdp attaches through discovery and the WebSocket client, and records cdpAttached", { skip: !enabled, timeout: 60000 }, async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-cdp-attach-"));
  const chrome = spawn(harness.launch.executablePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "--enable-unsafe-webgpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no DevTools port: ${stderr}`)), 15000);
      chrome.stderr.on("data", chunk => {
        stderr += chunk;
        const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(stderr);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const attached = await FastCDPHarness.launch({ cdpUrl: port });
    try {
      const report = await attached.run({ ...quick, url: `${server.url}/sse.html` });
      assert.equal(report.options.cdpAttached, true);
      assert.ok(report.inPage.samples.length > 0);
      assert.equal(attached.pid, null);
    } finally { await attached.close(); }
    assert.equal(chrome.exitCode, null, "attached browsers are left running");
  } finally {
    chrome.kill("SIGKILL");
    await new Promise(resolve => chrome.exitCode !== null || chrome.signalCode !== null ? resolve() : chrome.once("exit", resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a killed Chrome makes the harness report not alive", { skip: !enabled }, async () => {
  const doomed = await FastCDPHarness.launch({});
  try {
    assert.equal(doomed.alive, true);
    process.kill(doomed.pid, "SIGKILL");
    const deadline = Date.now() + 3000;
    while (doomed.alive && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(doomed.alive, false);
  } finally { await doomed.close({ abort: true }); }
});

test("serve relaunches Chrome after it is killed and /health reports it", { skip: !enabled, timeout: 60000 }, async () => {
  const { startReportServer } = await import("../src/report-server.js");
  const { requestJson } = await import("../src/http-client.js");
  const service = await startReportServer({ port: 0, idleTimeoutMs: 0 });
  try {
    const firstPid = service.harness.pid;
    process.kill(firstPid, "SIGKILL");
    const deadline = Date.now() + 3000;
    let health;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      health = await requestJson(`${service.url}/health`);
    } while (health.json.alive && Date.now() < deadline);
    assert.equal(health.status, 503);
    assert.equal(health.json.ok, false);
    const run = await requestJson(`${service.url}/run?format=compact`, { method: "POST", body: { ...quick, url: `${server.url}/sse.html` }, timeoutMs: 30000 });
    assert.equal(run.status, 200, JSON.stringify(run.json));
    health = await requestJson(`${service.url}/health`);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.relaunches, 1);
    assert.notEqual(health.json.pid, firstPid);
  } finally { await service.close(); }
});

test("a legacy profile dir without owner.json is removed by the next launch", { skip: !enabled || process.platform === "win32" }, async () => {
  const legacy = path.join(os.tmpdir(), `webgpu-report-cdp-legacy-${process.pid}`);
  await mkdir(path.join(legacy, "Default"), { recursive: true });
  const old = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(legacy, old, old);
  const fresh = await FastCDPHarness.launch({});
  try {
    await fresh.launch.sweep;
    await assert.rejects(stat(legacy), { code: "ENOENT" });
    const owner = JSON.parse(await readFile(path.join(fresh.launch.userDataDir, "owner.json"), "utf8"));
    assert.deepEqual([owner.ownerPid, owner.chromePid], [process.pid, fresh.pid]);
  } finally { await fresh.close(); await rm(legacy, { recursive: true, force: true }); }
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`no Chrome survives 6 s after ${signal} of the CLI`, { skip: !enabled, timeout: 60000 }, async () => {
    const child = spawn(process.execPath, [cli, "agent", "--no-daemon", "--file", path.join(examples, "webgl2-draw.html"), "--out", path.join(lockDir, `kill-${signal}.json`)], { stdio: "ignore" });
    // Wait until this CLI's Chrome profile exists, then kill the CLI mid-capture.
    let profile = null;
    const deadline = Date.now() + 15000;
    while (!profile && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const name of (await readdir(os.tmpdir())).filter(name => name.startsWith("webgpu-report-cdp-"))) {
        const owner = await readFile(path.join(os.tmpdir(), name, "owner.json"), "utf8").then(JSON.parse).catch(() => null);
        if (owner?.ownerPid === child.pid) profile = path.join(os.tmpdir(), name);
      }
    }
    assert.ok(profile, "the CLI launched Chrome");
    await new Promise(resolve => setTimeout(resolve, 800));
    child.kill(signal);
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
    await new Promise(resolve => setTimeout(resolve, 6000));
    const ps = await new Promise(resolve => execFile("ps", ["-axo", "pid=,args="], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(stdout)));
    const survivors = ps.split("\n").filter(line => line.includes(profile));
    assert.deepEqual(survivors, []);
    // The CLI's own handler closes Chrome and exits 128+signo.
    if (signal === "SIGTERM") assert.equal(child.exitCode, 128 + 15);
    await rm(profile, { recursive: true, force: true });
  });
}

test("runFastReport records teardownMs after closing Chrome", { skip: !enabled }, async () => {
  const report = await runFastReport({ ...quick, url: `${server.url}/sse.html` });
  assert.equal(typeof report.timings.teardownMs, "number");
  assert.ok(report.timings.teardownMs > 0);
});
