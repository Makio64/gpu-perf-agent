import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { FastCDPHarness, TOOL } from "./fast-cdp-runner.js";
import { invalidOption, normalizeOptions, numberOption } from "./options.js";
import { compactReport } from "./output.js";
import { reportValidity } from "./validity.js";

// createRequire, not ESM `import "node:http"`, which loads undici and tls (see http-client.js).
const { createServer } = createRequire(import.meta.url)("node:http");
const ARTIFACT_PATH_KEYS = ["screenshotPath", "rawTracePath", "screenshotJpegPath"];

/**
 * Warm profiler service. Other options are the server's launch and per-run defaults
 * (`launchOptions` takes precedence over flat keys). Local-only: requests with a foreign
 * Origin or Host get 403, POSTs that are not application/json get 415, and artifact paths
 * must stay inside `reportDir`. Closes Chrome and stops listening after `idleTimeoutMs`
 * without requests (0 disables).
 */
export async function startReportServer(options = {}) {
  const {
    port: requestedPort = 9099,
    host = "127.0.0.1",
    idleTimeoutMs: requestedIdleTimeoutMs = 600000,
    stateFile = null,
    reportDir = process.cwd(),
    launchOptions = {},
    maxQueue: requestedMaxQueue = 8,
    ...flatOptions
  } = options;
  const port = numberOption(requestedPort, 'port', { max: 65535, integer: true });
  const maxQueue = numberOption(requestedMaxQueue, 'maxQueue', { min: 1, max: 1000, integer: true });
  const idleTimeoutMs = numberOption(requestedIdleTimeoutMs, 'idleTimeoutMs', { max: 2147483647 });
  const artifactRoot = path.resolve(reportDir);
  const serverOptions = { ...flatOptions, ...launchOptions };
  const defaults = normalizeOptions(serverOptions, { requireTarget: false });
  let harness = await FastCDPHarness.launch(defaults);
  // Launched at startup, so the first job did not wait for it.
  harness.launchConsumed = true;
  let relaunching = null;
  let relaunches = 0;
  let closing = null;
  let pending = 0;
  let completed = 0;
  let failed = 0;
  let idleTimer = null;
  let listeningPort = port;

  function close() {
    if (!closing) {
      closing = (async () => {
        clearTimeout(idleTimer);
        await new Promise(resolve => {
          server.close(resolve);
          server.closeIdleConnections?.();
        });
        await harness.close();
        if (stateFile) await removeStateFile(stateFile);
      })();
    }
    return closing;
  }

  function touch() {
    clearTimeout(idleTimer);
    if (!idleTimeoutMs || closing) return;
    idleTimer = setTimeout(() => {
      if (pending === 0) close().catch(() => {});
      else touch();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // A dead browser (exited, pipe closed) is replaced before the next job.
  async function liveHarness() {
    if (harness.alive !== false || harness.cleanupError) return harness;
    relaunching ??= (async () => {
      await harness.close({ abort: true, timeoutMs: 1000 }).catch(() => {});
      harness = await FastCDPHarness.launch(defaults);
      relaunches += 1;
    })().finally(() => { relaunching = null; });
    await relaunching;
    return harness;
  }

  async function runJob(runOptions) {
    const current = await liveHarness();
    try {
      return await current.run(runOptions);
    } catch (error) {
      // Retry once, on a fresh browser, only when Chrome died before the in-page evaluation
      // began. The runner marks errors with samplingStarted; queued jobs rejected because a
      // relaunch closed the dead harness carry reason "harness-closed".
      const relaunchAbort = error?.code === "aborted" && error.reason === "harness-closed";
      if (error?.samplingStarted !== false || current.alive !== false || current.cleanupError || closing) throw error;
      if (error?.code === "aborted" && !relaunchAbort) throw error;
      return (await liveHarness()).run(runOptions);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const rejection = rejectRequest(request, listeningPort);
      if (rejection) return sendJson(response, rejection.status, { ok: false, error: rejection.error });
      touch();
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        const alive = harness.alive !== false && !harness.cleanupError;
        const ok = !closing && alive;
        return sendJson(response, ok ? 200 : 503, {
          ok, alive: harness.alive !== false, pid: harness.pid ?? null, version: TOOL.version, runner: "fast-cdp",
          pending, completed, failed, maxQueue, relaunches,
          launch: { executablePath: harness.launch?.executablePath ?? null, headful: Boolean(defaults.headful), chromiumArgs: defaults.chromiumArgs ?? [] },
          defaults: serverDefaults(defaults),
          ...(harness.cleanupError ? {error: {code: 'CAPTURE_CLEANUP_FAILED', message: harness.cleanupError.message}} : {})
        });
      }
      if (request.method === "POST" && url.pathname === "/run") {
        if (closing) return sendJson(response, 503, { ok: false, error: { code: 'CLOSING', message: 'Server is closing.' } });
        if (harness.cleanupError) return sendJson(response, 503, { ok: false, error: { code: 'CAPTURE_CLEANUP_FAILED', message: harness.cleanupError.message } });
        if (pending >= maxQueue) {
          response.setHeader('Retry-After', '1');
          return sendJson(response, 429, { ok: false, error: { code: 'QUEUE_FULL', message: 'Profiler queue is full; retry later.' } });
        }
        pending += 1;
        try {
          const body = await readJson(request);
          // A preset in the request overrides sampling defaults inherited from the server.
          const runOptions = normalizeOptions(confineArtifactPaths({ ...serverOptions, ...body }, artifactRoot));
          const report = await runJob(runOptions);
          completed += 1;
          if (!reportValidity(report).valid) failed += 1;
          return sendJson(response, 200, url.searchParams.get('format') === 'compact' ? compactReport(report) : report);
        } catch (error) {
          failed += 1;
          throw error;
        } finally {
          pending -= 1;
          touch();
        }
      }
      if (request.method === "POST" && url.pathname === "/close") {
        sendJson(response, 200, { ok: true });
        setImmediate(() => close().catch(() => {}));
        return;
      }
      sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      const invalid = error.statusCode === undefined && (error instanceof SyntaxError || error instanceof TypeError || ["invalid-options", "file-not-found"].includes(error?.code));
      const status = error.statusCode || (invalid ? 400 : 500);
      sendJson(response, status, { ok: false, error: {
        code: status === 400 ? 'INVALID_OPTIONS' : error?.code || 'RUN_FAILED',
        message: error?.message || String(error),
        ...(error?.hint ? { hint: error.hint } : {})
      } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await harness.close();
    throw error;
  }
  listeningPort = server.address().port;
  touch();
  if (stateFile) {
    await mkdir(path.dirname(path.resolve(stateFile)), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, JSON.stringify({ port: listeningPort, pid: process.pid, startedAt: new Date().toISOString(), key: path.basename(stateFile, ".json") }), { mode: 0o600 });
  }
  return {
    close,
    get harness() { return harness; },
    port: listeningPort,
    server,
    url: `http://127.0.0.1:${listeningPort}`
  };
}

// No token (non-goal); a browser page cannot reach this server: cross-site requests carry
// Origin, DNS rebinding carries a foreign Host, and a JSON content type forces a preflight
// that is never approved.
function rejectRequest(request, port) {
  const local = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origin = request.headers.origin;
  if (origin !== undefined && !(origin.startsWith("http://") && local.has(origin.slice(7)))) {
    return { status: 403, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin requests are not allowed.' } };
  }
  if (!local.has(request.headers.host || "")) {
    return { status: 403, error: { code: 'FORBIDDEN_HOST', message: `Host must be 127.0.0.1:${port} or localhost:${port}.` } };
  }
  if (request.method === "POST" && !/^application\/json\s*(;|$)/i.test(request.headers["content-type"] || "")) {
    return { status: 415, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'POST bodies must be Content-Type: application/json.' } };
  }
  return null;
}

/** Relative artifact paths resolve inside reportDir; anything outside it is rejected. */
export function confineArtifactPaths(options, reportDir) {
  const confined = { ...options };
  const root = path.resolve(reportDir);
  if (confined.screenshotOut != null && confined.screenshotPath == null) confined.screenshotPath = confined.screenshotOut;
  delete confined.screenshotOut;
  for (const key of ARTIFACT_PATH_KEYS) {
    if (confined[key] == null) continue;
    if (typeof confined[key] !== "string" || !confined[key].trim()) throw invalidOption(`${key} must be a non-empty string.`);
    const resolved = path.resolve(root, confined[key]);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw invalidOption(`${key} must be inside the server report directory ${root}.`);
    }
    confined[key] = resolved;
  }
  return confined;
}

function serverDefaults(options) {
  const keys = ["api", "autoInstrument", "contextMode", "deviceScaleFactor", "durationMs", "gpuTiming", "measureLock", "samples", "slowFrameThresholdMs", "viewport", "warmup"];
  return Object.fromEntries(keys.filter(key => options[key] !== undefined).map(key => [key, options[key]]));
}

async function removeStateFile(stateFile) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.pid === process.pid) await unlink(stateFile);
  } catch {
    // Already removed or replaced by another server.
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    request.on('data', chunk => {
      if (exceeded) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body exceeds 64 KiB.'), { statusCode: 413 }));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text.trim() ? JSON.parse(text) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Request body must be a JSON object.');
        resolve(body);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request was aborted.')));
  });
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
