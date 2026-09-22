import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function createFileTarget(filePath, options = {}) {
  const file = path.resolve(filePath);
  let root = path.resolve(options.fileRoot || process.cwd());
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
  return "application/octet-stream";
}
