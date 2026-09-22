import assert from 'node:assert/strict';
import test from 'node:test';
import { compactReport, formatAgentReport, comparisonExitCode } from '../src/output.js';

test('agent digest is bounded and preserves zero versus unavailable metrics', () => {
  const report = { summary: { fps: 0, gpuFrameMsMean: null, warnings: Array.from({length:100}, (_,i)=>({ code: `warning-${i}`, severity: 'high', recommendation: 'x'.repeat(1000) })) } };
  const digest = formatAgentReport(report, { out: '/tmp/report.json' });
  assert.match(digest, /0.0 FPS/);
  assert.match(digest, /GPU n\/a ms/);
  assert.match(digest, /\+97 more/);
  assert.ok(digest.length < 1200);
  assert.match(digest, /Report: \/tmp\/report.json/);
});

test('compact JSON avoids duplicating warnings and caps error details', () => {
  const report = { summary: { warnings: [{code:'test'}] }, diagnostics: { warnings: [{code:'test'}], pageErrors: Array(100).fill({type:'pageerror'}) } };
  const result = compactReport(report);
  assert.equal(result.diagnostics.warnings, undefined);
  assert.equal(result.diagnostics.pageErrorCount, 100);
  assert.equal(result.diagnostics.pageErrors.length, 5);
  assert.equal(report.diagnostics.pageErrors.length, 100);
});

test('allowed mismatches have consistent success and exit status', () => {
  const result = { compatibility: { compatible: false }, failures: [] };
  assert.equal(comparisonExitCode(result), 2);
  assert.equal(comparisonExitCode(result, {allowMismatch:true}), 0);
  result.failures.push({});
  assert.equal(comparisonExitCode(result, {allowMismatch:true}), 1);
});
