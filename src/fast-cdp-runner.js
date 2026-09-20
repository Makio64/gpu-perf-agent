import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { collectInPage } from "./injected.js";
import { createFileTarget } from "./static-server.js";
import { DEFAULT_TRACE_CATEGORIES, MINIMAL_TRACE_CATEGORIES, startChromeTrace, stopChromeTrace, summarizeTrace } from "./trace.js";
import { getAutoInstrumentScript } from "./browser/bundler.js";
import { finalizeReport } from "./diagnostics.js";

export async function runFastReport(options = {}) {
  const harness = await FastCDPHarness.launch(options);
  try {
    return await harness.run(options);
  } finally {
    await harness.close();
  }
}

export async function runFastReports(reportOptions, launchOptions = {}) {
  const harness = await FastCDPHarness.launch(launchOptions);
  try {
    const reports = [];
    for (const options of reportOptions) {
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
    const viewport = parseViewport(options.viewport);
    const cdpTarget = options.cdpUrl || options.cdp || options.webSocketUrl;
    let launch;
    let browserSession;

    if (cdpTarget) {
      const wsUrl = await resolveCdpWebSocketUrl(cdpTarget);
      browserSession = await CDPConnection.connect(wsUrl);
      launch = {
        args: [],
        webSocketUrl: wsUrl,
        close: async () => {}
      };
    } else {
      launch = await launchChromeForCDP(options, viewport);
      browserSession = await CDPConnection.connect(launch.webSocketUrl);
    }

    return new FastCDPHarness(launch, browserSession);
  }

  constructor(launch, browserSession) {
    this.browserInfo = null;
    this.browserSession = browserSession;
    this.closed = false;
    this.launch = launch;
  }

  async run(options = {}) {
    if (this.closed) {
      throw new Error("FastCDPHarness is already closed.");
    }

    const target = await createFastTarget(options);
    const viewport = parseViewport(options.viewport);
    let pageTargetId = null;
    let trace = null;
    let traceSummary = null;
    let traceError = null;

    try {
      const page = await createPage(this.browserSession, target.url, viewport, options);
      pageTargetId = page.targetId;

      const browserInfo = await this.getBrowserInfo();

      if (options.waitCondition) {
        const timeout = Number(options.waitConditionTimeoutMs ?? 20000);
        const start = Date.now();
        let conditionMet = false;
        while (Date.now() - start < timeout) {
          const evalResult = await page.session.send("Runtime.evaluate", {
            expression: options.waitCondition,
            returnByValue: true
          });
          if (evalResult?.result?.value) {
            conditionMet = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!conditionMet) {
          throw new Error(`Timed out waiting for condition: ${options.waitCondition}`);
        }
      }

      if (options.trace) {
        const categories = options.traceCategories || (options.minimalTrace ? MINIMAL_TRACE_CATEGORIES : DEFAULT_TRACE_CATEGORIES);
        await startChromeTrace(this.browserSession, categories);
      }

      const cdpBefore = await cdpSnapshot(page.session, options);
      const inPage = await evaluateInPage(page.session, {
        adaptive: Boolean(options.adaptive),
        api: options.api,
        durationMs: Number(options.durationMs ?? 1000),
        gc: Boolean(options.gc),
        hookName: options.hookName,
        samples: Number(options.samples ?? 5),
        warmup: Number(options.warmup ?? 1)
      }, Number(options.timeoutMs ?? 60000));
      const cdpAfter = await cdpSnapshot(page.session, options);

      if (options.trace) {
        try {
          trace = await stopChromeTrace(this.browserSession);
          traceSummary = summarizeTrace(trace);
        } catch (error) {
          traceError = plainError(error);
        }
      }

      if (trace && options.rawTracePath) {
        await mkdir(path.dirname(options.rawTracePath), { recursive: true });
        await writeFile(options.rawTracePath, JSON.stringify(trace));
      }

      let screenshotSize = null;
      let screenshotError = null;

      if (options.screenshot || options.visualValidation) {
        try {
          const canvasDataUrl = await page.session.send("Runtime.evaluate", {
            expression: `(async () => {
              const canvas = document.querySelector('canvas');
              if (!canvas) return null;
              return new Promise((resolve) => {
                const timer = setTimeout(() => resolve(null), 5000);
                canvas.toBlob((blob) => {
                  clearTimeout(timer);
                  if (!blob) {
                    resolve(null);
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result);
                  reader.onerror = () => resolve(null);
                  reader.readAsDataURL(blob);
                }, 'image/png');
              });
            })()`,
            awaitPromise: true,
            returnByValue: true
          });

          let screenshotBuffer = null;
          if (canvasDataUrl?.result?.value) {
            const dataUrl = canvasDataUrl.result.value;
            const base64Data = dataUrl.slice(dataUrl.indexOf(",") + 1);
            screenshotBuffer = Buffer.from(base64Data, "base64");
          } else {
            const screenshotResponse = await page.session.send("Page.captureScreenshot", {
              format: "png"
            });
            if (screenshotResponse?.data) {
              screenshotBuffer = Buffer.from(screenshotResponse.data, "base64");
            }
          }

          if (screenshotBuffer) {
            screenshotSize = screenshotBuffer.byteLength;
            let savePath = options.screenshotOut;
            if (!savePath && options.screenshot && options.out) {
              savePath = options.out.replace(/\.json$/i, ".png");
              if (savePath === options.out) {
                savePath = options.out + ".png";
              }
            }
            if (savePath) {
              await mkdir(path.dirname(savePath), { recursive: true });
              await writeFile(savePath, screenshotBuffer);
            }
          } else {
            screenshotError = "Failed to capture canvas or page screenshot.";
          }
        } catch (error) {
          screenshotError = error?.message || String(error);
        }
      }

      return finalizeReport({
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
        schemaVersion: 1,
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
        },
        screenshotSize,
        screenshotError
      });
    } finally {
      if (pageTargetId) {
        await safeSend(this.browserSession, "Target.closeTarget", { targetId: pageTargetId });
      }
      await target.close?.();
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await safeSend(this.browserSession, "Browser.close");
    this.browserSession.close();
    await this.launch.close();
  }

  async getBrowserInfo() {
    if (!this.browserInfo) {
      this.browserInfo = {
        executablePath: this.launch.executablePath,
        pid: this.launch.process.pid,
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

async function resolveCdpWebSocketUrl(target) {
  if (typeof target !== "string") {
    throw new Error(`Invalid CDP target: ${target}`);
  }
  if (target.startsWith("ws://") || target.startsWith("wss://")) {
    return target;
  }
  let httpUrl = target;
  if (/^\d+$/.test(target)) {
    httpUrl = `http://127.0.0.1:${target}`;
  } else if (!httpUrl.startsWith("http://") && !httpUrl.startsWith("https://")) {
    httpUrl = `http://${httpUrl}`;
  }
  const versionUrl = new URL("/json/version", httpUrl).toString();
  const res = await fetch(versionUrl);
  if (!res.ok) {
    throw new Error(`Failed to query CDP version endpoint at ${versionUrl}: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data.webSocketDebuggerUrl) {
    throw new Error(`CDP endpoint ${versionUrl} did not return webSocketDebuggerUrl.`);
  }
  return data.webSocketDebuggerUrl;
}

async function launchChromeForCDP(options, viewport) {
  const executablePath = await resolveChromeExecutable(options);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-agent-cdp-"));
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
  const webSocketUrl = await new Promise((resolve, reject) => {
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
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });

  return {
    args,
    close: async () => {
      if (!child.killed && child.exitCode == null) {
        child.kill("SIGTERM");
        await waitForExit(child, 2500).catch(() => {
          if (!child.killed && child.exitCode == null) {
            child.kill("SIGKILL");
          }
        });
      }
      await rm(userDataDir, { force: true, recursive: true });
    },
    executablePath,
    process: child,
    userDataDir,
    webSocketUrl
  };
}

async function createPage(browserSession, url, viewport, options) {
  const events = [];
  const target = await browserSession.send("Target.createTarget", {
    newWindow: false,
    url: "about:blank"
  });
  const attached = await browserSession.send("Target.attachToTarget", {
    flatten: true,
    targetId: target.targetId
  });
  const session = browserSession.session(attached.sessionId);

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

  if (options.slowFrameThreshold) {
    const source = `globalThis.__gpuSlowFrameThreshold = ${Number(options.slowFrameThreshold)};`;
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  if (options.autoInstrument) {
    const source = await getAutoInstrumentScript();
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  await navigatePage(session, url, {
    timeoutMs: Number(options.timeoutMs ?? 60000),
    waitUntil: options.waitUntil || "networkidle"
  });

  return {
    events,
    session,
    targetId: target.targetId
  };
}

async function navigatePage(session, url, options) {
  const waitUntil = options.waitUntil || "load";
  const timeoutMs = Number(options.timeoutMs ?? 60000);
  const deadline = Date.now() + timeoutMs;
  const network = createNetworkTracker(session);
  const loadPromise = waitForEvent(session, "Page.loadEventFired", timeoutMs);

  try {
    const navigation = await session.send("Page.navigate", { url });
    if (navigation.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }

    if (waitUntil === "commit") {
      return;
    }

    await loadPromise;

    if (waitUntil === "networkidle") {
      await network.waitForIdle(250, Math.max(1, deadline - Date.now()));
    }
  } finally {
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
      if (pending.size === 0) {
        return new Promise((resolve) => setTimeout(resolve, idleForMs));
      }
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

  const performanceMetrics = await safeSend(session, "Performance.getMetrics");
  const domCounters = await safeSend(session, "Memory.getDOMCounters");

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

  throw new Error("Could not find Chrome/Chromium. Pass --executable-path, set CHROME_PATH, or run `npx playwright install chromium`.");
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

function parseViewport(viewport) {
  if (!viewport) {
    return { height: 720, width: 1280 };
  }

  const match = /^(\d+)x(\d+)$/i.exec(viewport);
  if (!match) {
    throw new Error(`Invalid viewport "${viewport}". Expected WIDTHxHEIGHT, for example 1280x720.`);
  }

  return {
    height: Number(match[2]),
    width: Number(match[1])
  };
}

async function safeSend(session, method, params) {
  try {
    return await session.send(method, params);
  } catch (error) {
    return { error: plainError(error), method };
  }
}

function waitForEvent(session, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const off = session.once(method, (params) => {
      clearTimeout(timeout);
      resolve(params);
    });
    const timeout = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
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
    browserChannel: options.channel || null,
    chromiumArgs: launchArgs,
    durationMs: Number(options.durationMs ?? 1000),
    gc: Boolean(options.gc),
    headful: Boolean(options.headful),
    hookName: options.hookName || "__gpuReportBench",
    runner: "fast-cdp",
    samples: Number(options.samples ?? 5),
    adaptive: Boolean(options.adaptive),
    trace: Boolean(options.trace),
    minimalTrace: Boolean(options.minimalTrace),
    viewport: options.viewport || "1280x720",
    warmup: Number(options.warmup ?? 1),
    autoInstrument: Boolean(options.autoInstrument),
    slowFrameThreshold: options.slowFrameThreshold ? Number(options.slowFrameThreshold) : null,
    screenshot: Boolean(options.screenshot),
    screenshotOut: options.screenshotOut || null,
    visualValidation: Boolean(options.visualValidation),
    waitCondition: options.waitCondition || null,
    waitConditionTimeoutMs: options.waitConditionTimeoutMs ? Number(options.waitConditionTimeoutMs) : null
  };
}

class CDPConnection {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools WebSocket.")), 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", (event) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome DevTools WebSocket error: ${event.message || "unknown"}`));
      }, { once: true });
    });

    return new CDPConnection(socket);
  }

  constructor(socket) {
    this.id = 1;
    this.listeners = new Map();
    this.pending = new Map();
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(new Error("Chrome DevTools WebSocket closed."));
      }
      this.pending.clear();
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  session(sessionId) {
    return new CDPSession(this, sessionId);
  }

  send(method, params, timeoutMs = 30000) {
    return this.sendRaw(method, params, undefined, timeoutMs);
  }

  sendRaw(method, params, sessionId, timeoutMs = 30000) {
    const id = this.id;
    this.id += 1;
    const message = {
      id,
      method,
      params
    };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        reject,
        resolve,
        timeout
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  once(method, handler) {
    const off = this.on(method, (params, sessionId) => {
      off();
      handler(params, sessionId);
    });
    return off;
  }

  handleMessage(data) {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const message = JSON.parse(text);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const handlers = this.listeners.get(message.method);
      if (!handlers) {
        return;
      }
      for (const handler of Array.from(handlers)) {
        handler(message.params || {}, message.sessionId);
      }
    }
  }
}

class CDPSession {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  send(method, params, timeoutMs = 30000) {
    return this.connection.sendRaw(method, params, this.sessionId, timeoutMs);
  }

  on(method, handler) {
    return this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) {
        handler(params);
      }
    });
  }

  once(method, handler) {
    const off = this.on(method, (params) => {
      off();
      handler(params);
    });
    return off;
  }
}
