export async function collectInPage(options = {}) {
  const config = {
    api: options.api || "auto",
    durationMs: Number(options.durationMs ?? 1000),
    gc: Boolean(options.gc),
    hookName: options.hookName || "__gpuReportBench",
    samples: Number(options.samples ?? 5),
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
      count: numbers.length,
      min: numbers[0],
      max: numbers[numbers.length - 1],
      mean: sum / numbers.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      p99_9: percentile(0.999)
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
      support.limits = sanitize(adapter.limits || {});
      if (adapter.info) {
        support.adapter = sanitize(adapter.info);
      } else if (typeof adapter.requestAdapterInfo === "function") {
        support.adapter = sanitize(await adapter.requestAdapterInfo());
      }
    } catch (error) {
      support.error = plainError(error);
    }

    return support;
  }

  function detectWebGL2() {
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

    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", {
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
      support.error = plainError(error);
    }

    return support;
  }

  async function detectApis() {
    const [webgpu, webgl2] = await Promise.all([detectWebGPU(), Promise.resolve(detectWebGL2())]);
    return { webgpu, webgl2 };
  }

  function trackerSnapshot() {
    const candidates = [
      globalThis.__gpuMemoryTracker,
      globalThis.__gpuReportMemoryTracker,
      globalThis.__webgpuMemoryTracker,
      globalThis.__webglMemoryTracker
    ];

    for (const candidate of candidates) {
      if (candidate && typeof candidate.snapshot === "function") {
        try {
          return sanitize(candidate.snapshot());
        } catch (error) {
          return { error: plainError(error) };
        }
      }
    }

    return null;
  }

  function appSnapshot() {
    const e2e = globalThis.__e2e;
    const isGated = !!document.querySelector('.webgpu-gate');
    const isCrashed = !!document.querySelector('.webgpu-error:not(.webgpu-gate)');
    const errorText = isCrashed ? document.querySelector('.webgpu-error:not(.webgpu-gate)').textContent?.trim() : null;

    const snapshot = {
      isGated,
      isCrashed,
      errorText,
      e2e: null
    };

    if (e2e) {
      snapshot.e2e = {
        frames: finiteNumber(e2e.frames) ? e2e.frames : null,
        framesStable: finiteNumber(e2e.framesStable) ? e2e.framesStable : null,
        stats: null
      };
      if (typeof e2e.stats === "function") {
        try {
          snapshot.e2e.stats = sanitize(e2e.stats());
        } catch (error) {
          snapshot.e2e.stats = { error: plainError(error) };
        }
      }
    }
    return snapshot;
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

    if (typeof performance.measureUserAgentSpecificMemory === "function") {
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

    const beforeTracked = before?.trackedGpuMemory;
    const afterTracked = after?.trackedGpuMemory;
    if (beforeTracked && afterTracked) {
      delta.createdCount = (afterTracked.createdCount || 0) - (beforeTracked.createdCount || 0);
      delta.releasedCount = (afterTracked.releasedCount || 0) - (beforeTracked.releasedCount || 0);
      delta.leakCount = (afterTracked.totalResources || 0) - (beforeTracked.totalResources || 0);
    }

    return delta;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  async function settleFrames(count = 2) {
    for (let index = 0; index < count; index += 1) {
      await nextFrame();
    }
  }

  function sampleFrames(durationMs) {
    return new Promise((resolve) => {
      const timestamps = [];
      let start = null;

      function frame(timestamp) {
        if (start == null) {
          start = timestamp;
        }
        timestamps.push(timestamp);
        if (timestamp - start < durationMs) {
          requestAnimationFrame(frame);
          return;
        }

        const deltas = [];
        for (let index = 1; index < timestamps.length; index += 1) {
          deltas.push(timestamps[index] - timestamps[index - 1]);
        }

        let maxJitter = 0;
        for (let index = 1; index < deltas.length; index += 1) {
          const jitter = Math.abs(deltas[index] - deltas[index - 1]);
          if (jitter > maxJitter) {
            maxJitter = jitter;
          }
        }

        const elapsedMs = timestamps[timestamps.length - 1] - timestamps[0];
        resolve({
          durationMs: elapsedMs,
          fps: elapsedMs > 0 ? (timestamps.length - 1) / (elapsedMs / 1000) : 0,
          frameCount: timestamps.length,
          frameTimeMs: stats(deltas),
          maxJitter,
          type: "raf"
        });
      }

      requestAnimationFrame(frame);
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
    const frameTimeP95s = [];
    const frameTimeP99s = [];
    const frameTimeP99_9s = [];
    const frameTimeMaxes = [];
    const maxJitters = [];
    const jsHeapDeltas = [];
    const trackedGpuTotals = [];
    const trackedGpuDeltas = [];
    const userAgentMemoryDeltas = [];
    const createdCounts = [];
    const releasedCounts = [];
    const leakCounts = [];

    for (const sample of samples) {
      elapsed.push(sample.elapsedMs);
      if (finiteNumber(sample.measurement?.fps)) {
        fps.push(sample.measurement.fps);
      }
      if (finiteNumber(sample.measurement?.frameTimeMs?.mean)) {
        frameTimeMeans.push(sample.measurement.frameTimeMs.mean);
      }
      if (finiteNumber(sample.measurement?.frameTimeMs?.p95)) {
        frameTimeP95s.push(sample.measurement.frameTimeMs.p95);
      }
      if (finiteNumber(sample.measurement?.frameTimeMs?.p99)) {
        frameTimeP99s.push(sample.measurement.frameTimeMs.p99);
      }
      if (finiteNumber(sample.measurement?.frameTimeMs?.p99_9)) {
        frameTimeP99_9s.push(sample.measurement.frameTimeMs.p99_9);
      }
      if (finiteNumber(sample.measurement?.frameTimeMs?.max)) {
        frameTimeMaxes.push(sample.measurement.frameTimeMs.max);
      }
      if (finiteNumber(sample.measurement?.maxJitter)) {
        maxJitters.push(sample.measurement.maxJitter);
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
      if (finiteNumber(sample.memory?.delta?.createdCount)) {
        createdCounts.push(sample.memory.delta.createdCount);
      }
      if (finiteNumber(sample.memory?.delta?.releasedCount)) {
        releasedCounts.push(sample.memory.delta.releasedCount);
      }
      if (finiteNumber(sample.memory?.delta?.leakCount)) {
        leakCounts.push(sample.memory.delta.leakCount);
      }
    }

    return {
      elapsedMs: stats(elapsed),
      fps: stats(fps),
      frameTimeMsMean: stats(frameTimeMeans),
      frameTimeMsP95: stats(frameTimeP95s),
      frameTimeMsP99: stats(frameTimeP99s),
      frameTimeMsP99_9: stats(frameTimeP99_9s),
      frameTimeMsMax: stats(frameTimeMaxes),
      maxJitter: stats(maxJitters),
      jsHeapDeltaBytes: stats(jsHeapDeltas),
      sampleCount: samples.length,
      trackedGpuDeltaBytes: stats(trackedGpuDeltas),
      trackedGpuTotalBytes: stats(trackedGpuTotals),
      userAgentMemoryDeltaBytes: stats(userAgentMemoryDeltas),
      createdCount: stats(createdCounts),
      releasedCount: stats(releasedCounts),
      leakCount: stats(leakCounts)
    };
  }

  const hookFound = typeof globalThis[config.hookName] === "function";
  const warnings = [];
  if (!hookFound) {
    warnings.push(`No ${config.hookName} hook found; report uses requestAnimationFrame sampling only.`);
  }

  const apiSupport = await detectApis();
  await settleFrames(2);

  for (let index = 0; index < config.warmup; index += 1) {
    if (hookFound) {
      await runHook("warmup", index);
    } else {
      await sampleFrames(Math.min(250, config.durationMs));
    }
  }

  const globalBefore = await memorySnapshot();
  const samples = [];

  for (let index = 0; index < config.samples; index += 1) {
    if (config.gc && typeof globalThis.gc === "function") {
      globalThis.gc();
      await settleFrames(1);
    }

    const before = await memorySnapshot();
    const startedAtMs = performance.now();
    let measurement;
    let error = null;

    try {
      measurement = hookFound ? await runHook("sample", index) : await sampleFrames(config.durationMs);
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

    samples.push({
      elapsedMs: endedAtMs - startedAtMs,
      error,
      index,
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
  }

  const globalAfter = await memorySnapshot();

  return {
    apiSupport,
    config,
    hook: {
      found: hookFound,
      name: config.hookName
    },
    location: globalThis.location?.href || null,
    memory: {
      after: globalAfter,
      before: globalBefore,
      delta: deltaMemory(globalBefore, globalAfter)
    },
    samples,
    summary: summarizeSamples(samples),
    userAgent: navigator.userAgent,
    warnings,
    slowFrames: globalThis.__gpuSlowFrames || []
  };
}
