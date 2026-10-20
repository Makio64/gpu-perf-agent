import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOptions, parseViewport } from '../src/options.js';
import { runFastReport } from '../src/fast-cdp-runner.js';

const target = { url: 'http://localhost:1234' };
test('presets apply consistently and explicit values win', () => {
  const options = normalizeOptions({ ...target, preset: 'quick', samples: 2 });
  assert.equal(options.samples, 2);
  assert.equal(options.durationMs, 250);
  assert.equal(options.warmup, 2);
  assert.equal(normalizeOptions({ ...target, rawTracePath: '/tmp/trace.json' }).trace, true);
});
for (const invalid of [
  { samples: 0 }, { samples: 1.1 }, { samples: NaN }, { durationMs: 0 },
  { warmup: -1 }, { warmup: Infinity }, { timeoutMs: 0 }, { timeoutMs: 2 ** 32 },
  { viewport: '0x720' }, { viewport: '400x0' }, { viewport: 'bad' },
  { deviceScaleFactor: 0 }, { api: 'metal' }, { waitUntil: 'typo' },
  { samplingMode: 'typo' }, { samplingMode: 'hook', adaptive: true },
  { chromiumArgs: 'oops' }, { autoInstrument: 'false' }, { preset: 'constructor' },
  { file: 'test.html' }, { url: 'file:///tmp/test.html' }
]) {
  test(`rejects invalid options before Chrome launch: ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(runFastReport({ ...target, ...invalid, executablePath: '/definitely/missing' }), TypeError);
  });
}
test('target and object input are required', () => {
  for (const options of [undefined, null, [], 'url']) assert.throws(() => normalizeOptions(options), TypeError);
  assert.deepEqual(parseViewport('800x600'), { width: 800, height: 600 });
});

test('capture context isolation defaults to isolated and shared mode is explicit', () => {
  assert.equal(normalizeOptions(target).contextMode, 'isolated');
  assert.equal(normalizeOptions({...target, contextMode:'shared'}).contextMode, 'shared');
  assert.throws(() => normalizeOptions({...target, contextMode:'typo'}), /contextMode/);
});

test('hook sampling is explicit and defaults only an omitted hook readiness option', () => {
  const frames = normalizeOptions(target);
  assert.equal(frames.samplingMode, 'frames');
  assert.equal(frames.waitForHook, undefined);
  assert.equal(normalizeOptions({ ...target, samplingMode: 'frames', adaptive: true }).adaptive, true);
  const hook = normalizeOptions({ ...target, samplingMode: 'hook', waitForHook: undefined });
  assert.equal(hook.samplingMode, 'hook');
  assert.equal(hook.waitForHook, true);
  assert.equal(normalizeOptions(hook).waitForHook, true);
  assert.equal(normalizeOptions({ ...target, samplingMode: 'hook', waitForHook: false }).waitForHook, false);
  assert.equal(normalizeOptions({ ...target, samplingMode: 'frames', waitForHook: true }).waitForHook, true);
});

test('2.2 options: defaults, clamps and validation', () => {
  const options = normalizeOptions(target);
  assert.equal(options.gpuTiming, true);
  assert.equal(options.readyTimeoutMs, 3000);
  assert.equal(options.allowIdle, false);
  assert.equal(options.networkIdleBudgetMs, 10000);
  assert.equal(options.cpuProfile, 'auto');
  assert.equal(options.lockTimeoutMs, 30000);
  assert.equal(options.label, null);
  assert.equal(options.cdpAttached, false);
  assert.equal(normalizeOptions({ ...target, cdpUrl: '9222' }).cdpAttached, true);
  // readyTimeoutMs ≤ timeoutMs; networkIdleBudgetMs ≤ timeoutMs − 1000 (min 0).
  const short = normalizeOptions({ ...target, timeoutMs: 2500, readyTimeoutMs: 9000 });
  assert.equal(short.readyTimeoutMs, 2500);
  assert.equal(short.networkIdleBudgetMs, 1500);
  assert.equal(normalizeOptions({ ...target, timeoutMs: 500 }).networkIdleBudgetMs, 0);
  assert.equal(normalizeOptions({ ...target, readyTimeoutMs: 0 }).readyTimeoutMs, 0);
  assert.equal(normalizeOptions({ ...target, cpuProfile: false }).cpuProfile, false);
  assert.equal(normalizeOptions({ ...target, label: 'cand-3.v2_x' }).label, 'cand-3.v2_x');
  assert.equal(normalizeOptions(normalizeOptions({ ...target, timeoutMs: 2500 })).networkIdleBudgetMs, 1500);
  for (const invalid of [
    { gpuTiming: 'yes' }, { allowIdle: 1 }, { measureLock: 'no' }, { cpuProfile: 'sometimes' },
    { readyTimeoutMs: -1 }, { networkIdleBudgetMs: 'x' }, { lockTimeoutMs: -5 },
    { label: '.' }, { label: '..' }, { label: 'a/b' }, { label: '' }, { label: 'x'.repeat(65) }, { label: 7 },
    { screenshotJpegPath: '' }
  ]) {
    assert.throws(() => normalizeOptions({ ...target, ...invalid }), error => error instanceof TypeError && error.code === 'invalid-options', JSON.stringify(invalid));
  }
});

test('GPU_PERF_AGENT_NO_LOCK=1 turns the measurement lock off by default only', () => {
  const previous = process.env.GPU_PERF_AGENT_NO_LOCK;
  try {
    delete process.env.GPU_PERF_AGENT_NO_LOCK;
    assert.equal(normalizeOptions(target).measureLock, true);
    process.env.GPU_PERF_AGENT_NO_LOCK = '1';
    assert.equal(normalizeOptions(target).measureLock, false);
    assert.equal(normalizeOptions({ ...target, measureLock: true }).measureLock, true);
  } finally {
    if (previous === undefined) delete process.env.GPU_PERF_AGENT_NO_LOCK;
    else process.env.GPU_PERF_AGENT_NO_LOCK = previous;
  }
});

test('applyOptionPrecedence: explicit > base > preset > default, and presets never override the base', async () => {
  const { applyOptionPrecedence, BASE_INHERITED_OPTION_KEYS } = await import('../src/options.js');
  const base = { schemaVersion: 3, options: { samples: 15, durationMs: 500, warmup: 4, api: 'webgpu', gpuTiming: false, waitCondition: null, viewport: '800x600', label: 'base', trace: true } };
  const merged = applyOptionPrecedence({ explicit: { warmup: 1, url: 'http://localhost', samples: undefined }, base, preset: 'quick', defaults: { durationMs: 1000, timeoutMs: 60000 } });
  assert.equal(merged.samples, 15);       // base beats preset
  assert.equal(merged.durationMs, 500);   // base beats preset and default
  assert.equal(merged.warmup, 1);         // explicit beats base
  assert.equal(merged.api, 'webgpu');
  assert.equal(merged.gpuTiming, false);
  assert.equal(merged.viewport, '800x600');
  assert.equal(merged.timeoutMs, 60000);  // default
  assert.equal('waitCondition' in merged, false); // null base values are not inherited
  assert.equal('label' in merged, false);  // only the §2 key list is inherited
  assert.equal('trace' in merged, false);
  assert.ok(BASE_INHERITED_OPTION_KEYS.includes('hookName'));
  // Without a base: preset beats defaults; works with a raw options object as base too.
  assert.equal(applyOptionPrecedence({ preset: 'quick', defaults: { samples: 5 } }).samples, 6);
  assert.equal(applyOptionPrecedence({ base: { samples: 3 }, preset: 'confirm' }).samples, 3);
  // A report without schemaVersion (treated as v2) is still recognized as a report.
  const legacy = applyOptionPrecedence({ base: { options: { samples: 9, api: 'webgpu' }, inPage: {} }, preset: 'quick' });
  assert.equal(legacy.samples, 9);
  assert.equal(legacy.api, 'webgpu');
  assert.throws(() => applyOptionPrecedence({ preset: 'nope' }), { code: 'invalid-options' });
  assert.equal(normalizeOptions(merged).samples, 15);
});
