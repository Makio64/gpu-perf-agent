// Bound retained diagnostics at the source: compacting stdout cannot bound a live
// capture, and routine logs must never consume the slots reserved for failures.
export const PAGE_EVENT_LIMITS = Object.freeze({
  routine: 200,
  pageerror: 50,
  requestfailed: 50,
  consoleError: 50,
  logError: 50,
  textChars: 8192,
  stringChars: 2048,
  arrayItems: 16,
  objectFields: 16,
  depth: 6,
  nodes: 128
});

const emptyCounts = () => ({ console: 0, consoleError: 0, pageerror: 0, requestfailed: 0, log: 0, logError: 0 });

export function createPageEventCollector() {
  const events = [];
  const counts = emptyCounts();
  const retainedCounts = emptyCounts();
  const retainedBuckets = { routine: 0, pageerror: 0, requestfailed: 0, consoleError: 0, logError: 0 };
  let total = 0;
  let truncated = 0;
  return {
    // Details are materialized only when a slot remains. Counters still include
    // every event, even after the bounded evidence samples fill up.
    record(type, details, { level, truncated: alreadyTruncated = false } = {}) {
      const category = type === "pageerror" || type === "requestfailed" ? type
        : type === "console.error" || type === "console.assert" ? "consoleError"
        : type === "log.entry" ? (level === "error" ? "logError" : "log") : "console";
      const bucket = category === "console" || category === "log" ? "routine" : category;
      total++;
      counts[category]++;
      if (retainedBuckets[bucket] >= PAGE_EVENT_LIMITS[bucket]) return;
      const state = { text: PAGE_EVENT_LIMITS.textChars, nodes: PAGE_EVENT_LIMITS.nodes, truncated: alreadyTruncated };
      const detail = boundedValue(typeof details === "function" ? details() : details, state);
      events.push({ ...detail, type });
      retainedBuckets[bucket]++;
      retainedCounts[category]++;
      if (state.truncated) truncated++;
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
          retainedCounts: { ...retainedCounts },
          limits: PAGE_EVENT_LIMITS
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
    collector.record("log.entry", () => ({
      level: event.entry?.level || null,
      source: event.entry?.source || null,
      text: event.entry?.text || null
    }), { level: event.entry?.level });
  });
  session.on("Network.loadingFailed", event => {
    collector.record("requestfailed", () => ({ failure: event.errorText || null, url: event.requestId }));
  });
  return collector;
}

export function capturePlaywrightPageEvents(page, collector = createPageEventCollector()) {
  page.on("console", message => collector.record(`console.${message.type()}`, () => ({ location: message.location(), text: message.text() })));
  page.on("pageerror", error => collector.record("pageerror", () => ({ error: {
    message: error?.message || String(error), name: error?.name || "Error", ...(error?.stack ? { stack: error.stack } : {})
  } })));
  page.on("requestfailed", request => collector.record("requestfailed", () => ({ failure: request.failure()?.errorText || null, url: request.url() })));
  return collector;
}

export function withCaptureDiagnostics(error, collector) {
  if (!collector || error?.captureDiagnostics) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.captureDiagnostics = collector.snapshot();
  return failure;
}

function remoteObjectValue(object) {
  if (!object) return "";
  if ("value" in object) return object.value;
  return object.unserializableValue || object.description || object.type || "";
}
