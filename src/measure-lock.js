import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Machine-wide advisory lock around the timed portion of a capture, so concurrent
// agents (CLI, MCP servers, daemons) do not render into each other's sampling windows.
const STALE_AFTER_MS = 5 * 60 * 1000;
const POLL_MS = 50;
const held = new Map();
let exitHookInstalled = false;

/**
 * GPU_PERF_AGENT_LOCK_DIR, else (win32 ? os.tmpdir() : "/tmp")/gpu-perf-agent-<uid>/measure.lock.
 * Deliberately independent of TMPDIR so sandboxed CLIs, MCP servers and daemons share it.
 */
export function measurementLockPath() {
  const directory = process.env.GPU_PERF_AGENT_LOCK_DIR
    || path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `gpu-perf-agent-${userId()}`);
  return path.join(directory, "measure.lock");
}

/**
 * Bounded wait for the lock. Never throws for lock problems: a timeout returns
 * `{acquired:false, timedOut:true}` and an unusable directory returns `{unavailable}`,
 * so the capture proceeds and validity reports the contention.
 * `onWait()` is awaited once, only when the lock is not immediately free.
 */
export async function acquireMeasurementLock({ timeoutMs = 30000, label = "", onWait, signal } = {}) {
  const lockPath = measurementLockPath();
  const startedAt = performance.now();
  const result = (fields) => ({
    acquired: false, waitedMs: performance.now() - startedAt, timedOut: false, holder: null, path: lockPath,
    release: async () => {}, ...fields
  });
  const unsafe = ensureSafeDirectory(path.dirname(lockPath));
  if (unsafe) return result({ waitedMs: 0, unavailable: unsafe });

  const nonce = randomBytes(8).toString("hex");
  const content = JSON.stringify({ pid: process.pid, label: String(label ?? ""), since: Date.now(), nonce });
  let waited = false;
  let holder = null;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error("Capture aborted while waiting for the measurement lock."), { code: "aborted" });
    let fd;
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") return result({ unavailable: `open-failed:${error.code || "error"}` });
    }
    if (fd !== undefined) {
      try { writeSync(fd, content); } finally { closeSync(fd); }
      held.set(lockPath, nonce);
      installExitHook();
      return result({
        acquired: true,
        holder: waited ? holder : null,
        release: async () => releaseLock(lockPath, nonce)
      });
    }

    const current = readLock(lockPath);
    if (current && isStale(current)) {
      // Re-read right before removal so a lock taken over by someone else is kept.
      if (readLock(lockPath)?.raw === current.raw) {
        try { unlinkSync(lockPath); } catch { /* Another waiter removed it first. */ }
      }
      continue;
    }
    if (current?.pid) holder = { pid: current.pid, label: current.label ?? "" };
    if (!waited) {
      waited = true;
      await onWait?.();
    }
    const remaining = timeoutMs - (performance.now() - startedAt);
    if (remaining <= 0) return result({ timedOut: true, holder });
    await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, remaining)));
  }
}

function releaseLock(lockPath, nonce) {
  if (held.get(lockPath) !== nonce) return;
  held.delete(lockPath);
  // Only remove our own lock; a stale-lock takeover may have replaced it.
  if (readLock(lockPath)?.nonce === nonce) {
    try { unlinkSync(lockPath); } catch { /* Already removed. */ }
  }
}

function readLock(lockPath) {
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    return { ...value, raw, mtimeMs };
  } catch {
    // Created but not yet written, or garbage: judge it by age only.
    return { raw, mtimeMs, pid: null, since: null };
  }
}

function isStale(lock) {
  const since = Number.isFinite(lock.since) ? lock.since : lock.mtimeMs;
  if (Date.now() - since > STALE_AFTER_MS) return true;
  if (!lock.pid) return Date.now() - lock.mtimeMs > 5000;
  return !processAlive(lock.pid);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The directory is shared by every process of this user. Refuse to use one that another
// user owns or that group/other can write, since its lock file could then be forged.
function ensureSafeDirectory(directory) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return `mkdir-failed:${error.code || "error"}`;
  }
  if (process.platform === "win32") return null;
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory()) return "unsafe-dir";
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "unsafe-dir";
    if ((info.mode & 0o077) !== 0) return "unsafe-dir";
  } catch {
    return "unsafe-dir";
  }
  return null;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [lockPath, nonce] of held) releaseLock(lockPath, nonce);
  });
}

function userId() {
  if (typeof process.getuid === "function") return process.getuid();
  try { return os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_"); } catch { return "user"; }
}
