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
  assert.equal(result.summary.warnings.find(warning => warning.code === 'page-errors').value, 100);
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
  assert.equal(finalizeReport(r).summary.warnings.find(warning => warning.code === 'page-errors').value, 40);
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
