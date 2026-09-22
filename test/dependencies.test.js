import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("public API and CLI load without packages and explain the optional runner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-no-dependencies-"));
  try {
    await cp(new URL("../src", import.meta.url), path.join(directory, "src"), { recursive: true });
    await cp(new URL("../package.json", import.meta.url), path.join(directory, "package.json"));

    const api = await import(pathToFileURL(path.join(directory, "src/index.js")));
    assert.equal(api.runReport, api.runFastReport);
    assert.equal(typeof api.FastCDPHarness.launch, "function");
    assert.equal(typeof api.compareReports, "function");
    await assert.rejects(api.runPlaywrightReport({ url: "http://127.0.0.1:5173" }), /npm install --save-dev playwright/);

    const cli = path.join(directory, "src/cli.js");
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 5000 });
    assert.equal(help.status, 0, help.stderr);
    const result = spawnSync(process.execPath, [cli, "run", "--runner", "playwright", "--url", "http://127.0.0.1:5173", "--json"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.error.message, /npm install --save-dev playwright/);
    assert.match(output.error.message, /--runner fast/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
