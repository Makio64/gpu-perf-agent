import assert from "node:assert/strict";
import test from "node:test";
import { createPageEventCollector, captureCdpPageEvents, capturePlaywrightPageEvents, isRenderingLogEntry, isWebgpuRenderingEcho, withCaptureDiagnostics, PAGE_EVENT_LIMITS } from "../src/page-events.js";
import { failedResources } from "../src/validity.js";
import { FastCDPHarness } from "../src/fast-cdp-runner.js";

function emitter() {
  const listeners = new Map();
  return {
    listeners,
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
      return () => { listeners.get(type)?.delete(callback); };
    },
    emit(type, event) { for (const callback of listeners.get(type) || []) callback(event); },
    dispose() { listeners.clear(); }
  };
}

test("log floods retain bounded independent failure evidence with exact total counts", () => {
  const collector = createPageEventCollector();
  let materialized = 0;
  const details = () => { materialized++; return { text: "evidence" }; };
  for (let i = 0; i < 10000; i++) collector.record("console.log", details);
  for (let i = 0; i < 123; i++) collector.record("pageerror", () => ({ error: { message: `runtime ${i}` } }));
  for (let i = 0; i < 234; i++) collector.record("requestfailed", details);
  for (let i = 0; i < 67; i++) collector.record("console.error", details);
  for (let i = 0; i < 89; i++) collector.record("log.entry", details, { level: "error" });
  const { pageEvents, pageEventSummary: summary } = collector.snapshot();
  assert.equal(summary.total, 10513);
  assert.equal(summary.retained, 400);
  assert.equal(summary.dropped, 10113);
  assert.equal(summary.truncated, 0);
  assert.deepEqual(summary.counts, { console: 10000, consoleError: 67, pageerror: 123, requestfailed: 234, log: 0, logError: 89, httpError: 0, renderingError: 0, renderingErrorWebgpu: 0 });
  assert.equal(materialized, 350);
  assert.equal(pageEvents.find(event => event.type === "pageerror").error.message, "runtime 0");
  assert.equal(pageEvents.filter(event => event.type === "pageerror").length, 50);
  assert.equal(pageEvents.filter(event => event.type === "requestfailed").length, 50);
});

test("event payload bounds handle huge strings, stacks, and cyclic nested diagnostics", () => {
  const collector = createPageEventCollector();
  const deep = { frames: Array.from({ length: 100 }, () => ({ url: "x".repeat(10000), functionName: "y".repeat(10000) })) };
  deep.parent = deep;
  collector.record("pageerror", { error: { message: "bad".repeat(10000), stack: deep } });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.equal(pageEventSummary.truncated, 1);
  assert.equal(pageEventSummary.dropped, 0);
  assert.equal(pageEvents[0].error.message.length, PAGE_EVENT_LIMITS.stringChars);
  assert.ok(JSON.stringify(pageEvents).length < 12000);
  assert.equal(pageEvents[0].type, "pageerror");
});

test("snapshots preserve earlier counts and report chronology", () => {
  const collector = createPageEventCollector();
  collector.record("console.log", { text: "first" });
  const first = collector.snapshot();
  collector.record("pageerror", { error: { message: "second" } });
  assert.equal(first.pageEventSummary.total, 1);
  assert.equal(first.pageEventSummary.counts.pageerror, 0);
  assert.equal(first.pageEvents.length, 1);
  assert.deepEqual(collector.snapshot().pageEvents.map(event => event.type), ["console.log", "pageerror"]);
});

test("CDP adapter bounds console arguments and preserves detailed runtime errors", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  session.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello" }, { value: 1 }, { description: "Object" }] });
  session.emit("Runtime.consoleAPICalled", { type: "error", args: Array.from({ length: 100 }, () => ({ value: "short" })) });
  session.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "Error: device lost" }, stackTrace: { callFrames: [{ url: "scene.js" }] } } });
  session.emit("Log.entryAdded", { entry: { level: "error", source: "rendering", text: "GPU warning" } });
  session.emit("Network.loadingFailed", { errorText: "ERR_FAILED", requestId: "request-1" });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.deepEqual(pageEvents[0], { args: ["hello", 1, "Object"], text: "hello 1 Object", type: "console.log" });
  assert.equal(pageEvents[1].argsOmitted, 84);
  assert.equal(pageEvents[1].args.length, 16);
  assert.equal(pageEvents[2].error.message, "Error: device lost");
  assert.equal(pageEventSummary.truncated, 1);
  assert.equal(pageEventSummary.counts.consoleError, 1);
  assert.equal(pageEventSummary.counts.logError, 1);
  assert.equal(pageEventSummary.counts.requestfailed, 1);
});

