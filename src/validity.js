import { collectAutoGpuEvidence, collectGpuTimingEvidence, gpuTimingValidityIssues } from "./gpu-timing.js";
import { isRenderingLogEntry } from "./page-events.js";

const GPU_WORK_COUNTER = /^(webgpu|webgl2?)\.(drawCalls|bundleDrawsExecuted|dispatchCalls|clearCalls|queueSubmits)$/;
const WARNED_RESOURCE_TYPES = new Set(["Script", "Stylesheet", "Fetch", "XHR", "Image", "Document"]);
const ADAPTIVE_REASONS = new Set(["fps-converged", "gpu-converged", "frames-converged"]);

/**
 * Measurement validity is separate from the workload's performance verdict.
 * The single source of truth (§3): `{valid, issues, warnings}`, every entry
 * `{code, severity, message, …details}`. GPU timing issues are folded in here.
 */
export function reportValidity(report, precomputed = null) {
  const issues = [];
  const warnings = [];
  const add = (code, message, details = {}) => issues.push({ code, severity: "invalid", message, ...details });
  const warn = (code, message, details = {}) => warnings.push({ code, severity: "warning", message, ...details });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    add("invalid-report", "Expected a profiling report object.");
    return { valid: false, issues, warnings };
  }
  // Aggregates preserve each round's validity; their empty samples are intentional.
  if (Array.isArray(report.roundValidity)) {
    const seen = new Set();
    report.roundValidity.forEach((validity, round) => {
      if (!validity.valid) add("invalid-round", `Round ${round + 1} has invalid measurements.`, { round, issues: validity.issues });
      for (const warning of validity.warnings || []) {
        if (!seen.has(warning.code)) { seen.add(warning.code); warnings.push({ ...warning, round }); }
      }
    });
    if (!report.roundValidity.length) add("no-samples", "No profiling rounds were captured.");
    return { valid: issues.length === 0, issues, warnings };
  }

  const options = report.options || {};
  const inPage = report.inPage || {};
  const samples = Array.isArray(inPage.samples) ? inPage.samples : [];
  const diagnostics = report.diagnostics || {};
  const hookMode = (options.samplingMode ?? inPage.config?.samplingMode) === "hook";
  if (report.runError) add("run-failed", `Capture failed: ${report.runError.message ?? report.runError.code ?? "unknown error"}`,
    { runError: report.runError });
  const sampleErrors = samples.filter(sample => sample?.error).length || diagnostics.sampleErrors?.length || 0;
  if (sampleErrors) add("sample-errors", `${sampleErrors} benchmark sample(s) failed.`, { count: sampleErrors });
  const pageErrors = pageErrorCounts(report).runtime;
  if (pageErrors) add("runtime-errors", `${pageErrors} uncaught page error(s) occurred.`, { count: pageErrors });
  const sampling = inPage.sampling;
  const adaptiveComplete = !hookMode && options.adaptive === true && sampling?.stoppedEarly === true
    && ADAPTIVE_REASONS.has(sampling.reason) && samples.length >= 3 && samples.length < options.samples
    // GPU/frame convergence carries its own criterion (CV or SD); FPS convergence keeps the CV bound.
    && (sampling.reason !== "fps-converged" || (Number.isFinite(sampling.coefficientOfVariation)
      && sampling.coefficientOfVariation >= 0 && sampling.coefficientOfVariation < 0.015));
  if (Number.isInteger(options.samples) && samples.length !== options.samples && !adaptiveComplete) {
    add("incomplete-samples", `Expected ${options.samples} samples; captured ${samples.length}.`);
  }
  const hasSignal = samples.some(sample => !sample?.error && hasNumericMeasurement(sample?.measurement))
    || Number.isFinite(inPage.summary?.fps?.mean)
    || Number.isFinite(inPage.summary?.frameTimeMsMean?.mean)
    || Object.values(report.aggregateMetrics || {}).some(Number.isFinite);
  if (!hasSignal) add("no-measurements", "No numeric workload or frame measurements were captured.");
  if ((hookMode && inPage.hook?.found !== true) || (options.waitForHook && inPage.hook?.found === false)) {
    add("missing-hook", "The requested benchmark hook was not found.");
  }
  if (hookMode && (options.adaptive === true || sampling?.adaptive === true)) {
    add("incompatible-sampling", "Hook sampling cannot use FPS-based adaptive stopping.");
  }

  const api = options.api === "webgl" && !inPage.apiSupport?.webgl ? "webgl2" : options.api;
  const support = inPage.apiSupport?.[api];
  if (support?.available === false || support?.error) add("api-unavailable", `The requested ${api} API is unavailable.`);
  if (options.autoInstrument && (inPage.instrumentation?.after === null || diagnostics.instrumentation?.enabled === false)) {
    add("missing-instrumentation", "Requested allocation and draw instrumentation is unavailable.");
  }
  // Timer failures never reach instrumentation.errors (§1.5); only tool failures do.
  const instrumentationErrors = Array.isArray(inPage.instrumentation?.errors) ? inPage.instrumentation.errors
    : inPage.instrumentation?.after?.errors || diagnostics.instrumentation?.errors || [];
  if (instrumentationErrors.length) add("instrumentation-errors", `${instrumentationErrors.length} instrumentation error(s) occurred.`);
  if (options.trace && (report.trace?.captured === false || report.trace?.error)) add("trace-failed", "Requested Chrome trace was not captured successfully.");

  const httpStatus = report.target?.httpStatus;
  const documentUrl = report.target?.documentUrl ?? report.target?.url ?? null;
  const documentFailed = Number.isFinite(httpStatus) && httpStatus >= 400;
  if (documentFailed) add("document-http-status", `Main document returned HTTP ${httpStatus} (${documentUrl}).`, { status: httpStatus, url: documentUrl });

  const work = gpuWorkState(report);
  const resources = classifyFailedResources(report, work);
  const critical = resources.filter(resource => resource.critical && !(documentFailed && resource.mainDocument));
  if (critical.length) {
    add("critical-resource-failed", `Failed to load ${critical.slice(0, 3).map(describeResource).join("; ")}.`,
      { count: critical.length, resources: critical.slice(0, 3).map(publicResource) });
  }
  const otherFailures = resources.filter(resource => !resource.critical && !resource.mainDocument
    && (resource.resourceType == null || WARNED_RESOURCE_TYPES.has(resource.resourceType)));
  if (otherFailures.length) {
    warn("resource-failed", `${otherFailures.length} request(s) failed, first: ${otherFailures[0].url}.`,
      { count: otherFailures.length, resources: otherFailures.slice(0, 3).map(publicResource) });
  }

  gpuApiErrors(report, add, warn);

  const hookFound = inPage.hook?.found === true;
  const firstFailure = resources[0] ? ` First failed request: ${resources[0].url}.` : "";
  if (work.unobserved) {
    const offThread = work.offThread > 0
      ? `; page created ${work.offThread} Worker(s)/OffscreenCanvas — off-thread rendering is not instrumented` : "";
    warn("gpu-work-unobserved", `No main-thread GPU work observed${offThread}.`,
      { contexts: work.contexts, offMainThread: work.offThread });
  } else if (work.noGpuWork) {
    const message = `No GPU work during sampling (0 submits, 0 draws, 0 clears); hook ${hookFound ? "found" : "not found"}.${firstFailure}`;
    if (options.allowIdle === true) warn("no-gpu-work", message, { allowIdle: true });
    else add("no-gpu-work", message);
  }
  const idle = samples.filter(sample => sample?.idle === true).length;
  if (idle > 0 && idle < samples.length) {
    warn("idle-samples", `${idle}/${samples.length} samples had no GPU work and were excluded.`, { count: idle, sampleCount: samples.length });
  }

  const gpuEvidence = precomputed?.gpu ?? collectGpuTimingEvidence(report);
  for (const entry of gpuTimingValidityIssues(gpuEvidence, report)) {
    (entry.severity === "invalid" ? issues : warnings).push(entry);
  }
  const auto = precomputed?.autoEvidence ?? collectAutoGpuEvidence(report);
  if (auto.stability.status === "unstable") {
    const existing = warnings.find(warning => warning.code === "gpu-timing-unstable");
    if (existing) {
      existing.reasons = [...new Set([...(existing.reasons || []), ...auto.stability.reasons])];
      existing.source = "hook+auto";
      existing.message = `GPU timing unstable (${existing.reasons.join(", ")}); GPU rows from separate captures will not gate.`;
    } else {
      warn("gpu-timing-unstable", `GPU timing unstable (${auto.stability.reasons.join(", ")}); GPU rows from separate captures will not gate.`,
        { source: "auto", reasons: auto.stability.reasons });
    }
  }

  const networkIdle = report.timings?.networkIdle;
  if (networkIdle?.status === "budget-exceeded") {
    const pending = Array.isArray(networkIdle.pending) ? networkIdle.pending : [];
    const waited = Number(networkIdle.waitedMs);
    const budget = networkIdle.budgetMs ?? options.networkIdleBudgetMs;
    const when = Number.isFinite(waited) && Number.isFinite(budget) && waited < budget
      ? `when sampling began (${Math.round(waited)} ms after load)`
      : `after ${budget} ms`;
    warn("network-not-idle", `Network not idle ${when}; sampled with ${pending.length} pending: ${pending.slice(0, 3).map(item => item.url).join(", ") || "unknown"}.`,
      { pending: pending.slice(0, 3) });
  }
  if (inPage.ready?.reason === "timeout") {
    warn("ready-timeout", `No GPU work seen within ${options.readyTimeoutMs ?? inPage.config?.readyTimeoutMs ?? 3000} ms of load; sampling anyway.`,
      { waitedMs: inPage.ready.waitedMs ?? null });
  }
  // Only reports that ran the readiness gate (v3) record why it could not wait.
  if (inPage.ready && options.autoInstrument !== true && !hookFound && inPage.ready.reason !== "disabled") {
    warn("readiness-unavailable", "Neither auto-instrumentation nor a hook was available, so sampling did not wait for GPU work.");
  }
  const lock = report.measurementLock;
  if (lock?.timedOut) {
    warn("measurement-lock-timeout", `Another capture held the measurement lock for ${Math.round(lock.waitedMs ?? 0)} ms; results may be contended.`,
      { waitedMs: lock.waitedMs ?? null, holder: lock.holder ?? null });
  } else if (lock?.unavailable) {
    warn("measurement-lock-timeout", `Measurement lock unavailable (${lock.unavailable}).`, { unavailable: lock.unavailable });
  }
  const overhead = instrumentationOverhead(report);
  if (overhead) {
    warn("instrumentation-overhead", `Instrumentation may inflate CPU time on this page (${overhead}); compare CPU metrics only against captures with the same options.`);
  }
  return { valid: issues.length === 0, issues, warnings };
}

