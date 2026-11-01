import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { CDPConnection } from "./cdp.js";
import { requestJson } from "./http-client.js";
import { acquireMeasurementLock, processAlive } from "./measure-lock.js";
import { normalizeOptions, parseViewport, PROFILING_PRESETS } from "./options.js";
import { classifyBottleneck, finalizeReport } from "./analysis.js";
import { autoInstrumentationSource } from "./browser/auto-instrument.js";
import { startCpuProfile, stopCpuProfile, summarizeCpuProfile } from "./cpu-profile.js";
import * as injected from "./injected.js";
import { assertFileTarget, createFileTarget } from "./static-server.js";
import { captureCdpPageEvents, createPageEventCollector, withCaptureDiagnostics } from "./page-events.js";
import { DEFAULT_TRACE_CATEGORIES, MINIMAL_TRACE_CATEGORIES, startChromeTrace, stopChromeTrace, summarizeTrace } from "./trace.js";

const packageInfo = createRequire(import.meta.url)("../package.json");
export const TOOL = Object.freeze({ name: "gpu-perf-agent", version: packageInfo.version });

const PROFILE_PREFIX = "webgpu-report-cdp-";
const STDERR_RING_BYTES = 64 * 1024;
const PROGRESS_BINDING = "__gpuPerfProgress";
const liveHarnesses = new Set();

export async function runFastReport(options = {}, { onProgress, signal } = {}) {
  options = normalizeOptions(options);
  // Fail on a missing file before paying for a Chrome launch.
  if (options.file) await assertFileTarget(options.file, { fileArg: options.fileArg ?? options.file });
  if (signal?.aborted) throw abortedError();
  emitProgress(onProgress, { stage: "launch" });
  const harness = await FastCDPHarness.launch(options);
  let report;
  try {
    report = await harness.run(options, { onProgress, signal });
  } finally {
    const closeStartedAt = performance.now();
    // One-shot: profile removal is handed to a detached reaper (never on abort).
    await harness.close({ abort: Boolean(signal?.aborted), detachTeardown: true });
    // CLI one-shot only: recorded after close, JSON only.
    if (report?.timings) report.timings.teardownMs = round(performance.now() - closeStartedAt);
  }
  return report;
}

export async function runFastReports(reportOptions, launchOptions = {}) {
  if (!Array.isArray(reportOptions)) throw new TypeError("reportOptions must be an array.");
  const jobs = reportOptions.map(options => normalizeOptions({ ...launchOptions, ...options }));
  if (jobs.length === 0) return [];
  const harness = await FastCDPHarness.launch(launchOptions);
  try {
    const reports = [];
    for (const options of jobs) {
      reports.push(await harness.run({
        ...launchOptions,
        ...options
      }));
    }
    return reports;
  } finally {
    await harness.close();
  }
}

/** Close every harness of this process without draining queues (CLI signal handlers). */
export async function closeAllHarnesses({ timeoutMs = 2000 } = {}) {
  const harnesses = Array.from(liveHarnesses);
  if (harnesses.length === 0) return;
  let timer;
  await Promise.race([
    Promise.allSettled(harnesses.map(harness => harness.close({ abort: true, timeoutMs }))),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs + 500); })
  ]);
  clearTimeout(timer);
}

export class FastCDPHarness {
  static async launch(options = {}) {
    options = normalizeOptions(options, { requireTarget: false });
    const startedAt = performance.now();
    const viewport = parseViewport(options.viewport);
    let launch;
    let browserSession;
    if (options.cdpUrl) {
      const webSocketUrl = await resolveCdpWebSocketUrl(options.cdpUrl, options.launchTimeoutMs);
      browserSession = await CDPConnection.connect(webSocketUrl, { timeoutMs: options.launchTimeoutMs });
      launch = { external: true, args: [], webSocketUrl, close: async () => browserSession.close() };
    } else {
      launch = await launchChromeForCDP(options, viewport);
      browserSession = launch.connection;
    }
    const harness = new FastCDPHarness(launch, browserSession, options);
    harness.launchMs = performance.now() - startedAt;
    return harness;
  }

  constructor(launch, browserSession, options = {}) {
    this.browserInfo = null;
    this.browserSession = browserSession;
    this.closed = false;
    this.aborted = false;
    this.launch = launch;
    this.options = options;
    this.queue = Promise.resolve();
    this.closing = null;
    this.shutdown = null;
    this.cleanupError = null;
    this.sharedContextId = null;
    this.activeJob = null;
    this.connectionClosed = false;
    this.launchMs = 0;
    this.launchConsumed = false;
    browserSession?.onClose?.(() => { this.connectionClosed = true; });
    liveHarnesses.add(this);
  }

  /** False after Chrome exits, the pipe/socket closes, a cleanup failure, or close(). */
  get alive() {
    if (this.closed || this.cleanupError || this.connectionClosed || this.browserSession?.closed) return false;
    const child = this.launch?.process;
    return !(child && (child.exitCode != null || child.signalCode != null));
  }

  get pid() {
    return this.launch?.process?.pid ?? null;
  }

  stderrTail(bytes = 2048) {
    return this.launch?.stderrTail?.(bytes) ?? "";
  }

