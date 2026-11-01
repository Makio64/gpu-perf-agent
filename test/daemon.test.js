import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  connectOrStartDaemon,
  daemonDisabled,
  daemonKey,
  defaultDaemonStateDir,
  pruneDirectory,
  runViaDaemon
} from "../src/daemon.js";

const { createServer } = createRequire(import.meta.url)("node:http");
const networkEnabled = process.env.GPU_PERF_NETWORK_TESTS === "1";

test("daemonDisabled honors --no-daemon, GPU_PERF_AGENT_NO_DAEMON=1, and incompatible CLI flags", () => {
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--file", "a.html"], env: {} }), false);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--no-daemon"], env: {} }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent"], env: { GPU_PERF_AGENT_NO_DAEMON: "1" } }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent"], env: { GPU_PERF_AGENT_NO_DAEMON: "true" } }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--headful"], env: {} }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--cdp", "9222"], env: {} }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--server", "http://127.0.0.1:9099"], env: {} }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--runner", "playwright"], env: {} }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--runner=playwright"], env: {} }), true);
  assert.equal(daemonDisabled({ argv: ["node", "cli.js", "agent", "--runner", "cdp"], env: {} }), false);
});

test("daemonKey hashes launchOptions and invalidates when src/*.js mtime advances", async t => {
  const fakeSrc = await mkdtemp(path.join(os.tmpdir(), "gpu-daemon-src-"));
  t.after(() => rm(fakeSrc, { recursive: true, force: true }));

  const fileA = path.join(fakeSrc, "a.js");
  await writeFile(fileA, "export const a = 1;\n");
  const baseTime = new Date(Date.now() - 60000);
  await utimes(fileA, baseTime, baseTime);

  const key1 = await daemonKey({ headful: false, angle: "metal" }, { srcDir: fakeSrc });
  const key1Repeat = await daemonKey({ headful: false, angle: "metal" }, { srcDir: fakeSrc });
  assert.equal(key1, key1Repeat);
  assert.match(key1, /^[0-9a-f]{24}$/);

  const keyDiffOption = await daemonKey({ headful: false, angle: "gl" }, { srcDir: fakeSrc });
  assert.notEqual(key1, keyDiffOption);

  const keyDiffArgs = await daemonKey({ headful: false, angle: "metal", chromiumArgs: ["--foo", "--bar"] }, { srcDir: fakeSrc });
  assert.notEqual(key1, keyDiffArgs);

  // Touching a src/*.js file changes the key so a daemon from an older src mtime is not reused.
  const newerTime = new Date(baseTime.getTime() + 10000);
  await utimes(fileA, newerTime, newerTime);
  const keyNewerMtime = await daemonKey({ headful: false, angle: "metal" }, { srcDir: fakeSrc });
  assert.notEqual(key1, keyNewerMtime);
});

test("pruneDirectory keeps newest 200 files, removes files older than 7 days, and never touches outside files or subdirectories", async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "gpu-prune-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const targetDir = path.join(rootDir, "reports");
  const outsideFile = path.join(rootDir, "outside.json");
  const subDir = path.join(targetDir, "nested");
  await mkdir(subDir, { recursive: true });
  await writeFile(outsideFile, "{}");
  await writeFile(path.join(subDir, "keep-nested.json"), "{}");

  const now = Date.now();
  // Create 250 files: 5 of them 10 days old, 245 recent with distinct mtimes.
  for (let i = 0; i < 250; i += 1) {
    const filePath = path.join(targetDir, `file-${String(i).padStart(3, "0")}.json`);
    await writeFile(filePath, "{}");
    const ageMs = i < 5 ? 10 * 864e5 : (250 - i) * 1000;
    const mtime = new Date(now - ageMs);
    await utimes(filePath, mtime, mtime);
  }

  const removed = await pruneDirectory(targetDir, { keep: 200, maxAgeMs: 7 * 864e5, now });
  assert.equal(removed, 50);

  const entries = await readdir(targetDir, { withFileTypes: true });
  const remainingFiles = entries.filter(e => e.isFile()).map(e => e.name).sort();
  assert.equal(remainingFiles.length, 200);
  // Oldest 50 (file-000..file-049, including the 5 ten-day-old files) were removed; newest 200 (file-050..file-249) kept.
  assert.equal(remainingFiles[0], "file-050.json");
  assert.equal(remainingFiles[199], "file-249.json");

  // Now test age-only pruning when count <= 200: make 2 files 10 days old.
  const tenDaysAgo = new Date(now - 10 * 864e5);
  await utimes(path.join(targetDir, "file-050.json"), tenDaysAgo, tenDaysAgo);
  await utimes(path.join(targetDir, "file-051.json"), tenDaysAgo, tenDaysAgo);
  const removedOld = await pruneDirectory(targetDir, { keep: 200, maxAgeMs: 7 * 864e5, now });
  assert.equal(removedOld, 2);

  // Outside file and nested directory are untouched.
  assert.ok(await stat(outsideFile));
  assert.ok(await stat(path.join(subDir, "keep-nested.json")));
});

