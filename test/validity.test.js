import assert from 'node:assert/strict';
import test from 'node:test';
import { reportValidity } from '../src/validity.js';
import { finalizeReport } from '../src/analysis.js';
import { compareReports } from '../src/compare.js';
import { compactReport, comparisonExitCode, formatAgentReport, formatAgentComparison } from '../src/output.js';

const report = () => ({ options: {samples: 1}, inPage: {samples: [{measurement: {gpuMs: 0}}]} });

test('validity distinguishes zero measurements from absent evidence and failed samples', () => {
  assert.equal(reportValidity(report()).valid, true);
  assert.equal(reportValidity({}).valid, false);
  const failed = report();
  failed.inPage.samples[0].error = {message: 'draw failed'};
  const finalized = finalizeReport(failed);
  assert.equal(finalized.diagnostics.validity.valid, false);
  assert.equal(compactReport(finalized).ok, false);
  assert.match(formatAgentReport(finalized), /GPU INVALID/);
  const comparison = compareReports(report(), finalized);
  assert.equal(comparisonExitCode(comparison, {allowMismatch: true}), 2);
  assert.match(formatAgentComparison(comparison), /INVALID/);
  assert.equal(comparisonExitCode(compareReports({}, {}), {allowMismatch: true}), 2);
});

test('runtime errors, missing samples, unavailable API and failed requested capture invalidate evidence', () => {
  const cases = [
    r => {r.pageEvents = [{type: 'pageerror', message: 'device lost'}];},
    r => {r.options.samples = 2;},
    r => {r.options.api = 'webgpu'; r.inPage.apiSupport = {webgpu: {available: false}};},
    r => {r.options.autoInstrument = true; r.inPage.instrumentation = {after: null};},
    r => {r.options.trace = true; r.trace = {captured: false};},
    r => {r.options.waitForHook = true; r.inPage.hook = {found: false};}
  ];
  for (const change of cases) {
    const r = report(); change(r);
    assert.equal(reportValidity(r).valid, false, JSON.stringify(r));
  }
  const network = report();
  network.pageEvents = [{type: 'requestfailed', url: 'https://telemetry.invalid'}];
  assert.equal(reportValidity(network).valid, true);
});

test('an empty frame observer is not evidence of a measured workload', () => {
  const r = report();
  r.inPage.samples[0].measurement = {type: 'raf', frameCount: 0, fps: null, durationMs: 0, slowFrameCount: 0};
  assert.equal(reportValidity(r).valid, false);
});

test('dropped runtime errors still invalidate measurements and all failures stay counted', () => {
  const r = report();
  r.pageEvents = [{ type: 'pageerror', error: { message: 'first failure' } }, { type: 'requestfailed' }];
  r.pageEventSummary = { total: 10100, retained: 2, dropped: 10098, truncated: 1, counts: { pageerror: 60, requestfailed: 40, console: 10000 } };
  const result = finalizeReport(r);
  assert.equal(result.diagnostics.validity.issues.find(issue => issue.code === 'runtime-errors').count, 60);
  assert.equal(result.diagnostics.pageErrors.length, 2);
  assert.equal(result.diagnostics.pageErrorCount, 100);
  // §5.3: page-errors is an info finding (non-critical failed requests); runtime errors are validity issues.
  assert.ok(result.summary.findings.some(finding => finding.code === 'page-errors' && finding.role === 'info'));
  const compact = compactReport(result);
  assert.equal(compact.ok, false);
  assert.equal(compact.diagnostics.pageErrorCount, 100);
  assert.equal(compact.diagnostics.pageErrorsOmitted, 98);
  assert.deepEqual(compact.pageEventSummary, r.pageEventSummary);
  assert.match(formatAgentReport(result), /2\/10100 events retained; 10098 dropped, 1 shortened/);
  assert.equal(comparisonExitCode(compareReports(report(), r)), 2);

  r.pageEvents = [];
  assert.equal(reportValidity(r).valid, false);
  r.pageEventSummary.counts.pageerror = 0;
  assert.equal(reportValidity(r).valid, true, 'network failures alone remain warnings');
  assert.equal(finalizeReport(r).diagnostics.pageErrorCount, 40);
});

