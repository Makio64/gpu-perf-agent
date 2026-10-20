import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeAllHarnesses, createNetworkTracker, FastCDPHarness, sweepStaleProfiles, timingAnomalies, TOOL } from '../src/fast-cdp-runner.js';

test('tool identity is read from package.json', async () => {
  const { createRequire } = await import('node:module');
  assert.deepEqual(TOOL, { name: 'gpu-perf-agent', version: createRequire(import.meta.url)('../package.json').version });
});

test('timing anomalies: slow navigation, slow TLS and lock waits only, at most 3', () => {
  assert.deepEqual(timingAnomalies({ navigationMs: 200, lockWaitMs: 0 }, { ms: 30, host: 'a', url: 'https://a/x' }), []);
  assert.deepEqual(timingAnomalies({ navigationMs: 25600, lockWaitMs: 2500 }, { ms: 25300, host: 'unpkg.com', url: 'https://unpkg.com/three.js' }), [
    { code: 'slow-navigation', ms: 25600 },
    { code: 'slow-tls', ms: 25300, host: 'unpkg.com', url: 'https://unpkg.com/three.js' },
    { code: 'lock-wait', ms: 2500 }
  ]);
});

test('profile sweep removes only old dirs whose owners are dead or that no process uses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-sweep-'));
  const old = new Date(Date.now() - 20 * 60 * 1000);
  const make = async (name, owner, age = old) => {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'Default'), { recursive: true });
    if (owner) await writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner));
    await utimes(directory, age, age);
    return directory;
  };
  try {
    const deadPid = 2 ** 22 + 4242;
    await make('webgpu-report-cdp-dead', { ownerPid: deadPid, chromePid: deadPid + 1 });
    await make('webgpu-report-cdp-live-owner', { ownerPid: process.pid, chromePid: deadPid });
    await make('webgpu-report-cdp-young', { ownerPid: deadPid, chromePid: deadPid }, new Date());
    if (process.platform !== 'win32') await make('webgpu-report-cdp-legacy', null);
    const kept = await make('webgpu-report-cdp-keep', { ownerPid: deadPid, chromePid: deadPid });
    await make('unrelated-dir', null);
    await sweepStaleProfiles({ root, keep: kept });
    const left = (await readdir(root)).sort();
    assert.deepEqual(left, ['unrelated-dir', 'webgpu-report-cdp-keep', 'webgpu-report-cdp-live-owner', 'webgpu-report-cdp-young']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fakeLaunch() {
  const listeners = new Set();
  return {
    process: { pid: 4321, exitCode: null, signalCode: null },
    executablePath: '/chrome',
    stderrTail: bytes => 'x'.repeat(5000).slice(-bytes),
    closed: 0,
    async close() { this.closed++; },
    listeners
  };
}

test('harness reports alive, pid and stderr tail, and goes dead when Chrome exits or the pipe closes', () => {
  const launch = fakeLaunch();
  let onClose;
  const session = { closed: false, onClose: handler => { onClose = handler; }, send: async () => ({}), close() {} };
  const harness = new FastCDPHarness(launch, session);
  assert.equal(harness.alive, true);
  assert.equal(harness.pid, 4321);
  assert.equal(harness.stderrTail(10).length, 10);
  assert.equal(harness.stderrTail().length, 2048);
  launch.process.exitCode = 0;
  assert.equal(harness.alive, false);
  launch.process.exitCode = null;
  onClose();
  assert.equal(harness.alive, false);
  const second = new FastCDPHarness(fakeLaunch(), { send: async () => ({}), close() {} });
  second.cleanupError = new Error('x');
  assert.equal(second.alive, false);
});

test('close({abort}) does not drain: the running job and queued jobs reject with code aborted', async () => {
  const launch = fakeLaunch();
  const harness = new FastCDPHarness(launch, { send: async () => ({}), close() {} });
  let release;
  harness.runJob = () => new Promise((resolve, reject) => { release = reject; });
  const running = harness.run({ url: 'http://localhost/a' });
  const queued = harness.run({ url: 'http://localhost/b' });
  await new Promise(resolve => setImmediate(resolve));
  const closing = harness.close({ abort: true, timeoutMs: 100 });
  assert.equal(harness.alive, false);
  release(Object.assign(new Error('connection closed'), { code: 'aborted' }));
  await closing;
  assert.equal(launch.closed, 1);
  await assert.rejects(running, { code: 'aborted' });
  // Tagged so a server that replaced the dead browser can retry the queued job.
  await assert.rejects(queued, { code: 'aborted', reason: 'harness-closed', samplingStarted: false });
  await assert.rejects(harness.run({ url: 'http://localhost/c' }), /closed/);
});

test('closeAllHarnesses aborts every live harness of the process', async () => {
  const launches = [fakeLaunch(), fakeLaunch()];
  const harnesses = launches.map(launch => new FastCDPHarness(launch, { send: async () => ({}), close() {} }));
  await closeAllHarnesses({ timeoutMs: 200 });
  assert.deepEqual(launches.map(launch => launch.closed), [1, 1]);
  assert.ok(harnesses.every(harness => harness.closed && harness.aborted));
});

test('an aborted signal rejects a queued run with code aborted before it starts', async () => {
  const harness = new FastCDPHarness(fakeLaunch(), { send: async () => ({}), close() {} });
  let started = 0;
  harness.runJob = async () => { started++; return {}; };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(harness.run({ url: 'http://localhost' }, { signal: controller.signal }), { code: 'aborted' });
  assert.equal(started, 0);
  await harness.close();
});

// Minimal CDP session: on() returns an unsubscribe function; emit() fires events.
function fakeSession() {
  const listeners = new Map();
  return {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name).delete(listener);
    },
    emit(name, params) { for (const listener of listeners.get(name) ?? []) listener(params); },
    send: async () => ({})
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (session, id, url = `http://localhost/${id}`) => session.emit('Network.requestWillBeSent', { requestId: id, type: 'Fetch', request: { url } });

test('network idle: classified against evaluation start and warmup end', async () => {
  // Idle before evaluation starts.
  let session = fakeSession();
  let tracker = createNetworkTracker(session, session, { quietMs: 10 });
  let idle = tracker.waitForIdle({ budgetMs: 1000 });
  assert.equal((await idle).status, 'idle');
  tracker.markSamplingStart();
  tracker.markWarmupEnd();
  assert.equal(tracker.idleResult().status, 'idle');
  tracker.dispose();

  // Idle after evaluation start but before the first sample-start: overlapped.
  session = fakeSession();
  tracker = createNetworkTracker(session, session, { quietMs: 10 });
  request(session, 'a');
  idle = tracker.waitForIdle({ budgetMs: 1000 });
  tracker.markSamplingStart();
  session.emit('Network.loadingFinished', { requestId: 'a' });
  await idle;
  tracker.markWarmupEnd();
  assert.deepEqual({ ...tracker.idleResult(), waitedMs: 0 }, { status: 'overlapped', waitedMs: 0, budgetMs: 1000, pending: [] });
  tracker.dispose();

  // Still pending at warmup end: budget-exceeded with that snapshot, though idle came later
  // and the budget never ran out.
  session = fakeSession();
  tracker = createNetworkTracker(session, session, { quietMs: 10 });
  request(session, 'slow', 'http://localhost/slow');
  idle = tracker.waitForIdle({ budgetMs: 1000 });
  tracker.markSamplingStart();
  await sleep(20);
  tracker.markWarmupEnd();
  session.emit('Network.loadingFinished', { requestId: 'slow' });
  await idle;
  const result = tracker.idleResult();
  assert.equal(result.status, 'budget-exceeded');
  assert.deepEqual(result.pending.map(item => item.url), ['http://localhost/slow']);
  assert.ok(result.waitedMs >= 15 && result.waitedMs < 1000, JSON.stringify(result));
  tracker.dispose();
});

test('network idle: without progress events warmup end falls back to the evaluation start', async () => {
  const session = fakeSession();
  const tracker = createNetworkTracker(session, session, { quietMs: 10 });
  request(session, 'a');
  const idle = tracker.waitForIdle({ budgetMs: 1000 });
  tracker.markSamplingStart();
  session.emit('Network.loadingFinished', { requestId: 'a' });
  await idle;
  const result = tracker.idleResult();
  assert.equal(result.status, 'budget-exceeded');
  assert.equal(result.pending.length, 1);
  tracker.dispose();
});

test('network idle: the budget pauses while the page is frozen', async () => {
  const session = fakeSession();
  const tracker = createNetworkTracker(session, session, { quietMs: 10 });
  request(session, 'a');
  const idle = tracker.waitForIdle({ budgetMs: 60 });
  tracker.pause();
  await sleep(120);
  tracker.resume();
  await sleep(20);
  session.emit('Network.loadingFinished', { requestId: 'a' });
  const result = await idle;
  assert.equal(result.status, 'idle', JSON.stringify(result));
  assert.ok(result.waitedMs < 60, JSON.stringify(result));
  tracker.markSamplingStart();
  assert.ok(tracker.idleResult().pausedMs >= 100, JSON.stringify(tracker.idleResult()));
  tracker.dispose();
});

test('network idle: dispose settles the wait and clears its timers', async () => {
  const session = fakeSession();
  const tracker = createNetworkTracker(session, session, { quietMs: 10 });
  request(session, 'poll');
  const idle = tracker.waitForIdle({ budgetMs: 60000 });
  tracker.dispose();
  assert.equal((await idle).status, 'disposed');
  // With the budget timer cleared, nothing keeps the event loop alive: this test file
  // would otherwise run for a further 60 s.
});