  run(options = {}, { onProgress, signal } = {}) {
    if (this.closed) return Promise.reject(new Error("FastCDPHarness is already closed."));
    // Serialize even Node API callers: Chrome tracing is browser-wide.
    const job = this.queue.then(() => {
      if (this.aborted) throw Object.assign(harnessClosedError("The profiler is shutting down."), { samplingStarted: false });
      if (this.cleanupError) throw this.cleanupError;
      if (signal?.aborted) throw abortedError();
      options = { ...options };
      if (options.cdp || options.webSocketUrl) options.cdpUrl ??= options.cdp ?? options.webSocketUrl;
      const merged = { ...this.options, ...(options.preset ? PROFILING_PRESETS[options.preset] : {}), ...options };
      if (options.url && !options.file) delete merged.file;
      if (options.file && !options.url) delete merged.url;
      // Launch-only flags cannot take effect after Chrome has started.
      for (const key of ["angle", "channel", "executablePath", "headful", "chromiumArgs", "cdpUrl"]) {
        if (options[key] !== undefined && JSON.stringify(options[key]) !== JSON.stringify(this.options[key] ?? (key === "headful" ? false : key === "chromiumArgs" ? [] : undefined))) {
          throw Object.assign(new TypeError(`${key} is a launch option; create a new harness to change it.`), { code: "invalid-options" });
        }
      }
      return this.runJob(normalizeOptions(merged), { onProgress, signal });
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async runJob(options, { onProgress, signal } = {}) {
    const startedAt = performance.now();
    const emit = event => emitProgress(onProgress, event);
    const harnessReused = this.launchConsumed;
    const launchMs = harnessReused ? 0 : this.launchMs;
    this.launchConsumed = true;
    // One controller for the caller's signal and close({abort:true}), so an aborted job
    // also stops waiting for the measurement lock.
    const controller = new AbortController();
    const job = { aborted: false, sampling: false, dispose: null, abort: null };
    // Harness close sets this.aborted instead of job.aborted (see harnessClosedError).
    job.abort = () => {
      controller.abort();
      job.dispose?.();
    };
    const onAbort = () => {
      job.aborted = true;
      job.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.activeJob = job;

    let target = null;
    let page = null;
    let lock = null;
    let tracing = false;
    let trace = null;
    let traceSummary = null;
    let traceError = null;
    let screenshotPath = null;
    let screenshotJpegPath = null;
    let screenshotSize = null;

    try {
      target = await createFastTarget(options);
      const viewport = parseViewport(options.viewport);
      if (options.contextMode === "shared" && !this.sharedContextId) {
        const context = await this.browserSession.send("Target.createBrowserContext", { disposeOnDetach: true });
        this.sharedContextId = context.browserContextId;
      }
      emit({ stage: "navigate", message: target.url });
      page = await createPage(this.browserSession, target.url, viewport, options, this.sharedContextId, { job, emit, startedAt });
      if (controller.signal.aborted) throw abortedError();

      const browserInfo = await this.getBrowserInfo();

      let measurementLock = null;
      let lockWaitMs = 0;
      if (options.measureLock) {
        // Held only around the timed portion, never during navigation.
        let frozenWhileWaiting = false;
        const lockStartedAt = performance.now();
        lock = await acquireMeasurementLock({
          timeoutMs: options.lockTimeoutMs,
          label: options.label ?? target.url,
          signal: controller.signal,
          onWait: async () => {
            emit({ stage: "lock-wait" });
            // Stop the waiting page rendering so it does not load the GPU of the holder.
            const frozen = await safeSend(page.session, "Page.setWebLifecycleState", { state: "frozen" });
            frozenWhileWaiting = !frozen?.error;
            // A frozen page finishes no requests: the network-idle budget stops meanwhile.
            if (frozenWhileWaiting) page.network.pause();
          }
        });
        if (frozenWhileWaiting) {
          await resumeFrozenPage(page.session);
          page.network.resume();
        }
        lockWaitMs = performance.now() - lockStartedAt;
        measurementLock = {
          acquired: lock.acquired,
          waitedMs: round(lock.waitedMs),
          timedOut: lock.timedOut,
          holder: lock.holder,
          path: lock.path,
          frozenWhileWaiting,
          ...(lock.unavailable ? { unavailable: lock.unavailable } : {})
        };
      }

      if (options.trace) {
        await startChromeTrace(this.browserSession, options.traceCategories || (options.minimalTrace ? MINIMAL_TRACE_CATEGORIES : DEFAULT_TRACE_CATEGORIES));
        tracing = true;
      }

      const cdpBefore = await cdpSnapshot(page.session, options);
      const samplingStartedAt = performance.now();
      job.sampling = true;
      page.network.markSamplingStart(samplingStartedAt);
      const inPageOptions = {
        adaptive: Boolean(options.adaptive),
        api: options.api,
        durationMs: Number(options.durationMs ?? 1000),
        gc: Boolean(options.gc),
        deepMemory: Boolean(options.deepMemory),
        hookName: options.hookName,
        samples: Number(options.samples ?? 5),
        samplingMode: options.samplingMode,
        slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
        warmup: Number(options.warmup ?? 1),
        readyTimeoutMs: options.readyTimeoutMs,
        waitNetworkIdle: page.overlapNetworkIdle,
        networkIdleBudgetMs: options.networkIdleBudgetMs,
        progress: true
      };
      const inPage = await evaluateInPage(page.session, inPageOptions, Number(options.timeoutMs ?? 60000));
      const samplingMs = performance.now() - samplingStartedAt;
      const cdpSamples = await page.progress.samples();
      const cdpAfter = await cdpSnapshot(page.session, options);
      // L5: the optional profiled extra sample runs here, while the lock is still held.
      let cpuProfile = null;
      let cpuProfileMs = 0;
      if (options.cpuProfile !== false) {
        const rawBottleneck = classifyBottleneck({
          inPage,
          cdp: { before: cdpBefore, after: cdpAfter, samples: cdpSamples },
          options: reportOptions(options, this.launch.args)
        });
        const requested = options.cpuProfile === true;
        const autoTrigger = options.cpuProfile === "auto"
          && (rawBottleneck.class === "cpu-bound"
            || (rawBottleneck.class === "mixed" && Number.isFinite(rawBottleneck.mainThreadBusy) && rawBottleneck.mainThreadBusy >= 0.6));
        if (requested || autoTrigger) {
          emit({ stage: "cpu-profile" });
          const profileStartedAt = performance.now();
          await startCpuProfile(page.session, { intervalUs: 100 });
          const profiledInPage = await evaluateInPage(page.session, {
            ...inPageOptions,
            samples: 1,
            warmup: 0,
            readyTimeoutMs: 0,
            waitNetworkIdle: false,
            progress: false
          }, Number(options.timeoutMs ?? 60000));
          const stopStartedAt = performance.now();
          const rawProfile = await stopCpuProfile(page.session);
          const extraSample = profiledInPage?.samples?.[0];
          const extraFrames = extraSample?.measurement?.observedFrames?.frameCount
            ?? extraSample?.measurement?.frameCount
            ?? extraSample?.activity?.activeTicks
            ?? extraSample?.activity?.ticks
            ?? profiledInPage?.summary?.observedFrameCount
            ?? 1;
          const extraWindowMs = extraSample?.elapsedMs ?? ((rawProfile.endTime - rawProfile.startTime) / 1000);
          const extraFps = extraSample?.activity?.activeFrameRatio < 0.9 && Number.isFinite(extraSample?.activity?.pageFps)
            ? extraSample.activity.pageFps
            : (extraSample?.measurement?.observedFrames?.fps ?? extraSample?.measurement?.fps ?? rawBottleneck.fps);
          cpuProfile = summarizeCpuProfile(rawProfile, {
            trigger: requested ? "requested" : "auto",
            frames: Math.max(1, extraFrames || 1),
            windowMs: extraWindowMs,
            budgetMs: rawBottleneck.budgetMs ?? 16.67,
            hz: rawBottleneck.hz ?? 60,
            fps: extraFps,
            intervalUs: 100,
            overheadMs: performance.now() - stopStartedAt
          });
          cpuProfile.overheadMs = round(performance.now() - stopStartedAt);
          cpuProfileMs = performance.now() - profileStartedAt;
        }
      }

      if (lock) {
        await lock.release();
        lock = null;
      }

      if (options.trace) {
        try {
          trace = await stopChromeTrace(this.browserSession);
          tracing = false;
          traceSummary = summarizeTrace(trace);
        } catch (error) {
          traceError = plainError(error);
        }
      }

      if (trace && options.rawTracePath) {
        await mkdir(path.dirname(options.rawTracePath), { recursive: true });
        await writeFile(options.rawTracePath, JSON.stringify(trace));
      }

      if (options.screenshotPath || options.screenshot || options.visualValidation) {
        const screenshot = await page.session.send("Page.captureScreenshot", {
          captureBeyondViewport: false,
          format: "png",
          fromSurface: true
        });
        const bytes = Buffer.from(screenshot.data, "base64");
        screenshotSize = bytes.byteLength;
        if (options.screenshotPath) {
          screenshotPath = path.resolve(options.screenshotPath);
          await mkdir(path.dirname(screenshotPath), { recursive: true });
          await writeFile(screenshotPath, bytes);
        }
      }
      if (options.screenshotJpegPath) {
        // MCP inline screenshots: JPEG q70, at most 640 px wide.
        const scale = Math.min(1, 640 / (viewport.width * Number(options.deviceScaleFactor ?? 1)));
        const screenshot = await page.session.send("Page.captureScreenshot", {
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
          format: "jpeg",
          fromSurface: true,
          quality: 70
        });
        screenshotJpegPath = path.resolve(options.screenshotJpegPath);
        await mkdir(path.dirname(screenshotJpegPath), { recursive: true });
        await writeFile(screenshotJpegPath, Buffer.from(screenshot.data, "base64"));
      }

      emit({ stage: "analyze" });
      const idle = page.network.idleResult();
      const extended = Number(inPage?.warmup?.extendedForNetworkMs);
      // Overlapped: only the warmup extension the page spent waiting for the idle flag counts.
      const networkIdleWaitMs = page.overlapNetworkIdle
        ? (Number.isFinite(extended) ? extended : 0)
        : page.timings.networkIdleWaitMs;
      const timings = {
        launchMs: round(launchMs),
        harnessReused,
        pageSetupMs: round(page.timings.pageSetupMs),
        navigationMs: round(page.timings.navigationMs),
        networkIdleWaitMs: round(networkIdleWaitMs),
        networkIdle: idle,
        lockWaitMs: round(lockWaitMs),
        readyWaitMs: round(Number(inPage?.ready?.waitedMs ?? 0)),
        warmupMs: inPage?.warmup?.durationMs == null ? null : round(inPage.warmup.durationMs),
        samplingMs: round(samplingMs),
        cpuProfileMs: round(cpuProfileMs),
        totalMs: round(performance.now() - startedAt)
      };
      timings.anomalies = timingAnomalies(timings, page.network.slowestTls());

      return finalizeReport({
        tool: TOOL,
        screenshotSize,
        artifacts: {
          screenshotPath,
          ...(screenshotJpegPath ? { screenshotJpegPath } : {})
        },
        timings,
        measurementLock,
        ...(cpuProfile ? { cpuProfile } : {}),
        browser: browserInfo,
        cdp: {
          after: cdpAfter,
          before: cdpBefore,
          samples: cdpSamples
        },
        createdAt: new Date().toISOString(),
        host: hostInfo(),
        inPage,
        options: reportOptions(options, this.launch.args),
        ...page.events.snapshot(),
        schemaVersion: 3,
        target: {
          file: target.file || null,
          root: target.root || null,
          source: options.file ? "file-server" : "url",
          url: target.url,
          ...page.network.documentInfo()
        },
        trace: {
          captured: Boolean(trace),
          error: traceError,
          rawTracePath: options.rawTracePath || null,
          summary: traceSummary
        }
      }, options);
    } catch (error) {
      if (error?.code === "capture-cleanup-failed") this.cleanupError = error;
      const failure = job.aborted ? abortedError(undefined, error)
        : this.aborted ? harnessClosedError(undefined, error) : error;
      // Lets a server retry only jobs that failed before the in-page evaluation began.
      if (failure && typeof failure === "object") failure.samplingStarted = job.sampling;
      throw withCaptureDiagnostics(failure, page?.events);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.activeJob === job) this.activeJob = null;
      try {
        await lock?.release();
        if (tracing) await stopChromeTrace(this.browserSession, { timeoutMs: 5000 }).catch(() => {});
        if (page) await page.close();
      } catch (error) {
        if (!this.aborted && !job.aborted && !this.connectionClosed) {
          this.cleanupError = withCaptureDiagnostics(captureCleanupError(error), page?.events);
          throw this.cleanupError;
        }
      } finally {
        await target?.close?.();
      }
    }
  }

  /** Quick capability check for doctor: one about:blank page in a throwaway context. */
  probe() {
    if (this.closed) return Promise.reject(new Error("FastCDPHarness is already closed."));
    const job = this.queue.then(() => probeBrowser(this.browserSession, this.launch));
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * abort=false drains queued jobs first. abort=true rejects the running job (its context
   * is disposed or the connection closes) and every queued job, then closes Chrome.
   */
  close({ abort = false, timeoutMs = 1500, detachTeardown = false } = {}) {
    if (abort) this.aborted = true;
    this.closed = true;
    const shutdown = () => {
      this.shutdown ??= this.closeBrowser(timeoutMs, detachTeardown && !abort).finally(() => liveHarnesses.delete(this));
      return this.shutdown;
    };
    if (abort) {
      // Disposes the job's context and stops a measurement-lock wait.
      this.activeJob?.abort?.();
      this.closing = shutdown();
    } else {
      this.closing ??= this.queue.then(shutdown);
    }
    return this.closing;
  }

  async closeBrowser(timeoutMs, detach = false) {
    try {
      if (this.launch.external) {
        if (this.sharedContextId) await safeSend(this.browserSession, "Target.disposeBrowserContext", { browserContextId: this.sharedContextId }, timeoutMs);
        this.browserSession.close();
      } else if (this.launch.close) {
        await this.launch.close({ timeoutMs, detach });
      } else {
        // Unit-test harnesses built from plain objects.
        await safeSend(this.browserSession, "Browser.close");
        this.browserSession.close?.();
      }
    } finally {
      this.browserSession.close?.();
    }
  }

  async getBrowserInfo() {
    if (!this.browserInfo) {
      this.browserInfo = {
        executablePath: this.launch.executablePath,
        pid: this.launch.process?.pid ?? null,
        systemInfo: await safeSend(this.browserSession, "SystemInfo.getInfo"),
        version: await safeSend(this.browserSession, "Browser.getVersion")
      };
    }
    return this.browserInfo;
  }
}

async function createFastTarget(options = {}) {
  if (options.url) {
    return {
      close: null,
      url: options.url
    };
  }
  if (options.file) {
    return createFileTarget(options.file, {
      fileRoot: options.fileRoot
    });
  }
  throw Object.assign(new Error("A target is required. Pass --url or --file."), { code: "invalid-options" });
}

async function resolveCdpWebSocketUrl(target, timeoutMs) {
  if (/^wss?:\/\//.test(target)) return new URL(target).href;
  const endpoint = /^\d+$/.test(target) ? `http://127.0.0.1:${target}` : /^[a-z]+:\/\//i.test(target) ? target : `http://${target}`;
  const url = new URL("/json/version", endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new TypeError("CDP discovery must use HTTP(S), or provide a browser WebSocket URL."), { code: "invalid-options" });
  const { status, json } = await requestJson(url, { timeoutMs });
  if (status < 200 || status >= 300) throw Object.assign(new Error(`CDP discovery returned HTTP ${status}.`), { code: "server-unreachable" });
  if (typeof json?.webSocketDebuggerUrl !== "string" || !/^wss?:\/\//.test(json.webSocketDebuggerUrl)) {
    throw Object.assign(new Error("CDP discovery did not return a browser WebSocket URL."), { code: "server-unreachable" });
  }
  return json.webSocketDebuggerUrl;
}

async function launchChromeForCDP(options, viewport) {
  const executablePath = await resolveChromeExecutable(options);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
  const args = [
    ...chromiumArgs(options),
    `--user-data-dir=${userDataDir}`,
    // CDP over fds 3/4: no debugging port, no stderr URL parsing, no WebSocket (and so no
    // undici/tls in Node). Chrome also exits by itself when its parent dies.
    "--remote-debugging-pipe",
    `--window-size=${viewport.width},${viewport.height}`,
    "about:blank"
  ];

  if (!options.headful) {
    args.unshift("--headless=new");
  }

  // Never detached: a terminal Ctrl-C must also reach Chrome.
  const child = spawn(executablePath, args, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  const stderr = createRingBuffer(STDERR_RING_BYTES);
  // Drain continuously: Chrome must never block on a full stderr pipe.
  child.stderr.on("data", chunk => stderr.push(chunk));
  child.stderr.on("error", () => {});
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("error", () => {});
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => resolve({ error }));
  });
  const connection = CDPConnection.fromPipe(child.stdio[3], child.stdio[4]);
  // Chrome does not exit when its owner dies mid-capture (pipe EOF is ignored while a page
  // is busy), so a detached watchdog ends it, then removes the profile.
  const watchdog = child.pid ? spawnWatchdog(child.pid, userDataDir) : null;

  let closing = null;
  const close = ({ timeoutMs = 2500, detach = false } = {}) => {
    closing ??= (async () => {
      const running = () => child.pid && child.exitCode == null && child.signalCode == null;
      // Browser.close over the pipe, end the pipe, then SIGTERM; SIGKILL on timeout.
      if (running() && !connection.closed) {
        await connection.send("Browser.close", undefined, Math.max(100, Math.min(1000, timeoutMs / 2))).catch(() => {});
      }
      connection.close();
      if (detach && running() && watchdog?.alive()) {
        // One-shot captures: the watchdog waits for Chrome to exit, then removes the profile,
        // so the CLI exits right away (a 10-run median of ~63 ms saved per run).
        child.kill("SIGTERM");
        for (const stream of [child.stderr, child.stdio[3], child.stdio[4]]) stream?.destroy();
        child.unref();
        watchdog.release();
        return;
      }
      if (running()) {
        child.kill("SIGTERM");
        try { await waitForExit(child, timeoutMs); }
        catch {
          child.kill("SIGKILL");
          await waitForExit(child, 2500).catch(() => {});
        }
      }
      for (const stream of [child.stderr, child.stdio[3], child.stdio[4]]) stream?.destroy();
      child.unref();
      await rm(userDataDir, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
      watchdog?.release();
    })();
    return closing;
  };

  try {
    await writeFile(path.join(userDataDir, "owner.json"), JSON.stringify({ ownerPid: process.pid, chromePid: child.pid ?? null, createdAt: new Date().toISOString() }));
    const timeoutMs = Number(options.launchTimeoutMs ?? 15000);
    let timer;
    await Promise.race([
      connection.send("Browser.getVersion", undefined, timeoutMs),
      exited.then(({ code, signal, error }) => {
        throw error ?? new Error(`Chrome exited before DevTools was ready: code=${code} signal=${signal}`);
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms waiting for Chrome DevTools.`)), timeoutMs); })
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    await close({ timeoutMs: 1000 }).catch(() => {});
    const tail = stderr.tail(2048).trim();
    throw Object.assign(new Error(`Chrome failed to start (${executablePath}): ${error.message}${tail ? `\n${tail}` : ""}`, { cause: error }), {
      code: "chrome-launch-failed",
      hint: "Check the browser with `gpu-perf-agent doctor`, or pass --executable-path."
    });
  }

  // Remove profiles leaked by killed runs; never delays the capture.
  const sweep = sweepStaleProfiles({ keep: userDataDir }).catch(() => 0);

  return {
    args,
    close,
    connection,
    executablePath,
    process: child,
    stderrTail: bytes => stderr.tail(bytes),
    sweep,
    userDataDir
  };
}

// Runs as a detached `node -e`. Its stdin is a pipe whose other end only the owner holds,
// so it closes when the owner exits, is killed (even SIGKILL), or releases it. Then: SIGTERM
// Chrome if it still runs (SIGKILL after 2 s), wait for it to exit, and remove the profile.
const WATCHDOG_SOURCE = `const pid = Number(process.argv[1]);
const dir = process.argv[2];
const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const finish = () => {
  try { require("node:fs").rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  process.exit(0);
};
const ownerGone = () => {
  if (!alive()) return finish();
  const started = Date.now();
  try { process.kill(pid, "SIGTERM"); } catch {}
  const poll = setInterval(() => {
    if (!alive() || Date.now() - started > 15000) { clearInterval(poll); finish(); }
    else if (Date.now() - started > 2000) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }, 25);
};
process.stdin.on("data", () => {});
process.stdin.on("end", ownerGone);
process.stdin.on("error", ownerGone);
process.stdin.resume();`;

function spawnWatchdog(pid, userDataDir) {
  let watchdog;
  try {
    watchdog = spawn(process.execPath, ["-e", WATCHDOG_SOURCE, String(pid), userDataDir], {
      detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true
    });
  } catch {
    return null;
  }
  watchdog.on("error", () => {});
  watchdog.stdin.on("error", () => {});
  // Neither the process nor its pipe may keep the owner alive.
  watchdog.unref();
  watchdog.stdin.unref?.();
  return {
    alive: () => Boolean(watchdog.pid) && watchdog.exitCode === null && watchdog.signalCode === null,
    release: () => watchdog.stdin.destroyed || watchdog.stdin.end()
  };
}

/**
 * Remove os.tmpdir()/webgpu-report-cdp-* dirs older than 10 min whose owner.json pids are
 * both dead, or (not on win32) that have no owner.json and appear in no process's argv.
 * Never kills processes, so other agents' browsers are never touched.
 */
export async function sweepStaleProfiles({ root = os.tmpdir(), keep = null, maxAgeMs = 10 * 60 * 1000 } = {}) {
  let names;
  try { names = await readdir(root); } catch { return 0; }
  let argv;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const directory = path.join(root, name);
    if (directory === keep) continue;
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory() || Date.now() - info.mtimeMs < maxAgeMs) continue;
    const owner = await readFile(path.join(directory, "owner.json"), "utf8").then(JSON.parse).catch(() => null);
    if (owner) {
      if (processAlive(owner.ownerPid) || processAlive(owner.chromePid)) continue;
    } else {
      if (process.platform === "win32") continue;
      argv ??= await processArgv();
      if (argv === null || argv.includes(directory)) continue;
    }
    await rm(directory, { force: true, recursive: true, maxRetries: 2, retryDelay: 50 }).then(() => { removed += 1; }, () => {});
  }
  return removed;
}

function processArgv() {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "args="], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function createRingBuffer(limit) {
  const chunks = [];
  let size = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length > 1) size -= chunks.shift().length;
      if (size > limit) {
        chunks[0] = chunks[0].subarray(chunks[0].length - limit);
        size = chunks[0].length;
      }
    },
    tail(bytes = 2048) {
      const all = Buffer.concat(chunks, size);
      return all.subarray(Math.max(0, all.length - bytes)).toString("utf8");
    }
  };
}

async function createPage(browserSession, url, viewport, options, sharedContextId, { job = {}, emit = () => {}, startedAt = performance.now() } = {}) {
  const events = createPageEventCollector();
  const timings = { pageSetupMs: 0, navigationMs: 0, networkIdleWaitMs: 0 };
  const setupStartedAt = performance.now();
  const deadline = startedAt + Number(options.timeoutMs ?? 60000);
  let target;
  let browserContextId;
  let session;
  let network = null;
  let progress = null;
  const isolated = options.contextMode !== "shared";
  const close = async () => {
    network?.dispose();
    progress?.dispose();
    session?.dispose();
    if (browserContextId && isolated) {
      // Also closes popups and terminates workers owned by this job.
      const id = browserContextId;
      browserContextId = null;
      await browserSession.send("Target.disposeBrowserContext", { browserContextId: id }, 5000);
    } else if (browserContextId) {
      // Shared mode retains storage and service workers, but never leaves popup pages running.
      const pagesOf = async () => (await browserSession.send("Target.getTargets")).targetInfos
        .filter(info => info.browserContextId === browserContextId && info.type === "page");
      await Promise.all((await pagesOf()).map(info => browserSession.send("Target.closeTarget", { targetId: info.targetId }, 5000)));
      // closeTarget answers before the page is gone; wait (bounded) so the next job starts clean.
      for (let tries = 0; tries < 50 && (await pagesOf()).length > 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    } else if (target) {
      await safeSend(browserSession, "Target.closeTarget", { targetId: target.targetId });
    }
    target = null;
  };
  // Aborting a job disposes its context, which makes the in-page evaluation reject.
  // Clearing the ids first makes the later close() skip what is already being disposed.
  job.dispose = () => {
    // Settles a pending idle wait and stops its timers.
    network?.dispose();
    if (browserContextId && isolated) {
      const id = browserContextId;
      browserContextId = null;
      safeSend(browserSession, "Target.disposeBrowserContext", { browserContextId: id }, 2000);
    } else if (target) {
      const { targetId } = target;
      target = null;
      safeSend(browserSession, "Target.closeTarget", { targetId }, 2000);
    }
  };
  try {
    if (isolated) {
      ({ browserContextId } = await browserSession.send("Target.createBrowserContext", { disposeOnDetach: true }));
    } else browserContextId = sharedContextId;
    target = await browserSession.send("Target.createTarget", {
      browserContextId,
      // Omit newWindow so Chrome can create the first window in a fresh context.
      url: "about:blank"
    });
    const attached = await browserSession.send("Target.attachToTarget", {
      flatten: true,
      targetId: target.targetId
    });
    session = browserSession.session(attached.sessionId);

    captureCdpPageEvents(session, events);
    network = createNetworkTracker(session, browserSession, {
      mainFrameId: target.targetId,
      quietMs: options.file ? 100 : 250
    });
    progress = createProgressRelay(session, emit, { onFirstSampleStart: at => network.markWarmupEnd(at) });
    await Promise.all([
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("Log.enable"),
      session.send("Network.enable"),
      session.send("Performance.enable"),
      session.send("HeapProfiler.enable"),
      session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      // Before navigation, so progress from the first evaluation is never lost.
      session.send("Runtime.addBinding", { name: PROGRESS_BINDING }),
      // Dedicated workers: their Network events finish requests the page started. Children
      // wait for the debugger so Network is enabled before their first request.
      safeSend(session, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
      session.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: Number(options.deviceScaleFactor ?? 1),
        height: viewport.height,
        mobile: false,
        width: viewport.width
      })
    ]);

    if (options.autoInstrument) {
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: autoInstrumentationSource({ gpuTiming: options.gpuTiming !== false, callSites: true })
      });
    }
    timings.pageSetupMs = performance.now() - setupStartedAt;

    const waitUntil = options.waitUntil || "networkidle";
    timings.navigationMs = await navigatePage(session, url, { deadline, waitUntil, network });

    // Overlap the idle wait with the in-page warmup unless readiness must come first.
    const overlap = waitUntil === "networkidle" && !options.waitCondition && !options.waitForHook;
    if (waitUntil === "networkidle") {
      const idle = network.waitForIdle({ budgetMs: Number(options.networkIdleBudgetMs ?? 10000), deadline });
      if (overlap) {
        idle.then(result => result.status !== "disposed" && safeSend(session, "Runtime.evaluate", {
          expression: `globalThis.__gpuPerfNetworkIdle = ${result.status === "idle" ? "true" : '"budget-exceeded"'}`
        }));
      } else {
        const result = await idle;
        if (job.aborted || result.status === "disposed") throw abortedError();
        if (result.status === "deadline") throw network.timeoutError("network-idle-timeout", "network idle", Number(options.timeoutMs ?? 60000));
        timings.networkIdleWaitMs = result.waitedMs;
      }
    }

    if (options.waitCondition) {
      const ready = await session.send("Runtime.evaluate", {
        expression: `(async () => {
          const deadline = performance.now() + ${options.waitConditionTimeoutMs};
          while (!(${options.waitCondition})) {
            if (performance.now() >= deadline) return "timeout";
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return "ready";
        })()`, awaitPromise: true, returnByValue: true
      }, options.waitConditionTimeoutMs + 1000);
      if (ready.exceptionDetails) throw new Error(formatExceptionDetails(ready.exceptionDetails));
      if (ready.result?.value === "timeout") {
        throw Object.assign(new Error(`Timed out after ${options.waitConditionTimeoutMs} ms waiting for page condition: ${options.waitCondition}`), {
          code: "condition-timeout",
          hint: "Check the --wait-condition expression or raise --wait-condition-timeout."
        });
      }
    }

    if (options.waitForHook) {
      const hookName = options.hookName || "__gpuReportBench";
      const ready = await session.send("Runtime.evaluate", {
        expression: `(async () => {
          const deadline = performance.now() + ${options.timeoutMs};
          while (typeof globalThis[${JSON.stringify(hookName)}] !== "function") {
            if (performance.now() >= deadline) return "timeout";
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return "ready";
        })()`,
        awaitPromise: true,
        returnByValue: true
      }, options.timeoutMs + 1000);
      if (ready.exceptionDetails) throw new Error(formatExceptionDetails(ready.exceptionDetails));
      if (ready.result?.value === "timeout") {
        throw Object.assign(new Error(`Timed out waiting for benchmark hook ${hookName}.`), {
          code: "hook-timeout",
          hint: `Define globalThis.${hookName}, pass --hook NAME, or drop --wait-for-hook.`
        });
      }
    }

    return {
      close,
      events,
      network,
      overlapNetworkIdle: overlap,
      progress,
      session,
      targetId: target.targetId,
      timings
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw withCaptureDiagnostics(captureCleanupError(new AggregateError([error, cleanupError])), events); }
    throw withCaptureDiagnostics(error, events);
  }
}

function captureCleanupError(cause) {
  return Object.assign(new Error("Capture cleanup failed; close this harness and launch a new one before profiling again.", { cause }), { code: "capture-cleanup-failed" });
}

async function navigatePage(session, url, { deadline, waitUntil = "load", network }) {
  const navigationStartedAt = performance.now();
  const timeoutMs = Math.max(1, deadline - navigationStartedAt);
  const event = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
  const load = waitUntil === "commit" ? null : waitForEvent(session, event, timeoutMs);
  try {
    // Page.navigate answers once the response commits, so a stalled document times out here.
    const navigation = await session.send("Page.navigate", { url }, timeoutMs).catch((error) => {
      throw /timed out/i.test(error.message) ? network.timeoutError("navigation-timeout", "the document response", Math.round(timeoutMs)) : error;
    });
    if (navigation.errorText) {
      throw Object.assign(new Error(`Navigation failed: ${navigation.errorText} (${url})`), {
        code: "navigation-failed",
        hint: "Check that the URL is reachable from this machine and the dev server is running."
      });
    }
    if (navigation.frameId) network.setMainFrame(navigation.frameId);
    if (load) {
      try { await load.promise; }
      catch {
        throw network.timeoutError("navigation-timeout", waitUntil === "domcontentloaded" ? "DOMContentLoaded" : "the load event", Math.round(timeoutMs));
      }
    }
    return performance.now() - navigationStartedAt;
  } finally {
    load?.cancel();
  }
}

/**
 * Tracks requests for network idle, plus the main document status and slow TLS.
 * Never counts EventSource or blob:/data: requests. Dedicated-worker sessions are
 * auto-attached, so requests they finish leave the pending set.
 */
export function createNetworkTracker(session, connection, { mainFrameId = null, quietMs = 250 } = {}) {
  const pending = new Map();
  const offs = [];
  const workerSessions = new Set();
  let frameId = mainFrameId;
  let documentInfo = { httpStatus: null, documentUrl: null };
  let slowestTls = null;
  let onChange = null;
  let evaluationStart = null;
  let warmupEnd = null;
  let wait = null;
  let result = null;

  const subscribe = (target) => {
    offs.push(target.on("Network.requestWillBeSent", (event) => {
      const requestUrl = event.request?.url || "";
      if (event.type === "EventSource" || requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) return;
      const existing = pending.get(event.requestId);
      pending.set(event.requestId, { url: requestUrl, type: event.type || null, startedAt: existing?.startedAt ?? performance.now() });
      onChange?.();
    }));
    const finish = (event) => {
      if (pending.delete(event.requestId)) onChange?.();
    };
    offs.push(target.on("Network.loadingFinished", finish));
    offs.push(target.on("Network.loadingFailed", finish));
    offs.push(target.on("Network.responseReceived", (event) => {
      const response = event.response || {};
      if (event.type === "Document" && (event.frameId === frameId || !frameId)) {
        documentInfo = { httpStatus: Number.isInteger(response.status) ? response.status : null, documentUrl: response.url || null };
      }
      const timing = response.timing;
      if (timing && timing.sslStart >= 0 && timing.sslEnd >= timing.sslStart) {
        const ms = timing.sslEnd - timing.sslStart;
        if (!slowestTls || ms > slowestTls.ms) {
          let host = null;
          try { host = new URL(response.url).host; } catch { /* Keep null. */ }
          slowestTls = { ms, host, url: response.url || null };
        }
      }
    }));
  };
  subscribe(session);
  // Auto-attached children start paused: enable Network first, then resume, so the worker's
  // own script response (reported only on its session) finishes the page's pending request.
  offs.push(session.on("Target.attachedToTarget", (event) => {
    const child = event.sessionId ? connection.session?.(event.sessionId) : null;
    if (!child) return;
    const resume = () => child.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    if (!["worker", "iframe"].includes(event.targetInfo?.type)) return void resume();
    workerSessions.add(child);
    subscribe(child);
    child.send("Network.enable").catch(() => {}).finally(resume);
  }));

  const pendingList = (limit = 3) => {
    const now = performance.now();
    return Array.from(pending.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, limit)
      .map(request => ({ url: request.url, type: request.type, ageMs: Math.round(now - request.startedAt) }));
  };
  // Idle-wait time excludes time the page spent frozen (lock wait).
  const activeWaitMs = (at) => at - wait.startedAt - wait.pausedMs - (wait.pausedAt === null ? 0 : at - wait.pausedAt);
  const snapshot = (at) => ({ at, count: pending.size, pending: pendingList(), waitedMs: wait ? round(activeWaitMs(at)) : 0 });
  const armLimit = () => {
    clearTimeout(wait.limitTimer);
    const limitAt = Math.min(wait.budgetEndsAt, wait.deadline);
    wait.limitTimer = setTimeout(() => settle(wait.budgetEndsAt <= wait.deadline ? "budget-exceeded" : "deadline"), Math.max(0, limitAt - performance.now()));
    wait.limitTimer.unref?.();
  };
  const settle = (status) => {
    if (!wait || result) return;
    clearTimeout(wait.quietTimer);
    clearTimeout(wait.limitTimer);
    onChange = null;
    const now = performance.now();
    result = {
      status,
      waitedMs: round(activeWaitMs(now)),
      budgetMs: wait.budgetMs,
      pending: status === "idle" ? [] : pendingList(),
      settledAt: now
    };
    wait.resolve(result);
  };

  return {
    setMainFrame(id) {
      frameId = id;
    },
    documentInfo() {
      return { ...documentInfo };
    },
    slowestTls() {
      return slowestTls;
    },
    pendingList,
    /** Start of the in-page evaluation (ready + warmup + samples). */
    markSamplingStart(at = performance.now()) {
      evaluationStart = snapshot(at);
    },
    /** Node time of the page's first sample-start: the end of warmup. */
    markWarmupEnd(at = performance.now()) {
      warmupEnd ??= snapshot(at);
    },
    /**
     * Resolves {status:"idle", waitedMs} after `quietMs` without pending requests,
     * {status:"budget-exceeded", pending} when the budget expires first (the caller
     * continues), {status:"deadline"} when the hard timeout comes first, or
     * {status:"disposed"} when the page closes first. Timers never keep Node alive.
     */
    waitForIdle({ budgetMs = 10000, deadline = Infinity } = {}) {
      const startedAt = performance.now();
      return new Promise((resolve) => {
        wait = { budgetMs, startedAt, budgetEndsAt: startedAt + budgetMs, deadline, pausedAt: null, pausedMs: 0, quietTimer: null, limitTimer: null, resolve };
        onChange = () => {
          clearTimeout(wait.quietTimer);
          wait.quietTimer = null;
          if (pending.size !== 0) return;
          wait.quietTimer = setTimeout(() => settle("idle"), quietMs);
          wait.quietTimer.unref?.();
        };
        armLimit();
        onChange();
      });
    },
    /**
     * A frozen page completes no requests, so the budget (and the hard-timeout check)
     * stops while it is frozen for the measurement lock and resumes afterwards.
     */
    pause(at = performance.now()) {
      if (!wait || result || wait.pausedAt !== null) return;
      wait.pausedAt = at;
      clearTimeout(wait.limitTimer);
    },
    resume(at = performance.now()) {
      if (!wait || result || wait.pausedAt === null) return;
      const frozenMs = Math.max(0, at - wait.pausedAt);
      wait.pausedAt = null;
      wait.pausedMs += frozenMs;
      wait.budgetEndsAt += frozenMs;
      wait.deadline += frozenMs;
      armLimit();
    },
    /**
     * timings.networkIdle, classified against the in-page phases: "idle" when reached
     * before evaluation began, "overlapped" when reached before warmup ended (the first
     * sample-start; the evaluation start when the page sends no progress), otherwise
     * "budget-exceeded" with the requests pending when warmup ended. waitedMs excludes
     * the time the page was frozen for the measurement lock, reported as pausedMs.
     */
    idleResult() {
      if (!wait) return { status: "not-requested", waitedMs: 0, budgetMs: null, pending: [] };
      const pausedMs = round(wait.pausedMs);
      const extra = pausedMs > 0 ? { pausedMs } : {};
      const boundary = warmupEnd ?? evaluationStart;
      const settledIdle = result?.status === "idle";
      if (settledIdle && (!evaluationStart || result.settledAt <= evaluationStart.at)) {
        return { status: "idle", waitedMs: result.waitedMs, budgetMs: wait.budgetMs, pending: [], ...extra };
      }
      if (settledIdle && (!boundary || result.settledAt <= boundary.at)) {
        return { status: "overlapped", waitedMs: result.waitedMs, budgetMs: wait.budgetMs, pending: [], ...extra };
      }
      if (result && result.status !== "idle" && result.status !== "disposed" && (!boundary || result.settledAt <= boundary.at)) {
        // The budget (or the hard timeout) ran out before sampling.
        return { status: "budget-exceeded", waitedMs: result.waitedMs, budgetMs: wait.budgetMs, pending: result.pending, ...extra };
      }
      if (!boundary) return { status: "budget-exceeded", waitedMs: round(activeWaitMs(performance.now())), budgetMs: wait.budgetMs, pending: pendingList(), ...extra };
      // Sampling began before idle: report what was pending then, not what is pending now.
      // Nothing pending at that moment (only the quiet window left) counts as overlapped.
      if (boundary.count === 0) return { status: "overlapped", waitedMs: boundary.waitedMs, budgetMs: wait.budgetMs, pending: [], ...extra };
      return { status: "budget-exceeded", waitedMs: boundary.waitedMs, budgetMs: wait.budgetMs, pending: boundary.pending, ...extra };
    },
    timeoutError(code, what, timeoutMs) {
      const list = pendingList();
      const urls = list.map(request => request.url).join(", ");
      return Object.assign(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}; ${pending.size} request(s) pending${urls ? `: ${urls}` : ""}.`), {
        code,
        hint: "Pass --wait-until load (or domcontentloaded) when the page keeps requests open, or raise --timeout.",
        pending: list
      });
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      settle("disposed");
      onChange = null;
      workerSessions.clear();
    }
  };
}

/**
 * Relays `__gpuPerfProgress` binding calls to onProgress and takes Performance.getMetrics
 * at each sample-start/sample-end (cdp.samples). The binding round trip lags the page by
 * a few ms; that is accepted.
 */
function createProgressRelay(session, emit, { onFirstSampleStart } = {}) {
  const marks = new Map();
  const tasks = [];
  let sampleStarted = false;
  const record = (index, edge) => {
    tasks.push(session.send("Performance.getMetrics", undefined, 5000).then(({ metrics = [] }) => {
      const values = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
      const entry = marks.get(index) ?? {};
      entry[edge] = values;
      marks.set(index, entry);
    }, () => {}));
  };
  const off = session.on("Runtime.bindingCalled", (event) => {
    if (event.name !== PROGRESS_BINDING) return;
    let payload;
    try { payload = JSON.parse(event.payload); } catch { return; }
    const { stage, index, total } = payload || {};
    if (stage === "sample-start") {
      if (!sampleStarted) {
        sampleStarted = true;
        onFirstSampleStart?.(performance.now());
      }
      record(index, "start");
      emit({ stage: "sample", index, total });
    } else if (stage === "sample-end") record(index, "end");
    else if (stage === "ready") emit({ stage: "ready" });
    else if (stage === "warmup") emit({ stage: "warmup", index, total });
  });
  return {
    async samples() {
      await Promise.allSettled(tasks);
      const samples = [];
      for (const [index, { start, end }] of [...marks].sort((a, b) => a[0] - b[0])) {
        if (!start || !end) continue;
        samples.push({
          index,
          startTs: start.Timestamp,
          endTs: end.Timestamp,
          // Seconds spent during this sample (end minus start).
          threadTimeS: end.ThreadTime - start.ThreadTime,
          taskDurationS: end.TaskDuration - start.TaskDuration
        });
      }
      return samples;
    },
    dispose() {
      off();
    }
  };
}

async function probeBrowser(browserSession, launch) {
  const version = await browserSession.send("Browser.getVersion", undefined, 5000);
  const { browserContextId } = await browserSession.send("Target.createBrowserContext", { disposeOnDetach: true }, 5000);
  let session;
  try {
    const target = await browserSession.send("Target.createTarget", { browserContextId, url: "about:blank" }, 5000);
    const attached = await browserSession.send("Target.attachToTarget", { flatten: true, targetId: target.targetId }, 5000);
    session = browserSession.session(attached.sessionId);
    const result = await session.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const webgpu = { available: false, adapter: null, timestampQuery: false };
        try {
          const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
          if (adapter) {
            const info = adapter.info || {};
            webgpu.available = true;
            webgpu.adapter = { vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "", description: info.description || "" };
            webgpu.timestampQuery = adapter.features.has("timestamp-query");
          }
        } catch (error) { webgpu.error = String(error && error.message || error); }
        const webgl2 = { available: false, renderer: null };
        try {
          const gl = document.createElement("canvas").getContext("webgl2");
          if (gl) {
            const debug = gl.getExtension("WEBGL_debug_renderer_info");
            webgl2.available = true;
            webgl2.renderer = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
            gl.getExtension("WEBGL_lose_context")?.loseContext();
          }
        } catch (error) { webgl2.error = String(error && error.message || error); }
        return { webgpu, webgl2 };
      })()`
    }, 10000);
    if (result.exceptionDetails) throw new Error(formatExceptionDetails(result.exceptionDetails));
    return {
      chrome: { version: version.product ?? null, path: launch?.executablePath ?? null, userAgent: version.userAgent ?? null },
      ...result.result.value
    };
  } finally {
    session?.dispose();
    await safeSend(browserSession, "Target.disposeBrowserContext", { browserContextId }, 5000);
  }
}

// Freezing hides the page, and "active" alone leaves it hidden with rAF stopped (headless
// Chrome). Focus emulation restores the state of a fresh page: visible and focused.
async function resumeFrozenPage(session) {
  await safeSend(session, "Page.setWebLifecycleState", { state: "active" });
  await safeSend(session, "Emulation.setFocusEmulationEnabled", { enabled: true });
  const state = await safeSend(session, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, 5000);
  if (state?.result?.value === "hidden") {
    throw new Error("The page did not resume after waiting for the measurement lock (still hidden); recapture, or pass --no-lock.");
  }
}

async function evaluateInPage(session, options, timeoutMs) {
  const expression = typeof injected.collectInPageExpression === "function"
    ? injected.collectInPageExpression(options)
    : `(${injected.collectInPage.toString()})(${JSON.stringify(options)})\n//# sourceURL=gpu-perf-agent/collect.js`;
  const result = await session.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    timeout: timeoutMs
  }, timeoutMs + 1000);

  if (result.exceptionDetails) {
    throw new Error(formatExceptionDetails(result.exceptionDetails));
  }

  return result.result?.value;
}

async function cdpSnapshot(session, options) {
  if (options.gc) {
    await safeSend(session, "HeapProfiler.collectGarbage");
  }

  const [performanceMetrics, domCounters] = await Promise.all([
    safeSend(session, "Performance.getMetrics"), safeSend(session, "Memory.getDOMCounters")
  ]);

  return {
    domCounters,
    performanceMetrics: Array.isArray(performanceMetrics?.metrics)
      ? Object.fromEntries(performanceMetrics.metrics.map((metric) => [metric.name, metric.value]))
      : performanceMetrics
  };
}

/** ≤3 anomalies; empty in the normal case (the digest prints only these). */
export function timingAnomalies(timings, slowestTls = null) {
  const anomalies = [];
  if (timings.navigationMs > 3000) anomalies.push({ code: "slow-navigation", ms: round(timings.navigationMs) });
  if (slowestTls?.ms > 2000) anomalies.push({ code: "slow-tls", ms: round(slowestTls.ms), host: slowestTls.host, url: slowestTls.url });
  if (timings.lockWaitMs > 2000) anomalies.push({ code: "lock-wait", ms: round(timings.lockWaitMs) });
  return anomalies.slice(0, 3);
}

function chromiumArgs(options) {
  const args = [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--enable-precise-memory-info",
    "--enable-unsafe-webgpu",
    "--enable-dawn-features=allow_unsafe_apis",
    "--js-flags=--expose-gc",
    "--no-first-run"
  ];

  if (options.angle) {
    args.push(`--use-angle=${options.angle}`);
  }

  for (const extraArg of options.chromiumArgs || []) {
    args.push(extraArg);
  }

  return args;
}

async function resolveChromeExecutable(options = {}) {
  const candidates = [
    options.executablePath,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    ...channelCandidates(options.channel),
    ...platformChromeCandidates()
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  try {
    const { chromium } = await import("playwright");
    const executablePath = chromium.executablePath();
    if (await isExecutable(executablePath)) {
      return executablePath;
    }
  } catch {
    // Keep the final error focused on what the user can fix.
  }

  throw Object.assign(new Error(options.executablePath
    ? `Chrome/Chromium not found at ${options.executablePath}.`
    : "Could not find Chrome/Chromium. Install Chrome/Chromium, pass --executable-path, or set CHROME_PATH or CHROMIUM_PATH."), {
    code: "chrome-not-found",
    hint: "Install Chrome, or pass --executable-path /path/to/chrome (or set CHROME_PATH)."
  });
}

function channelCandidates(channel) {
  if (!channel) {
    return [];
  }

  const normalized = channel.toLowerCase();
  if (process.platform === "darwin") {
    const apps = {
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "chrome-beta": "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "chrome-canary": "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    };
    return [apps[normalized]];
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA
    ].filter(Boolean);
    const names = normalized.includes("edge")
      ? ["Microsoft/Edge/Application/msedge.exe"]
      : ["Google/Chrome/Application/chrome.exe"];
    return roots.flatMap((root) => names.map((name) => path.join(root, name)));
  }

  const linuxNames = normalized.includes("edge")
    ? ["microsoft-edge", "microsoft-edge-stable"]
    : normalized.includes("chromium")
      ? ["chromium", "chromium-browser"]
      : ["google-chrome", "google-chrome-stable", "chrome"];
  return linuxNames;
}

function platformChromeCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ];
  }

  if (process.platform === "win32") {
    return channelCandidates("chrome");
  }

  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser"
  ];
}

async function isExecutable(candidate) {
  if (!candidate) {
    return false;
  }
  if (!path.isAbsolute(candidate)) {
    return Boolean(await findOnPath(candidate));
  }
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(binary) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const directory of paths) {
    const candidate = path.join(directory, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

async function safeSend(session, method, params, timeoutMs) {
  try {
    return await session.send(method, params, timeoutMs);
  } catch (error) {
    return { error: plainError(error), method };
  }
}

function waitForEvent(session, method, timeoutMs) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const off = session.once(method, (params) => {
      clearTimeout(timeout);
      resolve(params);
    });
    const timeout = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);
    cancel = () => { off(); clearTimeout(timeout); resolve(); };
  });
  // Navigation can fail before the waiter is awaited.
  promise.catch(() => {});
  return { promise, cancel };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onExit = () => { clearTimeout(timeout); resolve(); };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Timed out waiting for process exit."));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function emitProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try { onProgress(event); } catch { /* A progress observer must never fail a capture. */ }
}

