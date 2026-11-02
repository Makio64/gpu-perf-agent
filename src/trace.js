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
  } catch {
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

const GPU_CAT_RE = /(^|,|\.)gpu|webgpu|dawn|webgl|gl_/i;
const GPU_NAME_RE = /(,|\.)gpu|webgpu|dawn|webgl|gl_/i;
const FRAME_NAME_RE = /DrawFrame|BeginFrame|FramePresented|CompositeLayers/i;
const MEMORY_TEXT_RE = /memory|dump/i;
const MEMORY_PATH_RE = /(bytes|byte_size|size|resident|malloc|allocated|gpu_memory|discardable|private_footprint|peak)/i;

export function summarizeTrace(trace) {
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const gpuDurations = [];
  const topComplete = [];
  const topGPU = [];
  const memoryPaths = new Map();
  const catFlags = new Map();
  const nameInfo = new Map();
  let lastCat = null;
  let lastCf = 0;
  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;
  let frameCount = 0;
  let gpuCount = 0;
  let memoryCount = 0;

  const onMemoryNumber = (path, value) => {
    const normalizedPath = path.startsWith("dumps.") ? path.slice(6) : path;
    const previous = memoryPaths.get(normalizedPath);
    if (previous) {
      if (value > previous.maxBytes) previous.maxBytes = value;
      previous.samples += 1;
    } else memoryPaths.set(normalizedPath, { maxBytes: Math.max(0, value), path: normalizedPath, samples: 1 });
  };

  // Classify once without retaining several additional arrays of trace events.
  // Exact GPU percentiles still require durations, but never the event objects.
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const ts = event.ts;
    if (typeof ts === "number") {
      if (ts < minTimestamp) minTimestamp = ts;
      if (ts > maxTimestamp) maxTimestamp = ts;
    }
    const dur = event.dur;
    const hasDur = typeof dur === "number" && Number.isFinite(dur);
    if (event.ph === "X" && hasDur) {
      const durationMs = dur / 1000;
      if (topComplete.length < 15 || durationMs > topComplete[14].durationMs) {
        insertTopEvent(topComplete, event, durationMs, 15);
      }
    }

    const cat = event.cat || "";
    let cf;
    if (cat === lastCat) {
      cf = lastCf;
    } else {
      cf = catFlags.get(cat);
      if (cf === undefined) {
        cf = (GPU_CAT_RE.test(cat) ? 1 : 0) | (MEMORY_TEXT_RE.test(cat) ? 4 : 0);
        catFlags.set(cat, cf);
      }
      lastCat = cat;
      lastCf = cf;
    }

    const rawName = event.name || "";
    let info = nameInfo.get(rawName);
    if (info === undefined) {
      info = {
        flags: (GPU_NAME_RE.test(rawName) ? 1 : 0) | (FRAME_NAME_RE.test(rawName) ? 2 : 0) | (MEMORY_TEXT_RE.test(rawName) ? 4 : 0),
        name: rawName || "(unnamed)",
        gpuCount: 0,
        frameCount: 0
      };
      nameInfo.set(rawName, info);
    }
    const flags = cf | info.flags;

    if (flags & 1) {
      gpuCount += 1;
      info.gpuCount += 1;
      if (hasDur) {
        const durationMs = dur / 1000;
        gpuDurations.push(durationMs);
        if (topGPU.length < 12 || durationMs > topGPU[11].durationMs) {
          insertTopEvent(topGPU, event, durationMs, 12);
        }
      }
    }
    if (flags & 2) {
      frameCount += 1;
      info.frameCount += 1;
    }
    if (event.ph === "v" || (flags & 4)) {
      memoryCount += 1;
      if (event.args) collectMemoryNumbers(event.args, "", onMemoryNumber);
    }
  }

  const frameTop = [];
  const gpuTop = [];
  for (const info of nameInfo.values()) {
    if (info.frameCount > 0) frameTop.push({ count: info.frameCount, name: info.name });
    if (info.gpuCount > 0) gpuTop.push({ count: info.gpuCount, name: info.name });
  }
  frameTop.sort((a, b) => b.count - a.count);
  if (frameTop.length > 12) frameTop.length = 12;
  gpuTop.sort((a, b) => b.count - a.count);
  if (gpuTop.length > 15) gpuTop.length = 15;

  return {
    durationMs: minTimestamp === Infinity || maxTimestamp === -Infinity ? null : (maxTimestamp - minTimestamp) / 1000,
    eventCount: events.length,
    frames: {
      eventCount: frameCount,
      topNames: frameTop
    },
    gpu: {
      completeDurationMs: numericStats(gpuDurations),
      eventCount: gpuCount,
      topCompleteEvents: topGPU,
      topNames: gpuTop
    },
    memory: {
      eventCount: memoryCount,
      topBytePaths: [...memoryPaths.values()].filter((item) => item.maxBytes > 0)
        .sort((a, b) => b.maxBytes - a.maxBytes).slice(0, 20)
    },
    topCompleteEvents: topComplete
  };
}

function insertTopEvent(top, event, durationMs, limit) {
  const entry = { cat: event.cat || null, durationMs, name: event.name || "(unnamed)" };
  const index = top.findIndex(item => item.durationMs < durationMs);
  top.splice(index < 0 ? top.length : index, 0, entry);
  if (top.length > limit) top.pop();
}

function collectMemoryNumbers(value, path, onNumber, seen = null, depth = 0, pathMatched = false) {
  if (!value || typeof value !== "object" || depth > 12) {
    return;
  }
  if (seen) {
    if (seen.has(value)) return;
    seen.add(value);
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const item = value[key];
    const nextPath = path ? `${path}.${key}` : key;
    const matched = pathMatched || MEMORY_PATH_RE.test(key);

    if (matched) {
      const number = parseTraceNumber(item);
      if (number != null) {
        onNumber(nextPath, number);
        continue;
      }
    }

    if (item && typeof item === "object") {
      if (item === value || (seen && seen.has(item))) continue;
      if (!seen) {
        seen = new WeakSet();
        seen.add(value);
      }
      collectMemoryNumbers(item, nextPath, onNumber, seen, depth + 1, matched);
    }
  }
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
