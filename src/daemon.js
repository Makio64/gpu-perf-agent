import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestJson } from "./http-client.js";
import { processAlive } from "./measure-lock.js";

const TOOL_VERSION = "2.2.0";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const REPORT_SERVER_PATH = fileURLToPath(new URL("./report-server.js", import.meta.url));
const LAUNCH_OPTION_KEYS = ["angle", "channel", "chromiumArgs", "executablePath", "headful", "cdp", "cdpUrl", "webSocketUrl"];
// Daemon answers meaning it could not take the job (closing, full queue, dead or
// relaunching browser), as opposed to the page failing.
const DAEMON_UNAVAILABLE_CODES = new Set(["CLOSING", "QUEUE_FULL", "CAPTURE_CLEANUP_FAILED", "capture-cleanup-failed", "chrome-launch-failed", "aborted"]);

export function defaultDaemonStateDir() {
  if (process.env.GPU_PERF_AGENT_STATE_DIR) return path.resolve(process.env.GPU_PERF_AGENT_STATE_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `gpu-perf-agent-${uid}`);
}

export function daemonDisabled({ argv = process.argv, env = process.env, noDaemon = false } = {}) {
  if (noDaemon) return true;
  if (Array.isArray(argv)) {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = String(argv[i] ?? "");
      if (
        arg === "--no-daemon" ||
        arg === "--no-daemon=1" ||
        arg === "--no-daemon=true" ||
        arg === "--headful" ||
        arg === "--server" ||
        arg.startsWith("--server=") ||
        arg === "--cdp" ||
        arg.startsWith("--cdp=") ||
        arg === "--cdp-url" ||
        arg.startsWith("--cdp-url=") ||
        arg === "--runner=playwright" ||
        (arg === "--runner" && argv[i + 1] === "playwright")
      ) {
        return true;
      }
    }
  }
  const flag = env?.GPU_PERF_AGENT_NO_DAEMON;
  return Boolean(flag && flag !== "0" && flag !== "false");
}

export function daemonKey(launchOptions = {}, options = {}) {
  const rawSrcDir = options?.srcDir || launchOptions?.srcDir ? path.resolve(options?.srcDir || launchOptions.srcDir) : SRC_DIR;
  let resolvedSrcDir = rawSrcDir;
  try {
    resolvedSrcDir = realpathSync(rawSrcDir);
  } catch {
    resolvedSrcDir = path.resolve(rawSrcDir);
  }
  const maxMtimeMs = Number.isFinite(launchOptions?.maxMtimeMs)
    ? Number(launchOptions.maxMtimeMs)
    : computeMaxMtimeMs(resolvedSrcDir);
  const payload = {
    version: launchOptions?.version ?? TOOL_VERSION,
    srcDir: resolvedSrcDir,
    maxMtimeMs,
    executablePath: launchOptions?.executablePath || process.env.CHROME_PATH || process.env.CHROMIUM_PATH || null,
    channel: launchOptions?.channel || null,
    headful: Boolean(launchOptions?.headful),
    angle: launchOptions?.angle || null,
    chromiumArgs: Array.isArray(launchOptions?.chromiumArgs) ? [...launchOptions.chromiumArgs] : [],
    cdpUrl: launchOptions?.cdpUrl || launchOptions?.cdp || launchOptions?.webSocketUrl || null
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

/**
 * Retention helper: keeps the newest `keep` regular files in `dir` and removes any
 * regular file older than `maxAgeMs`. Never touches directories or files outside `dir`.
 */
export async function pruneDirectory(dir, { keep = 200, maxAgeMs = 7 * 864e5, now = Date.now() } = {}) {
  if (!dir || typeof dir !== "string") return 0;
  const root = path.resolve(dir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (entry.name.includes("/") || entry.name.includes("\\") || entry.name === "." || entry.name === "..") continue;
    const filePath = path.join(root, entry.name);
    if (path.dirname(filePath) !== root) continue;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      files.push({ filePath, name: entry.name, mtimeMs: info.mtimeMs });
    } catch {
      // Concurrent removal is ignored.
    }
  }
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
  const cutoff = now - maxAgeMs;
  let deleted = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (index < keep && file.mtimeMs >= cutoff) continue;
    try {
      await unlink(file.filePath);
      deleted += 1;
    } catch {
      // Ignore already-unlinked files.
    }
  }
  return deleted;
}

