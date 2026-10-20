import assert from "node:assert/strict";
import test from "node:test";
import { createPageEventCollector, captureCdpPageEvents, capturePlaywrightPageEvents, withCaptureDiagnostics, PAGE_EVENT_LIMITS } from "../src/page-events.js";
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
  assert.deepEqual(summary.counts, { console: 10000, consoleError: 67, pageerror: 123, requestfailed: 234, log: 0, logError: 89 });
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
  assert.equal(report.pageEventSummary.retainedCounts.pageerror, 50);
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