test("connectOrStartDaemon and runViaDaemon reuse a healthy daemon and replace a stale state file", { skip: !networkEnabled }, async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gpu-daemon-state-"));
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  let requests = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, alive: true, pid: process.pid }));
      return;
    }
    if (req.method === "POST" && req.url === "/run") {
      requests += 1;
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          schemaVersion: 3,
          options: parsed,
          summary: { verdict: "excellent", fps: 60 },
          diagnostics: { validity: { valid: true, issues: [], warnings: [] } }
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();

  const launchOptions = { angle: "metal" };
  const key = await daemonKey(launchOptions);
  const stateFile = path.join(stateDir, `${key}.json`);

  // Write a valid state file pointing to our mock daemon
  await writeFile(stateFile, JSON.stringify({
    port,
    pid: process.pid,
    startedAt: new Date(Date.now() - 120000).toISOString(),
    key
  }), { mode: 0o600 });

  const connected = await connectOrStartDaemon(launchOptions, {
    stateDir,
    spawnFn() { throw new Error("Should not spawn when daemon is healthy"); }
  });
  assert.ok(connected);
  assert.equal(connected.reused, true);
  assert.equal(connected.pid, process.pid);
  assert.equal(connected.url, `http://127.0.0.1:${port}`);

  // Test runViaDaemon with progress notifications
  const progressEvents = [];
  const report = await runViaDaemon(
    { url: "http://127.0.0.1:8080", warmup: 1, samples: 2 },
    {
      launchOptions,
      stateDir,
      // test:browser sets GPU_PERF_AGENT_NO_DAEMON=1 for the CLI tests; this one drives the daemon directly.
      argv: [],
      env: {},
      onProgress: ev => progressEvents.push(ev),
      onDaemonUsed: info => assert.equal(info.pid, process.pid)
    }
  );
  assert.ok(report);
  assert.equal(report.summary.verdict, "excellent");
  assert.equal(requests, 1);
  assert.equal(progressEvents.length, 3);

  // If state file has a dead PID, connectOrStartDaemon spawns a fresh daemon
  await writeFile(stateFile, JSON.stringify({
    port,
    pid: 999999,
    startedAt: new Date().toISOString(),
    key
  }), { mode: 0o600 });

  let spawned = 0;
  const reconnected = await connectOrStartDaemon(launchOptions, {
    stateDir,
    spawnFn() {
      spawned += 1;
      setTimeout(() => {
        writeFile(stateFile, JSON.stringify({
          port,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          key
        }), { mode: 0o600 }).catch(() => {});
      }, 20);
      return { unref() {} };
    }
  });
  assert.equal(spawned, 1);
  assert.ok(reconnected);
  assert.equal(reconnected.reused, false);
  assert.equal(reconnected.pid, process.pid);
});

