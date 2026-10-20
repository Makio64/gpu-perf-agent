import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileTarget } from "../src/static-server.js";

const enabled = process.env.GPU_PERF_NETWORK_TESTS === "1" || process.env.GPU_PERF_BROWSER_TESTS === "1";

test("createFileTarget serves sibling-project modules with correct content types", { skip: !enabled }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-static-"));
  await writeFile(path.join(directory, "index.html"), '<script type="module" src="./scene.js"></script>');
  await writeFile(path.join(directory, "scene.js"), "export const ready = true;");
  const target = await createFileTarget(path.join(directory, "index.html"), { fileRoot: directory });
  try {
    const html = await fetch(target.url);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    const module = await fetch(new URL("scene.js", target.url));
    assert.match(module.headers.get("content-type"), /text\/javascript/);
    assert.equal(await module.text(), "export const ready = true;");
  } finally {
    await target.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("createFileTarget falls back to the file directory when root is outside", { skip: !enabled }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-root-"));
  const file = path.join(directory, "page with spaces.html");
  await writeFile(file, "<!doctype html><title>fixture</title>");
  const target = await createFileTarget(file, { fileRoot: process.cwd() });
  try {
    assert.equal(target.root, directory);
    assert.equal((await fetch(target.url)).status, 200);
  } finally {
    await target.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('closing a file target releases speculative sockets without waiting for HTTP timeout', { skip: !enabled }, async () => {
  const { createConnection } = await import('node:net');
  const target = await createFileTarget(path.resolve('fixtures/sibling-project/index.html'));
  const socket = createConnection({host:'127.0.0.1',port:Number(new URL(target.url).port)});
  await new Promise((resolve, reject) => { socket.once('connect',resolve); socket.once('error',reject); });
  let timer;
  try {
    await Promise.race([target.close(), new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('File target close hung on unused socket')),1000);})]);
  } finally { clearTimeout(timer); socket.destroy(); await target.close(); }
});

test('resolveFileRoot picks the nearest package.json/.git ancestor, else the file directory', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { resolveFileRoot } = await import('../src/static-server.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-root-detect-'));
  try {
    await mkdir(path.join(directory, 'app', 'examples', 'deep'), { recursive: true });
    await writeFile(path.join(directory, 'app', 'package.json'), '{}');
    assert.equal(resolveFileRoot(path.join(directory, 'app', 'examples', 'deep', 'page.html')), path.join(directory, 'app'));
    await mkdir(path.join(directory, 'app', 'examples', '.git'));
    assert.equal(resolveFileRoot(path.join(directory, 'app', 'examples', 'deep', 'page.html')), path.join(directory, 'app', 'examples'));
    assert.equal(resolveFileRoot(path.resolve('examples/webgpu-clear.html')), process.cwd());
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('a missing --file fails with file-not-found before Chrome launches', async () => {
  const { runFastReport } = await import('../src/fast-cdp-runner.js');
  const started = performance.now();
  await assert.rejects(runFastReport({ file: path.resolve('does-not-exist/page.html'), executablePath: '/definitely/missing' }), (error) => {
    assert.equal(error.code, 'file-not-found');
    assert.match(error.hint, /resolved from --file .*cwd /);
    return true;
  });
  assert.ok(performance.now() - started < 100, `took ${performance.now() - started} ms`);
});
