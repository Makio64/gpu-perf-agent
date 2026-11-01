import { numericStats } from "./stats.js";

export const DEFAULT_TRACE_CATEGORIES = [
  "blink",
  "cc",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-gpu.service",
  "disabled-by-default-memory-infra",
  "gpu",
  "loading",
  "renderer.scheduler",
  "toplevel",
  "v8",
  "viz"
];

export const MINIMAL_TRACE_CATEGORIES = ["disabled-by-default-gpu.service", "gpu"];

export async function startChromeTrace(session, categories = DEFAULT_TRACE_CATEGORIES) {
  const params = {
    categories: categories.join(","),
    transferMode: "ReturnAsStream",
    options: "record-as-much-as-possible",
    memoryDumpConfig: {
      triggers: [
        {
          mode: "light",
          period_ms: 1000,
          type: "periodic_interval"
        }
      ]
    }
  };

  try {
    await session.send("Tracing.start", params);
  } catch (error) {
    if (/already been started/i.test(error?.message || "")) {
      await stopChromeTrace(session, { timeoutMs: 5000 }).catch(() => {});
    }
    const fallback = { ...params };
    delete fallback.memoryDumpConfig;
    await session.send("Tracing.start", fallback);
  }
}

export async function stopChromeTrace(session, { timeoutMs = 30000, maxBytes = 128 * 1024 * 1024 } = {}) {
  let timer;
  let handler;
  let unsubscribe;
  const complete = new Promise((resolve, reject) => {
    handler = resolve;
    unsubscribe = session.once("Tracing.tracingComplete", handler);
    timer = setTimeout(() => reject(new Error("Timed out waiting for Chrome trace completion.")), timeoutMs);
  });
  complete.catch(() => {});
  let stream;
  try {
    // Observe completion before ending; a short trace can finish immediately.
    const [, event] = await Promise.all([session.send("Tracing.end"), complete]);
    stream = event.stream;
    if (!stream) return null;
    const chunks = [];
    let bytes = 0;
    while (true) {
      const chunk = await session.send("IO.read", { handle: stream, size: 1024 * 1024 });
      const data = Buffer.from(chunk.data || "", chunk.base64Encoded ? "base64" : "utf8");
      bytes += data.length;
      if (bytes > maxBytes) throw new Error(`Chrome trace exceeds ${maxBytes} bytes; reduce sample duration or trace categories.`);
      chunks.push(data);
      if (chunk.eof) break;
    }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  } finally {
    clearTimeout(timer);
    if (typeof unsubscribe === "function") unsubscribe();
    else session.off?.("Tracing.tracingComplete", handler);
    if (stream) await session.send("IO.close", { handle: stream }).catch(() => {});
  }
}

export function summarizeTrace(trace) {
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const frameNames = new Map();
  const gpuNames = new Map();
  const gpuDurations = [];
  const topComplete = [];
  const topGPU = [];
  const memoryPaths = new Map();
  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;
  let frameCount = 0;
  let gpuCount = 0;
  let memoryCount = 0;

  // Classify once without retaining several additional arrays of trace events.
  // Exact GPU percentiles still require durations, but never the event objects.
  for (const event of events) {
    if (typeof event.ts === "number") {
      if (event.ts < minTimestamp) minTimestamp = event.ts;
      if (event.ts > maxTimestamp) maxTimestamp = event.ts;
    }
    if (event.ph === "X") addTopCompleteEvent(topComplete, event, 15);

    const name = event.name || "(unnamed)";
    const text = `${event.cat || ""} ${event.name || ""}`;
    if (/(^|,|\.)gpu|webgpu|dawn|webgl|gl_/i.test(text)) {
      gpuCount += 1;
      gpuNames.set(name, (gpuNames.get(name) || 0) + 1);
      if (Number.isFinite(event.dur)) gpuDurations.push(event.dur / 1000);
      addTopCompleteEvent(topGPU, event, 12);
    }
    if (/DrawFrame|BeginFrame|FramePresented|CompositeLayers/i.test(event.name || "")) {
      frameCount += 1;
      frameNames.set(name, (frameNames.get(name) || 0) + 1);
    }
    if (event.ph === "v" || /memory|dump/i.test(text)) {
      memoryCount += 1;
      collectMemoryNumbers(event.args, "", (path, value) => {
        const normalizedPath = path.replace(/^dumps\./, "");
        const previous = memoryPaths.get(normalizedPath);
        if (previous) {
          previous.maxBytes = Math.max(previous.maxBytes, value);
          previous.samples += 1;
        } else memoryPaths.set(normalizedPath, { maxBytes: Math.max(0, value), path: normalizedPath, samples: 1 });
      });
    }
  }

  return {
    durationMs: minTimestamp === Infinity || maxTimestamp === -Infinity ? null : (maxTimestamp - minTimestamp) / 1000,
    eventCount: events.length,
    frames: {
      eventCount: frameCount,
      topNames: topNames(frameNames, 12)
    },
    gpu: {
      completeDurationMs: numericStats(gpuDurations),
      eventCount: gpuCount,
      topCompleteEvents: topGPU,
      topNames: topNames(gpuNames, 15)
    },
    memory: {
      eventCount: memoryCount,
      topBytePaths: [...memoryPaths.values()].filter((item) => item.maxBytes > 0)
        .sort((a, b) => b.maxBytes - a.maxBytes).slice(0, 20)
    },
    topCompleteEvents: topComplete
  };
}

function topNames(counts, limit) {
  return Array.from(counts, ([name, count]) => ({ count, name }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function addTopCompleteEvent(top, event, limit) {
  if (!Number.isFinite(event.dur)) return;
  const durationMs = event.dur / 1000;
  if (top.length === limit && durationMs <= top[top.length - 1].durationMs) return;
  const entry = { cat: event.cat || null, durationMs, name: event.name || "(unnamed)" };
  const index = top.findIndex(item => item.durationMs < durationMs);
  top.splice(index < 0 ? top.length : index, 0, entry);
  if (top.length > limit) top.pop();
}

function collectMemoryNumbers(value, path, onNumber, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (depth > 12 || seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const [key, item] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;

    if (isMemoryNumberPath(nextPath)) {
      const number = parseTraceNumber(item);
      if (number != null) {
        onNumber(nextPath, number);
        continue;
      }
    }

    if (item && typeof item === "object") {
      collectMemoryNumbers(item, nextPath, onNumber, seen, depth + 1);
    }
  }
}

function isMemoryNumberPath(path) {
  return /(bytes|byte_size|size|resident|malloc|allocated|gpu_memory|discardable|private_footprint|peak)/i.test(path);
}

function parseTraceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    if (/^0x[0-9a-f]+$/i.test(value)) {
      return Number.parseInt(value, 16);
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  if (value && typeof value === "object" && "value" in value) {
    return parseTraceNumber(value.value);
  }

  return null;
}
