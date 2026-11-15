import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  formatAgxDigest,
  parseIoregAccelerator,
  sampleMacOSAgx,
  summarizeAgxSamples
} from "../src/native/macos-agx.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "src", "cli.js");

const MOCK_IOREG = `
+-o AGXAcceleratorG15C  <class AGXAcceleratorG15C, id 0x100000837, registered, matched, active, busy 0 (0 ms), retain 65>
    {
      "IOClass" = "AGXAcceleratorG15C"
      "CFBundleIdentifier" = "com.apple.AGXG15C"
      "model" = "Apple M3 Max"
      "gpu-core-count" = 30
      "AGXParameterBufferMaxSize" = 536870912
      "GPUConfigurationVariable" = {"gpu_gen"=15,"usc_gen"=15,"num_gps"=4,"num_frags"=8,"num_mgpus"=1,"gpu_var"="C"}
      "PerformanceStatistics" = {"In use system memory"=2147483648,"Alloc system memory"=4294967296,"In use system memory (driver)"=268435456,"Device Utilization %"=82,"Renderer Utilization %"=78,"Tiler Utilization %"=19,"TiledSceneBytes"=262144,"Allocated PB Size"=33554432,"SplitSceneCount"=4,"recoveryCount"=0}
    }
`;

test("parseIoregAccelerator extracts Apple AGX hardware config and PerformanceStatistics", () => {
  const parsed = parseIoregAccelerator(MOCK_IOREG);
  assert.equal(parsed.available, true);
  assert.equal(parsed.hardware.model, "Apple M3 Max");
  assert.equal(parsed.hardware.ioClass, "AGXAcceleratorG15C");
  assert.equal(parsed.hardware.gpuCoreCount, 30);
  assert.equal(parsed.hardware.gpuGen, 15);
  assert.equal(parsed.telemetry.deviceUtilizationPercent, 82);
  assert.equal(parsed.telemetry.rendererUtilizationPercent, 78);
  assert.equal(parsed.telemetry.tilerUtilizationPercent, 19);
  assert.equal(parsed.telemetry.inUseSystemMemoryMiB, 2048);
  assert.equal(parsed.telemetry.allocSystemMemoryMiB, 4096);
  assert.equal(parsed.telemetry.tiledSceneKiB, 256);
  assert.equal(parsed.telemetry.splitSceneCount, 4);

  assert.equal(parseIoregAccelerator("").available, false);
  assert.equal(parseIoregAccelerator("unrelated output").available, false);
});

test("summarizeAgxSamples classifies renderer-dominant, tiler-dominant, and split-scene overflow", () => {
  const s1 = parseIoregAccelerator(MOCK_IOREG);
  const s2 = structuredClone(s1);
  s2.telemetry.splitSceneCount = 7;
  s2.telemetry.rendererUtilizationPercent = 84;
  s2.telemetry.tilerUtilizationPercent = 22;

  const renDom = summarizeAgxSamples([s1, s2]);
  assert.equal(renDom.summary.unitBalance, "renderer-dominant");
  assert.equal(renDom.summary.splitSceneDelta, 3);
  assert.ok(renDom.hints.some((h) => /SplitScene|Parameter Buffer overflow/i.test(h)));
  assert.ok(renDom.hints.some((h) => /Renderer utilization exceeds Tiler/i.test(h)));

  const digest = formatAgxDigest(renDom);
  assert.match(digest, /Apple M3 Max \(30 cores, gen 15\) — renderer-dominant/);
  assert.match(digest, /Split scenes Δ: 3/);

  const t1 = structuredClone(s1);
  t1.telemetry.rendererUtilizationPercent = 18;
  t1.telemetry.tilerUtilizationPercent = 65;
  const tilDom = summarizeAgxSamples([t1]);
  assert.equal(tilDom.summary.unitBalance, "tiler-dominant");
  assert.ok(tilDom.hints.some((h) => /Tiler utilization exceeds Renderer/i.test(h)));
});

test("agx CLI --help and instant snapshot work on macOS without loading tls", { skip: process.platform !== "darwin" }, async () => {
  const help = spawnSync(process.execPath, [cli, "agx", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--duration-ms/);

  const live = await sampleMacOSAgx({ durationMs: 0 });
  assert.equal(live.available, true);
  assert.equal(typeof live.hardware.gpuCoreCount, "number");

  const cliRes = spawnSync(process.execPath, [cli, "agx", "--duration-ms", "0", "--json"], { encoding: "utf8" });
  assert.equal(cliRes.status, 0, cliRes.stderr);
  const json = JSON.parse(cliRes.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.available, true);
});