test('malformed or lower event counters cannot hide retained failures', () => {
  for (const pageerror of [0, -1, null, NaN, Infinity, '100', 1.5]) {
    const r = report();
    r.pageEvents = [{ type: 'pageerror' }, { type: 'pageerror' }];
    r.pageEventSummary = { counts: { pageerror } };
    assert.equal(reportValidity(r).issues.find(issue => issue.code === 'runtime-errors').count, 2);
  }
});

test('hook mode requires a real hook and cannot waive incomplete samples using FPS convergence', () => {
  const r = report();
  r.options.samplingMode = 'hook';
  assert.equal(reportValidity(r).valid, false);
  r.inPage.hook = { found: true };
  assert.equal(reportValidity(r).valid, true, 'zero GPU time remains a numeric measurement');
  const finalized = finalizeReport(r);
  assert.equal(finalized.summary.fps, null);
  assert.equal(finalized.diagnostics.signal.samplingMode, 'hook');
  assert.match(formatAgentReport(finalized), /Sampling: hook completion/);
  assert.ok(!finalized.summary.warnings.some(warning => warning.code === 'limited-frame-signal'));
  assert.ok(finalizeReport({ ...r, options: { ...r.options, samplingMode: 'frames' } }).summary.warnings.some(warning => warning.code === 'limited-frame-signal'));
  r.options.samples = 5;
  r.options.adaptive = true;
  r.inPage.samples = Array.from({ length: 3 }, () => ({ measurement: { gpuMs: 0, fps: 60 } }));
  r.inPage.sampling = { adaptive: true, stoppedEarly: true, reason: 'fps-converged', coefficientOfVariation: 0 };
  const validity = reportValidity(r);
  assert.ok(validity.issues.some(issue => issue.code === 'incomplete-samples'));
  assert.ok(validity.issues.some(issue => issue.code === 'incompatible-sampling'));
});

// ---- 2.2.0: every §3.1 code on v3 fixtures
import { readFileSync } from 'node:fs';
import { failedResources, pageErrorCounts } from '../src/validity.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v3/${name}`, import.meta.url), 'utf8'));
const capture = () => fixture('report-capture.json');
const codes = entries => entries.map(entry => entry.code);
const invalidCodes = r => codes(reportValidity(r).issues);
const warningCodesOf = r => codes(reportValidity(r).warnings);
const ORIGIN = 'http://127.0.0.1:57216';
const noWork = r => {
  for (const key of Object.keys(r.inPage.instrumentation.delta)) r.inPage.instrumentation.delta[key] = 0;
  return r;
};

test('fixtures: clean capture has no issues or warnings, every entry carries code, severity and message', () => {
  assert.deepEqual(reportValidity(capture()), { valid: true, issues: [], warnings: [] });
  assert.equal(reportValidity(fixture('report-v2.json')).valid, true);
  for (const name of ['report-saturated.json', 'report-clock-sensitive.json', 'report-hook-warm.json', 'report-hookmode.json']) {
    assert.deepEqual(reportValidity(fixture(name)), { valid: true, issues: [], warnings: [] }, name);
  }
  const r = capture();
  r.runError = { code: 'navigation-timeout', message: 'Timed out' };
  r.target.httpStatus = 500;
  r.measurementLock.timedOut = true;
  const validity = reportValidity(r);
  for (const entry of [...validity.issues, ...validity.warnings]) {
    assert.equal(typeof entry.code, 'string');
    assert.equal(typeof entry.message, 'string');
    assert.ok(['invalid', 'warning'].includes(entry.severity));
  }
  assert.ok(validity.issues.every(entry => entry.severity === 'invalid'));
  assert.ok(validity.warnings.every(entry => entry.severity === 'warning'));
});

test('run-failed and document-http-status invalidate the capture', () => {
  const failed = capture();
  failed.runError = { code: 'navigation-timeout', message: 'Navigation timed out after 30000 ms.' };
  const issue = reportValidity(failed).issues.find(entry => entry.code === 'run-failed');
  assert.equal(issue.message, 'Capture failed: Navigation timed out after 30000 ms.');
  const missing = capture();
  missing.target.httpStatus = 404;
  missing.pageEvents = [{ type: 'httperror', url: missing.target.url, resourceType: 'Document', status: 404 }];
  const validity = reportValidity(missing);
  assert.deepEqual(codes(validity.issues), ['document-http-status'], 'the main document is not listed twice');
  assert.equal(validity.issues[0].message, `Main document returned HTTP 404 (${missing.target.documentUrl}).`);
});

