// Rebuilds audit-captures.json.gz: saved v2 captures from the 2.2.0 audit, trimmed to the
// fields analysis.js, compare.js and validity.js read (§4.7 acceptance inputs).
//   node test/fixtures/saved/build.mjs --audit /path/to/scratchpad/audit
// Trimming is checked to leave every comparison and summary unchanged.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const pick = (object, keys) => object && typeof object === "object"
  ? Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]])) : object;
const trimTracked = tracked => tracked && typeof tracked === "object"
  ? pick(tracked, ["api", "byKind", "totalBytes", "totalResources", "pipelines", "bindGroups"]) : tracked;
const trimSnapshot = snapshot => snapshot && { ...pick(snapshot, ["counters", "errors", "version"]), resources: trimTracked(snapshot.resources) };
const metricKeys = ["Timestamp", "ThreadTime", "TaskDuration", "JSHeapUsedSize", "JSHeapTotalSize"];
const recommendation = item => pick(item, ["id", "category", "severity", "title", "action", "value", "threshold", "unit"]);

function trimMeasurement(measurement) {
  if (!measurement || typeof measurement !== "object") return measurement;
  const copy = { ...measurement };
  if (copy.trackedGpuMemory) copy.trackedGpuMemory = trimTracked(copy.trackedGpuMemory);
  if (copy.observedFrames) copy.observedFrames = pick(copy.observedFrames, ["type", "frameCount", "fps", "frameTimeMs", "cadence", "maxJitter",
    "slowFrameCount", "durationMs", "observationWindowMs"]);
  return copy;
}

export function trimReport(report) {
  const inPage = report.inPage || {};
  return {
    schemaVersion: report.schemaVersion,
    summary: report.summary && { ...report.summary, recommendations: (report.summary.recommendations || []).map(recommendation) },
    diagnostics: report.diagnostics && { signal: report.diagnostics.signal, recommendations: (report.diagnostics.recommendations || []).map(recommendation) },
    options: report.options,
    target: report.target && pick(report.target, ["source", "url", "httpStatus", "documentUrl"]),
    measurementLock: report.measurementLock,
    cpuProfile: report.cpuProfile,
    inPage: {
      config: inPage.config,
      apiSupport: inPage.apiSupport && Object.fromEntries(Object.entries(inPage.apiSupport).map(([api, support]) => [api,
        pick(support, ["available", "error", "adapter", "vendor", "renderer", "unmaskedVendor", "unmaskedRenderer", "version", "shadingLanguageVersion"])])),
      hook: inPage.hook, ready: inPage.ready, warmup: inPage.warmup, sampling: inPage.sampling,
      instrumentation: inPage.instrumentation && { ...pick(inPage.instrumentation, ["delta", "errors", "warmupStartCounters"]),
        before: trimSnapshot(inPage.instrumentation.before), after: trimSnapshot(inPage.instrumentation.after) },
      memory: inPage.memory && { ...pick(inPage.memory, ["delta", "retained"]),
        before: inPage.memory.before && { ...inPage.memory.before, trackedGpuMemory: trimTracked(inPage.memory.before.trackedGpuMemory) },
        after: inPage.memory.after && { ...inPage.memory.after, trackedGpuMemory: trimTracked(inPage.memory.after.trackedGpuMemory) } },
      samples: (inPage.samples || []).map(sample => ({ ...pick(sample, ["index", "startedAtMs", "elapsedMs", "error", "idle", "activity", "autoGpu"]),
        measurement: trimMeasurement(sample.measurement),
        memory: sample.memory && pick(sample.memory, ["delta", "trackedGpuTotalBytes"]),
        instrumentation: sample.instrumentation && pick(sample.instrumentation, ["delta"]) })),
      slowFrames: inPage.slowFrames, summary: inPage.summary
    },
    cdp: report.cdp && { before: { performanceMetrics: pick(report.cdp.before?.performanceMetrics, metricKeys) },
      after: { performanceMetrics: pick(report.cdp.after?.performanceMetrics, metricKeys) },
      ...(report.cdp.samples ? { samples: report.cdp.samples } : {}) },
    pageEventSummary: report.pageEventSummary,
    pageEvents: (report.pageEvents || []).filter(event => event?.type !== "console").slice(0, 10),
    browser: report.browser && { version: report.browser.version,
      systemInfo: report.browser.systemInfo && { gpu: report.browser.systemInfo.gpu && pick(report.browser.systemInfo.gpu, ["devices", "auxAttributes", "featureStatus"]) } },
    host: report.host && pick(report.host, ["platform", "arch", "release", "totalmem", "cpus"]),
    createdAt: report.createdAt
  };
}

export function captureFiles(audit) {
  const V = `${audit}/digest-verify/out`, D = `${audit}/digest`, DO = `${audit}/diagnostics/out`, DV = `${audit}/diagnostics-verify/out`, E = `${audit}/engine-verify/out`;
  const files = {
    "draw-1": `${V}/draw-1.json`, "draw-2": `${V}/draw-2.json`, "draw-3": `${V}/draw-3.json`, "draw-4": `${V}/draw-4.json`,
    "draw-5": `${D}/w-draw.json`, "draw-6": `${D}/wall-0.json`, "draw-7": `${D}/wall-1.json`, "draw-8": `${D}/wall-2.json`,
    "clear-1": `${V}/clear-1.json`, "clear-2": `${V}/clear-2.json`, "clear-3": `${V}/clear-3.json`, "clear-4": `${V}/clear-4.json`,
    "clear-5": `${D}/webgpu-clear-r1.json`, "clear-6": `${D}/webgpu-clear-r2.json`, "clear-7": `${D}/webgpu-clear-r3.json`,
    "mid-1": `${V}/mid-1.json`, "mid-2": `${V}/mid-2.json`, "mid-3": `${V}/mid-3.json`, "mid-4": `${D}/w-gpu-mid.json`,
    "cube-1": `${V}/cube-2.json`, "cube-2": `${D}/threejs-cube-a.json`, "cube-3": `${D}/threejs-cube-b.json`, "cube-4": `${D}/threejs-cube-c.json`,
    "heavy-1": `${D}/w-gpu-heavy.json`,
    "broken-240-1": `${DV}/b-gpu-broken-240-1.json`, "three-failed-1": `${DO}/three-1.json`, "three-ok-1": `${DO}/three-2.json`
  };
  for (const n of [1, 2, 3, 4, 5]) {
    files[`gl-cpu-20-${n}`] = `${DO}/c-gl-cpu-20-${n}.json`;
    files[`gl-cpu-24-${n}`] = `${DO}/c-gl-cpu-24-${n}.json`;
    files[`gpu-loop-300-${n}`] = `${DO}/c-gpu-loop-300-${n}.json`;
  }
  for (const n of [1, 2, 3]) {
    files[`ovh-autoinst-${n}`] = `${E}/ovh-autoinst-${n}.json`;
    files[`warm-200-${n}`] = `${DV}/w-gpu-warm-200-${n}.json`;
    files[`warm-240-${n}`] = `${DV}/w-gpu-warm-240-${n}.json`;
  }
  return files;
}

if (process.argv.includes("--audit")) {
  const audit = process.argv[process.argv.indexOf("--audit") + 1];
  const bundle = Object.fromEntries(Object.entries(captureFiles(audit)).map(([name, file]) => [name, trimReport(JSON.parse(readFileSync(file, "utf8")))]));
  writeFileSync(new URL("audit-captures.json.gz", import.meta.url), gzipSync(JSON.stringify(bundle), { level: 9 }));
}
