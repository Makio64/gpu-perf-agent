import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { CDPConnection } from "./cdp.js";
import { normalizeOptions, parseViewport, PROFILING_PRESETS } from "./options.js";
import { finalizeReport } from "./analysis.js";
import { autoInstrumentationSource } from "./browser/auto-instrument.js";
import { collectInPage } from "./injected.js";
import { createFileTarget } from "./static-server.js";
import { DEFAULT_TRACE_CATEGORIES, MINIMAL_TRACE_CATEGORIES, startChromeTrace, stopChromeTrace, summarizeTrace } from "./trace.js";

export async function runFastReport(options = {}) {
  options = normalizeOptions(options);
  const harness = await FastCDPHarness.launch(options);
  try {
    return await harness.run(options);
  } finally {
    await harness.close();
  }
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

export class FastCDPHarness {
  static async launch(options = {}) {
    options = normalizeOptions(options, { requireTarget: false });
    const viewport = parseViewport(options.viewport);
    const launch = options.cdpUrl ? {
      external: true,
      args: [],
      webSocketUrl: await resolveCdpWebSocketUrl(options.cdpUrl, options.launchTimeoutMs),
      close: async () => {}
    } : await launchChromeForCDP(options, viewport);
    try {
      const browserSession = await CDPConnection.connect(launch.webSocketUrl);
      return new FastCDPHarness(launch, browserSession, options);
    } catch (error) {
      await launch.close();
      throw error;
    }
  }

  constructor(launch, browserSession, options = {}) {
    this.browserInfo = null;
    this.browserSession = browserSession;
    this.closed = false;
    this.launch = launch;
    this.options = options;
    this.queue = Promise.resolve();
    this.closing = null;
    this.cleanupError = null;
    this.sharedContextId = null;
  }

  run(options = {}) {
    if (this.closed) return Promise.reject(new Error("FastCDPHarness is already closed."));
    // Serialize even Node API callers: Chrome tracing is browser-wide.
    const job = this.queue.then(() => {
      if (this.cleanupError) throw this.cleanupError;
      options = { ...options };
      if (options.cdp || options.webSocketUrl) options.cdpUrl ??= options.cdp ?? options.webSocketUrl;
      const merged = { ...this.options, ...(options.preset ? PROFILING_PRESETS[options.preset] : {}), ...options };
      if (options.url && !options.file) delete merged.file;
      if (options.file && !options.url) delete merged.url;
      // Launch-only flags cannot take effect after Chrome has started.
      for (const key of ["angle", "channel", "executablePath", "headful", "chromiumArgs", "cdpUrl"]) {
        if (options[key] !== undefined && JSON.stringify(options[key]) !== JSON.stringify(this.options[key] ?? (key === "headful" ? false : key === "chromiumArgs" ? [] : undefined))) {
          throw new TypeError(`${key} is a launch option; create a new harness to change it.`);
        }
      }
      return this.runJob(normalizeOptions(merged));
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async runJob(options) {
    const startedAt = performance.now();
    const target = await createFastTarget(options);
    const viewport = parseViewport(options.viewport);
    let page = null;
    let tracing = false;
    let trace = null;
    let traceSummary = null;
    let traceError = null;
    let screenshotPath = null;
    let screenshotSize = null;

    try {
      if (options.contextMode === "shared" && !this.sharedContextId) {
        const context = await this.browserSession.send("Target.createBrowserContext", { disposeOnDetach: true });
        this.sharedContextId = context.browserContextId;
      }
      page = await createPage(this.browserSession, target.url, viewport, options, this.sharedContextId);
      const navigationMs = performance.now() - startedAt;

      const browserInfo = await this.getBrowserInfo();

      if (options.trace) {
        await startChromeTrace(this.browserSession, options.traceCategories || (options.minimalTrace ? MINIMAL_TRACE_CATEGORIES : DEFAULT_TRACE_CATEGORIES));
        tracing = true;
      }

      const cdpBefore = await cdpSnapshot(page.session, options);
      const samplingStartedAt = performance.now();
      const inPage = await evaluateInPage(page.session, {
        adaptive: Boolean(options.adaptive),
        api: options.api,
        durationMs: Number(options.durationMs ?? 1000),
        gc: Boolean(options.gc),
        deepMemory: Boolean(options.deepMemory),
        hookName: options.hookName,
        samples: Number(options.samples ?? 5),
        slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
        warmup: Number(options.warmup ?? 1)
      }, Number(options.timeoutMs ?? 60000));
      const samplingMs = performance.now() - samplingStartedAt;
      const cdpAfter = await cdpSnapshot(page.session, options);

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

      return finalizeReport({
        screenshotSize,
        artifacts: {
          screenshotPath
        },
        timings: { navigationMs, samplingMs, totalMs: performance.now() - startedAt },
        browser: browserInfo,
        cdp: {
          after: cdpAfter,
          before: cdpBefore
        },
        createdAt: new Date().toISOString(),
        host: hostInfo(),
        inPage,
        options: reportOptions(options, this.launch.args),
        pageEvents: page.events,
        schemaVersion: 2,
        target: {
          file: target.file || null,
          root: target.root || null,
          source: options.file ? "file-server" : "url",
          url: target.url
        },
        trace: {
          captured: Boolean(trace),
          error: traceError,
          rawTracePath: options.rawTracePath || null,
          summary: traceSummary
        }
      }, options);
    } catch (error) {
      if (error.code === "CAPTURE_CLEANUP_FAILED") this.cleanupError = error;
      throw error;
    } finally {
      try {
        if (tracing) await stopChromeTrace(this.browserSession, { timeoutMs: 5000 }).catch(() => {});
        if (page) await page.close();
      } catch (error) {
        this.cleanupError = captureCleanupError(error);
        throw this.cleanupError;
      } finally {
        await target.close?.();
      }
    }
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.queue.then(async () => {
        try {
          if (this.launch.external) {
            if (this.sharedContextId) await safeSend(this.browserSession, "Target.disposeBrowserContext", {browserContextId: this.sharedContextId});
          } else await safeSend(this.browserSession, "Browser.close");
        }
        finally {
          this.browserSession.close();
          await this.launch.close();
        }
      });
    }
    return this.closing;
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
  throw new Error("A target is required. Pass --url or --file.");
}

async function resolveCdpWebSocketUrl(target, timeoutMs) {
  if (/^wss?:\/\//.test(target)) return new URL(target).href;
  const endpoint = /^\d+$/.test(target) ? `http://127.0.0.1:${target}` : /^[a-z]+:\/\//i.test(target) ? target : `http://${target}`;
  const url = new URL("/json/version", endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("CDP discovery must use HTTP(S), or provide a browser WebSocket URL.");
  const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}.`);
  const data = await response.json();
  if (typeof data.webSocketDebuggerUrl !== "string" || !/^wss?:\/\//.test(data.webSocketDebuggerUrl)) throw new Error("CDP discovery did not return a browser WebSocket URL.");
  return data.webSocketDebuggerUrl;
}

async function launchChromeForCDP(options, viewport) {
  const executablePath = await resolveChromeExecutable(options);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "webgpu-report-cdp-"));
  const args = [
    ...chromiumArgs(options),
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--window-size=${viewport.width},${viewport.height}`,
    "about:blank"
  ];

  if (!options.headful) {
    args.unshift("--headless=new");
  }

  const child = spawn(executablePath, args, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  const close = async () => {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      try { await waitForExit(child, 2500); }
      catch {
        child.kill("SIGKILL");
        await waitForExit(child, 2500).catch(() => {});
      }
    }
    await rm(userDataDir, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
  };
  let webSocketUrl;
  try {
    webSocketUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for Chrome DevTools endpoint.\n${stderr}`));
      }, Number(options.launchTimeoutMs ?? 15000));

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited before DevTools was ready: code=${code} signal=${signal}\n${stderr}`));
      });

      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-65536);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });

  } catch (error) {
    await close();
    throw error;
  }

  return {
    args,
    close,
    executablePath,
    process: child,
    userDataDir,
    webSocketUrl
  };
}