test('critical-resource-failed: main document, same-origin scripts, and any script when no GPU work was seen', () => {
  const sameOrigin = capture();
  sameOrigin.pageEvents = [{ type: 'requestfailed', url: `${ORIGIN}/src/app.js`, resourceType: 'Script', status: null,
    failure: 'net::ERR_ABORTED', canceled: false, requestId: '1.2', frameId: 'main' }];
  const issue = reportValidity(sameOrigin).issues.find(entry => entry.code === 'critical-resource-failed');
  assert.equal(issue.message, `Failed to load Script ${ORIGIN}/src/app.js (net::ERR_ABORTED).`);

  const cdn = { type: 'requestfailed', url: 'https://unpkg.com/three@0.160.0/build/three.module.js', resourceType: 'Script',
    status: null, failure: 'net::ERR_SOCKET_NOT_CONNECTED', canceled: false, requestId: '2.1', frameId: 'main' };
  const working = capture();
  working.pageEvents = [cdn];
  assert.deepEqual(invalidCodes(working), [], 'a cross-origin script failure on a page that renders is a warning');
  assert.deepEqual(warningCodesOf(working), ['resource-failed']);
  const broken = noWork(capture());
  broken.pageEvents = [cdn];
  assert.deepEqual(invalidCodes(broken), ['critical-resource-failed', 'no-gpu-work']);
  assert.match(reportValidity(broken).issues[1].message, /First failed request: https:\/\/unpkg\.com/);
  const blank = fixture('report-blank.json');
  blank.pageEvents = [cdn];
  assert.deepEqual(invalidCodes(blank), ['critical-resource-failed'], 'gpu-work-unobserved also makes scripts critical');

  const httpScript = capture();
  httpScript.pageEventSummary.failedResources = [{ url: `${ORIGIN}/missing.js`, resourceType: 'Script', status: 404, failure: null, critical: true }];
  assert.match(reportValidity(httpScript).issues[0].message, /Script http:\/\/127\.0\.0\.1:57216\/missing\.js \(404\)/);
});

test('resource-failed warns for other failures; canceled requests and non-errors are ignored', () => {
  const r = capture();
  r.pageEvents = [
    { type: 'httperror', url: `${ORIGIN}/img.png`, resourceType: 'Image', status: 404 },
    { type: 'requestfailed', url: `${ORIGIN}/api`, resourceType: 'Fetch', status: null, failure: 'net::ERR_ABORTED', canceled: true },
    { type: 'requestfailed', url: `${ORIGIN}/font.woff2`, resourceType: 'Font', status: null, failure: 'net::ERR_FAILED', canceled: false }
  ];
  const validity = reportValidity(r);
  assert.equal(validity.valid, true);
  assert.deepEqual(codes(validity.warnings), ['resource-failed']);
  assert.equal(validity.warnings[0].message, `1 request(s) failed, first: ${ORIGIN}/img.png.`);
  assert.deepEqual(failedResources(r).map(resource => [resource.url, resource.critical]),
    [[`${ORIGIN}/img.png`, false], [`${ORIGIN}/font.woff2`, false]]);
  // v2 events recorded the requestId as the URL and no type: still reported, never critical.
  const legacy = fixture('report-v2.json');
  legacy.pageEvents = [{ type: 'requestfailed', failure: 'net::ERR_ABORTED', url: '27673.2' }];
  assert.equal(reportValidity(legacy).valid, true);
  assert.deepEqual(warningCodesOf(legacy), ['resource-failed']);
});