test("runViaDaemon falls back (null) only when the daemon cannot take the job, never after a page-level failure", async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gpu-daemon-fallback-"));
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let runReply = null;
  let health = { ok: true, alive: true, pid: process.pid };
  let runs = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/health") return res.end(JSON.stringify(health));
    req.resume();
    req.on("end", () => {
      runs += 1;
      if (runReply.browserDied) health = { ok: false, alive: false, pid: process.pid };
      res.statusCode = runReply.status;
      res.end(JSON.stringify(runReply.body));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const launchOptions = { angle: "metal" };
  const key = daemonKey(launchOptions);
  await writeFile(path.join(stateDir, `${key}.json`), JSON.stringify({ port: server.address().port, pid: process.pid, startedAt: new Date().toISOString(), key }), { mode: 0o600 });
  let reused = 0;
  const run = () => runViaDaemon({ url: "http://127.0.0.1:9/", samples: 1 }, {
    launchOptions, stateDir, argv: [], env: {}, onReuse: () => { reused += 1; },
    spawnFn() { throw new Error("must reuse the running daemon"); }
  });
  const failure = (status, code, extra = {}) => ({ status, body: { ok: false, error: { code, message: `${code} message`, ...extra } } });

  // Page-level failures: the page already loaded once in the daemon; rerunning would load it twice.
  for (const [code, samplingStarted] of [["hook-timeout", false], ["condition-timeout", false], ["navigation-failed", false], ["RUN_FAILED", true]]) {
    runReply = failure(500, code, { samplingStarted });
    await assert.rejects(run(), { code, message: `${code} message` });
  }
  // The daemon could not take the job.
  for (const [status, code] of [[503, "CLOSING"], [429, "QUEUE_FULL"], [503, "CAPTURE_CLEANUP_FAILED"], [500, "aborted"]]) {
    runReply = failure(status, code);
    assert.equal(await run(), null, code);
  }
  // Its browser died mid-capture: /health no longer reports a live harness.
  runReply = { ...failure(500, "RUN_FAILED", { samplingStarted: true }), browserDied: true };
  assert.equal(await run(), null);
  assert.equal(reused, 0, "the warm-profiler notice waits for a report");

  health = { ok: true, alive: true, pid: process.pid };
  runReply = { status: 200, body: { schemaVersion: 3, options: {}, summary: { verdict: "excellent" } } };
  const report = await run();
  assert.equal(report.summary.verdict, "excellent");
  assert.equal(report.daemon.reused, true);
  assert.equal(reused, 1);
  assert.equal(runs, 10);
});

test("browser: second consecutive agent --file examples/webgpu-clear.html is >= 0.3 s faster and prints warm pid", {
  skip: process.env.GPU_PERF_BROWSER_TESTS !== "1",
  timeout: 45000
}, async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { requestJson } = await import("../src/http-client.js");
  const execFileAsync = promisify(execFile);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gpu-daemon-bench-"));
  const stateDir = path.join(tempDir, "state");
  const cliPath = path.resolve("src/cli.js");
  const pagePath = path.resolve("examples/webgpu-clear.html");
  const env = {
    ...process.env,
    GPU_PERF_AGENT_STATE_DIR: stateDir,
    GPU_PERF_AGENT_NO_DAEMON: "0"
  };

  t.after(async () => {
    try {
      const files = await readdir(stateDir).catch(() => []);
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const st = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(stateDir, name), "utf8"));
        if (st?.port) {
          await requestJson(`http://127.0.0.1:${st.port}/close`, {
            method: "POST",
            body: {},
            timeoutMs: 1000
          }).catch(() => {});
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const t0 = performance.now();
  const first = await execFileAsync(process.execPath, [
    cliPath, "agent", "--file", pagePath, "--samples", "2", "--duration-ms", "150", "--warmup", "1",
    "--out", path.join(tempDir, "run1.json")
  ], { env });
  const wall1Ms = performance.now() - t0;

  const t1 = performance.now();
  const second = await execFileAsync(process.execPath, [
    cliPath, "agent", "--file", pagePath, "--samples", "2", "--duration-ms", "150", "--warmup", "1",
    "--out", path.join(tempDir, "run2.json")
  ], { env });
  const wall2Ms = performance.now() - t1;

  assert.doesNotMatch(first.stderr, /using warm profiler pid/);
  assert.match(second.stderr, /using warm profiler pid \d+/);
  assert.ok(wall2Ms <= wall1Ms - 300, `expected second wall (${Math.round(wall2Ms)} ms) <= first wall (${Math.round(wall1Ms)} ms) - 300 ms`);
});