export async function connectOrStartDaemon(launchOptions = {}, {
  idleTimeoutMs = 600000,
  startTimeoutMs = 15000,
  stateDir = defaultDaemonStateDir(),
  spawnImpl,
  spawnFn
} = {}) {
  const spawner = spawnFn || spawnImpl || spawn;
  const dir = path.resolve(stateDir);
  const key = daemonKey(launchOptions);
  const stateFile = path.join(dir, `${key}.json`);

  const existing = await probeStateFile(stateFile, key, true);
  if (existing) return existing;

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await pruneDirectory(dir);
  } catch {
    return null;
  }

  const serveArgs = buildServeArgs(launchOptions, { idleTimeoutMs, stateFile });
  let childExited = false;
  let fallbackSpawned = false;
  try {
    const child = spawner(process.execPath, [CLI_PATH, "serve", ...serveArgs], {
      detached: true,
      stdio: "ignore"
    });
    child?.on?.("error", () => { childExited = true; });
    child?.once?.("exit", () => { childExited = true; });
    child?.unref?.();
  } catch {
    return null;
  }

  const deadline = performance.now() + startTimeoutMs;
  while (performance.now() < deadline) {
    const started = await probeStateFile(stateFile, key, false);
    if (started) return started;
    if (childExited && !fallbackSpawned && spawner === spawn) {
      fallbackSpawned = true;
      childExited = false;
      try {
        const fallback = spawn(process.execPath, [REPORT_SERVER_PATH, ...serveArgs], {
          detached: true,
          stdio: "ignore"
        });
        fallback.on("error", () => { childExited = true; });
        fallback.once("exit", () => { childExited = true; });
        fallback.unref();
      } catch {
        return null;
      }
    } else if (childExited && (fallbackSpawned || spawner !== spawn)) {
      const retry = await probeStateFile(stateFile, key, false);
      return retry;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return null;
}

export async function runViaDaemon(options = {}, {
  launchOptions = {},
  onProgress,
  onReuse,
  onDaemonUsed,
  stateDir,
  idleTimeoutMs = 600000,
  startTimeoutMs = 15000,
  argv = process.argv,
  env = process.env,
  spawnImpl,
  spawnFn
} = {}) {
  if (daemonDisabled({ argv, env, noDaemon: options?.noDaemon })) return null;
  if (options?.server || options?.cdp || options?.cdpUrl || options?.webSocketUrl || options?.headful || options?.runner === "playwright") {
    return null;
  }
  const mergedLaunch = {
    ...extractLaunchOptions(options),
    ...launchOptions
  };
  if (mergedLaunch.headful || mergedLaunch.cdpUrl) return null;

  const daemon = await connectOrStartDaemon(mergedLaunch, {
    idleTimeoutMs,
    startTimeoutMs,
    stateDir,
    spawnImpl: spawnFn || spawnImpl
  });
  if (!daemon) return null;

  try {
    onDaemonUsed?.(daemon);
  } catch {
    // Ignore callback errors.
  }

  const runBody = { ...options };
  for (const key of LAUNCH_OPTION_KEYS) delete runBody[key];

  const timeoutMs = (Number(options.timeoutMs) || 60000) + (Number(options.lockTimeoutMs) || 30000) + 30000;
  try {
    const { status, json } = await requestJson(`${daemon.url}/run`, {
      method: "POST",
      body: runBody,
      timeoutMs,
      headers: {
        "content-type": "application/json",
        host: `127.0.0.1:${daemon.port}`,
        origin: `http://127.0.0.1:${daemon.port}`
      }
    });
    if (status >= 200 && status < 300 && json && typeof json === "object") {
      if (typeof onProgress === "function") {
        const warmup = Number(options.warmup ?? json.options?.warmup ?? 0) || 0;
        const samples = Number(options.samples ?? json.options?.samples ?? 0) || 0;
        for (let i = 0; i < warmup; i += 1) emitProgress(onProgress, { stage: "warmup", index: i, total: warmup });
        for (let i = 0; i < samples; i += 1) emitProgress(onProgress, { stage: "sample", index: i, total: samples });
      }
      json.daemon = {
        pid: daemon.pid,
        port: daemon.port,
        url: daemon.url,
        startedAt: daemon.startedAt,
        reused: daemon.reused,
        key: daemon.key
      };
      try {
        if (daemon.reused) onReuse?.(daemon);
      } catch {
        // Ignore callback errors.
      }
      return json;
    }
    // null lets the caller run the job in-process: only when the daemon could not take it,
    // or its browser died. A page-level failure (navigation, readiness, hook exception)
    // would fail the same way again, after loading the page a second time.
    if (DAEMON_UNAVAILABLE_CODES.has(json?.error?.code) || (status >= 500 && !(await daemonAlive(daemon)))) return null;
    if (status === 400 && /must be inside the server report directory/.test(json?.error?.message || "")) return null;
    throw Object.assign(new Error(json?.error?.message || `Daemon returned HTTP ${status}.`), {
      code: json?.error?.code || "run-failed",
      ...(json?.error?.hint ? { hint: json.error.hint } : {})
    });
  } catch (error) {
    if (error?.code === "server-unreachable") return null;
    throw error;
  }
}

export const runWithDaemon = runViaDaemon;
export const runDaemonCapture = runViaDaemon;

async function daemonAlive(daemon) {
  try {
    const { status, json } = await requestJson(`${daemon.url}/health`, {
      timeoutMs: 1000,
      headers: { host: `127.0.0.1:${daemon.port}` }
    });
    return status === 200 && json?.ok === true && json?.alive === true;
  } catch {
    return false;
  }
}

async function probeStateFile(stateFile, expectedKey, reused) {
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
  const port = Number(state?.port);
  const pid = Number(state?.pid);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !processAlive(pid)) {
    await unlink(stateFile).catch(() => {});
    return null;
  }
  try {
    const { status, json } = await requestJson(`http://127.0.0.1:${port}/health`, {
      timeoutMs: 300,
      headers: { host: `127.0.0.1:${port}` }
    });
    if (status === 200 && json?.ok === true && json?.alive === true) {
      return {
        url: `http://127.0.0.1:${port}`,
        port,
        pid: json.pid ?? pid,
        startedAt: state.startedAt ?? null,
        key: state.key ?? expectedKey,
        reused
      };
    }
  } catch {
    // Server not yet listening or unreachable.
  }
  return null;
}

