import assert from 'node:assert/strict';
import test from 'node:test';
import { compactReport, formatAgentReport, comparisonExitCode, formatAgentComparison } from '../src/output.js';
import { finalizeReport } from '../src/analysis.js';

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

test('agent output retains GPU scope evidence even with no warning rows', () => {
  const timing = { schemaVersion: 1, status: 'ambiguous', scope: null, sampleCount: 3, validSampleCount: 0, timingCount: 9, ambiguousSampleCount: 3, negativeTimingCount: 0, reasons: ['multiple-timings'] };
  const report = { summary: { gpuFrameMsMean: null, warnings: [] }, diagnostics: { validity: { valid: true, issues: [] }, signal: { gpuTiming: timing } } };
  const digest = formatAgentReport(report, { maxWarnings: 0 });
  assert.match(digest, /GPU n\/a ms/);
  assert.match(digest, /GPU timing scope: ambiguous; aggregate GPU time unavailable \(multiple-timings\)/);
  assert.deepEqual(compactReport(report).diagnostics.signal.gpuTiming, timing);
  report.diagnostics.signal.gpuTiming = { ...timing, status: 'single-scope', scope: '', validSampleCount: 3, reasons: [] };
  report.summary.gpuFrameMsMean = 0;
  assert.match(formatAgentReport(report), /GPU 0.00 ms/);
  assert.match(formatAgentReport(report), /GPU timing scope: \(root\); 3\/3 samples/);
});

test('allowed mismatches have consistent success and exit status', () => {
  const result = { compatibility: { compatible: false }, failures: [] };
  assert.equal(comparisonExitCode(result), 2);
  assert.equal(comparisonExitCode(result, {allowMismatch:true}), 0);
  result.failures.push({});
  assert.equal(comparisonExitCode(result, {allowMismatch:true}), 1);
});

test('compact JSON bounds large guidance and preserves numeric signal, identity, artifacts and omission counts', () => {
  const longText = 'x'.repeat(10000);
  const report = {
    summary: {
      verdict: 'poor', fps: 0, gpuFrameMsMean: null, trackedVram: { totalMiB: 0, available: true },
      warnings: Array.from({ length: 100 }, (_, index) => ({ code: `warning-${index}`, severity: 'high', recommendation: longText })),
      recommendations: Array.from({ length: 100 }, (_, index) => ({ id: `rec-${index}`, severity: 'critical', title: 'Title', evidence: longText, action: longText, codeHint: longText, agentPrompt: longText }))
    },
    diagnostics: {
      validity: { valid: true, issues: [] },
      signal: { sampleCount: 6, observedFrameCount: 0, gpuTimingSamples: 0 },
      instrumentation: { enabled: true, errors: [] },
      pageErrors: Array.from({ length: 100 }, () => ({ type: 'requestfailed', message: longText, stack: longText })),
      sampleErrors: []
    },
    artifacts: { screenshotPath: `/tmp/${'nested/'.repeat(60)}screenshot.png` },
    timings: { samplingMs: 0 }
  };
  const snapshot = structuredClone(report);
  const result = compactReport(report, '/tmp/report.json');
  assert.equal(result.ok, true);
  assert.equal(result.summary.fps, 0);
  assert.equal(result.summary.gpuFrameMsMean, null);
  assert.equal(result.summary.trackedVram.totalMiB, 0);
  assert.deepEqual(result.diagnostics.signal, report.diagnostics.signal);
  assert.equal(result.summary.warnings.length, 5);
  assert.equal(result.summary.warningCount, 100);
  assert.equal(result.summary.warningsOmitted, 95);
  assert.equal(result.summary.recommendations.length, 3);
  assert.equal(result.summary.recommendationCount, 100);
  assert.equal(result.summary.recommendationsOmitted, 97);
  assert.equal(result.summary.recommendations[0].codeHint, undefined);
  assert.equal(result.summary.recommendations[0].agentPrompt, undefined);
  assert.equal(result.diagnostics.pageErrors.length, 5);
  assert.equal(result.diagnostics.pageErrors[0].type, 'requestfailed');
  assert.equal(result.diagnostics.pageErrorCount, 100);
  assert.equal(result.diagnostics.pageErrorsOmitted, 95);
  assert.equal(result.artifacts.screenshotPath, report.artifacts.screenshotPath);
  assert.equal(result.timings.samplingMs, 0);
  assert.ok(result.truncation.truncatedText > 0);
  assert.ok(result.truncation.omittedFields >= 6);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10000);
  assert.deepEqual(report, snapshot);
});

