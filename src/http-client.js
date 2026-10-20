import { createRequire } from "node:module";

// Never load node:tls on the local path: under NODE_USE_SYSTEM_CA=1, Node joins a
// keychain thread at exit after tls loads (1-80 s stalls). ESM `import "node:http"`,
// global fetch and global WebSocket all load undici and tls; createRequire does not.
const require = createRequire(import.meta.url);

/**
 * Small JSON client for CDP discovery and `--server`. https is required lazily, only
 * for https: URLs. Network failures throw `server-unreachable`.
 */
export function requestJson(url, { method = "GET", body, headers = {}, timeoutMs = 10000 } = {}) {
  const target = url instanceof URL ? url : new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    return Promise.reject(Object.assign(new TypeError(`Expected an HTTP(S) URL, received ${target.protocol}`), { code: "invalid-options" }));
  }
  const transport = target.protocol === "https:" ? require("node:https") : require("node:http");
  const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const requestHeaders = { accept: "application/json", ...headers };
  if (payload) {
    requestHeaders["content-type"] ??= "application/json";
    requestHeaders["content-length"] = payload.byteLength;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = transport.request(target, { method, headers: requestHeaders, agent: false }, (response) => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", error => finish(unreachable(target, error)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        if (text.trim()) {
          try { json = JSON.parse(text); }
          catch {
            return finish(Object.assign(new Error(`${target.origin} returned HTTP ${response.statusCode} with a non-JSON body.`), {
              code: "server-unreachable", status: response.statusCode
            }));
          }
        }
        finish(null, { status: response.statusCode, json });
      });
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish(unreachable(target, Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })));
    }, timeoutMs);
    request.on("error", error => finish(unreachable(target, error)));
    request.end(payload ?? undefined);
  });
}

function unreachable(target, cause) {
  return Object.assign(new Error(`Could not reach ${target.origin}: ${cause?.code || cause?.message || cause}.`, { cause }), {
    code: "server-unreachable",
    hint: "Check that the server is running and the URL/port is correct."
  });
}