function buildServeArgs(launchOptions = {}, { idleTimeoutMs, stateFile }) {
  const args = [
    "--port", "0",
    "--idle-timeout-ms", String(idleTimeoutMs),
    "--state-file", stateFile
  ];
  if (launchOptions.reportDir) args.push("--report-dir", path.resolve(launchOptions.reportDir));
  if (launchOptions.angle) args.push("--angle", String(launchOptions.angle));
  if (launchOptions.channel) args.push("--channel", String(launchOptions.channel));
  if (launchOptions.executablePath) args.push("--executable-path", String(launchOptions.executablePath));
  if (launchOptions.headful) args.push("--headful");
  if (Array.isArray(launchOptions.chromiumArgs)) {
    for (const arg of launchOptions.chromiumArgs) {
      args.push(`--chromium-arg=${arg}`);
    }
  }
  return args;
}

function extractLaunchOptions(options = {}) {
  return {
    ...(options.angle !== undefined ? { angle: options.angle } : {}),
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
    ...(options.headful !== undefined ? { headful: options.headful } : {}),
    ...(options.chromiumArgs !== undefined ? { chromiumArgs: options.chromiumArgs } : {}),
    ...(options.cdpUrl || options.cdp || options.webSocketUrl ? { cdpUrl: options.cdpUrl || options.cdp || options.webSocketUrl } : {})
  };
}

function computeMaxMtimeMs(srcDir) {
  let max = 0;
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        try {
          const mtimeMs = Math.floor(statSync(fullPath).mtimeMs);
          if (mtimeMs > max) max = mtimeMs;
        } catch {
          // Ignore transient files.
        }
      }
    }
  };
  visit(srcDir);
  return max;
}

function emitProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try { onProgress(event); } catch { /* Progress is advisory. */ }
}