test('compact JSON caps nested validity without hiding invalid state or exhausting measurement output', () => {
  const nested = { valid: false, issues: Array.from({ length: 100 }, () => ({ code: 'bad-round', message: 'invalid measurement'.repeat(100), issues: Array(10).fill({ message: 'inner failure'.repeat(100) }) })) };
  const report = {
    summary: { fps: 60, verdict: 'good', warnings: [] },
    diagnostics: { validity: nested, signal: { sampleCount: 6 }, sampleErrors: Array(100).fill({ message: 'failed', details: nested }) }
  };
  const result = compactReport(report);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.validity.valid, false);
  assert.equal(result.diagnostics.validity.issues.length, 5);
  assert.equal(result.diagnostics.validity.issuesOmitted, 95);
  assert.equal(result.diagnostics.sampleErrors.length, 3);
  assert.equal(result.diagnostics.sampleErrorCount, 100);
  assert.equal(result.diagnostics.sampleErrorsOmitted, 97);
  assert.equal(result.summary.fps, 60);
  assert.equal(result.diagnostics.signal.sampleCount, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 18000);
});

test('compact JSON preserves every finalized core measurement ahead of arbitrary extra fields', () => {
  const report = finalizeReport({
    options: { samples: 1 },
    inPage: {
      samples: [{ measurement: { fps: 60, gpuTimeNs: 0, frameTimeMsMean: 16.7, trackedGpuMemory: { pipelines: { syncCount: 0, asyncCount: 2, shaderModules: 2 }, bindGroups: { createdCount: 2 } } } }],
      summary: { fps: { mean: 60 }, frameTimeMsMean: { mean: 16.7 }, frameTimeMsP95: { mean: 17 }, sampleCount: 1, observedFrameCount: 30, cadence: { hz: 60, intervalMs: 16.7, hitRate: 1 } },
      warmup: { durationMs: 200, lagSpikeMs: 0 }
    }
  });
  const core = structuredClone(report.summary);
  report.summary = { ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`custom${i}`, i])), ...report.summary };
  const result = compactReport(report);
  for (const [key, value] of Object.entries(core)) {
    if (['warnings', 'recommendations', 'highlights', 'warningCount'].includes(key)) continue;
    assert.deepEqual(result.summary[key], value, key);
  }
  assert.ok(result.truncation.omittedFields > 0);
  assert.equal(result.summary.warningCount, core.warnings.length);
});

test('report digest preserves unavailable counters, finite limits and invalid issue counts', () => {
  const report = { diagnostics: { validity: { valid: false, issues: Array(50).fill({ message: 'failure' }) } }, summary: { warnings: Array(100).fill({ code: 'warning', message: 'x'.repeat(10000) }) } };
  const digest = formatAgentReport(report, { maxWarnings: Infinity });
  assert.match(digest, /slow n\/a/);
  assert.match(digest, /n\/a samples, n\/a frames, n\/a GPU timings/);
  assert.match(digest, /\+47 more issues/);
  assert.match(digest, /\+97 more warnings/);
  assert.ok(digest.length < 1500);
  const artifact = `/tmp/${'directory/'.repeat(40)}report.json`;
  assert.ok(formatAgentReport(report, { out: artifact }).endsWith(`Report: ${artifact}`));
});