test('gpu-api-errors: in-window uncaptured errors, lost devices and contexts, shader failures, rendering logs', () => {
  const cases = {
    inWindow: r => { r.inPage.summary.gpuErrors = { ...r.inPage.summary.gpuErrors, total: 3, inWindow: 3, top: [{ message: 'Invalid CommandBuffer.\n - details', count: 3 }] }; },
    lost: r => { r.inPage.summary.gpuErrors.deviceLost = [{ reason: 'unknown', message: 'GPU process crashed' }]; },
    contextLost: r => { r.inPage.instrumentation.after.counters['webgl.contextLost'] = 1; },
    shader: r => { r.inPage.instrumentation.after.counters['webgl.shaderCompileFailures'] = 1; },
    rendering: r => { r.pageEventSummary.counts.renderingError = 5; r.pageEventSummary.renderingErrors = ["Error while parsing WGSL: :4:12 error: no matching constructor"]; },
    sentinel: r => { r.pageEventSummary.counts.renderingError = 2;
      r.pageEvents = [{ type: 'log.entry', level: 'warning', source: 'rendering', text: 'WebGL: too many errors, no more errors will be reported to the console for this context.' }]; }
  };
  for (const [name, change] of Object.entries(cases)) {
    const r = capture();
    change(r);
    assert.deepEqual(invalidCodes(r), ['gpu-api-errors'], name);
  }
  const r = capture();
  cases.inWindow(r);
  assert.equal(reportValidity(r).issues[0].message, '3 GPU API error(s): "Invalid CommandBuffer.".');
  const rendering = capture();
  cases.rendering(rendering);
  assert.match(reportValidity(rendering).issues[0].message, /"Error while parsing WGSL/);
});

test('a destroyed device is not an error; errors before warmup and 1-4 rendering errors are warnings', () => {
  const destroyed = capture();
  destroyed.inPage.summary.gpuErrors.deviceLost = [{ reason: 'destroyed', message: 'Device was destroyed.' }];
  assert.deepEqual(reportValidity(destroyed), { valid: true, issues: [], warnings: [] });
  const startup = capture();
  startup.inPage.summary.gpuErrors = { ...startup.inPage.summary.gpuErrors, total: 2, inWindow: 0 };
  assert.deepEqual(warningCodesOf(startup), ['gpu-api-warnings']);
  assert.equal(reportValidity(startup).valid, true);
  const fewLogs = capture();
  fewLogs.pageEventSummary.counts.renderingError = 4;
  assert.deepEqual(warningCodesOf(fewLogs), ['gpu-api-warnings']);
});

test('Chrome echoes of uncaptured WebGPU errors follow the window rule, not the rendering-log count', () => {
  const echoed = r => { r.pageEventSummary.counts = { ...r.pageEventSummary.counts, renderingError: 12, renderingErrorWebgpu: 12 };
    r.pageEventSummary.renderingErrors = ['[Invalid CommandBuffer] is invalid due to a previous error.']; };
  const startup = capture();
  startup.inPage.summary.gpuErrors = { ...startup.inPage.summary.gpuErrors, total: 12, inWindow: 0 };
  echoed(startup);
  assert.deepEqual(invalidCodes(startup), [], '12 WebGPU errors before warmup only');
  assert.deepEqual(warningCodesOf(startup), ['gpu-api-warnings']);
  assert.match(reportValidity(startup).warnings[0].message, /^12 GPU API error\(s\)/, 'each error is counted once');
  const ongoing = capture();
  ongoing.inPage.summary.gpuErrors = { ...ongoing.inPage.summary.gpuErrors, total: 12, inWindow: 7 };
  echoed(ongoing);
  assert.deepEqual(invalidCodes(ongoing), ['gpu-api-errors']);
  assert.match(reportValidity(ongoing).issues[0].message, /^7 GPU API error\(s\)/);
  const webgl = capture();
  webgl.inPage.summary.gpuErrors = { ...webgl.inPage.summary.gpuErrors, total: 12, inWindow: 0 };
  echoed(webgl);
  webgl.pageEventSummary.counts.renderingError = 17; // 5 WebGL errors besides the 12 echoes
  assert.deepEqual(invalidCodes(webgl), ['gpu-api-errors']);
  const untracked = capture();
  delete untracked.inPage.summary.gpuErrors;
  delete untracked.inPage.instrumentation;
  untracked.options.autoInstrument = false;
  echoed(untracked);
  assert.ok(invalidCodes(untracked).includes('gpu-api-errors'), 'without in-page error counts the echoes are the only evidence');
});

test('malformed saved event lists do not throw', () => {
  const r = capture();
  r.pageEventSummary.failedResources = { url: 'x' };
  r.pageEventSummary.renderingErrors = 'text';
  r.pageEvents = [null, 3, { type: 'requestfailed', url: `${ORIGIN}/a.png`, resourceType: 'Image', failure: 'net::ERR_FAILED' }];
  assert.deepEqual(warningCodesOf(r), ['resource-failed']);
  r.pageEvents = { length: 2 };
  assert.deepEqual(reportValidity(r), { valid: true, issues: [], warnings: [] });
});

test('the uncaptured-error window is warmup+sampling, from warmupStartCounters, else the sampling window', () => {
  const warmup = capture();
  delete warmup.inPage.summary.gpuErrors;
  const { after, warmupStartCounters } = { after: warmup.inPage.instrumentation.after.counters, warmupStartCounters: warmup.inPage.instrumentation.warmupStartCounters };
  warmupStartCounters['webgpu.uncapturedErrors'] = 1;
  after['webgpu.uncapturedErrors'] = 2; // one during warmup, none during sampling
  assert.deepEqual(invalidCodes(warmup), ['gpu-api-errors']);
  const setup = capture();
  delete setup.inPage.summary.gpuErrors;
  setup.inPage.instrumentation.warmupStartCounters['webgpu.uncapturedErrors'] = 2;
  setup.inPage.instrumentation.after.counters['webgpu.uncapturedErrors'] = 2;
  assert.deepEqual(invalidCodes(setup), []);
  assert.deepEqual(warningCodesOf(setup), ['gpu-api-warnings']);
  const older = capture();
  delete older.inPage.summary.gpuErrors;
  delete older.inPage.instrumentation.warmupStartCounters;
  older.inPage.instrumentation.after.counters['webgpu.uncapturedErrors'] = 2;
  assert.deepEqual(invalidCodes(older), [], 'no warmup counters: only sampling-window errors invalidate');
  older.inPage.instrumentation.delta['webgpu.uncapturedErrors'] = 1;
  assert.deepEqual(invalidCodes(older), ['gpu-api-errors']);
});

test('no-gpu-work invalidates frames captures with an app context but no work; allowIdle makes it a warning', () => {
  const idle = noWork(capture());
  const issue = reportValidity(idle).issues.find(entry => entry.code === 'no-gpu-work');
  assert.equal(issue.message, 'No GPU work during sampling (0 submits, 0 draws, 0 clears); hook not found.');
  idle.options.allowIdle = true;
  assert.deepEqual(invalidCodes(idle), []);
  assert.deepEqual(warningCodesOf(idle), ['no-gpu-work']);
  const clearOnly = noWork(capture());
  clearOnly.inPage.instrumentation.delta['webgl2.clearCalls'] = 90;
  assert.deepEqual(invalidCodes(clearOnly), [], 'clears are GPU work');
  const bundles = noWork(capture());
  bundles.inPage.instrumentation.delta['webgpu.bundleDrawsExecuted'] = 90;
  assert.deepEqual(invalidCodes(bundles), []);
  const hookMode = noWork(capture());
  hookMode.options.samplingMode = 'hook';
  hookMode.inPage.hook.found = true;
  assert.ok(!invalidCodes(hookMode).includes('no-gpu-work'));
  const manual = noWork(capture());
  manual.options.autoInstrument = false;
  assert.ok(!invalidCodes(manual).includes('no-gpu-work'));
});

test('gpu-work-unobserved: no app context (blank page) or off-main-thread rendering', () => {
  const blank = fixture('report-blank.json');
  const validity = reportValidity(blank);
  assert.equal(validity.valid, true);
  assert.deepEqual(codes(validity.warnings), ['gpu-work-unobserved', 'ready-timeout']);
  assert.equal(validity.warnings[0].message, 'No main-thread GPU work observed.');
  const worker = noWork(capture());
  worker.inPage.summary.offMainThread = { workers: 1, offscreenTransfers: 1 };
  assert.deepEqual(invalidCodes(worker), []);
  assert.equal(reportValidity(worker).warnings[0].message,
    'No main-thread GPU work observed; page created 2 Worker(s)/OffscreenCanvas — off-thread rendering is not instrumented.');
  // Older reports: the API probe's own context does not count as the app's.
  const legacy = capture();
  delete legacy.inPage.summary.appGpuContexts;
  Object.assign(legacy.inPage.instrumentation.after.counters, { 'webgpu.devices': 0, 'webgl2.contexts': 1, 'webgl.contexts': 0 });
  assert.deepEqual(warningCodesOf(legacy), ['gpu-work-unobserved']);
  legacy.inPage.instrumentation.after.counters['webgl2.contexts'] = 2;
  assert.deepEqual(warningCodesOf(legacy), []);
});

test('idle-samples warns only when some, not all, samples were idle', () => {
  const r = capture();
  r.inPage.samples[1].idle = true;
  const warning = reportValidity(r).warnings.find(entry => entry.code === 'idle-samples');
  assert.equal(warning.message, '1/6 samples had no GPU work and were excluded.');
  for (const sample of r.inPage.samples) sample.idle = true;
  assert.ok(!warningCodesOf(r).includes('idle-samples'));
});

test('hook timing codes: zero durations, cdpAttached, partial zeros, quantization, scope drift, negatives', () => {
  const zero = fixture('report-cdp-attached-zero.json');
  assert.deepEqual(invalidCodes(zero), []);
  assert.deepEqual(warningCodesOf(zero), ['zero-gpu-duration', 'gpu-timing-unstable']);
  zero.options.cdpAttached = false;
  assert.deepEqual(invalidCodes(zero), ['zero-gpu-duration']);
  const hook = values => {
    const r = capture();
    r.inPage.hook.found = true;
    r.inPage.samples.forEach((sample, index) => { sample.measurement.gpuMs = values[index]; });
    return r;
  };
  const partial = hook([0, 0.21, 0.2, 0.19, 0.2, 0.2]);
  assert.ok(warningCodesOf(partial).includes('zero-gpu-duration-partial'));
  assert.deepEqual(invalidCodes(partial), []);
  const quantized = hook([0.1, 0.2, 0.1, 0.1, 0.2, 0.1]);
  assert.ok(warningCodesOf(quantized).includes('hook-timing-quantized'));
  assert.ok(!warningCodesOf(hook([0.1013, 0.2, 0.1, 0.1, 0.2, 0.1])).includes('hook-timing-quantized'));
  const drift = capture();
  drift.inPage.hook.found = true;
  drift.inPage.samples.forEach((sample, index) => { sample.measurement[index % 2 ? 'main' : 'shadow'] = { gpuMs: 1 }; });
  assert.ok(invalidCodes(drift).includes('gpu-timing-scope-drift'));
  assert.ok(invalidCodes(hook([1, -1, 1, 1, 1, 1])).includes('invalid-gpu-timing'));
});

test('gpu-timing-unstable (hook or auto) and gpu-timing-contended are warnings', () => {
  const vsync = fixture('report-hook-vsync.json');
  const warning = reportValidity(vsync).warnings.find(entry => entry.code === 'gpu-timing-unstable');
  assert.match(warning.message, /^GPU timing unstable \(between-sample-drift, high-dispersion\); GPU rows from separate captures will not gate\.$/);
  const auto = capture();
  auto.inPage.summary.autoGpu.perSampleP50Ns = [8.4e6, 8.4e6, 8.4e6, 8.4e6, 8.4e6, 8.4e6];
  auto.inPage.samples[0].autoGpu.frameNs.p50 = 0.86e6;
  assert.deepEqual(reportValidity(auto).warnings.map(entry => [entry.code, entry.source]), [['gpu-timing-unstable', 'auto']]);
  const both = fixture('report-hook-vsync.json');
  both.inPage.samples[0].autoGpu.frameNs.p50 = 0.3e6;
  const merged = reportValidity(both).warnings.filter(entry => entry.code === 'gpu-timing-unstable');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'hook+auto');
  const contended = capture();
  contended.inPage.hook.found = true;
  contended.inPage.samples.forEach((sample, index) => { sample.measurement.gpuMs = index < 3 ? 30 : 3; });
  const entry = reportValidity(contended).warnings.find(item => item.code === 'gpu-timing-contended');
  assert.equal(entry.message, 'GPU timing exceeds frame time in 3/6 samples (other GPU work or overlap).');
});

