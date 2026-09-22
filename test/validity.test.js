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
