import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.equal(typeof api.comparisonStatus, "function");
    assert.equal(typeof api.classifyBottleneck, "function");
    assert.equal(typeof api.selectPrimaryMetric, "function");
    assert.equal(typeof api.workEquivalence, "function");
    assert.equal(typeof api.acquireMeasurementLock, "function");
    assert.equal(typeof api.reportValidity, "function");
    assert.equal(typeof api.heapSummary, "function");
    assert.equal(typeof api.startReportServer, "function");
    assert.equal(typeof api.runMcpServer, "function");
    assert.equal(typeof api.startCpuProfile, "function");
    assert.equal(typeof api.summarizeCpuProfile, "function");
    assert.ok(api.DECISION_METRICS);

    // Verify new v2.2.0 modules load cleanly in isolation without external packages.
    for (const relModule of [
      "src/measure-lock.js",
      "src/http-client.js",
      "src/daemon.js",
      "src/cpu-profile.js"
    ]) {
      const mod = await import(pathToFileURL(path.join(directory, relModule)));
      assert.ok(mod && typeof mod === "object", `expected ${relModule} to import cleanly`);
    }

    await assert.rejects(api.runPlaywrightReport({ url: "http://127.0.0.1:5173" }), /npm install --save-dev playwright/);

    const cli = path.join(directory, "src/cli.js");
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 5000 });
    assert.equal(help.status, 0, help.stderr);
    const result = spawnSync(process.execPath, [cli, "run", "--runner", "playwright", "--url", "http://127.0.0.1:5173", "--json"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 3, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 3);
    assert.match(output.error.message, /npm install --save-dev playwright/);
    assert.match(output.error.message, /--runner fast/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new modules and fixture-server use only Node builtins", async () => {
  const filesToCheck = [
    new URL("../src/measure-lock.js", import.meta.url),
    new URL("../src/http-client.js", import.meta.url),
    new URL("../src/daemon.js", import.meta.url),
    new URL("../src/cpu-profile.js", import.meta.url),
    new URL("./fixtures/servers/fixture-server.mjs", import.meta.url)
  ];
  const importSpecifiers = /^(?:import\s+(?:[^"']+?\s+from\s+)?|(?:const|let|var)\s+[^=]+=\s*createRequire\([^)]+\)\(\s*)["']([^"']+)["']/gm;

  for (const fileUrl of filesToCheck) {
    const source = await readFile(fileUrl, "utf8");
    for (const match of source.matchAll(importSpecifiers)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"),
        `unexpected non-builtin import "${specifier}" in ${fileUrl.pathname}`
      );
    }
  }
});
