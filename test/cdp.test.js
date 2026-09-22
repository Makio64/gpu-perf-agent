import assert from 'node:assert/strict';
import test from 'node:test';
import { CDPConnection } from '../src/cdp.js';
import { FastCDPHarness } from '../src/fast-cdp-runner.js';

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

test('disposing hundreds of page sessions releases every CDP listener', () => {
  const c = new CDPConnection(new Socket());
  for (let i = 0; i < 300; i++) {
    const page = c.session(String(i));
    page.on('Runtime.consoleAPICalled', () => {});
    page.once('Page.loadEventFired', () => {});
    assert.equal(c.listeners.size, 2);
    page.dispose();
    assert.equal(c.listeners.size, 0);
  }
  c.close();
});

test('closed and failing sockets reject immediately without pending timers', async () => {
  const socket = new Socket();
  const c = new CDPConnection(socket);
  socket.send = () => { throw Error('send failed'); };
  await assert.rejects(c.send('Test'), /send failed/);
  assert.equal(c.pending.size, 0);
  socket.send = () => {};
  const pending = c.send('Test');
  c.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(c.send('Test'), /closed/);
  assert.equal(c.pending.size, 0);
});

test('CDP responses and events are routed to the correct session', async () => {
  const socket = new Socket();
  const c = new CDPConnection(socket);
  const first = c.session('one');
  const second = c.session('two');
  let calls = 0;
  first.once('event', () => calls++);
  second.on('event', () => calls += 100);
  c.handleMessage(JSON.stringify({ method: 'event', sessionId: 'one' }));
  c.handleMessage(JSON.stringify({ method: 'event', sessionId: 'one' }));
  assert.equal(calls, 1);
  const result = first.send('Test');
  c.handleMessage(JSON.stringify({ id: socket.sent[0].id, result: { ok: true } }));
  assert.deepEqual(await result, { ok: true });
  first.dispose(); second.dispose(); c.close();
});

test('harness serializes callers, recovers after failure and drains before close', async () => {
  const events = [];
  const harness = new FastCDPHarness({ close: async () => events.push('closed') }, { send: async () => {}, close() {} });
  harness.runJob = async (options) => {
    events.push(options.url);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (options.url.endsWith('bad')) throw new Error('bad job');
    events.push('done');
    return options;
  };
  const good = harness.run({ url: 'http://localhost/one' });
  const bad = assert.rejects(harness.run({ url: 'http://localhost/bad' }), /bad job/);
  const next = harness.run({ url: 'http://localhost/two', preset: 'quick' });
  const close = harness.close();
  assert.equal(harness.close(), close);
  await Promise.all([good, bad, next, close]);
  assert.deepEqual(events, ['http://localhost/one', 'done', 'http://localhost/bad', 'http://localhost/two', 'done', 'closed']);
  assert.equal((await next).durationMs, 250);
  await assert.rejects(harness.run({ url: 'http://localhost/no' }), /closed/);
});

test('disposing a session cancels only its pending commands and rejects further use', async () => {
  const socket = new Socket();
  const connection = new CDPConnection(socket);
  const first = connection.session('first');
  const second = connection.session('second');
  const pendingFirst = assert.rejects(first.send('Runtime.evaluate'), /session closed/);
  const pendingSecond = second.send('Runtime.evaluate');
  first.dispose();
  await pendingFirst;
  assert.equal(connection.pending.size, 1);
  assert.equal(connection.sessions.size, 1);
  await assert.rejects(first.send('Page.navigate'), /session closed/);
  assert.throws(() => first.on('event', () => {}), /session closed/);
  connection.handleMessage(JSON.stringify({id: socket.sent[1].id, result: {value:2}}));
  assert.deepEqual(await pendingSecond, {value:2});
  connection.close();
  assert.equal(connection.sessions.size, 0);
});

test('Chrome detachment releases session listeners and pending commands immediately', async () => {
  const connection = new CDPConnection(new Socket());
  const session = connection.session('closed-page');
  session.on('Runtime.consoleAPICalled', () => {});
  const pending = assert.rejects(session.send('Runtime.evaluate'), /session closed/);
  connection.handleMessage(JSON.stringify({method:'Target.detachedFromTarget', params:{sessionId:'closed-page'}}));
  await pending;
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.listeners.size, 0);
  assert.equal(connection.sessions.size, 0);
  connection.close();
});

test('page creation failures dispose the newly created browser context', async () => {
  const calls = [];
  const browser = {async send(method, params) {
    calls.push({method, params});
    if (method === 'Target.createBrowserContext') return {browserContextId:'job'};
    if (method === 'Target.createTarget') throw new Error('create target failed');
    return {};
  }};
  const harness = new FastCDPHarness({}, browser);
  await assert.rejects(harness.run({url:'http://localhost', contextMode:'isolated'}), /create target failed/);
  assert.deepEqual(calls.map(call => call.method), ['Target.createBrowserContext', 'Target.createTarget', 'Target.disposeBrowserContext']);
  assert.equal(calls[1].params.browserContextId, 'job');
  assert.equal(calls[2].params.browserContextId, 'job');
});

test('failed context cleanup prevents queued jobs from measuring contaminated state', async () => {
  const calls = [];
  const browser = {async send(method) {
    calls.push(method);
    if (method === 'Target.createBrowserContext') return {browserContextId:'job'};
    if (method === 'Target.createTarget') throw new Error('create target failed');
    if (method === 'Target.disposeBrowserContext') throw new Error('context disposal failed');
  }};
  const harness = new FastCDPHarness({}, browser);
  const first = assert.rejects(harness.run({url:'http://localhost'}), /Capture cleanup failed/);
  const queued = assert.rejects(harness.run({url:'http://localhost/next'}), /Capture cleanup failed/);
  await Promise.all([first, queued]);
  assert.deepEqual(calls, ['Target.createBrowserContext', 'Target.createTarget', 'Target.disposeBrowserContext']);
});
