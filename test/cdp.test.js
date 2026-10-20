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

test('pipe transport frames NUL-delimited JSON across chunk and UTF-8 boundaries', async () => {
  const { PassThrough } = await import('node:stream');
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const connection = CDPConnection.fromPipe(toChrome, fromChrome);
  const written = [];
  toChrome.on('data', chunk => written.push(chunk));
  const pending = connection.send('Browser.getVersion');
  await new Promise(resolve => setImmediate(resolve));
  const request = Buffer.concat(written).toString('utf8');
  assert.equal(request.at(-1), '\0');
  const { id } = JSON.parse(request.slice(0, -1));
  const reply = Buffer.from(`${JSON.stringify({ id, result: { product: 'Chrome/€' } })}\0${JSON.stringify({ method: 'Target.targetCreated', params: { n: 1 } })}\0`);
  const events = [];
  connection.on('Target.targetCreated', params => events.push(params.n));
  const euro = reply.indexOf(0xe2);
  fromChrome.write(reply.subarray(0, euro + 1));
  fromChrome.write(reply.subarray(euro + 1, euro + 2));
  fromChrome.write(reply.subarray(euro + 2));
  assert.deepEqual(await pending, { product: 'Chrome/€' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [1]);
  let closed = 0;
  connection.onClose(() => closed++);
  const inflight = assert.rejects(connection.send('Runtime.evaluate'), /closed/);
  fromChrome.end();
  await inflight;
  assert.equal(closed, 1);
  assert.equal(connection.closed, true);
});

test('WebSocket client handshakes, masks frames and handles lengths, fragments, ping and close', async () => {
  const { createHash } = await import('node:crypto');
  const net = await import('node:net');
  const frames = [];
  let serverSocket;
  const encode = (opcode, payload, fin = true) => {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, length])
      : length < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return h; })();
    return Buffer.concat([header, payload]);
  };
  const server = net.createServer(socket => {
    serverSocket = socket;
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buffer.subarray(0, end).toString())[1];
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      while (buffer.length >= 2) {
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)).map((byte, index) => byte ^ mask[index & 3]);
        frames.push({ opcode: buffer[0] & 0x0f, masked, text: Buffer.from(payload).toString() });
        buffer = buffer.subarray(offset + 4 + length);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const connection = await CDPConnection.connect(`ws://127.0.0.1:${server.address().port}/devtools/browser/x`);
    const pending = connection.send('Browser.getVersion');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(frames[0].masked, true);
    const { id } = JSON.parse(frames[0].text);
    const big = 'x'.repeat(70000);
    const medium = 'y'.repeat(300);
    const events = [];
    connection.on('Big.event', params => events.push(params.value.length));
    // 64-bit length event, then a fragmented 16-bit response with a ping in between.
    const response = Buffer.from(JSON.stringify({ id, result: { medium } }));
    serverSocket.write(Buffer.concat([
      encode(1, Buffer.from(JSON.stringify({ method: 'Big.event', params: { value: big } }))),
      encode(1, response.subarray(0, 100), false),
      encode(9, Buffer.from('hi')),
      encode(0, response.subarray(100))
    ]));
    assert.deepEqual(await pending, { medium });
    assert.deepEqual(events, [70000]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(frames.filter(frame => frame.opcode === 10).map(frame => frame.text), ['hi']);
    let closed = false;
    connection.onClose(() => { closed = true; });
    serverSocket.write(encode(8, Buffer.from([0x03, 0xe8])));
    serverSocket.end();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, true);
    assert.ok(frames.some(frame => frame.opcode === 8), 'client answers the close frame');
  } finally {
    serverSocket?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('WebSocket connect failures carry server-unreachable and reject bad schemes', async () => {
  const net = await import('node:net');
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(CDPConnection.connect(`ws://127.0.0.1:${server.address().port}/x`), error => error.code === 'server-unreachable' && /404/.test(error.message));
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
  await assert.rejects(CDPConnection.connect('http://127.0.0.1:1/x'), error => error.code === 'invalid-options');
  await assert.rejects(CDPConnection.connect('ws://127.0.0.1:1/x', { timeoutMs: 2000 }), error => error.code === 'server-unreachable');
});
