import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptions, parseViewport } from "./options.js";
import { finalizeReport } from "./analysis.js";
import { installAutoInstrumentation } from "./browser/auto-instrument.js";
import { collectInPage } from "./injected.js";
import { createFileTarget } from "./static-server.js";
import { DEFAULT_TRACE_CATEGORIES, MINIMAL_TRACE_CATEGORIES, startChromeTrace, stopChromeTrace, summarizeTrace } from "./trace.js";

export async function runReport(options = {}) {
  options = normalizeOptions(options);
  if (options.cdpUrl) throw new TypeError("CDP attachment requires the fast runner.");
  if (options.contextMode === "shared") throw new TypeError("Shared contexts require the fast runner and a persistent harness or server.");
  const { chromium } = await import("playwright").catch((error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.message.startsWith("Cannot find package 'playwright'")) {
      throw error;
    }
    throw new Error('The Playwright runner is optional. Install it with `npm install --save-dev playwright` in the profiler installation, or use the default `--runner fast` with Chrome/Chromium.', { cause: error });
  });
  const target = await createTarget(options);
  const launchArgs = chromiumArgs(options);
  let browser;
  try {
    browser = await chromium.launch({
      args: launchArgs,
      channel: options.channel,
      executablePath: options.executablePath,
      headless: !options.headful
    });
  } catch (error) {
    await target.close?.();
    throw error;
  }

  let trace = null;
  let traceSummary = null;
  let traceError = null;

  try {
    const context = await browser.newContext({
      viewport: parseViewport(options.viewport),
      deviceScaleFactor: options.deviceScaleFactor
    });
    if (options.autoInstrument) {
      await context.addInitScript(installAutoInstrumentation, options.autoInstrumentOptions || {});
    }
    const page = await context.newPage();
    const pageEvents = capturePageEvents(page);
    const session = await context.newCDPSession(page);
    const browserSession = typeof browser.newBrowserCDPSession === "function"
      ? await browser.newBrowserCDPSession()
      : null;

    await safeSend(session, "Performance.enable");
    await safeSend(session, "HeapProfiler.enable");

    const browserInfo = {
      systemInfo: browserSession ? await safeSend(browserSession, "SystemInfo.getInfo") : null,
      version: browserSession ? await safeSend(browserSession, "Browser.getVersion") : null
    };

    if (options.trace) {
      await startChromeTrace(session, options.traceCategories || (options.minimalTrace ? MINIMAL_TRACE_CATEGORIES : DEFAULT_TRACE_CATEGORIES));
    }

    await page.goto(target.url, {
      timeout: Number(options.timeoutMs ?? 60000),
      waitUntil: options.waitUntil || "networkidle"
    });

    if (options.waitCondition) await page.waitForFunction(options.waitCondition, undefined, {timeout: options.waitConditionTimeoutMs});
    if (options.waitForHook) {
      await page.waitForFunction(name => typeof globalThis[name] === "function", options.hookName || "__gpuReportBench", { timeout: options.timeoutMs });
    }
    const cdpBefore = await cdpSnapshot(session, options);
    let evaluationTimer;
    const evaluation = page.evaluate(collectInPage, {
      adaptive: Boolean(options.adaptive),
      api: options.api,
      durationMs: Number(options.durationMs ?? 1000),
      gc: Boolean(options.gc),
      deepMemory: Boolean(options.deepMemory),
      hookName: options.hookName,
      samples: Number(options.samples ?? 5),
      slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
      warmup: Number(options.warmup ?? 1)
    });
    let inPage;
    try {
      inPage = await Promise.race([evaluation, new Promise((_, reject) => {
        evaluationTimer = setTimeout(() => reject(new Error("Timed out sampling page.")), options.timeoutMs);
      })]);
    } finally { clearTimeout(evaluationTimer); }
    const cdpAfter = await cdpSnapshot(session, options);

    if (options.trace) {
      try {
        trace = await stopChromeTrace(session);
        traceSummary = summarizeTrace(trace);
      } catch (error) {
        traceError = plainError(error);
      }
    }

    if (trace && options.rawTracePath) {
      await mkdir(path.dirname(options.rawTracePath), { recursive: true });
      await writeFile(options.rawTracePath, JSON.stringify(trace));
    }

    let screenshotPath = null;
    let screenshotSize = null;
    if (options.screenshotPath || options.screenshot || options.visualValidation) {
      if (options.screenshotPath) {
        screenshotPath = path.resolve(options.screenshotPath);
        await mkdir(path.dirname(screenshotPath), { recursive: true });
      }
      screenshotSize = (await page.screenshot({ ...(screenshotPath ? {path: screenshotPath} : {}) })).byteLength;
    }

    await context.close();

    return finalizeReport({
      screenshotSize,
      artifacts: {
        screenshotPath
      },
      browser: browserInfo,
      cdp: {
        after: cdpAfter,
        before: cdpBefore
      },
      createdAt: new Date().toISOString(),
      host: hostInfo(),
      inPage,
      options: reportOptions(options, launchArgs),
      pageEvents,
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
  } finally {
    try { await browser.close(); }
    finally { await target.close?.(); }
  }
}

export async function createTarget(options = {}) {
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

function capturePageEvents(page) {
  const events = [];
  page.on("console", (message) => {
    events.push({
      location: message.location(),
      text: message.text(),
      type: `console.${message.type()}`
    });
  });
  page.on("pageerror", (error) => {
    events.push({
      error: plainError(error),
      type: "pageerror"
    });
  });
  page.on("requestfailed", (request) => {
    events.push({
      failure: request.failure()?.errorText || null,
      type: "requestfailed",
      url: request.url()
    });
  });
  return events;
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

async function safeSend(session, method, params) {
  try {
    return await session.send(method, params);
  } catch (error) {
    return { error: plainError(error), method };
  }
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
    waitCondition: options.waitCondition ?? null,
    durationMs: Number(options.durationMs ?? 1000),
    deviceScaleFactor: options.deviceScaleFactor,
    deepMemory: Boolean(options.deepMemory),
    waitUntil: options.waitUntil,
    waitForHook: Boolean(options.waitForHook),
    runner: "playwright",
    gc: Boolean(options.gc),
    headful: Boolean(options.headful),
    hookName: options.hookName || "__gpuReportBench",
    samples: Number(options.samples ?? 5),
    slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
    trace: Boolean(options.trace),
    viewport: options.viewport || "1280x720",
    warmup: Number(options.warmup ?? 1)
  };
}