function comparison(rows) {
  const summary = { regressions: 0, improved: 0, inconclusive: 0, passed: 0, missing: 0, total: rows.length };
  for (const row of rows) summary[{ regression: 'regressions', pass: 'passed' }[row.status] || row.status]++;
  return { rows, summary, compatibility: { compatible: true, differences: [] }, validity: { valid: true, issues: [] }, diagnostics: { resolvedWarnings: [], introducedWarnings: [] }, failures: rows.filter(row => row.status === 'regression') };
}

test('comparison digest prioritizes regressions and discloses omitted metrics with evidence', () => {
  const result = comparison([
    ...Array.from({ length: 10 }, (_, i) => ({ key: `a.improvement${i}`, base: 100, candidate: 50, deltaPercent: -50, status: 'improved', evidence: 'independent-samples', confidence95: { low: -55, high: -45 } })),
    ...Array.from({ length: 6 }, (_, i) => ({ key: `z.regression${i}`, base: 0, candidate: 5, deltaPercent: null, status: 'regression', evidence: 'threshold-only' }))
  ]);
  const digest = formatAgentComparison(result);
  assert.match(digest, /10 with 95% intervals, 6 threshold-only/);
  assert.match(digest, /regression: z\.regression0 0\.00 → 5\.00 \(n\/a%\); threshold-only/);
  assert.doesNotMatch(digest, /- improved/);
  assert.match(digest, /Omitted: .*10 improved.*1 regression/);
  assert.equal((digest.match(/^- /gm) || []).length, 5);
});

test('comparison digest always displays requested primary metric even when passing', () => {
  const result = comparison([
    ...Array.from({ length: 6 }, (_, i) => ({ key: `z.regression${i}`, base: 1, candidate: 2, status: 'regression', evidence: 'threshold-only' })),
    { key: 'custom.primary.mean', base: 1, candidate: 1, deltaPercent: 0, status: 'pass', evidence: 'paired-samples', confidence95: { low: -0.1, high: 0.1 } }
  ]);
  const digest = formatAgentComparison(result, { primaryMetric: 'custom.primary.mean' });
  assert.match(digest, /primary pass: custom\.primary\.mean/);
  assert.match(digest, /paired-samples; 95% Δ \[-0\.10, 0\.10\]/);
  assert.match(digest, /Omitted: 2 regression/);
  assert.match(digest, /passing alone does not establish equivalence/);
  assert.equal((digest.match(/^- /gm) || []).length, 5);
  assert.equal(result.failures.length, 6);
  const absent = formatAgentComparison(result, { primaryMetric: 'not.captured' });
  assert.match(absent, /Primary metric not measured: not\.captured/);
  assert.match(absent, /regression: z\.regression0/);
});

test('comparison digest bounds mismatch and warning lists and retains a passing measurement', () => {
  const result = comparison([{ key: 'frame.fps.mean', base: 0, candidate: 0, deltaPercent: null, status: 'pass', evidence: 'threshold-only' }]);
  result.compatibility = { compatible: false, differences: Array.from({ length: 100 }, (_, i) => ({ key: `option-${i}` })) };
  result.compatibility.environment = { checkedKeys: ['host.arch'], unverifiedKeys: ['browser.version', 'adapter.device'] };
  result.diagnostics.resolvedWarnings = Array.from({ length: 100 }, (_, i) => ({ code: `resolved-${i}` }));
  result.diagnostics.introducedWarnings = Array.from({ length: 100 }, (_, i) => ({ code: `new-${i}` }));
  const digest = formatAgentComparison(result);
  assert.match(digest, /pass: frame\.fps\.mean 0\.00 → 0\.00/);
  assert.match(digest, /0 with 95% intervals, 1 threshold-only/);
  assert.match(digest, /Mismatched capture\/environment/);
  assert.match(digest, /Environment: 1 fields checked; 2 unverified/);
  assert.equal((digest.match(/\+95 more/g) || []).length, 3);
  assert.ok(digest.length < 1000);
});