test('capture-environment warnings: network idle, readiness, measurement lock, instrumentation overhead', () => {
  const network = capture();
  network.timings.networkIdle = { status: 'budget-exceeded', waitedMs: 10000, budgetMs: 10000,
    pending: [{ url: `${ORIGIN}/poll`, type: 'XHR', ageMs: 10000 }] };
  assert.equal(reportValidity(network).warnings[0].message, `Network not idle after 10000 ms; sampled with 1 pending: ${ORIGIN}/poll.`);
  const ready = capture();
  ready.inPage.ready = { reason: 'timeout', waitedMs: 3000 };
  assert.equal(reportValidity(ready).warnings[0].message, 'No GPU work seen within 3000 ms of load; sampling anyway.');
  const manual = capture();
  manual.options.autoInstrument = false;
  manual.inPage.ready = { reason: 'no-instrumentation', waitedMs: 0 };
  assert.deepEqual(warningCodesOf(manual), ['readiness-unavailable']);
  manual.inPage.hook.found = true;
  assert.deepEqual(warningCodesOf(manual), []);
  const lock = capture();
  lock.measurementLock = { ...lock.measurementLock, acquired: false, timedOut: true, waitedMs: 30000.4 };
  assert.equal(reportValidity(lock).warnings[0].message, 'Another capture held the measurement lock for 30000 ms; results may be contended.');
  lock.measurementLock = { acquired: false, waitedMs: 0, timedOut: false, holder: null, path: '/tmp/x', unavailable: 'unsafe-dir' };
  assert.equal(reportValidity(lock).warnings[0].message, 'Measurement lock unavailable (unsafe-dir).');
  const profiled = capture();
  profiled.cpuProfile = { trigger: 'auto', windowMs: 250, frames: 15, busy: 0.5, msPerFrame: { tool: 1.2, appJs: 5 } };
  assert.match(reportValidity(profiled).warnings[0].message, /^Instrumentation may inflate CPU time on this page \(tool JS 1\.2 ms\/frame is 14% of main-thread busy time\)/);
  profiled.cpuProfile.msPerFrame.tool = 0.5;
  assert.deepEqual(warningCodesOf(profiled), []);
  const draws = capture();
  draws.inPage.summary.perFrame.glDrawCalls = 25000;
  assert.match(reportValidity(draws).warnings[0].message, /25000 WebGL draws\/frame are each wrapped/);
});

