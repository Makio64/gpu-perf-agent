import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const root = new URL("dist/", import.meta.url);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/src/style.css", ["src/style.css", "text/css; charset=utf-8"]],
  ["/src/main.js", ["src/main.js", "text/javascript; charset=utf-8"]],
  ["/assets/mark.svg", ["assets/mark.svg", "image/svg+xml"]],
]);
const server = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const entry = files.get(new URL(request.url, "http://localhost").pathname);
  if (!entry) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const data = await readFile(new URL(entry[0], root));
    response.writeHead(200, {
      "Content-Type": entry[1],
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch {
    response.writeHead(404).end("Build the site first: npm run build");
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log(`Website preview: http://127.0.0.1:${server.address().port}/`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
