import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { requestJson } from '../src/http-client.js';

const { createServer } = createRequire(import.meta.url)('node:http');

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('requestJson sends JSON bodies and parses JSON responses', async () => {
  await withServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, type: request.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
  }, async (origin) => {
    const { status, json } = await requestJson(`${origin}/run`, { method: 'POST', body: { a: 1 } });
    assert.equal(status, 201);
    assert.deepEqual(json, { method: 'POST', type: 'application/json', body: { a: 1 } });
    const get = await requestJson(new URL('/x', origin));
    assert.equal(get.json.method, 'GET');
  });
});

test('requestJson reports unreachable servers, timeouts and non-JSON bodies with a code', async () => {
  await assert.rejects(requestJson('http://127.0.0.1:1/json/version'), error => error.code === 'server-unreachable' && /ECONNREFUSED/.test(error.message));
  await withServer(() => {}, async (origin) => {
    await assert.rejects(requestJson(origin, { timeoutMs: 100 }), error => error.code === 'server-unreachable' && /ETIMEDOUT/.test(error.message));
  });
  await withServer((request, response) => response.end('<html>'), async (origin) => {
    await assert.rejects(requestJson(origin), error => error.code === 'server-unreachable' && /non-JSON/.test(error.message));
  });
  await assert.rejects(requestJson('ftp://127.0.0.1/'), error => error.code === 'invalid-options');
});