function abortedError(message = "Capture aborted.", cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "aborted" });
}

// close({abort:true}) on the harness, not the caller's signal: reason lets a server that
// replaced a dead browser retry the job.
function harnessClosedError(message = "Capture aborted: the profiler was closed.", cause) {
  return Object.assign(abortedError(message, cause), { reason: "harness-closed" });
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value ?? null;
}

function formatExceptionDetails(details) {
  const message = details.exception?.description || details.text || "Runtime.evaluate failed";
  const callFrames = details.stackTrace?.callFrames || [];
  if (callFrames.length === 0) {
    return message;
  }
  return `${message}\n${callFrames.map((frame) => `    at ${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`).join("\n")}`;
}

function plainError(error) {
  return {
    message: error?.message || String(error),
    name: error?.name || "Error"
  };
}

function hostInfo() {
  return {
    arch: os.arch(),
    cpus: os.cpus().map((cpu) => cpu.model),
    freemem: os.freemem(),
    hostname: os.hostname(),
    loadavg: os.loadavg(),
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    totalmem: os.totalmem()
  };
}

function reportOptions(options, launchArgs) {
  return {
    angle: options.angle || null,
    api: options.api || "auto",
    autoInstrument: Boolean(options.autoInstrument),
    browserChannel: options.channel || null,
    chromiumArgs: launchArgs,
    contextMode: options.contextMode,
    samplingMode: options.samplingMode,
    frameObservation: options.samplingMode === "hook" ? "disabled" : "wall-clock",
    adaptive: Boolean(options.adaptive),
    minimalTrace: Boolean(options.minimalTrace),
    cdpAttached: Boolean(options.cdpUrl),
    waitCondition: options.waitCondition ?? null,
    durationMs: Number(options.durationMs ?? 1000),
    deviceScaleFactor: options.deviceScaleFactor,
    deepMemory: Boolean(options.deepMemory),
    waitUntil: options.waitUntil,
    waitForHook: Boolean(options.waitForHook),
    gc: Boolean(options.gc),
    headful: Boolean(options.headful),
    hookName: options.hookName || "__gpuReportBench",
    runner: "fast-cdp",
    samples: Number(options.samples ?? 5),
    slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
    trace: Boolean(options.trace),
    viewport: options.viewport || "1280x720",
    warmup: Number(options.warmup ?? 1),
    gpuTiming: options.gpuTiming !== false,
    readyTimeoutMs: Number(options.readyTimeoutMs ?? 3000),
    allowIdle: Boolean(options.allowIdle),
    networkIdleBudgetMs: Number(options.networkIdleBudgetMs ?? 10000),
    cpuProfile: options.cpuProfile ?? "auto",
    measureLock: options.measureLock !== false,
    label: options.label ?? null
  };
}