test("Playwright adapter skips saturated log text and retains subsequent errors", () => {
  const page = emitter();
  const collector = capturePlaywrightPageEvents(page);
  let textReads = 0;
  for (let i = 0; i < 1000; i++) page.emit("console", { type: () => "log", text: () => { textReads++; return "rendering"; }, location: () => ({ url: "scene.js" }) });
  page.emit("pageerror", new Error("device lost"));
  page.emit("requestfailed", { failure: () => ({ errorText: "ERR_FAILED" }), url: () => "https://example.test/model.bin" });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.equal(textReads, 200);
  assert.equal(pageEventSummary.total, 1002);
  assert.equal(pageEventSummary.dropped, 800);
  assert.equal(pageEvents[200].error.message, "device lost");
  assert.match(pageEvents[200].error.stack, /device lost/);
  assert.equal(pageEvents[201].failure, "ERR_FAILED");
});

test("failed captures carry bounded evidence without replacing the original error", () => {
  const collector = createPageEventCollector();
  collector.record("pageerror", { error: { message: "initial problem" } });
  const failure = Object.assign(new Error("Timed out sampling page."), { code: "TIMEOUT" });
  assert.equal(withCaptureDiagnostics(failure, collector), failure);
  assert.equal(failure.code, "TIMEOUT");
  assert.equal(failure.captureDiagnostics.pageEventSummary.counts.pageerror, 1);
  collector.record("pageerror", { error: { message: "after cleanup" } });
  assert.equal(withCaptureDiagnostics(failure, collector).captureDiagnostics.pageEventSummary.counts.pageerror, 1);
});

function mockBrowser({ navigationError, samplingError } = {}) {
  const calls = [];
  const session = emitter();
  session.send = async method => {
    calls.push(method);
    if (method === "Page.navigate") {
      for (let i = 0; i < 1000; i++) session.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: `frame ${i}` }] });
      for (let i = 0; i < 100; i++) session.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: `error ${i}` } } });
      if (navigationError) throw new Error("Navigation timed out");
    }
    if (method === "Runtime.evaluate") {
      if (samplingError) throw new Error("Timed out sampling page.");
      return { result: { value: { samples: [{ measurement: { gpuMs: 2 } }] } } };
    }
    return {};
  };
  const browser = {
    session: () => session,
    close() {},
    async send(method) {
      calls.push(method);
      if (method === "Target.createBrowserContext") return { browserContextId: "job" };
      if (method === "Target.createTarget") return { targetId: "target" };
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      return {};
    }
  };
  return { browser, session, calls };
}

test("Fast harness returns bounded events and exact dropped-error counts", async () => {
  const { browser, session, calls } = mockBrowser();
  const harness = new FastCDPHarness({ args: [], close: async () => {} }, browser);
  const report = await harness.run({ url: "https://example.test", waitUntil: "commit", samples: 1 });
  assert.equal(report.pageEvents.length, 250);
  assert.equal(report.pageEventSummary.total, 1100);
  assert.equal(report.pageEventSummary.counts.pageerror, 100);
  assert.equal(report.pageEvents.filter(event => event.type === "pageerror").length, 50);
  assert.equal(Object.hasOwn(report.pageEventSummary, "retainedCounts"), false);
  assert.equal(report.pageEventSummary.dropped, 850);
  assert.equal(session.listeners.size, 0);
  assert.ok(calls.includes("Target.disposeBrowserContext"));
  await harness.close();
});