test('adaptive stopping accepts fps, gpu and frames convergence reasons', () => {
  const r = capture();
  r.options.adaptive = true;
  r.inPage.samples = r.inPage.samples.slice(0, 3);
  for (const reason of ['gpu-converged', 'frames-converged']) {
    r.inPage.sampling = { adaptive: true, stoppedEarly: true, reason, coefficientOfVariation: 0.04 };
    assert.ok(!invalidCodes(r).includes('incomplete-samples'), reason);
  }
  r.inPage.sampling = { adaptive: true, stoppedEarly: true, reason: 'fps-converged', coefficientOfVariation: 0.04 };
  assert.ok(invalidCodes(r).includes('incomplete-samples'), 'FPS convergence keeps its CV bound');
  r.inPage.sampling = { adaptive: true, stoppedEarly: true, reason: 'bored', coefficientOfVariation: 0 };
  assert.ok(invalidCodes(r).includes('incomplete-samples'));
});

test('instrumentation-errors reads inPage.instrumentation.errors; timer failures elsewhere are ignored', () => {
  const r = capture();
  r.inPage.instrumentation.errors = [{ message: 'patch failed' }];
  assert.deepEqual(invalidCodes(r), ['instrumentation-errors']);
  r.inPage.instrumentation.errors = [];
  r.inPage.samples[0].autoGpu.partialReasons['timer-error'] = 3;
  assert.deepEqual(invalidCodes(r), []);
});

test('pageErrorCounts adds HTTP and rendering errors', () => {
  const r = capture();
  r.pageEventSummary.counts = { ...r.pageEventSummary.counts, pageerror: 1, requestfailed: 2, httpError: 3, renderingError: 4 };
  assert.deepEqual(pageErrorCounts(r), { runtime: 1, network: 5, rendering: 4, total: 10 });
  assert.deepEqual(pageErrorCounts({ pageEvents: [{ type: 'httperror', status: 404 },
    { type: 'log.entry', source: 'rendering', level: 'warning', text: 'WebGL: INVALID_OPERATION: useProgram: program not valid' },
    { type: 'log.entry', source: 'rendering', level: 'warning', text: 'GPU stall due to ReadPixels' }] }),
  { runtime: 0, network: 1, rendering: 1, total: 2 });
});