/** Retained diagnostics are representative; counters include dropped events. */
export function pageErrorCounts(report) {
  const events = [report?.pageEvents, report?.diagnostics?.pageErrors].find(Array.isArray) || [];
  let runtime = 0, network = 0, rendering = 0;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "pageerror") runtime++;
    else if (event.type === "requestfailed" || event.type === "httperror") network++;
    else if (event.type === "log.entry" && isRenderingLogEntry(event)) rendering++;
  }
  const counts = report?.pageEventSummary?.counts;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  runtime = Math.max(runtime, count(counts?.pageerror));
  network = Math.max(network, count(counts?.requestfailed) + count(counts?.httpError));
  rendering = Math.max(rendering, count(counts?.renderingError));
  return { runtime, network, rendering, total: runtime + network + rendering };
}

/** Failed requests (loadingFailed and not canceled, or HTTP >= 400), with the §3.1 criticality. */
export function failedResources(report) {
  return classifyFailedResources(report, gpuWorkState(report)).map(publicResource);
}

function classifyFailedResources(report, work) {
  const target = report?.target || {};
  const documentUrl = target.documentUrl ?? target.url ?? null;
  const documentOrigin = originOf(documentUrl);
  const byKey = new Map();
  const merge = (entry, structuralCritical = false) => {
    if (!entry || typeof entry !== "object") return;
    const url = typeof entry.url === "string" ? entry.url : entry.requestId ?? null;
    const status = Number.isFinite(entry.status) ? entry.status : null;
    if (entry.type === "requestfailed" && entry.canceled === true && !(status >= 400)) return;
    if (entry.type === "httperror" && !(status >= 400)) return;
    const key = `${url}\u0000${entry.resourceType ?? ""}`;
    const current = byKey.get(key);
    if (current) {
      current.status ??= status;
      current.failure ??= entry.failure ?? null;
      current.structural ||= structuralCritical;
      return;
    }
    byKey.set(key, { url, resourceType: entry.resourceType ?? null, status, failure: entry.failure ?? null,
      frameId: entry.frameId ?? null, structural: structuralCritical });
  };
  const list = value => Array.isArray(value) ? value : [];
  for (const entry of list(report?.pageEventSummary?.failedResources)) merge(entry, entry?.critical === true);
  for (const event of list(report?.pageEvents)) {
    if (event?.type === "requestfailed" || event?.type === "httperror") merge(event);
  }
  const resources = [];
  for (const resource of byKey.values()) {
    const mainDocument = resource.resourceType === "Document"
      && (resource.structural || (documentUrl != null && resource.url === documentUrl) || resource.url === target.url);
    const sameOrigin = documentOrigin !== null && originOf(resource.url) === documentOrigin;
    const critical = mainDocument
      || (resource.resourceType === "Script" && (sameOrigin || resource.structural || work.noGpuWorkCondition || work.unobserved));
    resources.push({ ...resource, mainDocument, critical });
  }
  // Critical failures first, then chronological.
  return resources.sort((a, b) => Number(b.critical) - Number(a.critical));
}

