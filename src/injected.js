export async function collectInPage(options = {}) {
  const config = {
    adaptive: Boolean(options.adaptive),
    api: options.api || "auto",
    durationMs: Number(options.durationMs ?? 1000),
    gc: Boolean(options.gc),
    deepMemory: Boolean(options.deepMemory),
    hookName: options.hookName || "__gpuReportBench",
    samples: Number(options.samples ?? 5),
    slowFrameThresholdMs: Number(options.slowFrameThresholdMs ?? 20),
    warmup: Number(options.warmup ?? 1)
  };

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
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

  function deltaInstrumentation(before, after) {
    const delta = {};
    const keys = new Set([
      ...Object.keys(before?.counters || {}),
      ...Object.keys(after?.counters || {})
    ]);
    for (const key of keys) {
      const beforeValue = before?.counters?.[key];
      const afterValue = after?.counters?.[key];
      if (finiteNumber(beforeValue) || finiteNumber(afterValue)) {
        delta[key] = Number(afterValue || 0) - Number(beforeValue || 0);
      }
    }
    return delta;
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

  function sampleFrames(durationMs) {
    return new Promise(resolve => {
      const timestamps = [];
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
        const deltas = [];
        for (let index = 1; index < timestamps.length; index += 1) {
          const delta = timestamps[index] - timestamps[index - 1];
          deltas.push(delta);
          if (delta > config.slowFrameThresholdMs && slowFrames.length < 100) {
            slowFrames.push({ timestamp: timestamps[index], frameDurationMs: delta });
          }
        }
        const elapsedMs = timestamps.length > 1 ? timestamps.at(-1) - timestamps[0] : 0;
        resolve({
          durationMs: elapsedMs,
          observationWindowMs: performance.now() - startedAt,
          fps: elapsedMs > 0 ? (timestamps.length - 1) / (elapsedMs / 1000) : null,
          frameCount: timestamps.length,
          frameTimeMs: stats(deltas),
          cadence: detectCadence(deltas),
          maxJitter: deltas.length ? deltas.reduce((max, value) => Math.max(max, value), 0) - deltas.reduce((min, value) => Math.min(min, value), Infinity) : null,
          slowFrameCount: deltas.filter(value => value > config.slowFrameThresholdMs).length,
          type: "raf"
        });
      }

      function frame(timestamp) {
        if (finished) return;
        timestamps.push(timestamp);
        if (performance.now() - startedAt >= durationMs) finish();
        else animationFrame = requestAnimationFrame(frame);
      }

      animationFrame = requestAnimationFrame(frame);
    });
  }

  async function runHook(phase, sampleIndex) {
    const hook = globalThis[config.hookName];
    if (typeof hook !== "function") {
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

  function summarizeSamples(samples) {
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
      if (finiteNumber(sample.memory?.after?.trackedGpuMemory?.totalBytes)) {
        trackedGpuTotals.push(sample.memory.after.trackedGpuMemory.totalBytes);
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
      sampleCount: samples.length,
      slowFrameCount,
      trackedGpuDeltaBytes: stats(trackedGpuDeltas),
      trackedGpuTotalBytes: stats(trackedGpuTotals),
      userAgentMemoryDeltaBytes: stats(userAgentMemoryDeltas)
    };
  }

  const hookFound = typeof globalThis[config.hookName] === "function";
  const slowFrames = [];
  const sampling = { adaptive: config.adaptive, stoppedEarly: false, requestedSamples: config.samples, coefficientOfVariation: null };
  const warnings = [];
  if (!hookFound) {
    warnings.push(`No ${config.hookName} hook found; report uses requestAnimationFrame sampling only.`);
  }

  const apiSupport = await detectApis();
  await settleFrames(2);

  const warmupStartedAt = performance.now();
  let lagSpikeMs = 0;
  for (let index = 0; index < config.warmup; index += 1) {
    const measurement = hookFound ? await runHook("warmup", index) : await sampleFrames(Math.min(250, config.durationMs));
    if (finiteNumber(measurement?.frameTimeMs?.max)) lagSpikeMs = Math.max(lagSpikeMs, measurement.frameTimeMs.max);
  }
  const warmup = { durationMs: performance.now() - warmupStartedAt, lagSpikeMs, settled: !warnings.some(w => w.startsWith("Frame settling")) };
  slowFrames.length = 0;

  const globalBefore = await memorySnapshot();
  const globalInstrumentationBefore = instrumentationSnapshot();
  const samples = [];

  for (let index = 0; index < config.samples; index += 1) {
    if (config.gc && typeof globalThis.gc === "function") {
      globalThis.gc();
      await settleFrames(1);
    }

    const before = await memorySnapshot();
    const instrumentationBefore = instrumentationSnapshot();
    const startedAtMs = performance.now();
    let measurement;
    let error = null;

    try {
      if (hookFound) {
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
    const after = await memorySnapshot();
    const instrumentationAfter = instrumentationSnapshot();

    samples.push({
      elapsedMs: endedAtMs - startedAtMs,
      error,
      index,
      instrumentation: {
        after: instrumentationAfter,
        before: instrumentationBefore,
        delta: deltaInstrumentation(instrumentationBefore, instrumentationAfter)
      },
      measurement,
      memory: {
        after,
        before,
        delta: deltaMemory(before, after)
      },
      startedAtMs
    });

    if (error) {
      break;
    }
    if (config.adaptive && samples.length >= 3 && samples.length < config.samples) {
      const fps = samples.map(sample => sample.measurement?.fps ?? sample.measurement?.observedFrames?.fps);
      const convergence = stats(fps);
      sampling.coefficientOfVariation = convergence?.coefficientOfVariation ?? null;
      if (convergence?.count === samples.length && convergence.mean > 0 && convergence.coefficientOfVariation < 0.015) {
        sampling.stoppedEarly = true;
        sampling.reason = "fps-converged";
        break;
      }
    }
  }

  const globalAfter = await memorySnapshot();
  const globalInstrumentationAfter = instrumentationSnapshot(true);

  return {
    apiSupport,
    config,
    hook: {
      found: hookFound,
      name: config.hookName
    },
    location: globalThis.location?.href || null,
    instrumentation: {
      after: globalInstrumentationAfter,
      before: globalInstrumentationBefore,
      delta: deltaInstrumentation(globalInstrumentationBefore, globalInstrumentationAfter)
    },
    memory: {
      after: globalAfter,
      before: globalBefore,
      delta: deltaMemory(globalBefore, globalAfter)
    },
    samples,
    sampling,
    slowFrames,
    warmup,
    summary: summarizeSamples(samples),
    userAgent: navigator.userAgent,
    warnings
  };
}
