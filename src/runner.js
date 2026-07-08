import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectInPage } from "./injected.js";
import { createFileTarget } from "./static-server.js";
import { getAutoInstrumentScript } from "./browser/bundler.js";
import { DEFAULT_TRACE_CATEGORIES, startChromeTrace, stopChromeTrace, summarizeTrace } from "./trace.js";
import { finalizeReport } from "./diagnostics.js";

async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    throw new Error(
      'The Playwright runner requires the optional "playwright" package. Install it with `npm install playwright` (and `npx playwright install chromium`), or use the default fast runner instead.'
    );
  }
}

export async function runReport(options = {}) {
  const chromium = await loadChromium();
  const target = await createTarget(options);
  const launchArgs = chromiumArgs(options);
  const browser = await chromium.launch({
    args: launchArgs,
    channel: options.channel,
    executablePath: options.executablePath,
    headless: !options.headful
  });

  let trace = null;
  let traceSummary = null;
  let traceError = null;

  try {
    const context = await browser.newContext({
      viewport: parseViewport(options.viewport)
    });
    const page = await context.newPage();
    if (options.autoInstrument) {
      const source = await getAutoInstrumentScript();
      await page.addInitScript(source);
    }
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
      await startChromeTrace(session, options.traceCategories || DEFAULT_TRACE_CATEGORIES);
    }

    await page.goto(target.url, {
      timeout: Number(options.timeoutMs ?? 60000),
      waitUntil: options.waitUntil || "networkidle"
    });

    if (options.waitCondition) {
      await page.waitForFunction(options.waitCondition, null, {
        timeout: Number(options.waitConditionTimeoutMs ?? 20000)
      });
    }

    const cdpBefore = await cdpSnapshot(session, options);
    const inPage = await page.evaluate(collectInPage, {
      api: options.api,
      durationMs: Number(options.durationMs ?? 1000),
      gc: Boolean(options.gc),
      hookName: options.hookName,
      samples: Number(options.samples ?? 5),
      warmup: Number(options.warmup ?? 1)
    });
    const cdpAfter = await cdpSnapshot(session, options);

    if (options.trace) {
      try {
        trace = await stopChromeTrace(session);
        traceSummary = summarizeTrace(trace);
      } catch (error) {
        traceError = plainError(error);
      }
    }

    let screenshotSize = null;
    let screenshotError = null;

    if (options.screenshot || options.visualValidation) {
      try {
        const canvasDataUrl = await page.evaluate(async () => {
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
        });

        let screenshotBuffer = null;
        if (canvasDataUrl) {
          const base64Data = canvasDataUrl.slice(canvasDataUrl.indexOf(",") + 1);
          screenshotBuffer = Buffer.from(base64Data, "base64");
        } else {
          screenshotBuffer = await page.screenshot({ type: "png" });
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

    await context.close();

    return finalizeReport({
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
    await browser.close();
    await target.close?.();
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
    browserChannel: options.channel || null,
    chromiumArgs: launchArgs,
    durationMs: Number(options.durationMs ?? 1000),
    gc: Boolean(options.gc),
    headful: Boolean(options.headful),
    hookName: options.hookName || "__gpuReportBench",
    samples: Number(options.samples ?? 5),
    trace: Boolean(options.trace),
    viewport: options.viewport || "1280x720",
    warmup: Number(options.warmup ?? 1),
    autoInstrument: Boolean(options.autoInstrument),
    screenshot: Boolean(options.screenshot),
    screenshotOut: options.screenshotOut || null,
    visualValidation: Boolean(options.visualValidation),
    waitCondition: options.waitCondition || null,
    waitConditionTimeoutMs: options.waitConditionTimeoutMs ? Number(options.waitConditionTimeoutMs) : null
  };
}