for (const phase of ["navigationError", "samplingError"]) {
  test(`Fast harness preserves evidence and closes the context after ${phase}`, async () => {
    const { browser, session, calls } = mockBrowser({ [phase]: true });
    const harness = new FastCDPHarness({ args: [], close: async () => {} }, browser);
    await assert.rejects(harness.run({ url: "https://example.test", waitUntil: "commit", samples: 1 }), failure => {
      assert.equal(failure.captureDiagnostics.pageEvents.length, 250);
      assert.equal(failure.captureDiagnostics.pageEventSummary.counts.pageerror, 100);
      assert.equal(failure.captureDiagnostics.pageEventSummary.dropped, 850);
      return true;
    });
    assert.equal(session.listeners.size, 0);
    assert.ok(calls.includes("Target.disposeBrowserContext"));
    await harness.close();
  });
}

// ---- 2.2.0: request URLs, HTTP errors, rendering errors, failed resources (§1.8)
const ORIGIN = "http://127.0.0.1:5173";
function navigate(session) {
  session.emit("Page.frameNavigated", { frame: { id: "main", url: `${ORIGIN}/index.html` } });
  session.emit("Network.requestWillBeSent", { requestId: "doc", type: "Document", frameId: "main", request: { url: `${ORIGIN}/index.html` } });
  session.emit("Network.responseReceived", { requestId: "doc", type: "Document", frameId: "main", response: { url: `${ORIGIN}/index.html`, status: 200 } });
  session.emit("Network.loadingFinished", { requestId: "doc" });
}

test("failed requests record their URL, resource type, status and frame instead of the request id", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  navigate(session);
  session.emit("Network.requestWillBeSent", { requestId: "7.1", type: "Script", frameId: "main", request: { url: "https://unpkg.com/three.module.js" } });
  session.emit("Network.loadingFailed", { requestId: "7.1", type: "Script", errorText: "net::ERR_SOCKET_NOT_CONNECTED", canceled: false });
  session.emit("Network.loadingFailed", { requestId: "unknown.9", type: "Fetch", errorText: "net::ERR_FAILED" });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.deepEqual(pageEvents[0], { url: "https://unpkg.com/three.module.js", resourceType: "Script", status: null,
    failure: "net::ERR_SOCKET_NOT_CONNECTED", canceled: false, requestId: "7.1", frameId: "main", type: "requestfailed" });
  assert.equal(pageEvents[1].url, "unknown.9", "the request id is used only when the URL is unknown");
  assert.equal(pageEvents[1].resourceType, "Fetch");
  assert.deepEqual(pageEventSummary.failedResources[0], { url: "https://unpkg.com/three.module.js", resourceType: "Script",
    status: null, failure: "net::ERR_SOCKET_NOT_CONNECTED", critical: false });
  assert.equal(Object.hasOwn(pageEventSummary, "limits"), false);
  assert.equal(Object.hasOwn(pageEventSummary, "retainedCounts"), false);
});

test("HTTP errors are their own event with a reserved bucket; a 404 module is critical when same-origin", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  navigate(session);
  session.emit("Network.requestWillBeSent", { requestId: "m", type: "Script", frameId: "main", request: { url: `${ORIGIN}/missing.js` } });
  session.emit("Network.responseReceived", { requestId: "m", type: "Script", frameId: "main", response: { url: `${ORIGIN}/missing.js`, status: 404 } });
  session.emit("Network.loadingFailed", { requestId: "m", type: "Script", errorText: "net::ERR_ABORTED", canceled: false });
  for (let i = 0; i < 120; i++) {
    session.emit("Network.requestWillBeSent", { requestId: `img${i}`, type: "Image", frameId: "main", request: { url: `${ORIGIN}/img${i}.png` } });
    session.emit("Network.responseReceived", { requestId: `img${i}`, type: "Image", response: { url: `${ORIGIN}/img${i}.png`, status: 404 } });
    session.emit("Network.loadingFinished", { requestId: `img${i}` });
  }
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.deepEqual(pageEvents[0], { url: `${ORIGIN}/missing.js`, resourceType: "Script", status: 404, type: "httperror" });
  assert.equal(pageEvents[1].type, "requestfailed");
  assert.equal(pageEvents[1].status, 404);
  assert.equal(pageEventSummary.counts.httpError, 121);
  assert.equal(pageEvents.filter(event => event.type === "httperror").length, 50);
  assert.equal(pageEventSummary.failedResources.length, 5);
  assert.deepEqual(pageEventSummary.failedResources[0], { url: `${ORIGIN}/missing.js`, resourceType: "Script", status: 404,
    failure: "net::ERR_ABORTED", critical: true });
});