function publicResource({ url, resourceType, status, failure, critical }) {
  return { url, resourceType, status, failure, critical };
}

function describeResource(resource) {
  return `${resource.resourceType ?? "resource"} ${resource.url} (${resource.status ?? resource.failure ?? "failed"})`;
}

function originOf(url) {
  try { const origin = new URL(url).origin; return origin === "null" ? null : origin; } catch { return null; }
}

// App GPU contexts, sampling-window GPU work and off-main-thread rendering (§3.1).
function gpuWorkState(report) {
  const options = report?.options || {};
  const inPage = report?.inPage || {};
  const instrumentation = inPage.instrumentation || {};
  const after = instrumentation.after?.counters;
  const autoOn = options.autoInstrument === true;
  const framesMode = (options.samplingMode ?? inPage.config?.samplingMode ?? "frames") === "frames";
  const summary = inPage.summary || {};
  let contexts = null;
  if (summary.appGpuContexts && typeof summary.appGpuContexts === "object") {
    contexts = Object.values(summary.appGpuContexts).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  } else if (after) {
    // Older reports counted the API probe's own context; subtract it.
    const probes = ["webgl2", "webgl"].filter(api => inPage.apiSupport?.[api]?.available === true).length;
    contexts = counter(after, "webgpu.devices") + Math.max(0, counter(after, "webgl2.contexts") + counter(after, "webgl.contexts") - probes);
  }
  const window = instrumentation.delta ?? summary.instrumentationCounters ?? (after && instrumentation.before?.counters
    ? Object.fromEntries(Object.keys(after).map(key => [key, counter(after, key) - counter(instrumentation.before.counters, key)])) : null);
  const workCount = window ? Object.entries(window).reduce((total, [key, value]) => total + (GPU_WORK_COUNTER.test(key) && Number.isFinite(value) ? value : 0), 0) : null;
  const offThread = counter(summary.offMainThread, "workers") + counter(summary.offMainThread, "offscreenTransfers");
  const instrumented = autoOn && contexts !== null;
  const unobserved = instrumented && (contexts === 0 || (offThread > 0 && workCount === 0));
  const noGpuWorkCondition = instrumented && framesMode && contexts > 0 && workCount === 0;
  return { contexts, workCount, offThread, unobserved, noGpuWorkCondition, noGpuWork: noGpuWorkCondition && !unobserved };
}

