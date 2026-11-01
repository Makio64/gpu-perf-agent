import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Under NODE_USE_SYSTEM_CA=1 (set by Claude Code), loading node:tls makes Node join a
// keychain thread at exit: 1-80 s stalls. The CLI's local paths must never load it.
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const browser = process.env.GPU_PERF_BROWSER_TESTS === '1';
const PRELOAD = `process.on('exit', () => {
  const loaded = process.moduleLoadList.filter(name => name === 'NativeModule tls' || name === 'NativeModule _tls_wrap' || name.startsWith('NativeModule internal/deps/undici'));
  process.stderr.write('\\nTLS-CHECK ' + JSON.stringify(loaded) + '\\n');
});`;

async function runCli(args, { timeout = 30000 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpu-perf-no-tls-'));
  try {
    const preload = path.join(directory, 'preload.cjs');
    await writeFile(preload, PRELOAD);
    const result = spawnSync(process.execPath, ['-r', preload, cli, ...args.map(arg => arg.replaceAll('$TMP', directory))], {
      encoding: 'utf8', timeout, env: { ...process.env, NODE_USE_SYSTEM_CA: '1' }
    });
    const check = /TLS-CHECK (.*)/.exec(result.stderr)?.[1];
    assert.ok(check, `no exit marker: status ${result.status} ${result.stderr.slice(-500)}`);
    return { ...result, loaded: JSON.parse(check) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('--help and compare never load tls or undici', async () => {
  assert.deepEqual((await runCli(['--help'])).loaded, []);
  const base = fileURLToPath(new URL('fixtures/v3/report-capture.json', import.meta.url));
  const compare = await runCli(['compare', '--base', base, '--candidate', base, '--out', '$TMP/compare.json', '--json']);
  assert.ok(compare.stdout.trim().startsWith('{'), compare.stderr.slice(-300));
  assert.deepEqual(compare.loaded, []);
});

test('--server client errors use node:http, not fetch', async () => {
  const result = await runCli(['run', '--server', 'http://127.0.0.1:1', '--url', 'http://127.0.0.1:2/', '--out', '$TMP/failed.json', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /127\.0\.0\.1:1/);
  assert.deepEqual(result.loaded, []);
});

test('a real capture never loads tls and exits promptly with NODE_USE_SYSTEM_CA=1', { skip: !browser, timeout: 60000 }, async () => {
  const started = performance.now();
  const result = await runCli(['run', '--file', 'examples/webgpu-clear.html', '--preset', 'quick', '--auto-instrument', '--json', '--out', '$TMP/report.json'], { timeout: 45000 });
  assert.equal(result.status, 0, result.stderr.slice(-500));
  assert.deepEqual(result.loaded, []);
  assert.ok(performance.now() - started < 15000);
});
