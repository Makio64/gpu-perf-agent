// Bound retained diagnostics at the source: compacting stdout cannot bound a live
// capture, and routine logs must never consume the slots reserved for failures.
export const PAGE_EVENT_LIMITS = Object.freeze({
  routine: 200,
  pageerror: 50,
  requestfailed: 50,
  httpError: 50,
  consoleError: 50,
  logError: 50,
  renderingError: 50,
  textChars: 8192,
  stringChars: 2048,
  arrayItems: 16,
  objectFields: 16,
  depth: 6,
  nodes: 128,
  requestMap: 2000,
  renderingErrorTexts: 3,
  renderingErrorChars: 200,
  failedResources: 5
});

// Chrome reports WebGPU/WebGL validation failures as rendering log entries (§1.8).
// ANGLE spells GL errors GL_INVALID_ENUM, where \b does not match after "GL_".
const RENDERING_ERROR = /(?:\b|GL_)INVALID_|WGSL|is invalid|Invalid |[Vv]alidation|OUT_OF_MEMORY|CONTEXT_LOST|\blost\b|too many errors/;
// Dawn echoes every uncaptured WebGPU error to the console ("[Invalid X]",
// " - While encoding [...]"). They are counted apart so validity can judge
// WebGPU errors by the in-page warmup+sampling window instead.
const WEBGPU_ECHO = /WGSL|\[Invalid [A-Z]|^\s*- While |\bWhile (?:calling|validating|encoding|finishing) \[/m;
const WEBGL_TEXT = /WebGL|\bGL_[A-Z]/;
const PRIORITY_RESOURCE_TYPES = new Set(["Document", "Script"]);

const emptyCounts = () => ({ console: 0, consoleError: 0, pageerror: 0, requestfailed: 0, log: 0, logError: 0, httpError: 0, renderingError: 0,
  renderingErrorWebgpu: 0 });

export function isRenderingLogEntry(entry) {
  return entry?.source === "rendering" && (entry.level === "warning" || entry.level === "error")
    && typeof entry.text === "string" && RENDERING_ERROR.test(entry.text);
}

/** A rendering-log text that is Chrome's echo of an uncaptured WebGPU error. */
export function isWebgpuRenderingEcho(text) {
  return typeof text === "string" && WEBGPU_ECHO.test(text) && !WEBGL_TEXT.test(text);
}

export function createPageEventCollector() {
  const events = [];
  const counts = emptyCounts();
  const retainedBuckets = { routine: 0, pageerror: 0, requestfailed: 0, httpError: 0, consoleError: 0, logError: 0, renderingError: 0 };
  const renderingErrors = [];
  const failed = [];
  let total = 0;
  let truncated = 0;
  return {
    // Details are materialized only when a slot remains. Counters still include
    // every event, even after the bounded evidence samples fill up.
    record(type, details, { level, category: forced, truncated: alreadyTruncated = false } = {}) {
      const category = forced ?? (type === "pageerror" || type === "requestfailed" ? type
        : type === "httperror" ? "httpError"
        : type === "console.error" || type === "console.assert" ? "consoleError"
        : type === "log.entry" ? (level === "error" ? "logError" : "log") : "console");
      const bucket = category === "console" || category === "log" ? "routine" : category;
      total++;
      counts[category]++;
      if (retainedBuckets[bucket] >= PAGE_EVENT_LIMITS[bucket]) return;
      const state = { text: PAGE_EVENT_LIMITS.textChars, nodes: PAGE_EVENT_LIMITS.nodes, truncated: alreadyTruncated };
      const detail = boundedValue(typeof details === "function" ? details() : details, state);
      events.push({ ...detail, type });
      retainedBuckets[bucket]++;
      if (state.truncated) truncated++;
    },
    // The first rendering-error texts survive even when their bucket overflows.
    noteRenderingError(text) {
      if (isWebgpuRenderingEcho(text)) counts.renderingErrorWebgpu++;
      if (renderingErrors.length >= PAGE_EVENT_LIMITS.renderingErrorTexts || typeof text !== "string") return;
      renderingErrors.push(detachedPrefix(text, PAGE_EVENT_LIMITS.renderingErrorChars));
    },
    // ≤5 failed resources; a Document/Script failure displaces a later minor one.
    noteFailedResource({ url = null, resourceType = null, status = null, failure = null, critical = false } = {}) {
      const entry = { url: typeof url === "string" ? detachedPrefix(url, PAGE_EVENT_LIMITS.stringChars) : url,
        resourceType, status, failure, critical: critical === true };
      const existing = failed.find(item => item.url === entry.url && item.resourceType === entry.resourceType);
      if (existing) {
        existing.status ??= entry.status;
        existing.failure ??= entry.failure;
        existing.critical ||= entry.critical;
        return;
      }
      if (failed.length < PAGE_EVENT_LIMITS.failedResources) { failed.push(entry); return; }
      if (!entry.critical && !PRIORITY_RESOURCE_TYPES.has(resourceType)) return;
      const minor = failed.findLastIndex(item => !item.critical && !PRIORITY_RESOURCE_TYPES.has(item.resourceType));
      if (minor >= 0) failed.splice(minor, 1), failed.push(entry);
    },
    snapshot() {
      return {
        pageEvents: events.slice(),
        pageEventSummary: {
          total,
          retained: events.length,
          dropped: total - events.length,
          truncated,
          counts: { ...counts },
          renderingErrors: renderingErrors.slice(),
          failedResources: failed.map(item => ({ ...item }))
        }
      };
    }
  };
}

function boundedValue(value, state, depth = 0) {
  if (state.nodes-- <= 0 || depth > PAGE_EVENT_LIMITS.depth) { state.truncated = true; return null; }
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const length = Math.min(PAGE_EVENT_LIMITS.stringChars, state.text);
    state.text -= Math.min(value.length, length);
    if (value.length <= length) return value;
    state.truncated = true;
    return length > 0 ? `${detachedPrefix(value, length - 1)}…` : "";
  }
  if (Array.isArray(value)) {
    if (value.length > PAGE_EVENT_LIMITS.arrayItems) state.truncated = true;
    return value.slice(0, PAGE_EVENT_LIMITS.arrayItems).map(item => boundedValue(item, state, depth + 1));
  }
  if (typeof value === "object") {
    const entries = [];
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (entries.length >= PAGE_EVENT_LIMITS.objectFields) { state.truncated = true; break; }
      const length = Math.min(128, state.text);
      if (length === 0) { state.truncated = true; break; }
      const name = key.length > length ? `${detachedPrefix(key, length - 1)}…` : key;
      state.text -= name.length;
      if (name !== key) state.truncated = true;
      entries.push([name, boundedValue(value[key], state, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  state.truncated = true;
  return detachedPrefix(String(value), 128);
}

// V8 slices may reference their complete original string. Copy bounded prefixes
// so retaining 2 KiB of a multi-megabyte log does not retain that whole log.
function detachedPrefix(value, length) {
  return Buffer.from(value.slice(0, length), "utf16le").toString("utf16le");
}

export function captureCdpPageEvents(session, collector = createPageEventCollector()) {
  // requestId -> {url, resourceType, frameId, status}: failed requests name their URL,
  // not the opaque id. Bounded; entries leave on finished/failed.
  const requests = new Map();
  let mainFrameId = null;
  let documentOrigin = null;
  const remember = (requestId, entry) => {
    if (requestId == null) return;
    const current = requests.get(requestId);
    if (current) { Object.assign(current, entry); return; }
    if (requests.size >= PAGE_EVENT_LIMITS.requestMap) requests.delete(requests.keys().next().value);
    requests.set(requestId, { url: null, resourceType: null, frameId: null, status: null, ...entry });
  };
  // Document failures in the main frame and same-origin scripts are critical (§3.1).
  const structurallyCritical = entry => (entry.resourceType === "Document" && (entry.frameId == null || entry.frameId === mainFrameId))
    || (entry.resourceType === "Script" && documentOrigin !== null && originOf(entry.url) === documentOrigin);
  session.on("Runtime.consoleAPICalled", event => {
    collector.record(`console.${event.type || "log"}`, () => {
      // Cap before joining so a single console call cannot build a huge string.
      const values = (event.args || []).slice(0, PAGE_EVENT_LIMITS.arrayItems).map(remoteObjectValue);
      const text = values.map(value => value == null ? "" : detachedPrefix(String(value), PAGE_EVENT_LIMITS.stringChars)).join(" ");
      return { args: values, text, ...((event.args?.length || 0) > values.length ? { argsOmitted: event.args.length - values.length } : {}) };
    }, { truncated: (event.args?.length || 0) > PAGE_EVENT_LIMITS.arrayItems });
  });
  session.on("Runtime.exceptionThrown", event => {
    collector.record("pageerror", () => ({ error: {
      message: event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || remoteObjectValue(event.exceptionDetails?.exception),
      stack: event.exceptionDetails?.stackTrace || null
    } }));
  });
  session.on("Log.entryAdded", event => {
    const entry = event.entry || {};
    const rendering = isRenderingLogEntry(entry);
    if (rendering) collector.noteRenderingError(entry.text);
    collector.record("log.entry", () => ({
      level: entry.level || null,
      source: entry.source || null,
      text: entry.text || null,
      url: entry.url || null,
      lineNumber: Number.isInteger(entry.lineNumber) ? entry.lineNumber : null
    }), { level: entry.level, ...(rendering ? { category: "renderingError" } : {}) });
  });
  session.on("Page.frameNavigated", event => {
    if (event.frame && !event.frame.parentId) {
      mainFrameId = event.frame.id ?? mainFrameId;
      documentOrigin = originOf(event.frame.url) ?? documentOrigin;
    }
  });
  session.on("Network.requestWillBeSent", event => {
    // The first Document request of a capture is the main navigation.
    if (event.type === "Document" && (mainFrameId === null || event.frameId === mainFrameId)) {
      mainFrameId ??= event.frameId ?? null;
      documentOrigin = originOf(event.request?.url) ?? documentOrigin;
    }
    remember(event.requestId, { url: event.request?.url ?? null, resourceType: event.type ?? null, frameId: event.frameId ?? null });
  });
  session.on("Network.responseReceived", event => {
    const status = Number.isFinite(event.response?.status) ? event.response.status : null;
    const url = event.response?.url || requests.get(event.requestId)?.url || null;
    remember(event.requestId, { url, status, resourceType: event.type ?? requests.get(event.requestId)?.resourceType ?? null,
      ...(event.frameId ? { frameId: event.frameId } : {}) });
    if (event.type === "Document" && event.frameId != null && event.frameId === mainFrameId) documentOrigin = originOf(url) ?? documentOrigin;
    if (!(status >= 400)) return;
    const entry = requests.get(event.requestId) ?? { resourceType: event.type ?? null, frameId: event.frameId ?? null };
    collector.noteFailedResource({ url, resourceType: entry.resourceType, status, failure: null, critical: structurallyCritical(entry) });
    collector.record("httperror", { url, resourceType: entry.resourceType, status });
  });
  session.on("Network.loadingFinished", event => { requests.delete(event.requestId); });
  session.on("Network.loadingFailed", event => {
    const known = requests.get(event.requestId);
    requests.delete(event.requestId);
    const entry = { url: known?.url ?? null, resourceType: event.type ?? known?.resourceType ?? null,
      frameId: known?.frameId ?? null, status: known?.status ?? null };
    const canceled = Boolean(event.canceled);
    if (!canceled || entry.status >= 400) {
      // Same URL fallback as the event, so validity merges the two into one failure.
      collector.noteFailedResource({ ...entry, url: entry.url ?? event.requestId ?? null, failure: event.errorText || null,
        critical: structurallyCritical(entry) });
    }
    collector.record("requestfailed", {
      url: entry.url ?? event.requestId ?? null, resourceType: entry.resourceType, status: entry.status,
      failure: event.errorText || null, canceled, requestId: event.requestId ?? null, frameId: entry.frameId
    });
  });
  return collector;
}

// Playwright reports lowercase resource types; CDP's spelling is the report's.
const PLAYWRIGHT_RESOURCE_TYPES = { document: "Document", stylesheet: "Stylesheet", image: "Image", media: "Media", font: "Font",
  script: "Script", texttrack: "TextTrack", xhr: "XHR", fetch: "Fetch", eventsource: "EventSource", websocket: "WebSocket",
  manifest: "Manifest", other: "Other" };

export function capturePlaywrightPageEvents(page, collector = createPageEventCollector()) {
  const resourceType = request => {
    try { const type = request?.resourceType?.(); return PLAYWRIGHT_RESOURCE_TYPES[type] ?? type ?? null; } catch { return null; }
  };
  const mainDocument = request => {
    try { return resourceType(request) === "Document" && request.frame?.() === page.mainFrame?.(); } catch { return false; }
  };
  page.on("console", message => collector.record(`console.${message.type()}`, () => ({ location: message.location(), text: message.text() })));
  page.on("pageerror", error => collector.record("pageerror", () => ({ error: {
    message: error?.message || String(error), name: error?.name || "Error", ...(error?.stack ? { stack: error.stack } : {})
  } })));
  page.on("requestfailed", request => {
    const entry = { url: request.url(), resourceType: resourceType(request), status: null, failure: request.failure()?.errorText || null };
    collector.noteFailedResource({ ...entry, critical: mainDocument(request) });
    collector.record("requestfailed", () => ({ ...entry, canceled: false, requestId: null, frameId: null }));
  });
  page.on("response", response => {
    const status = response?.status?.();
    if (!(status >= 400)) return;
    const request = response.request?.();
    const entry = { url: response.url(), resourceType: resourceType(request), status };
    collector.noteFailedResource({ ...entry, failure: null, critical: mainDocument(request) });
    collector.record("httperror", entry);
  });
  return collector;
}

export function withCaptureDiagnostics(error, collector) {
  if (!collector || error?.captureDiagnostics) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.captureDiagnostics = collector.snapshot();
  return failure;
}

function originOf(url) {
  try { const origin = new URL(url).origin; return origin === "null" ? null : origin; } catch { return null; }
}

function remoteObjectValue(object) {
  if (!object) return "";
  if ("value" in object) return object.value;
  return object.unserializableValue || object.description || object.type || "";
}
