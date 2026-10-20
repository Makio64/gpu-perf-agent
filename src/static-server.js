import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// createRequire, not ESM `import "node:http"`: the ESM namespace evaluates http's lazy
// WebSocket getters, which load undici and tls (see http-client.js).
const { createServer } = createRequire(import.meta.url)("node:http");

/** Nearest ancestor of `file` that holds package.json or .git, else dirname(file). */
export function resolveFileRoot(file) {
  const start = path.dirname(path.resolve(file));
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "package.json")) || existsSync(path.join(directory, ".git"))) return directory;
    if (path.dirname(directory) === directory) return start;
  }
}

/** Throws `file-not-found` (with a hint naming the argument and cwd) unless `file` is a readable file. */
export async function assertFileTarget(filePath, { fileArg = filePath } = {}) {
  const file = path.resolve(filePath);
  let info = null;
  try { info = await stat(file); } catch { /* Reported below. */ }
  if (!info?.isFile()) {
    throw Object.assign(new Error(`File not found: ${file}`), {
      code: "file-not-found",
      hint: `resolved from --file ${fileArg}, cwd ${process.cwd()}`
    });
  }
  return file;
}

export async function createFileTarget(filePath, options = {}) {
  const file = await assertFileTarget(filePath, options);
  let root = path.resolve(options.fileRoot || resolveFileRoot(file));
  let relative = path.relative(root, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    root = path.dirname(file);
    relative = path.basename(file);
  }

  const server = await startStaticServer(root);
  return {
    close: server.close,
    file,
    root,
    url: `http://127.0.0.1:${server.port}/${toUrlPath(relative)}`
  };
}

async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204, {
          "Cache-Control": "no-store"
        });
        response.end();
        return;
      }

      const decoded = decodeURIComponent(requestUrl.pathname);
      const candidate = path.resolve(root, `.${decoded}`);
      const relative = path.relative(root, candidate);

      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const fileStat = await stat(candidate);
      const file = fileStat.isDirectory() ? path.join(candidate, "index.html") : candidate;
      const body = await readFile(file);

      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentType(file)
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500);
      response.end(error?.message || "Not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    close: () => new Promise((resolve) => {
      server.close(resolve);
      // Chrome may retain speculative/preconnect sockets after its target is closed.
      // This server belongs only to that target, so no remaining request is useful.
      server.closeAllConnections();
    }),
    port: server.address().port
  };
}

function toUrlPath(filePath) {
  return filePath.split(path.sep).map(encodeURIComponent).join("/");
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".wasm") {
    return "application/wasm";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".webp" || extension === ".gif") {
    return `image/${extension.slice(1)}`;
  }
  if (extension === ".gltf") {
    return "model/gltf+json";
  }
  if (extension === ".glb") {
    return "model/gltf-binary";
  }
  if (extension === ".wgsl" || extension === ".glsl" || extension === ".txt") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}
