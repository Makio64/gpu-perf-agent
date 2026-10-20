import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireMeasurementLock, measurementLockPath } from '../src/measure-lock.js';

async function withLockDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-lock-'));
  const previous = process.env.GPU_PERF_AGENT_LOCK_DIR;
  process.env.GPU_PERF_AGENT_LOCK_DIR = directory;
  try { return await run(directory); }
  finally {
    if (previous === undefined) delete process.env.GPU_PERF_AGENT_LOCK_DIR;
    else process.env.GPU_PERF_AGENT_LOCK_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('lock path is independent of TMPDIR unless overridden', () => {
  const previous = process.env.GPU_PERF_AGENT_LOCK_DIR;
  delete process.env.GPU_PERF_AGENT_LOCK_DIR;
  try {
    const expected = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    assert.equal(path.dirname(path.dirname(measurementLockPath())), expected);
    assert.match(measurementLockPath(), /gpu-perf-agent-[^/\\]+[/\\]measure\.lock$/);
  } finally { if (previous !== undefined) process.env.GPU_PERF_AGENT_LOCK_DIR = previous; }
});

test('a free lock is acquired at once, holds pid and label, and release removes it', async () => {
  await withLockDir(async (directory) => {
    let waited = 0;
    const lock = await acquireMeasurementLock({ label: 'base', onWait: () => { waited++; } });
    assert.equal(lock.acquired, true);
    assert.equal(lock.timedOut, false);
    assert.equal(lock.holder, null);
    assert.equal(waited, 0);
    const content = JSON.parse(await readFile(path.join(directory, 'measure.lock'), 'utf8'));
    assert.equal(content.pid, process.pid);
    assert.equal(content.label, 'base');
    await lock.release();
    await lock.release();
    await assert.rejects(readFile(path.join(directory, 'measure.lock')), { code: 'ENOENT' });
  });
});

test('a held lock makes the second caller wait (onWait once) until release', async () => {
  await withLockDir(async () => {
    const first = await acquireMeasurementLock({ label: 'first' });
    let waits = 0;
    const second = acquireMeasurementLock({ label: 'second', timeoutMs: 5000, onWait: async () => { waits++; } });
    setTimeout(() => first.release(), 200);
    const lock = await second;
    assert.equal(lock.acquired, true);
    assert.equal(waits, 1);
    assert.ok(lock.waitedMs >= 150, `waited ${lock.waitedMs}`);
    assert.deepEqual(lock.holder, { pid: process.pid, label: 'first' });
    await lock.release();
  });
});

test('the wait is bounded: a timeout proceeds unlocked and names the holder', async () => {
  await withLockDir(async () => {
    const first = await acquireMeasurementLock({ label: 'slow' });
    const started = performance.now();
    const lock = await acquireMeasurementLock({ timeoutMs: 150 });
    assert.ok(performance.now() - started < 1000);
    assert.equal(lock.acquired, false);
    assert.equal(lock.timedOut, true);
    assert.equal(lock.holder.label, 'slow');
    await lock.release();
    await first.release();
  });
});

test('stale locks (dead holder pid, or older than 5 minutes) are taken over', async () => {
  await withLockDir(async (directory) => {
    const file = path.join(directory, 'measure.lock');
    await writeFile(file, JSON.stringify({ pid: 2 ** 22 + 12345, label: 'dead', since: Date.now() }));
    let lock = await acquireMeasurementLock({ timeoutMs: 100 });
    assert.equal(lock.acquired, true);
    await lock.release();
    await writeFile(file, JSON.stringify({ pid: process.ppid, label: 'old', since: Date.now() - 6 * 60 * 1000 }));
    lock = await acquireMeasurementLock({ timeoutMs: 100 });
    assert.equal(lock.acquired, true);
    await lock.release();
    // An empty (half-written) lock is only stale after a few seconds.
    await writeFile(file, '');
    const old = new Date(Date.now() - 10000);
    await utimes(file, old, old);
    lock = await acquireMeasurementLock({ timeoutMs: 100 });
    assert.equal(lock.acquired, true);
    await lock.release();
  });
});

test('a directory writable by group/other is refused instead of trusted', { skip: process.platform === 'win32' }, async () => {
  await withLockDir(async (directory) => {
    await chmod(directory, 0o777);
    const lock = await acquireMeasurementLock({ timeoutMs: 100 });
    assert.equal(lock.acquired, false);
    assert.equal(lock.unavailable, 'unsafe-dir');
    await chmod(directory, 0o700);
  });
});

test('an aborted signal stops the wait with code aborted', async () => {
  await withLockDir(async () => {
    const first = await acquireMeasurementLock();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(acquireMeasurementLock({ timeoutMs: 5000, signal: controller.signal }), { code: 'aborted' });
    await first.release();
  });
});