function gpuApiErrors(report, add, warn) {
  const inPage = report?.inPage || {};
  const instrumentation = inPage.instrumentation || {};
  const after = instrumentation.after?.counters || {};
  const gpuErrors = inPage.summary?.gpuErrors || {};
  const start = instrumentation.warmupStartCounters;
  const uncapturedTotal = Number.isFinite(gpuErrors.total) ? gpuErrors.total : counter(after, "webgpu.uncapturedErrors");
  // Warmup+sampling window; older reports without warmupStartCounters use the sampling window.
  const uncapturedInWindow = Number.isFinite(gpuErrors.inWindow) ? gpuErrors.inWindow
    : start ? counter(after, "webgpu.uncapturedErrors") - counter(start, "webgpu.uncapturedErrors")
    : counter(instrumentation.delta ?? inPage.summary?.instrumentationCounters, "webgpu.uncapturedErrors");
  const lost = Array.isArray(gpuErrors.deviceLost)
    ? gpuErrors.deviceLost.filter(entry => entry?.reason !== "destroyed")
    : [];
  const deviceLost = Math.max(lost.length, counter(after, "webgpu.deviceLost"));
  const contextLost = Math.max(counter(after, "webgl.contextLost"), Number.isFinite(gpuErrors.contextLost) ? gpuErrors.contextLost : 0);
  const shaderFailures = Math.max(counter(after, "webgl.shaderCompileFailures") + counter(after, "webgl.programLinkFailures"),
    Array.isArray(gpuErrors.shaderFailures) ? gpuErrors.shaderFailures.length : 0);
  const rendering = pageErrorCounts(report).rendering;
  // Chrome echoes each uncaptured WebGPU error as a rendering log entry. When
  // the page counted uncaptured errors itself, judge those by the window rule
  // above and leave only the other (WebGL) rendering errors for the >= 5 rule.
  const echoCount = report?.pageEventSummary?.counts?.renderingErrorWebgpu;
  const uncapturedTracked = Number.isFinite(gpuErrors.total) || Number.isFinite(after["webgpu.uncapturedErrors"]);
  const otherRendering = uncapturedTracked && Number.isSafeInteger(echoCount) && echoCount >= 0
    ? Math.max(0, rendering - echoCount)
    // Older reports cannot tell echoes apart: count only what exceeds the uncaptured errors.
    : uncapturedTracked ? Math.max(0, rendering - uncapturedTotal) : rendering;
  const renderingRule = uncapturedTracked && Number.isSafeInteger(echoCount) ? otherRendering : rendering;
  const renderingTexts = [...(Array.isArray(report?.pageEventSummary?.renderingErrors) ? report.pageEventSummary.renderingErrors : []),
    ...(Array.isArray(report?.pageEvents) ? report.pageEvents : []).filter(event => event?.type === "log.entry" && isRenderingLogEntry(event)).map(event => event.text)]
    .filter(text => typeof text === "string");
  const sentinel = renderingTexts.some(text => /too many errors/.test(text));
  const top = gpuErrors.top?.[0]?.message ?? lost[0]?.message ?? shaderMessage(gpuErrors.shaderFailures?.[0]) ?? renderingTexts[0] ?? null;
  const message = count => `${count} GPU API error(s)${top ? `: "${String(top).split("\n")[0].slice(0, 200)}"` : ""}.`;
  const details = { uncapturedInWindow, uncapturedTotal, deviceLost, contextLost, shaderFailures, rendering };
  if (uncapturedInWindow > 0 || deviceLost > 0 || contextLost > 0 || shaderFailures > 0 || renderingRule >= 5 || sentinel) {
    add("gpu-api-errors", message(Math.max(1, uncapturedInWindow + deviceLost + contextLost + shaderFailures + otherRendering)), details);
  } else if (uncapturedTotal > 0 || rendering > 0) {
    warn("gpu-api-warnings", message(Math.max(1, uncapturedTotal + otherRendering)), details);
  }
}