async function createPage(browserSession, url, viewport, options, sharedContextId) {
  const events = [];
  let target;
  let browserContextId;
  let session;
  const isolated = options.contextMode !== "shared";
  const close = async () => {
    session?.dispose();
    if (browserContextId && isolated) {
      // Also closes popups and terminates workers owned by this job.
      await browserSession.send("Target.disposeBrowserContext", { browserContextId }, 5000);
      browserContextId = null;
    } else if (browserContextId) {
      // Shared mode retains storage and service workers, but never leaves popup pages running.
      const { targetInfos } = await browserSession.send("Target.getTargets");
      await Promise.all(targetInfos.filter(info => info.browserContextId === browserContextId && info.type === "page")
        .map(info => browserSession.send("Target.closeTarget", { targetId: info.targetId }, 5000)));
    } else if (target) {
      await safeSend(browserSession, "Target.closeTarget", { targetId: target.targetId });
    }
    target = null;
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

    capturePageEvents(session, events);
    await Promise.all([
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("Log.enable"),
      session.send("Network.enable"),
      session.send("Performance.enable"),
      session.send("HeapProfiler.enable"),
      session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      session.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: Number(options.deviceScaleFactor ?? 1),
        height: viewport.height,
        mobile: false,
        width: viewport.width
      })
    ]);

    if (options.autoInstrument) {
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: autoInstrumentationSource(options.autoInstrumentOptions)
      });
    }

    await navigatePage(session, url, {
      timeoutMs: Number(options.timeoutMs ?? 60000),
      waitUntil: options.waitUntil || "networkidle"
    });

    if (options.waitCondition) {
      const ready = await session.send("Runtime.evaluate", {
        expression: `(async () => {
          const deadline = performance.now() + ${options.waitConditionTimeoutMs};
          while (!(${options.waitCondition})) {
            if (performance.now() >= deadline) throw new Error("Timed out waiting for page condition.");
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        })()`, awaitPromise: true, returnByValue: true
      }, options.waitConditionTimeoutMs + 1000);
      if (ready.exceptionDetails) throw new Error(formatExceptionDetails(ready.exceptionDetails));
    }

    if (options.waitForHook) {
      const hookName = options.hookName || "__gpuReportBench";
      const ready = await session.send("Runtime.evaluate", {
        expression: `(async () => {
          const deadline = performance.now() + ${options.timeoutMs};
          while (typeof globalThis[${JSON.stringify(hookName)}] !== "function") {
            if (performance.now() >= deadline) throw new Error(${JSON.stringify(`Timed out waiting for benchmark hook ${hookName}.`)});
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      }, options.timeoutMs + 1000);
      if (ready.exceptionDetails) throw new Error(formatExceptionDetails(ready.exceptionDetails));
    }

    return {
      close,
      events,
      session,
      targetId: target.targetId
    };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw captureCleanupError(new AggregateError([error, cleanupError])); }
    throw error;
  }
}

function captureCleanupError(cause) {
  return Object.assign(new Error("Capture cleanup failed; close this harness and launch a new one before profiling again.", { cause }), { code: "CAPTURE_CLEANUP_FAILED" });
}

async function navigatePage(session, url, options) {
  const waitUntil = options.waitUntil || "load";
  const timeoutMs = Number(options.timeoutMs ?? 60000);
  const deadline = Date.now() + timeoutMs;
  const network = createNetworkTracker(session);
  const event = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
  const load = waitUntil === "commit" ? null : waitForEvent(session, event, timeoutMs);

  try {
    const navigation = await session.send("Page.navigate", { url });
    if (navigation.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }

    if (waitUntil === "commit") {
      return;
    }

    await load.promise;

    if (waitUntil === "networkidle") {
      await network.waitForIdle(250, Math.max(1, deadline - Date.now()));
    }
  } finally {
    load?.cancel();
    network.dispose();
  }
}

function createNetworkTracker(session) {
  const pending = new Set();
  let idleTimer = null;
  const idleWaiters = new Set();
  const offStart = session.on("Network.requestWillBeSent", (event) => {
    if (!event.request?.url?.startsWith("data:")) {
      pending.add(event.requestId);
    }
    clearIdle();
  });
  const finish = (event) => {
    pending.delete(event.requestId);
    maybeIdle();
  };
  const offFinish = session.on("Network.loadingFinished", finish);
  const offFail = session.on("Network.loadingFailed", finish);

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function maybeIdle() {
    if (pending.size !== 0 || idleWaiters.size === 0) {
      return;
    }
    clearIdle();
    const idleForMs = Math.min(...Array.from(idleWaiters, (waiter) => waiter.idleForMs));
    idleTimer = setTimeout(() => {
      for (const waiter of idleWaiters) {
        waiter.resolve();
      }
      idleWaiters.clear();
    }, idleForMs);
  }

  return {
    dispose() {
      clearIdle();
      offStart();
      offFinish();
      offFail();
      for (const waiter of idleWaiters) {
        waiter.resolve();
      }
      idleWaiters.clear();
    },
    waitForIdle(idleForMs, timeoutMs) {
      return new Promise((resolve, reject) => {
        const waiter = { idleForMs, resolve };
        idleWaiters.add(waiter);
        const timeout = setTimeout(() => {
          idleWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for network idle with ${pending.size} request(s) pending.`));
        }, timeoutMs);
        waiter.resolve = () => {
          clearTimeout(timeout);
          resolve();
        };
        maybeIdle();
      });
    }
  };
}

