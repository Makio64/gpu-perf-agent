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
