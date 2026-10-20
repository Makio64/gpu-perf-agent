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
  assert.match(result.stdout, /--sampling-mode frames\|hook/);
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

test('inspect CLI returns bounded selected evidence and validates before reading', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { inspectReport } = await import('../src/inspect.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'gpu-inspect-'));
  try {
    const reportPath = path.join(directory, 'report.json');
    const report = { inPage: { samples: [{ measurement: { gpuMs: 0 } }, { measurement: { gpuMs: 2 } }] }, trace: { raw: 'x'.repeat(100000) } };
    await writeFile(reportPath, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, 'inspect', '--report', reportPath, '--section', 'samples', '--offset', '1', '--limit', '1'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { reportPath, ...inspectReport(report, { section: 'samples', offset: 1, limit: 1 }) });
    assert.ok(Buffer.byteLength(result.stdout) < 17000);
    for (const [key, value] of [['limit', '11'], ['offset', '-1'], ['offset', ''], ['run', '0.5']]) {
      const invalid = spawnSync(process.execPath, [cli, 'inspect', '--report', '/does/not/exist', `--${key}`, value], { encoding: 'utf8' });
      assert.equal(invalid.status, 1);
      assert.equal(JSON.parse(invalid.stdout).ok, false);
      assert.doesNotMatch(invalid.stdout, /ENOENT/);
    }
    assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report);
    const failure = { runError: { message: 'capture failed' }, diagnostics: { validity: { valid: false, issues: [{ code: 'run-failed' }] } } };
    await writeFile(reportPath, JSON.stringify(failure));
    const failedCapture = spawnSync(process.execPath, [cli, 'inspect', '--report', reportPath, '--section', 'errors'], { encoding: 'utf8' });
    assert.equal(failedCapture.status, 0, failedCapture.stderr || failedCapture.stdout);
    assert.equal(JSON.parse(failedCapture.stdout).validity.valid, false);
    assert.equal(JSON.parse(failedCapture.stdout).data.errors[0].error.message, 'capture failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown commands and invalid sampling values return JSON without launching Chrome', () => {
  for (const args of [['oops'], ['run', '--url', 'http://localhost:1234', '--samples', '0'], ['run', '--url', 'http://localhost:1234', '--duration-ms', 'NaN'],
    ['run', '--url', 'http://localhost:1234', '--sampling-mode', 'invalid'], ['agent', '--url', 'http://localhost:1234', '--sampling-mode', 'hook', '--adaptive']]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test('command help works and documents persistent agent usage', () => {
  for (const command of ['agent', 'run', 'serve', 'compare', 'inspect']) {
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

test('A/B rejects conflicting output and invalid readiness before browser launch', () => {
  const target = ['ab', '--base-url', 'http://localhost:1', '--candidate-url', 'http://localhost:2'];
  for (const [args, message] of [
    [['--agent', '--json'], /Choose --json or --agent/],
    [['--wait-until', 'invalid', '--json'], /waitUntil/],
    [['--device-scale-factor', '0', '--json'], /deviceScaleFactor/],
    [['--wait-condition-timeout', '0', '--json'], /waitConditionTimeoutMs/],
    [['--sampling-mode', 'invalid', '--json'], /samplingMode/]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...target, ...args], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error.message, message);
  }
});

test('CLI run and agent forward hook mode with default hook readiness through the HTTP service', async t => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'gpu-cli-hook-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const options = JSON.parse(Buffer.concat(chunks));
    requests.push(options);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ options, inPage: { hook: { found: true }, samples: [{ measurement: { gpuMs: 0 } }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const service = `http://127.0.0.1:${server.address().port}`;
  for (const [index, command, args] of [[0, 'run', []], [1, 'run', ['--sampling-mode', 'hook']], [2, 'agent', ['--sampling-mode', 'hook']]]) {
    const child = spawn(process.execPath, [cli, command, '--url', 'http://localhost:1234', '--samples', '1', '--server', service,
      '--out', path.join(directory, `${index}.json`), '--json', ...args], { cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(status, 0, stderr || stdout);
    assert.equal(JSON.parse(stdout).ok, true);
  }
  assert.equal(requests[0].samplingMode, 'frames');
  assert.equal(requests[0].waitForHook, undefined);
  assert.equal(requests[1].samplingMode, 'hook');
  assert.equal(requests[1].waitForHook, true);
  assert.equal(requests[2].samplingMode, 'hook');
  assert.equal(requests[2].waitForHook, true);
});

test('quick doctor locates xctrace without enumerating templates and handles missing tools', { skip: process.platform !== 'darwin' }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'gpu-doctor-'));
  const xcrun = path.join(directory, 'xcrun');
  const calls = path.join(directory, 'calls.jsonl');
  try {
    await writeFile(xcrun, `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); console.log(process.argv[2]==='--find'?'/mock/xctrace':'Metal System Trace');`, { mode: 0o755 });
    const env = { ...process.env, PATH: directory };
    const quick = spawnSync(process.execPath, [cli, 'doctor', '--quick', '--json'], { env, encoding: 'utf8' });
    assert.equal(quick.status, 0, quick.stderr);
    const result = JSON.parse(quick.stdout);
    assert.equal(result.xctrace.available, true);
    assert.equal(result.xctrace.templatesProbed, false);
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse), [['--find', 'xctrace']]);
    const full = spawnSync(process.execPath, ['--input-type=module', '-e', 'import {macOSProfilerStatus} from "./src/native/macos-xctrace.js";console.log(JSON.stringify(await macOSProfilerStatus()));'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).templatesProbed, true);
    assert.deepEqual(JSON.parse(full.stdout).templates, ['Metal System Trace']);
    await rm(xcrun);
    const missing = spawnSync(process.execPath, [cli, 'doctor', '--quick', '--json'], { env, encoding: 'utf8' });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).xctrace.available, false);
    assert.match(JSON.parse(missing.stdout).xctrace.xctraceError, /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
