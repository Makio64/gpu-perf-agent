export async function collectInPage(options = {}) {
  const evaluationStartedAt = performance.now();
  const config = {
    adaptive: Boolean(options.adaptive),
    api: options.api || "auto",
    durationMs: Number(options.durationMs ?? 1000),
    gc: Boolean(options.gc),
    deepMemory: Boolean(options.deepMemory),
    hookName: options.hookName || "__gpuReportBench",
    samplingMode: options.samplingMode ?? "frames",
    samples: Number(options.samples ?? 5),
    slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
    warmup: Number(options.warmup ?? 1),
    readyTimeoutMs: Math.max(0, Number(options.readyTimeoutMs ?? 3000) || 0),
    waitNetworkIdle: Boolean(options.waitNetworkIdle),
    networkIdleBudgetMs: Math.max(0, Number(options.networkIdleBudgetMs ?? 10000) || 0),
    progress: Boolean(options.progress)
  };
  if (!["frames", "hook"].includes(config.samplingMode)) {
    throw new TypeError('samplingMode must be "frames" or "hook".');
  }
  if (config.samplingMode === "hook" && config.adaptive) {
    throw new TypeError('samplingMode "hook" does not support adaptive FPS sampling.');
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function round(value, digits = 2) {
    if (!finiteNumber(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Stages: ready, warmup, sample-start, sample-end, done (relayed by the runner's __gpuPerfProgress binding).
  function progress(stage, index, total) {
    if (!config.progress) return;
    try {
      globalThis.__gpuPerfProgress?.(JSON.stringify({ stage, index, total, t: performance.now() }));
    } catch {
      // Progress is advisory; a missing or failing binding never affects the capture.
    }
  }

  function hookExists() {
    return typeof globalThis[config.hookName] === "function";
  }

  function stats(values) {
    const numbers = values.filter(finiteNumber).sort((a, b) => a - b);
    if (numbers.length === 0) {
      return null;
    }
    const sum = numbers.reduce((total, value) => total + value, 0);
    const mean = sum / numbers.length;
    const variance = numbers.reduce((total, value) => total + ((value - mean) ** 2), 0) / numbers.length;
    const percentile = (ratio) => {
      if (numbers.length === 1) {
        return numbers[0];
      }
      const index = (numbers.length - 1) * ratio;
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      if (lower === upper) {
        return numbers[lower];
      }
      const weight = index - lower;
      return numbers[lower] * (1 - weight) + numbers[upper] * weight;
    };
    return {
      coefficientOfVariation: mean === 0 ? null : Math.sqrt(variance) / Math.abs(mean),
      count: numbers.length,
      min: numbers[0],
      max: numbers[numbers.length - 1],
      mean,
      p50: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      p99: percentile(0.99),
      p99_9: percentile(0.999),
      stddev: Math.sqrt(variance),
      variance
    };
  }

  function plainError(error) {
    return {
      message: error?.message || String(error),
      name: error?.name || "Error",
      stack: error?.stack || null
    };
  }

  function sanitize(value, depth = 0) {
    if (depth > 8) {
      return "[max-depth]";
    }
    if (value == null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Error) {
      return plainError(value);
    }
    if (ArrayBuffer.isView(value)) {
      return {
        byteLength: value.byteLength,
        length: value.length,
        type: value.constructor?.name || "TypedArray"
      };
    }
    if (value instanceof ArrayBuffer) {
      return {
        byteLength: value.byteLength,
        type: "ArrayBuffer"
      };
    }
    if (value instanceof Set) {
      return Array.from(value, (item) => sanitize(item, depth + 1));
    }
    if (value instanceof Map) {
      return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), sanitize(item, depth + 1)]));
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, depth + 1));
    }
    if (typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = sanitize(item, depth + 1);
      }
      return out;
    }
    return String(value);
  }

  async function detectWebGPU() {
    const support = {
      available: Boolean(globalThis.navigator?.gpu),
      adapter: null,
      error: null,
      features: [],
      limits: {}
    };

    if (!support.available) {
      return support;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        support.available = false;
        support.error = "navigator.gpu.requestAdapter returned null";
        return support;
      }

      support.features = Array.from(adapter.features || []);
      support.limits = capabilityAttributes(adapter.limits);
      if (adapter.info) {
        support.adapter = capabilityAttributes(adapter.info);
      } else if (typeof adapter.requestAdapterInfo === "function") {
        support.adapter = capabilityAttributes(await adapter.requestAdapterInfo());
      }
    } catch (error) {
      support.available = false;
      support.error = plainError(error);
    }

    return support;
  }

  // WebIDL attributes live on prototypes, so Object.entries loses adapter info/limits.
  function capabilityAttributes(value) {
    const out = {};
    const keys = new Set();
    for (let prototype = value, depth = 0; prototype && prototype !== Object.prototype && depth < 4; prototype = Object.getPrototypeOf(prototype), depth += 1) {
      for (const key of Object.getOwnPropertyNames(prototype)) keys.add(key);
    }
    for (const key of keys) {
      if (key === "constructor" || key === "__proto__") continue;
      try {
        const item = value[key];
        if (typeof item === "string" || typeof item === "boolean" || finiteNumber(item)) out[key] = item;
      } catch { /* Optional browser attributes can be unavailable. */ }
    }
    return out;
  }

  function detectWebGL(api = "webgl2") {
    const support = {
      available: false,
      contextAttributes: null,
      extensions: [],
      renderer: null,
      shadingLanguageVersion: null,
      unmaskedRenderer: null,
      unmaskedVendor: null,
      vendor: null,
      version: null,
      error: null
    };

    let gl;
    try {
      const canvas = document.createElement("canvas");
      // Auto-instrumentation skips probe canvases: no wrappers, counters or GL frame timer.
      canvas.__gpuPerfAgentProbe = true;
      gl = canvas.getContext(api, {
        antialias: false,
        depth: false,
        stencil: false
      });
      support.available = Boolean(gl);
      if (!gl) {
        return support;
      }

      support.contextAttributes = gl.getContextAttributes();
      support.extensions = gl.getSupportedExtensions() || [];
      support.vendor = gl.getParameter(gl.VENDOR);
      support.renderer = gl.getParameter(gl.RENDERER);
      support.version = gl.getParameter(gl.VERSION);
      support.shadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);

      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        support.unmaskedVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        support.unmaskedRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
    } catch (error) {
      support.available = false;
      support.error = plainError(error);
    } finally {
      // The probe owns this context; release it before sampling the application's GPU work.
      try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch {}
    }

    return support;
  }

  async function detectApis() {
    const skipped = () => ({ available: null, skipped: true, error: null });
    const [webgpu, webgl2] = await Promise.all([
      config.api === "auto" || config.api === "webgpu" ? detectWebGPU() : skipped(),
      config.api === "auto" || config.api === "webgl2" ? detectWebGL() : skipped()
    ]);
    return { webgpu, webgl2, ...(config.api === "webgl" ? { webgl: detectWebGL("webgl") } : {}) };
  }

  function trackerSnapshot(includeHistory = false) {
    const candidates = [
      globalThis.__gpuMemoryTracker,
      globalThis.__gpuReportMemoryTracker,
      globalThis.__webgpuMemoryTracker,
      globalThis.__webglMemoryTracker
    ];

    for (const candidate of candidates) {
      if (candidate && typeof candidate.snapshot === "function") {
        try {
          return sanitize(candidate.snapshot({ includeHistory, includeResources: includeHistory }));
        } catch (error) {
          return { error: plainError(error) };
        }
      }
    }

    return null;
  }

  function appSnapshot() {
    const e2e = globalThis.__e2e;
    if (e2e) {
      const snapshot = {
        e2e: {
          frames: finiteNumber(e2e.frames) ? e2e.frames : null,
          framesStable: finiteNumber(e2e.framesStable) ? e2e.framesStable : null,
          stats: null
        }
      };
      if (typeof e2e.stats === "function") {
        try {
          snapshot.e2e.stats = sanitize(e2e.stats());
        } catch (error) {
          snapshot.e2e.stats = { error: plainError(error) };
        }
      }
      return snapshot;
    }

    return null;
  }

  function instrumentationSnapshot(includeHistory = false) {
    const instrumentation = globalThis.__gpuReportInstrumentation;
    if (!instrumentation || typeof instrumentation.snapshot !== "function") {
      return null;
    }
    try {
      return sanitize(instrumentation.snapshot({ includeHistory, includeResources: includeHistory }));
    } catch (error) {
      return { error: plainError(error) };
    }
  }

  // Counters only (cheaper than a full snapshot): per-sample deltas and warmupStartCounters.
  function instrumentationCounters() {
    const instrumentation = globalThis.__gpuReportInstrumentation;
    try {
      if (typeof instrumentation?.counters === "function") return sanitize(instrumentation.counters());
      if (typeof instrumentation?.snapshot === "function") {
        return sanitize(instrumentation.snapshot({ includeHistory: false, includeResources: false })?.counters ?? null);
      }
    } catch {
      // A failing page-supplied instrumentation leaves the sample without counter deltas.
    }
    return null;
  }

  function deltaCounters(before, after) {
    const delta = {};
    const keys = new Set([
      ...Object.keys(before || {}),
      ...Object.keys(after || {})
    ]);
    for (const key of keys) {
      const beforeValue = before?.[key];
      const afterValue = after?.[key];
      if (finiteNumber(beforeValue) || finiteNumber(afterValue)) {
        delta[key] = Number(afterValue || 0) - Number(beforeValue || 0);
      }
    }
    return delta;
  }

  function deltaInstrumentation(before, after) {
    return deltaCounters(before?.counters, after?.counters);
  }

  async function memorySnapshot() {
    const snapshot = {
      atMs: performance.now(),
      performanceMemory: null,
      trackedGpuMemory: trackerSnapshot(),
      userAgentSpecificMemory: null
    };

    if (performance.memory) {
      snapshot.performanceMemory = {
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        usedJSHeapSize: performance.memory.usedJSHeapSize
      };
    }

    if (config.deepMemory && typeof performance.measureUserAgentSpecificMemory === "function") {
      try {
        snapshot.userAgentSpecificMemory = sanitize(await performance.measureUserAgentSpecificMemory());
      } catch (error) {
        snapshot.userAgentSpecificMemory = { error: plainError(error) };
      }
    }

    return snapshot;
  }

  function deltaMemory(before, after) {
    const delta = {};

    if (before?.performanceMemory && after?.performanceMemory) {
      delta.performanceMemory = {};
      for (const key of ["jsHeapSizeLimit", "totalJSHeapSize", "usedJSHeapSize"]) {
        if (finiteNumber(before.performanceMemory[key]) && finiteNumber(after.performanceMemory[key])) {
          delta.performanceMemory[key] = after.performanceMemory[key] - before.performanceMemory[key];
        }
      }
    }

    const beforeUserAgentBytes = before?.userAgentSpecificMemory?.bytes;
    const afterUserAgentBytes = after?.userAgentSpecificMemory?.bytes;
    if (finiteNumber(beforeUserAgentBytes) && finiteNumber(afterUserAgentBytes)) {
      delta.userAgentSpecificMemoryBytes = afterUserAgentBytes - beforeUserAgentBytes;
    }

    const beforeTrackedBytes = before?.trackedGpuMemory?.totalBytes;
    const afterTrackedBytes = after?.trackedGpuMemory?.totalBytes;
    if (finiteNumber(beforeTrackedBytes) && finiteNumber(afterTrackedBytes)) {
      delta.trackedGpuMemoryBytes = afterTrackedBytes - beforeTrackedBytes;
    }

    return delta;
  }

  function nextFrame() {
    return new Promise(resolve => {
      let frame;
      const timeout = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 250);
      frame = requestAnimationFrame(() => { clearTimeout(timeout); resolve(true); });
    });
  }

  async function settleFrames(count = 2) {
    for (let index = 0; index < count; index += 1) {
      if (!await nextFrame()) {
        warnings.push("Frame settling ended without an animation callback; the page may be hidden or stalled.");
        break;
      }
    }
  }

  function detectCadence(deltas) {
    if (!deltas || deltas.length < 5) return null;
    const validDeltas = deltas.filter(d => typeof d === "number" && d > 2 && d < 120);
    if (validDeltas.length < 5) return null;
    const sorted = validDeltas.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const targets = [
      { hz: 240, ms: 1000 / 240 },
      { hz: 165, ms: 1000 / 165 },
      { hz: 144, ms: 1000 / 144 },
      { hz: 120, ms: 1000 / 120 },
      { hz: 90, ms: 1000 / 90 },
      { hz: 75, ms: 1000 / 75 },
      { hz: 60, ms: 1000 / 60 },
      { hz: 30, ms: 1000 / 30 }
    ];

    for (const target of targets.sort((a, b) => Math.abs(median - a.ms) - Math.abs(median - b.ms))) {
      if (Math.abs(median - target.ms) < 1.8) {
        const hits = validDeltas.filter(d => Math.abs(d - target.ms) < 2.0).length;
        const hitRate = hits / validDeltas.length;
        return {
          hz: target.hz,
          intervalMs: Math.round(target.ms * 100) / 100,
          hitRate: Math.round(hitRate * 1000) / 1000
        };
      }
    }

    return {
      hz: Math.round(1000 / median),
      intervalMs: Math.round(median * 100) / 100,
      hitRate: null
    };
  }

  // One preallocated timestamp buffer (500 Hz worth of frames) shared by the sequential warmup and sample
  // observers, so frame observation does not allocate per frame. The deltas of the last observation are
  // kept in `lastFrameDeltas` for the pooled summary.
  let frameTimestamps = new Float64Array(Math.max(64, Math.ceil(config.durationMs / 2) + 8));
  let lastFrameDeltas = null;

  function sampleFrames(durationMs) {
    return new Promise(resolve => {
      let count = 0;
      const startedAt = performance.now();
      let animationFrame;
      let finished = false;
      // Background pages may stop rAF entirely. A wall-clock deadline keeps capture bounded.
      const timeout = setTimeout(finish, durationMs);

      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        cancelAnimationFrame(animationFrame);
        const deltas = new Array(Math.max(0, count - 1));
        for (let index = 1; index < count; index += 1) {
          const delta = frameTimestamps[index] - frameTimestamps[index - 1];
          deltas[index - 1] = delta;
          if (delta > config.slowFrameThresholdMs && slowFrames.length < 100) {
            slowFrames.push({ timestamp: frameTimestamps[index], frameDurationMs: delta });
          }
        }
        lastFrameDeltas = deltas;
        const elapsedMs = count > 1 ? frameTimestamps[count - 1] - frameTimestamps[0] : 0;
        resolve({
          durationMs: elapsedMs,
          observationWindowMs: performance.now() - startedAt,
          fps: elapsedMs > 0 ? (count - 1) / (elapsedMs / 1000) : null,
          frameCount: count,
          frameTimeMs: stats(deltas),
          cadence: detectCadence(deltas),
          maxJitter: deltas.length ? deltas.reduce((max, value) => Math.max(max, value), 0) - deltas.reduce((min, value) => Math.min(min, value), Infinity) : null,
          slowFrameCount: deltas.filter(value => value > config.slowFrameThresholdMs).length,
          type: "raf"
        });
      }

      function frame(timestamp) {
        if (finished) return;
        if (count === frameTimestamps.length) {
          const grown = new Float64Array(count * 2);
          grown.set(frameTimestamps);
          frameTimestamps = grown;
        }
        frameTimestamps[count] = timestamp;
        count += 1;
        if (performance.now() - startedAt >= durationMs) finish();
        else animationFrame = requestAnimationFrame(frame);
      }

      animationFrame = requestAnimationFrame(frame);
    });
  }

  // Readiness gate (before warmup): wait until the benchmark hook exists or the auto-instrumentation ledger saw
  // GPU work (a submit, GL draw or gl.clear), polling every 25 ms up to readyTimeoutMs. A module's top-level
  // await can install the hook or start rendering well after `load`.
  async function waitForReady() {
    const started = performance.now();
    const done = reason => ({ reason, waitedMs: round(performance.now() - started) });
    if (!(config.readyTimeoutMs > 0)) return done("disabled");
    if (hookExists()) return done("hook");
    const frames = frameLedger();
    const sawGpuWork = frames && typeof frames.sawGpuWork === "function" ? () => {
      try { return frames.sawGpuWork() === true; } catch { return false; }
    } : null;
    // Without the ledger only the hook can signal readiness, and only hook sampling requires it.
    if (!sawGpuWork && config.samplingMode !== "hook") return done("no-instrumentation");
    while (performance.now() - started < config.readyTimeoutMs) {
      if (hookExists()) return done("hook");
      if (sawGpuWork?.()) return done("gpu-work");
      await sleep(25);
    }
    if (hookExists()) return done("hook");
    return done(sawGpuWork?.() ? "gpu-work" : "timeout");
  }

  function networkIdleFlag() {
    const flag = globalThis.__gpuPerfNetworkIdle;
    return flag === true || flag === "budget-exceeded" ? flag : null;
  }

  // Retained JS heap: two collections, then the precise used-heap size. Outside every timed window.
  function retainedHeapRead() {
    if (typeof globalThis.gc !== "function") return { unavailable: "gc-unavailable" };
    try {
      globalThis.gc();
      globalThis.gc();
    } catch {
      return { unavailable: "gc-failed" };
    }
    const bytes = performance.memory?.usedJSHeapSize;
    return finiteNumber(bytes) ? { bytes, atMs: performance.now() } : { unavailable: "memory-unavailable" };
  }

  function retainedHeap(before, after) {
    if (!finiteNumber(before?.bytes) || !finiteNumber(after?.bytes)) {
      return { available: false, method: "unavailable", reason: before?.unavailable ?? after?.unavailable ?? "unavailable" };
    }
    return {
      available: true,
      method: "gc-bracket",
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
      deltaBytes: after.bytes - before.bytes,
      windowMs: round(after.atMs - before.atMs, 1)
    };
  }

  // Long Animation Frame entries in a 32-entry ring, started at sampling start (cap-6).
  function observeLongAnimationFrames() {
    const Observer = globalThis.PerformanceObserver;
    if (typeof Observer !== "function" || !Observer.supportedEntryTypes?.includes?.("long-animation-frame")) return null;
    const ring = [];
    let cursor = 0;
    const keep = (entries) => {
      for (const entry of entries || []) {
        if (ring.length < 32) ring.push(entry);
        else {
          ring[cursor] = entry;
          cursor = (cursor + 1) % 32;
        }
      }
    };
    try {
      const observer = new Observer(list => keep(list.getEntries()));
      observer.observe({ type: "long-animation-frame" });
      return {
        stop() {
          try {
            keep(observer.takeRecords());
            observer.disconnect();
          } catch {
            // Keep what was delivered.
          }
          return ring.slice(cursor).concat(ring.slice(0, cursor));
        }
      };
    } catch {
      return null;
    }
  }

  const TOOL_SOURCE_PREFIX = "gpu-perf-agent/";

  function loafSummary(entry) {
    const scripts = Array.from(entry.scripts || [])
      .filter(script => !String(script?.sourceURL || "").startsWith(TOOL_SOURCE_PREFIX))
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))
      .slice(0, 3)
      .map(script => ({
        fn: script.sourceFunctionName || script.invoker || "",
        url: script.sourceURL || null,
        charPosition: finiteNumber(script.sourceCharPosition) && script.sourceCharPosition >= 0 ? script.sourceCharPosition : null,
        durationMs: round(script.duration, 1)
      }));
    const end = entry.startTime + entry.duration;
    return {
      durationMs: round(entry.duration, 1),
      blockingMs: round(entry.blockingDuration ?? 0, 1),
      styleLayoutMs: finiteNumber(entry.styleAndLayoutStart) && entry.styleAndLayoutStart > 0
        ? round(Math.max(0, end - entry.styleAndLayoutStart), 1) : 0,
      scripts
    };
  }

  // Each slow frame gets the LoAF entry that overlaps its rAF interval the most (each entry used once).
  function attachLongAnimationFrames(frames, entries) {
    if (!entries?.length) return;
    const used = new Set();
    for (const frame of frames) {
      const from = frame.timestamp - frame.frameDurationMs;
      let best = -1;
      let bestOverlap = 0;
      for (let index = 0; index < entries.length; index += 1) {
        if (used.has(index)) continue;
        const entry = entries[index];
        const overlap = Math.min(frame.timestamp, entry.startTime + entry.duration) - Math.max(from, entry.startTime);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = index;
        }
      }
      if (best >= 0) {
        used.add(best);
        try {
          frame.loaf = loafSummary(entries[best]);
        } catch {
          // An unreadable entry leaves the frame without attribution.
        }
      }
    }
  }

  async function runHook(phase, sampleIndex) {
    const hook = globalThis[config.hookName];
    if (typeof hook !== "function") {
      if (config.samplingMode === "hook") throw new Error(`samplingMode hook requires benchmark hook ${config.hookName}.`);
      return null;
    }

    return sanitize(await hook({
      api: config.api,
      durationMs: config.durationMs,
      phase,
      sampleIndex,
      samples: config.samples,
      warmup: config.warmup
    }));
  }

  function frameMeasurementOf(sample) {
    return sample.measurement?.observedFrames || sample.measurement;
  }

  // Statistics exclude idle samples (no GPU work while other samples had work).
  function summarizeSamples(allSamples) {
    const samples = allSamples.filter(sample => sample.idle !== true);
    const elapsed = [];
    const fps = [];
    const frameTimeMeans = [];
    const frameTimeMaxes = [];
    const frameTimeP95s = [];
    const instrumentationCounters = {};
    const jsHeapDeltas = [];
    let observedFrameCount = 0;
    let slowFrameCount = 0;
    const trackedGpuTotals = [];
    const trackedGpuDeltas = [];
    const userAgentMemoryDeltas = [];
    const extra = {};
    const cadences = [];
    let passes = null;
    const record = (key, value) => { if (finiteNumber(value)) (extra[key] ||= []).push(value); };

    for (const sample of samples) {
      elapsed.push(sample.elapsedMs);
      const frameMeasurement = sample.measurement?.observedFrames || sample.measurement;
      if (finiteNumber(sample.measurement?.fps)) {
        fps.push(sample.measurement.fps);
      } else if (finiteNumber(frameMeasurement?.fps)) {
        fps.push(frameMeasurement.fps);
      }
      const frameTime = { ...frameMeasurement?.frameTimeMs, ...sample.measurement?.frameTimeMs };
      record("frameTimeMsP99", frameTime.p99);
      record("frameTimeMsP99_9", frameTime.p99_9);
      record("maxJitter", sample.measurement?.maxJitter ?? frameMeasurement?.maxJitter);
      const cadence = sample.measurement?.cadence ?? frameMeasurement?.cadence;
      if (cadence) cadences.push(cadence);
      for (const key of ["gpuTimeNs", "computeTimeNs", "renderTimeNs"]) record(key, sample.measurement?.[key]);
      if (sample.measurement?.passes) passes = sample.measurement.passes;
      for (const key of ["drawCalls", "dispatchCalls", "renderPasses", "computePasses", "setPipelineCalls", "setBindGroupCalls"]) {
        const supplied = sample.measurement?.webgpuOps?.[key];
        const count = sample.instrumentation?.delta?.[`webgpu.${key}`];
        record(key, supplied ?? (frameMeasurement?.frameCount > 0 && finiteNumber(count) ? count / frameMeasurement.frameCount : null));
      }
      if (finiteNumber(frameTime?.mean)) {
        frameTimeMeans.push(frameTime.mean);
      }
      if (finiteNumber(frameTime?.p95)) {
        frameTimeP95s.push(frameTime.p95);
      }
      if (finiteNumber(frameTime?.max)) {
        frameTimeMaxes.push(frameTime.max);
      }
      if (finiteNumber(frameMeasurement?.frameCount)) {
        observedFrameCount += frameMeasurement.frameCount;
      }
      if (finiteNumber(frameMeasurement?.slowFrameCount)) {
        slowFrameCount += frameMeasurement.slowFrameCount;
      }
      for (const [key, value] of Object.entries(sample.instrumentation?.delta || {})) {
        if (finiteNumber(value)) {
          instrumentationCounters[key] = (instrumentationCounters[key] || 0) + value;
        }
      }
      if (finiteNumber(sample.memory?.delta?.performanceMemory?.usedJSHeapSize)) {
        jsHeapDeltas.push(sample.memory.delta.performanceMemory.usedJSHeapSize);
      }
      const trackedTotal = sample.memory?.trackedGpuTotalBytes ?? sample.memory?.after?.trackedGpuMemory?.totalBytes;
      if (finiteNumber(trackedTotal)) {
        trackedGpuTotals.push(trackedTotal);
      }
      if (finiteNumber(sample.memory?.delta?.trackedGpuMemoryBytes)) {
        trackedGpuDeltas.push(sample.memory.delta.trackedGpuMemoryBytes);
      }
      if (finiteNumber(sample.memory?.delta?.userAgentSpecificMemoryBytes)) {
        userAgentMemoryDeltas.push(sample.memory.delta.userAgentSpecificMemoryBytes);
      }
    }

    const cadenceCounts = new Map();
    for (const cadence of cadences) cadenceCounts.set(cadence.hz, (cadenceCounts.get(cadence.hz) || 0) + 1);
    return {
      ...Object.fromEntries(Object.entries(extra).map(([key, values]) => [key, stats(values)])),
      cadence: cadences.sort((a, b) => cadenceCounts.get(b.hz) - cadenceCounts.get(a.hz))[0] || null,
      passes,
      elapsedMs: stats(elapsed),
      fps: stats(fps),
      frameTimeMsMax: stats(frameTimeMaxes),
      frameTimeMsMean: stats(frameTimeMeans),
      frameTimeMsP95: stats(frameTimeP95s),
      instrumentationCounters,
      jsHeapDeltaBytes: stats(jsHeapDeltas),
      observedFrameCount,
      sampleCount: allSamples.length,
      slowFrameCount,
      trackedGpuDeltaBytes: stats(trackedGpuDeltas),
      trackedGpuTotalBytes: stats(trackedGpuTotals),
      userAgentMemoryDeltaBytes: stats(userAgentMemoryDeltas)
    };
  }

  // Auto-instrumentation frame ledger (auto-instrument.js); absent without --auto-instrument.
  function frameLedger() {
    const frames = globalThis.__gpuPerfAutoInstrumentation?.frames;
    return frames && typeof frames.window === "function" ? frames : null;
  }

  async function flushFrameLedger() {
    try {
      await frameLedger()?.flush?.(1000);
    } catch {
      // Timer failures never fail a capture; unread frames stay counted as pending.
    }
  }

  // Attaches `activity` and `autoGpu` as siblings of `measurement`; auto GPU data never enters it.
  function attachFrameWindow(sample, window, retain = false) {
    const frames = frameLedger();
    if (!frames || !window) return;
    try {
      const result = frames.window(window[0], window[1], retain);
      if (result?.activity) sample.activity = sanitize(result.activity);
      if (result?.autoGpu) sample.autoGpu = sanitize(result.autoGpu);
    } catch {
      // Leave the sample without ledger data rather than failing the capture.
    }
  }

  // The ledger keeps the last `frames.capacity` frames per pass. Before the oldest unretained sample would leave
  // it during the next sample, flush and retain every finished sample (between samples, outside timed windows).
  // Short runs never get here and keep the single flush after the loop.
  let retainedSamples = 0;
  async function retainFrameWindowsIfNeeded(samples, windows) {
    const frames = frameLedger();
    if (!frames || typeof frames.framesSince !== "function" || !(frames.capacity > 0)) return;
    if (retainedSamples >= samples.length) return;
    try {
      const sinceOldest = frames.framesSince(windows[retainedSamples][0]);
      const lastSample = frames.framesSince(windows.at(-1)[0]);
      if (sinceOldest + 2 * lastSample + 64 < frames.capacity) return;
    } catch {
      return;
    }
    await flushFrameLedger();
    for (; retainedSamples < samples.length; retainedSamples += 1) {
      attachFrameWindow(samples[retainedSamples], windows[retainedSamples], true);
    }
  }

  function pooledAutoGpu(samples, windows) {
    const frames = frameLedger();
    if (!frames || typeof frames.windows !== "function") return null;
    const ranges = [];
    const perSampleP50Ns = [];
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample.idle || !sample.autoGpu || !windows[index]) continue;
      ranges.push(windows[index]);
      if (finiteNumber(sample.autoGpu.frameNs?.p50)) perSampleP50Ns.push(sample.autoGpu.frameNs.p50);
    }
    if (ranges.length === 0) return null;
    try {
      const pooled = frames.windows(ranges)?.autoGpu;
      if (!pooled) return null;
      const truncated = pooled.truncated === true ? { truncated: true } : {};
      return sanitize({
        status: pooled.status,
        source: pooled.source,
        frames: pooled.frames,
        workFrames: pooled.workFrames,
        noWorkFrames: pooled.noWorkFrames,
        timedFrames: pooled.timedFrames,
        partialFrames: pooled.partialFrames,
        frameNs: pooled.frameNs,
        perSampleP50Ns,
        overlapRatio: pooled.overlapRatio,
        idleGapRatio: pooled.idleGapRatio,
        passes: pooled.passes,
        ...truncated
      });
    } catch {
      return null;
    }
  }

  // GPU work in a sample: the counter deltas over exactly the sample's window, else the ledger activity
  // (frames that started and ended inside it). null when unknown.
  const WORK_COUNTERS = ["webgpu.queueSubmits", "webgpu.drawCalls", "webgpu.dispatchCalls", "webgpu.bundleDrawsExecuted",
    "webgl2.drawCalls", "webgl.drawCalls", "webgl2.clearCalls", "webgl.clearCalls"];
  function sampleWork(sample) {
    const delta = sample.instrumentation?.delta;
    let known = false;
    let total = 0;
    for (const key of WORK_COUNTERS) {
      if (finiteNumber(delta?.[key])) {
        known = true;
        total += delta[key];
      }
    }
    if (known) return total;
    const activity = sample.activity;
    return finiteNumber(activity?.submits) ? activity.submits + (activity.glDraws || 0) + (activity.glClears || 0) : null;
  }

  // A sample is idle when it had no submit, draw or clear while another sample had GPU work.
  function markIdleSamples(samples) {
    const work = samples.map(sampleWork);
    const anyWork = work.some(value => value > 0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index].idle = anyWork && work[index] === 0 && !samples[index].error;
    }
  }

  // Per-sample GPU value for adaptive stopping: the auto union p50, else the hook's gpuTimeNs.
  function sampleGpuNs(sample) {
    if (sample.autoGpu?.timedFrames > 0 && finiteNumber(sample.autoGpu.frameNs?.p50)) return sample.autoGpu.frameNs.p50;
    const hook = sample.measurement?.gpuTimeNs;
    return finiteNumber(hook) ? hook : finiteNumber(hook?.p50) ? hook.p50 : null;
  }

  // Adaptive stop rule (latency-4): GPU p50 CV < 3% (or SD < 50 µs) when GPU data exists, AND p95 frame-time
  // spread < 1 ms, AND no new slow frames. FPS CV < 1.5% only for uncapped pages; otherwise frames alone.
  function adaptiveConvergence(samples) {
    const active = samples.filter(sample => !sample.idle && !sample.error);
    if (active.length < 3) return null;
    const last = active.at(-1);
    const lastFrames = frameMeasurementOf(last);
    const noNewSlowFrames = (lastFrames?.slowFrameCount ?? 0) === 0;
    const p95s = active.map(sample => frameMeasurementOf(sample)?.frameTimeMs?.p95);
    const framesStable = p95s.every(finiteNumber) && Math.max(...p95s) - Math.min(...p95s) < 1 && noNewSlowFrames;
    const gpu = active.map(sampleGpuNs);
    if (gpu.every(finiteNumber)) {
      const spread = stats(gpu);
      const stable = spread.mean > 0 && (spread.coefficientOfVariation < 0.03 || spread.stddev < 50000);
      return { converged: stable && framesStable, reason: "gpu-converged", coefficientOfVariation: spread.coefficientOfVariation };
    }
    const cadence = lastFrames?.cadence;
    const capped = finiteNumber(cadence?.hitRate) && cadence.hitRate >= 0.9;
    if (!capped) {
      const fps = stats(active.map(sample => sample.measurement?.fps ?? frameMeasurementOf(sample)?.fps));
      const stable = fps?.count === active.length && fps.mean > 0 && fps.coefficientOfVariation < 0.015 && noNewSlowFrames;
      return { converged: Boolean(stable), reason: "fps-converged", coefficientOfVariation: fps?.coefficientOfVariation ?? null };
    }
    return { converged: framesStable, reason: "frames-converged", coefficientOfVariation: null };
  }

  // Sampling-window GPU work per observed frame (non-idle samples), plus how many samples created resources.
  function perFrameRates(active) {
    const totals = {};
    let frames = 0;
    for (const sample of active) {
      const delta = sample.instrumentation?.delta;
      const count = frameMeasurementOf(sample)?.frameCount ?? sample.activity?.ticks;
      if (!delta || !(count > 0)) continue;
      frames += count;
      for (const [key, value] of Object.entries(delta)) {
        if (finiteNumber(value)) totals[key] = (totals[key] || 0) + value;
      }
    }
    if (!(frames > 0)) return null;
    const rate = (...keys) => round(keys.reduce((total, key) => total + (totals[key] || 0), 0) / frames, 4);
    const nonZero = (...keys) => active.filter(sample => keys.some(key => sample.instrumentation?.delta?.[key] > 0)).length;
    return {
      createBindGroup: rate("webgpu.createBindGroup"),
      createBuffer: rate("webgpu.createBuffer", "webgl2.createBuffer", "webgl.createBuffer"),
      createTexture: rate("webgpu.createTexture", "webgl2.createTexture", "webgl.createTexture"),
      createView: rate("webgpu.createView"),
      createSampler: rate("webgpu.createSampler"),
      createShaderModule: rate("webgpu.createShaderModule"),
      createPipelinesSync: rate("webgpu.createRenderPipeline", "webgpu.createComputePipeline"),
      createPipelinesAsync: rate("webgpu.createRenderPipelineAsync", "webgpu.createComputePipelineAsync"),
      writeBufferBytes: rate("webgpu.writeBufferBytes"),
      writeTextureBytes: rate("webgpu.writeTextureBytes"),
      drawCalls: rate("webgpu.drawCalls"),
      bundleDraws: rate("webgpu.bundleDrawsExecuted"),
      dispatches: rate("webgpu.dispatchCalls"),
      renderPasses: rate("webgpu.renderPasses"),
      computePasses: rate("webgpu.computePasses"),
      glDrawCalls: rate("webgl2.drawCalls", "webgl.drawCalls"),
      glClears: rate("webgl2.clearCalls", "webgl.clearCalls"),
      nonZeroSamples: {
        createBindGroup: nonZero("webgpu.createBindGroup"),
        createBuffer: nonZero("webgpu.createBuffer", "webgl2.createBuffer", "webgl.createBuffer"),
        createTexture: nonZero("webgpu.createTexture", "webgl2.createTexture", "webgl.createTexture")
      }
    };
  }

  function activitySummary(samples) {
    const active = samples.filter(sample => sample.idle !== true && sample.activity);
    if (!active.length) return null;
    let ticks = 0;
    let activeTicks = 0;
    for (const sample of active) {
      ticks += sample.activity.ticks || 0;
      activeTicks += sample.activity.activeTicks || 0;
    }
    return {
      pageFps: stats(active.map(sample => sample.activity.pageFps)),
      activeFrameRatio: ticks > 0 ? round(activeTicks / ticks, 3) : null,
      idleSampleIndices: samples.filter(sample => sample.idle === true).map(sample => sample.index)
    };
  }

  // Every observed rAF delta of the non-idle samples, in sample order, ≤4096, rounded to 0.01 ms.
  function pooledFrameDeltas(samples, deltasBySample) {
    const out = [];
    for (let index = 0; index < samples.length && out.length < 4096; index += 1) {
      if (samples[index].idle === true) continue;
      for (const delta of deltasBySample[index] || []) {
        if (out.length >= 4096) break;
        if (finiteNumber(delta)) out.push(round(delta, 2));
      }
    }
    return out;
  }

  // Error, context and off-main-thread evidence from the auto-instrumentation's final snapshot.
  function evidenceSummary(after, warmupStartCounters) {
    const counters = after?.counters || {};
    const count = key => finiteNumber(counters[key]) ? counters[key] : 0;
    const errors = after?.gpuErrors || {};
    const total = finiteNumber(errors.total) ? errors.total : count("webgpu.uncapturedErrors");
    return {
      churnSites: after?.churnSites || {},
      gpuErrors: {
        total,
        inWindow: Math.max(0, total - (finiteNumber(warmupStartCounters?.["webgpu.uncapturedErrors"]) ? warmupStartCounters["webgpu.uncapturedErrors"] : 0)),
        top: Array.isArray(errors.top) ? errors.top.slice(0, 3) : [],
        deviceLost: Array.isArray(errors.deviceLost) ? errors.deviceLost : [],
        contextLost: finiteNumber(errors.contextLost) ? errors.contextLost : count("webgl.contextLost"),
        shaderFailures: Array.isArray(errors.shaderFailures) ? errors.shaderFailures.slice(0, 3) : []
      },
      offMainThread: { workers: count("page.workers"), offscreenTransfers: count("page.offscreenTransfers") },
      appGpuContexts: {
        webgpuDevices: count("webgpu.devices"),
        webgpuCanvasContexts: count("webgpu.canvasContexts"),
        webgl2: count("webgl2.contexts"),
        webgl: count("webgl.contexts")
      }
    };
  }

  const slowFrames = [];
  const sampling = { mode: config.samplingMode, adaptive: config.adaptive, stoppedEarly: false, requestedSamples: config.samples, coefficientOfVariation: null };
  const warnings = [];

  const apiSupport = await detectApis();

  // Readiness gate, then re-evaluate the hook: a module may install it after a top-level await.
  const hookAtStart = hookExists();
  const ready = await waitForReady();
  const hookFound = hookExists();
  if (config.samplingMode === "hook" && !hookFound) {
    throw new Error(`samplingMode hook requires benchmark hook ${config.hookName}.`);
  }
  if (!hookFound) {
    warnings.push(`No ${config.hookName} hook found; report uses requestAnimationFrame sampling only.`);
  }
  if (config.samplingMode === "frames") await settleFrames(2);
  progress("ready");

  const warmupStartCounters = instrumentationCounters();
  const warmupStartedAt = performance.now();
  let lagSpikeMs = config.samplingMode === "hook" ? null : 0;
  const noteWarmup = (measurement) => {
    if (finiteNumber(measurement?.frameTimeMs?.max)) lagSpikeMs = Math.max(lagSpikeMs ?? 0, measurement.frameTimeMs.max);
  };
  // The runner sets __gpuPerfNetworkIdle when the network went idle (or its budget ran out).
  let networkIdle = config.waitNetworkIdle ? (networkIdleFlag() === true ? "idle" : networkIdleFlag()) : "not-requested";
  let warmupIndex = 0;
  for (; warmupIndex < config.warmup; warmupIndex += 1) {
    progress("warmup", warmupIndex, config.warmup);
    noteWarmup(hookFound ? await runHook("warmup", warmupIndex) : await sampleFrames(Math.min(250, config.durationMs)));
  }
  let extendedForNetworkMs = 0;
  if (config.waitNetworkIdle) {
    // Keep warming up until the runner reports network idle; the page's only bound is a hard cap.
    const extendedAt = performance.now();
    const capAt = evaluationStartedAt + config.networkIdleBudgetMs + 1000;
    while (!networkIdleFlag() && performance.now() < capAt) {
      noteWarmup(hookFound ? await runHook("warmup", warmupIndex) : await sampleFrames(Math.min(50, config.durationMs)));
      warmupIndex += 1;
    }
    extendedForNetworkMs = round(performance.now() - extendedAt);
    networkIdle ??= networkIdleFlag() === "budget-exceeded" ? "budget-exceeded" : networkIdleFlag() ? "overlapped" : "page-cap";
  }
  const warmup = {
    durationMs: performance.now() - warmupStartedAt,
    lagSpikeMs,
    settled: config.samplingMode === "frames" ? !warnings.some(w => w.startsWith("Frame settling")) : null,
    networkIdle,
    extendedForNetworkMs
  };
  slowFrames.length = 0;

  // Steady state: churn call-site sampling starts. Instrumentation and tracker snapshots stay outside the
  // retained-heap bracket, which is closed by gc() twice on both ends.
  try {
    globalThis.__gpuPerfAutoInstrumentation?.beginSteadyState?.();
  } catch {
    // Churn sites are optional evidence.
  }
  const globalInstrumentationBefore = instrumentationSnapshot();
  const globalBefore = await memorySnapshot();
  const longFrames = observeLongAnimationFrames();
  const heapBefore = retainedHeapRead();
  const samples = [];
  const sampleWindows = [];
  const sampleDeltas = [];

  for (let index = 0; index < config.samples; index += 1) {
    if (config.gc && typeof globalThis.gc === "function") {
      globalThis.gc();
      if (config.samplingMode === "frames") await settleFrames(1);
    }

    const before = await memorySnapshot();
    const countersBefore = instrumentationCounters();
    lastFrameDeltas = null;
    progress("sample-start", index, config.samples);
    const startedAtMs = performance.now();
    let measurement;
    let error = null;

    try {
      if (config.samplingMode === "hook") {
        const hookMeasurement = await runHook("sample", index);
        measurement = hookMeasurement && typeof hookMeasurement === "object" && !Array.isArray(hookMeasurement)
          ? hookMeasurement : { value: hookMeasurement };
      } else if (hookFound) {
        const [hookResult, frameResult] = await Promise.allSettled([
          runHook("sample", index),
          sampleFrames(config.durationMs)
        ]);
        if (hookResult.status === "rejected") throw hookResult.reason;
        if (frameResult.status === "rejected") throw frameResult.reason;
        const hookMeasurement = hookResult.value;
        const observedFrames = frameResult.value;
        if (hookMeasurement && typeof hookMeasurement === "object" && !Array.isArray(hookMeasurement)) {
          measurement = {
            ...hookMeasurement,
            observedFrames
          };
        } else {
          measurement = {
            observedFrames,
            value: hookMeasurement
          };
        }
      } else {
        measurement = await sampleFrames(config.durationMs);
      }
      const app = appSnapshot();
      if (app) {
        if (measurement && typeof measurement === "object" && !Array.isArray(measurement)) {
          measurement.app = app;
        } else {
          measurement = {
            app,
            value: measurement
          };
        }
      }
    } catch (caught) {
      error = plainError(caught);
      measurement = null;
    }

    const endedAtMs = performance.now();
    progress("sample-end", index, config.samples);
    const after = await memorySnapshot();
    const countersAfter = instrumentationCounters();

    // Per sample only deltas; the full before/after snapshots are kept once, globally.
    samples.push({
      index,
      startedAtMs,
      elapsedMs: endedAtMs - startedAtMs,
      error,
      idle: false,
      measurement,
      instrumentation: {
        delta: deltaCounters(countersBefore, countersAfter)
      },
      memory: {
        delta: deltaMemory(before, after),
        trackedGpuTotalBytes: finiteNumber(after?.trackedGpuMemory?.totalBytes) ? after.trackedGpuMemory.totalBytes : null
      }
    });
    sampleWindows.push([startedAtMs, endedAtMs]);
    sampleDeltas.push(lastFrameDeltas);
    if (config.adaptive && !error) {
      // Adaptive stopping needs this sample's GPU data now; fixed runs flush once after the loop.
      await flushFrameLedger();
      attachFrameWindow(samples.at(-1), sampleWindows.at(-1));
    }
    if (!error) await retainFrameWindowsIfNeeded(samples, sampleWindows);

    if (error) {
      break;
    }
    if (config.adaptive && samples.length >= 3 && samples.length < config.samples) {
      markIdleSamples(samples);
      const convergence = adaptiveConvergence(samples);
      sampling.coefficientOfVariation = convergence?.coefficientOfVariation ?? null;
      if (convergence?.converged) {
        sampling.stoppedEarly = true;
        sampling.reason = convergence.reason;
        break;
      }
    }
  }

  const heapAfter = retainedHeapRead();
  const longFrameEntries = longFrames?.stop() ?? null;
  const globalAfter = await memorySnapshot();
  const globalInstrumentationAfter = instrumentationSnapshot(true);

  // Outside every timed window and after the heap bracket: one flush, then one ledger window per sample.
  if (frameLedger()) {
    await flushFrameLedger();
    for (let index = 0; index < samples.length; index += 1) {
      if (index >= retainedSamples && !samples[index].activity && !samples[index].autoGpu) attachFrameWindow(samples[index], sampleWindows[index]);
    }
  }
  markIdleSamples(samples);
  const summary = summarizeSamples(samples);
  const autoGpu = pooledAutoGpu(samples, sampleWindows);
  if (autoGpu) summary.autoGpu = autoGpu;
  const activity = activitySummary(samples);
  if (activity) summary.activity = activity;
  const frameDeltasMs = pooledFrameDeltas(samples, sampleDeltas);
  if (frameDeltasMs.length) summary.frameDeltasMs = frameDeltasMs;
  const perFrame = perFrameRates(samples.filter(sample => sample.idle !== true));
  if (perFrame) summary.perFrame = perFrame;
  if (globalInstrumentationAfter?.gpuErrors) Object.assign(summary, evidenceSummary(globalInstrumentationAfter, warmupStartCounters));
  attachLongAnimationFrames(slowFrames, longFrameEntries);

  const memory = {
    after: globalAfter,
    before: globalBefore,
    delta: deltaMemory(globalBefore, globalAfter),
    retained: retainedHeap(heapBefore, heapAfter)
  };
  progress("done");

  return {
    apiSupport,
    config,
    hook: {
      found: hookFound,
      // True when the hook appeared only while the readiness gate waited.
      foundAfterReady: hookFound && !hookAtStart,
      name: config.hookName
    },
    ready,
    location: globalThis.location?.href || null,
    instrumentation: {
      warmupStartCounters,
      after: globalInstrumentationAfter,
      before: globalInstrumentationBefore,
      delta: deltaInstrumentation(globalInstrumentationBefore, globalInstrumentationAfter),
      // Tool failures that make the capture unusable; timer failures never land here.
      errors: Array.isArray(globalInstrumentationAfter?.errors) ? globalInstrumentationAfter.errors : []
    },
    memory,
    samples,
    sampling,
    slowFrames,
    warmup,
    summary,
    userAgent: navigator.userAgent,
    warnings
  };
}

/** Runtime.evaluate expression; the sourceURL lets stack parsing and LoAF attribution skip the tool's frames. */
export function collectInPageExpression(options = {}) {
  return `(${collectInPage.toString()})(${JSON.stringify(options ?? {})})\n//# sourceURL=gpu-perf-agent/collect.js`;
}
