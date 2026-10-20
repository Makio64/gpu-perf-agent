// Test HTTP server for capture fixtures. Node builtins only; node:http through createRequire
// so loading it never pulls in undici/tls (the same rule as src/).
//
//   import { startFixtureServer } from "./fixture-server.mjs";
//   const server = await startFixtureServer({ routes: { "/custom": (request, response, url) => { ... } } });
//   ... server.url ... await server.close();
//
// Or run it: `node test/fixtures/servers/fixture-server.mjs [port]`.
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { createServer } = createRequire(import.meta.url)("node:http");
export const PAGES_DIR = fileURLToPath(new URL("../pages/", import.meta.url));

const WEBGL_LOOP = `const gl = document.querySelector("canvas").getContext("webgl2");
function frame() { gl.clearColor(Math.random(), 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(frame); }
frame();`;

const BUILTIN_PAGES = {
  // A failed image is a warning, not a capture failure.
  "/img-404.html": `<!doctype html><meta charset="utf-8"><title>img-404</title><canvas width="256" height="256"></canvas>
<img src="/status/404/missing.png" alt=""><script>${WEBGL_LOOP}</script>`,
  // A module from an unroutable host: the page never renders.
  "/cdn-fail.html": `<!doctype html><meta charset="utf-8"><title>cdn-fail</title><canvas width="256" height="256"></canvas>
<script type="module">import * as THREE from "http://127.0.0.1:9/three.js"; ${WEBGL_LOOP}</script>`
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm"
};

/**
 * Routes: /sse and /events (EventSource, never ends), /poll (never answers),
 * /delayed?ms=N (answers after N ms), /status/<code>[/...] (that status),
 * /img-404.html, /cdn-fail.html, and a static mount of test/fixtures/pages/.
 * `routes` adds or overrides exact paths: (request, response, url) => void.
 */
export async function startFixtureServer({ port = 0, routes = {}, root = PAGES_DIR } = {}) {
  const sockets = new Set();
  const timers = new Set();
  const requests = [];
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname, at: Date.now() });
    try {
      if (Object.hasOwn(routes, url.pathname)) return await routes[url.pathname](request, response, url);
      if (url.pathname === "/sse" || url.pathname === "/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        response.write("retry: 60000\n\n");
        const tick = () => {
          if (response.destroyed) return;
          response.write(`data: ${Date.now()}\n\n`);
          later(tick, 1000);
        };
        later(tick, 1000);
        return;
      }
      if (url.pathname === "/poll") return; // A long-poll that never answers.
      if (url.pathname === "/delayed") {
        const ms = Math.max(0, Math.min(60000, Number(url.searchParams.get("ms")) || 0));
        later(() => {
          if (response.destroyed) return;
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ delayedMs: ms }));
        }, ms);
        return;
      }
      const status = /^\/status\/(\d{3})(\/|$)/.exec(url.pathname);
      if (status) {
        response.writeHead(Number(status[1]), { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end(`status ${status[1]}`);
        return;
      }
      if (Object.hasOwn(BUILTIN_PAGES, url.pathname)) {
        response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
        response.end(BUILTIN_PAGES[url.pathname]);
        return;
      }
      const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const relative = path.relative(root, file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const info = await stat(file);
      const target = info.isDirectory() ? path.join(file, "index.html") : file;
      const body = await readFile(target);
      response.writeHead(200, { "Content-Type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(body);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
      response.end(error?.message || "error");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.close(() => resolve());
      // SSE and long-poll connections never end on their own.
      for (const socket of sockets) socket.destroy();
    })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startFixtureServer({ port: Number(process.argv[2] || 0) });
  console.log(server.url);
  const stop = () => server.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