async function evaluateInPage(session, options, timeoutMs) {
  const expression = `(${collectInPage.toString()})(${JSON.stringify(options)})`;
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

function capturePageEvents(session, events) {
  session.on("Runtime.consoleAPICalled", (event) => {
    events.push({
      args: (event.args || []).map(remoteObjectValue),
      text: (event.args || []).map(remoteObjectValue).join(" "),
      type: `console.${event.type || "log"}`
    });
  });
  session.on("Runtime.exceptionThrown", (event) => {
    events.push({
      error: {
        message: event.exceptionDetails?.text || remoteObjectValue(event.exceptionDetails?.exception),
        stack: event.exceptionDetails?.stackTrace || null
      },
      type: "pageerror"
    });
  });
  session.on("Log.entryAdded", (event) => {
    events.push({
      level: event.entry?.level || null,
      source: event.entry?.source || null,
      text: event.entry?.text || null,
      type: "log.entry"
    });
  });
  session.on("Network.loadingFailed", (event) => {
    events.push({
      failure: event.errorText || null,
      type: "requestfailed",
      url: event.requestId
    });
  });
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

  throw new Error("Could not find Chrome/Chromium. Install Chrome/Chromium, pass --executable-path, or set CHROME_PATH or CHROMIUM_PATH.");
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

async function safeSend(session, method, params) {
  try {
    return await session.send(method, params);
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

function remoteObjectValue(object) {
  if (!object) {
    return "";
  }
  if ("value" in object) {
    return object.value;
  }
  if (object.unserializableValue) {
    return object.unserializableValue;
  }
  return object.description || object.type || "";
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
    frameObservation: "wall-clock",
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
    warmup: Number(options.warmup ?? 1)
  };
}