test("canceled requests are events but not failed resources; a failed main document is critical", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  session.emit("Network.requestWillBeSent", { requestId: "doc", type: "Document", frameId: "main", request: { url: `${ORIGIN}/gone.html` } });
  session.emit("Network.responseReceived", { requestId: "doc", type: "Document", frameId: "main", response: { url: `${ORIGIN}/gone.html`, status: 404 } });
  session.emit("Network.requestWillBeSent", { requestId: "c", type: "Fetch", frameId: "main", request: { url: `${ORIGIN}/abort` } });
  session.emit("Network.loadingFailed", { requestId: "c", type: "Fetch", errorText: "net::ERR_ABORTED", canceled: true });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.deepEqual(pageEventSummary.failedResources, [{ url: `${ORIGIN}/gone.html`, resourceType: "Document", status: 404, failure: null, critical: true }]);
  assert.equal(pageEvents.find(event => event.type === "requestfailed").canceled, true);
});

test("failed resources keep Document/Script failures when the list is full", () => {
  const collector = createPageEventCollector();
  for (let i = 0; i < 6; i++) collector.noteFailedResource({ url: `img${i}`, resourceType: "Image", status: 404 });
  collector.noteFailedResource({ url: "late.js", resourceType: "Script", failure: "net::ERR_FAILED" });
  collector.noteFailedResource({ url: "img9", resourceType: "Image", status: 404 });
  const list = collector.snapshot().pageEventSummary.failedResources;
  assert.equal(list.length, 5);
  assert.deepEqual(list.map(item => item.url), ["img0", "img1", "img2", "img3", "late.js"]);
});

test("rendering log errors get their own category, bucket and first three texts; log entries keep their URL", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  for (let i = 0; i < 260; i++) session.emit("Log.entryAdded", { entry: { level: "verbose", source: "other", text: `noise ${i}` } });
  for (let i = 0; i < 70; i++) {
    session.emit("Log.entryAdded", { entry: { level: "warning", source: "rendering",
      text: `WebGL: INVALID_OPERATION: useProgram: program not valid ${i} ${"x".repeat(300)}`, url: `${ORIGIN}/app.js`, lineNumber: 12 } });
  }
  session.emit("Log.entryAdded", { entry: { level: "warning", source: "rendering", text: "GPU stall due to ReadPixels" } });
  session.emit("Log.entryAdded", { entry: { level: "error", source: "network", text: "Failed to load resource: 404", url: `${ORIGIN}/x.js` } });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.equal(pageEventSummary.counts.renderingError, 70);
  assert.equal(pageEventSummary.counts.log, 261, "a rendering warning that is not an error stays routine");
  assert.equal(pageEventSummary.counts.logError, 1);
  assert.equal(pageEventSummary.renderingErrors.length, 3);
  assert.ok(pageEventSummary.renderingErrors.every(text => text.length === 200));
  assert.match(pageEventSummary.renderingErrors[0], /^WebGL: INVALID_OPERATION: useProgram: program not valid 0 /);
  const rendering = pageEvents.filter(event => event.source === "rendering" && /INVALID_/.test(event.text));
  assert.equal(rendering.length, 50, "rendering errors are retained after the routine bucket filled");
  assert.equal(rendering[0].url, `${ORIGIN}/app.js`);
  assert.equal(rendering[0].lineNumber, 12);
  assert.equal(pageEvents.find(event => event.level === "error").url, `${ORIGIN}/x.js`);
});

test("rendering-error text rule matches WebGPU and WebGL validation messages only", () => {
  const match = text => isRenderingLogEntry({ source: "rendering", level: "warning", text });
  for (const text of ["Error while parsing WGSL: :4:12 error", "WebGL: INVALID_ENUM: getParameter", "[Buffer] is invalid.",
    "Invalid CommandBuffer", "Validation error", "WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost",
    "WebGL: too many errors, no more errors will be reported",
    "[.WebGL-0x12c00a3e00] GL_INVALID_ENUM: glTexStorage2D: The <internalformat> is not a sized format",
    "[.WebGL-0x1] GL_INVALID_FRAMEBUFFER_OPERATION: glDrawArrays: Framebuffer is incomplete", "the GPU device was lost"]) {
    assert.ok(match(text), text);
  }
  assert.equal(match("GPU stall due to ReadPixels"), false);
  assert.equal(match("Pass colostate resolved"), false, "\"lost\" must be a whole word");
  assert.equal(isRenderingLogEntry({ source: "javascript", level: "error", text: "Invalid value" }), false);
  assert.equal(isRenderingLogEntry({ source: "rendering", level: "info", text: "Invalid value" }), false);
});