function shaderMessage(failure) {
  if (failure == null) return null;
  return typeof failure === "string" ? failure : failure.log ?? failure.message ?? null;
}

function instrumentationOverhead(report) {
  const profile = report?.cpuProfile;
  const reasons = [];
  if (profile && Number.isFinite(profile.msPerFrame?.tool) && profile.frames > 0 && profile.windowMs > 0 && profile.busy > 0) {
    const busyMsPerFrame = profile.busy * (profile.windowMs / profile.frames);
    const share = profile.msPerFrame.tool / busyMsPerFrame;
    if (share > 0.1) reasons.push(`tool JS ${round(profile.msPerFrame.tool)} ms/frame is ${Math.round(share * 100)}% of main-thread busy time`);
  }
  const summary = report?.inPage?.summary || {};
  let glDraws = summary.perFrame?.glDrawCalls;
  if (!Number.isFinite(glDraws)) {
    const window = report?.inPage?.instrumentation?.delta ?? summary.instrumentationCounters;
    const frames = summary.observedFrameCount;
    glDraws = window && frames > 0 ? (counter(window, "webgl2.drawCalls") + counter(window, "webgl.drawCalls")) / frames : null;
  }
  if (glDraws > 20000) reasons.push(`${Math.round(glDraws)} WebGL draws/frame are each wrapped`);
  return reasons.join("; ") || null;
}

function counter(counters, key) {
  const value = counters?.[key];
  return Number.isFinite(value) ? value : 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function hasNumericMeasurement(value, depth = 0) {
  if (Number.isFinite(value)) return true;
  if (!value || typeof value !== "object" || depth > 8) return false;
  // A zero-frame observer still contains numeric metadata, but no performance evidence.
  if (value.type === "raf") return value.frameCount >= 2;
  return Object.entries(value).some(([key, item]) => !["observedFrames", "frameCount", "slowFrameCount", "durationMs"].includes(key)
    ? hasNumericMeasurement(item, depth + 1)
    : key === "observedFrames" && item?.frameCount >= 2);
}
