import { createServer } from "node:http";
import { FastCDPHarness } from "./fast-cdp-runner.js";

export async function startReportServer(options = {}) {
  const harness = await FastCDPHarness.launch(options);
  let closing = null;

  function close() {
    if (!closing) {
      closing = closeServer(server, harness);
    }
    return closing;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          runner: "fast-cdp"
        });
      }

      if (request.method === "POST" && url.pathname === "/run") {
        const body = await readJson(request);
        const report = await harness.run({
          ...options,
          ...body
        });
        return sendJson(response, 200, report);
      }

      if (request.method === "POST" && url.pathname === "/close") {
        sendJson(response, 200, { ok: true });
        setImmediate(() => {
          close().catch(() => {});
        });
        return;
      }

      sendJson(response, 404, {
        error: "Not found"
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error?.message || String(error),
        stack: error?.stack || null
      });
    }
  });

  const port = Number(options.port ?? 0);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    close,
    harness,
    port: server.address().port,
    server,
    url: `http://127.0.0.1:${server.address().port}`
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value, null, 2));
}

async function closeServer(server, harness) {
  await new Promise((resolve) => server.close(resolve));
  await harness.close();
}