test("the requestId map is bounded at 2000 entries", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  for (let i = 0; i < 2500; i++) session.emit("Network.requestWillBeSent", { requestId: `r${i}`, type: "XHR", request: { url: `${ORIGIN}/poll/${i}` } });
  session.emit("Network.loadingFailed", { requestId: "r0", type: "XHR", errorText: "net::ERR_FAILED" });
  session.emit("Network.loadingFailed", { requestId: "r2499", type: "XHR", errorText: "net::ERR_FAILED" });
  const [evicted, kept] = collector.snapshot().pageEvents;
  assert.equal(evicted.url, "r0");
  assert.equal(kept.url, `${ORIGIN}/poll/2499`);
});

test("Playwright adapter records failed URLs, CDP resource types and HTTP errors", () => {
  const page = emitter();
  const mainFrame = {};
  page.mainFrame = () => mainFrame;
  const collector = capturePlaywrightPageEvents(page);
  const request = { url: () => "https://cdn.test/three.js", resourceType: () => "script", frame: () => mainFrame, failure: () => ({ errorText: "net::ERR_FAILED" }) };
  page.emit("requestfailed", request);
  const doc = { resourceType: () => "document", frame: () => mainFrame };
  page.emit("response", { status: () => 404, url: () => "https://site.test/", request: () => doc });
  page.emit("response", { status: () => 200, url: () => "https://site.test/ok.js", request: () => request });
  const { pageEvents, pageEventSummary } = collector.snapshot();
  assert.equal(pageEvents[0].resourceType, "Script");
  assert.deepEqual(pageEvents[1], { url: "https://site.test/", resourceType: "Document", status: 404, type: "httperror" });
  assert.equal(pageEventSummary.counts.httpError, 1);
  assert.deepEqual(pageEventSummary.failedResources.map(item => [item.resourceType, item.critical]), [["Script", false], ["Document", true]]);
});

test("Chrome's echoes of uncaptured WebGPU errors are counted apart from WebGL rendering errors", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  const echoes = ["[Invalid CommandBuffer] is invalid due to a previous error.",
    "Error while parsing WGSL: :14:18 error: no matching constructor",
    "[Invalid RenderPipeline (unlabeled)] is invalid due to a previous error.\n - While encoding [RenderPassEncoder (unlabeled)].SetPipeline(...).\n"];
  for (const text of echoes) session.emit("Log.entryAdded", { entry: { level: "warning", source: "rendering", text } });
  for (const text of ["WebGL: INVALID_OPERATION: drawArrays: no valid shader program in use",
    "[.WebGL-0x1] GL_INVALID_ENUM: glTexStorage2D: bad format"]) {
    session.emit("Log.entryAdded", { entry: { level: "warning", source: "rendering", text } });
  }
  const { counts } = collector.snapshot().pageEventSummary;
  assert.equal(counts.renderingError, 5);
  assert.equal(counts.renderingErrorWebgpu, 3);
  assert.equal(isWebgpuRenderingEcho("WebGL: INVALID_VALUE: vertexAttribPointer: index out of range"), false);
});

test("a failure with no known URL is one failed resource, not two", () => {
  const session = emitter();
  const collector = captureCdpPageEvents(session);
  navigate(session);
  for (const id of ["4", "5", "6"]) session.emit("Network.loadingFailed", { requestId: id, type: "Image", errorText: "net::ERR_FAILED" });
  // A response with no requestId (never sent by CDP) must not throw.
  session.emit("Network.responseReceived", { type: "Image", response: { url: `${ORIGIN}/x.png`, status: 404 } });
  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.pageEventSummary.failedResources.slice(0, 3).map(item => item.url), ["4", "5", "6"]);
  const report = { target: { url: `${ORIGIN}/index.html` }, ...snapshot };
  assert.deepEqual(failedResources(report).map(item => item.url), ["4", "5", "6", `${ORIGIN}/x.png`]);
});
