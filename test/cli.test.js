import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "src", "cli.js");

test("package exposes gpu-perf-agent and compatibility binaries", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "gpu-perf-agent");
  assert.equal(pkg.bin["gpu-perf-agent"], "./src/cli.js");
  assert.equal(pkg.bin["webgpu-report"], "./src/cli.js");
});

test("CLI help documents agent and cross-project workflows", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--auto-instrument/);
  assert.match(result.stdout, /--preset quick\|confirm\|profile/);
  assert.match(result.stdout, /Cross-project usage/);
});

test("doctor quick emits parseable agent JSON", () => {
  const result = spawnSync(process.execPath, [cli, "doctor", "--quick", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.match(output.node, /^v/);
  assert.equal(typeof output.xctrace.available, "boolean");
});

test("CLI failures remain machine-readable with --json", () => {
  const result = spawnSync(process.execPath, [cli, "run", "--preset", "unknown", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(output.error.message, /Unknown preset/);
});

test('unknown commands and invalid sampling values return JSON without launching Chrome', () => {
  for (const args of [['oops'], ['run', '--url', 'http://localhost:1234', '--samples', '0'], ['run', '--url', 'http://localhost:1234', '--duration-ms', 'NaN']]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test('command help works and documents persistent agent usage', () => {
  for (const command of ['agent', 'run', 'serve', 'compare']) {
    const result = spawnSync(process.execPath, [cli, command, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--server URL/);
  }
});

test('artifact collisions are rejected before profiling', () => {
  const result = spawnSync(process.execPath, [cli, 'run', '--file', 'x.html', '--out', 'same.json', '--screenshot-out', 'same.json', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error.message, /must be different/);
});

test('CLI comparison cannot waive invalid measurements with --allow-mismatch', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'gpu-compare-'));
  const file = path.join(directory, 'empty.json');
  try {
    await writeFile(file, '{}');
    const result = spawnSync(process.execPath, [cli, 'compare', '--base', file, '--candidate', file, '--allow-mismatch', '--json'], {encoding:'utf8'});
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.validity.valid, false);
    assert.equal(output.failures.length, 0);
  } finally { await rm(directory, {recursive:true, force:true}); }
});
