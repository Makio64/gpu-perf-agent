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

export function summarizeTrace(trace) {
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const completeEvents = events.filter((event) => event.ph === "X" && typeof event.dur === "number");
  const gpuEvents = events.filter((event) => /(^|,|\.)gpu|webgpu|dawn|webgl|gl_/i.test(`${event.cat || ""} ${event.name || ""}`));
  const frameEvents = events.filter((event) => /DrawFrame|BeginFrame|FramePresented|CompositeLayers/i.test(event.name || ""));
  const memoryEvents = events.filter((event) => {
    const text = `${event.cat || ""} ${event.name || ""}`;
    return event.ph === "v" || /memory|dump/i.test(text);
  });

  return {
    durationMs: traceDurationMs(events),
    eventCount: events.length,
    frames: {
      eventCount: frameEvents.length,
      topNames: topNames(frameEvents, 12)
    },
    gpu: {
      completeDurationMs: numericStats(gpuEvents.filter((event) => typeof event.dur === "number").map((event) => event.dur / 1000)),
      eventCount: gpuEvents.length,
      topCompleteEvents: topCompleteEvents(gpuEvents, 12),
      topNames: topNames(gpuEvents, 15)
    },
    memory: summarizeMemoryEvents(memoryEvents),
    topCompleteEvents: topCompleteEvents(completeEvents, 15)
  };
}

function traceDurationMs(events) {
  let min = Infinity;
  let max = -Infinity;
  for (const event of events) {
    if (typeof event.ts !== "number") {
      continue;
    }
    if (event.ts < min) {
      min = event.ts;
    }
    if (event.ts > max) {
      max = event.ts;
    }
  }
  if (min === Infinity || max === -Infinity) {
    return null;
  }
  return (max - min) / 1000;
}

function topNames(events, limit) {
  const counts = new Map();
  for (const event of events) {
    const key = event.name || "(unnamed)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts, ([name, count]) => ({ count, name }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function topCompleteEvents(events, limit) {
  const top = [];
  for (const event of events) {
    if (!Number.isFinite(event.dur)) continue;
    const durationMs = event.dur / 1000;
    if (top.length === limit && durationMs <= top[top.length - 1].durationMs) continue;
    const entry = { cat: event.cat || null, durationMs, name: event.name || "(unnamed)" };
    const index = top.findIndex(item => item.durationMs < durationMs);
    top.splice(index < 0 ? top.length : index, 0, entry);
    if (top.length > limit) top.pop();
  }
  return top;
}

function summarizeMemoryEvents(memoryEvents) {
  const pathMax = new Map();
  const pathSamples = new Map();

  for (const event of memoryEvents) {
    collectMemoryNumbers(event.args, "", (path, value) => {
      const normalizedPath = path.replace(/^dumps\./, "");
      pathMax.set(normalizedPath, Math.max(pathMax.get(normalizedPath) || 0, value));
      pathSamples.set(normalizedPath, (pathSamples.get(normalizedPath) || 0) + 1);
    });
  }

  const topPaths = Array.from(pathMax, ([path, maxBytes]) => ({
    maxBytes,
    path,
    samples: pathSamples.get(path) || 0
  }))
    .filter((item) => item.maxBytes > 0)
    .sort((a, b) => b.maxBytes - a.maxBytes)
    .slice(0, 20);

  return {
    eventCount: memoryEvents.length,
    topBytePaths: topPaths
  };
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
