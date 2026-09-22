import { createServer } from "node:http";
import { FastCDPHarness } from "./fast-cdp-runner.js";
import { normalizeOptions, numberOption } from "./options.js";
import { compactReport } from "./output.js";
import { reportValidity } from "./validity.js";

export async function startReportServer(options = {}) {
  const port = numberOption(options.port ?? 0, 'port', { max: 65535, integer: true });
  const maxQueue = numberOption(options.maxQueue ?? 8, 'maxQueue', { min: 1, max: 1000, integer: true });
  const defaults = normalizeOptions(options, { requireTarget: false });
  const harness = await FastCDPHarness.launch(defaults);
  let closing = null;
  let pending = 0;
  let completed = 0;
  let failed = 0;

  function close() {
    if (!closing) {
      closing = (async () => {
        await new Promise(resolve => server.close(resolve));
        await harness.close();
      })();
    }
    return closing;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        const ok = !closing && !harness.cleanupError;
        return sendJson(response, ok ? 200 : 503, { ok, runner: "fast-cdp", pending, completed, failed, maxQueue,
          ...(harness.cleanupError ? {error: {code: 'CAPTURE_CLEANUP_FAILED', message: harness.cleanupError.message}} : {}) });
      }
      if (request.method === "POST" && url.pathname === "/run") {
        if (closing) return sendJson(response, 503, { ok: false, error: { code: 'CLOSING', message: 'Server is closing.' } });
        if (harness.cleanupError) return sendJson(response, 503, { ok: false, error: { code: 'CAPTURE_CLEANUP_FAILED', message: harness.cleanupError.message } });
        if (pending >= maxQueue) {
          response.setHeader('Retry-After', '1');
          return sendJson(response, 429, { ok: false, error: { code: 'QUEUE_FULL', message: 'Profiler queue is full; retry later.' } });
        }
        pending += 1;
        try {
          const body = await readJson(request);
          // A preset in the request overrides sampling defaults inherited from the server.
          const runOptions = normalizeOptions({ ...options, ...body });
          const report = await harness.run(runOptions);
          completed += 1;
          if (!reportValidity(report).valid) failed += 1;
          return sendJson(response, 200, url.searchParams.get('format') === 'compact' ? compactReport(report) : report);
        } catch (error) {
          failed += 1;
          throw error;
        } finally { pending -= 1; }
      }
      if (request.method === "POST" && url.pathname === "/close") {
        sendJson(response, 200, { ok: true });
        setImmediate(() => close().catch(() => {}));
        return;
      }
      sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      const status = error.statusCode || (error instanceof SyntaxError || error instanceof TypeError ? 400 : 500);
      sendJson(response, status, { ok: false, error: { code: status === 400 ? 'INVALID_OPTIONS' : 'RUN_FAILED', message: error?.message || String(error) } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await harness.close();
    throw error;
  }
  return { close, harness, port: server.address().port, server, url: `http://127.0.0.1:${server.address().port}` };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    request.on('data', chunk => {
      if (exceeded) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body exceeds 64 KiB.'), { statusCode: 413 }));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text.trim() ? JSON.parse(text) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Request body must be a JSON object.');
        resolve(body);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request was aborted.')));
  });
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
