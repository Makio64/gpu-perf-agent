import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareOutputBuffers,
  f16ToNumber,
  formatKernelDigest,
  numberToF16Bits,
  parseBufferOverrides,
  parseWgslBindingsAndEntry,
  parseWorkgroups,
  runKernelBenchmark
} from "../src/kernel-runner.js";

const cli = path.resolve(new URL("../src/cli.js", import.meta.url).pathname);
const browserTests = process.env.GPU_PERF_BROWSER_TESTS === "1";

let hasDawnNode = false;
try {
  const pkg = "webgpu";
  hasDawnNode = Boolean(import.meta.resolve(pkg));
} catch {
  hasDawnNode = false;
}

test("parseWgslBindingsAndEntry extracts compute entries, f16/subgroups, and buffer kinds", () => {
  const code = `
    enable f16;
    enable subgroups;
    @group(0) @binding(0) var<uniform> params: vec4<f32>;
    @group(0) @binding(1) var<storage, read> srcBuf: array<vec4<f16>>;
    @group(1) @binding(0) var<storage, read_write> dstBuf: array<vec4<f16>>;
    @compute @workgroup_size(8, 8, 1)
    fn cs_main(@builtin(global_invocation_id) id: vec3<u32>) {}
  `;
  const parsed = parseWgslBindingsAndEntry(code);
  assert.equal(parsed.usesF16, true);
  assert.equal(parsed.usesSubgroups, true);
  assert.deepEqual(parsed.entryPoints, [{ name: "cs_main", workgroupSize: [8, 8, 1] }]);
  assert.equal(parsed.bindings.length, 3);
  assert.deepEqual(parsed.bindings.map((b) => `${b.group}:${b.binding}:${b.kind}:${b.scalar}`), [
    "0:0:uniform:f32",
    "0:1:storage-ro:f16",
    "1:0:storage-rw:f16"
  ]);
});

test("parseWorkgroups and parseBufferOverrides validate and normalize options", () => {
  assert.deepEqual(parseWorkgroups("128,2,1"), [128, 2, 1]);
  assert.deepEqual(parseWorkgroups(64), [64, 1, 1]);
  assert.throws(() => parseWorkgroups("0,1,1"), /between 1 and/);
  assert.deepEqual(parseBufferOverrides(["0:1=1025"]), { "0:1": 1028 });
  assert.throws(() => parseBufferOverrides(["bad"]), /Invalid buffer override/);
});

test("f16 encode/decode and compareOutputBuffers handle unaligned Buffers, tolerances, and mismatches", () => {
  const bits = numberToF16Bits(1.5);
  assert.ok(Math.abs(f16ToNumber(bits) - 1.5) < 1e-4);

  // Create unaligned Uint8Array views (byteOffset = 1) mimicking Buffer.from slab slices.
  const slabA = new Uint8Array(20);
  const slabB = new Uint8Array(20);
  const fa = new Float32Array([1.0, 2.0, 3.0, 4.0]);
  const fb = new Float32Array([1.0, 2.000001, 3.0, 4.0]);
  slabA.set(new Uint8Array(fa.buffer), 1);
  slabB.set(new Uint8Array(fb.buffer), 1);
  const unalignedA = slabA.subarray(1, 17);
  const unalignedB = slabB.subarray(1, 17);

  assert.equal(compareOutputBuffers(unalignedA, unalignedA, "f32", 1e-5).exactBitMatch, true);
  const tolPass = compareOutputBuffers(unalignedA, unalignedB, "f32", 1e-4);
  assert.equal(tolPass.ok, true);
  assert.equal(tolPass.exactBitMatch, false);
  assert.ok(tolPass.maxAbsDiff < 1e-4);

  const tolFail = compareOutputBuffers(unalignedA, unalignedB, "f32", 1e-7);
  assert.equal(tolFail.ok, false);
  assert.equal(tolFail.mismatchedElements, 1);

  // f16 comparison check
  const ha = new Uint16Array([numberToF16Bits(0.5), numberToF16Bits(2.0)]);
  const hb = new Uint16Array([numberToF16Bits(0.5), numberToF16Bits(3.0)]);
  const f16Cmp = compareOutputBuffers(new Uint8Array(ha.buffer), new Uint8Array(hb.buffer), "f16", 1e-3);
  assert.equal(f16Cmp.ok, false);
  assert.equal(f16Cmp.mismatchedElements, 1);
  assert.ok(Math.abs(f16Cmp.maxAbsDiff - 1.0) < 1e-3);
});

test("runKernelBenchmark on dawn-node benchmarks single kernel, verifies A/B speedup, and catches output mismatch", {
  skip: !hasDawnNode || process.platform !== "darwin"
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gpu-kernel-test-"));
  try {
    const heavyCode = `
      @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let idx = id.x % arrayLength(&src);
        var acc = src[idx];
        for (var i = 0u; i < 64u; i = i + 1u) {
          acc = sqrt(acc * acc + vec4<f32>(0.25)) - vec4<f32>(0.125);
        }
        dst[idx] = acc - acc + src[idx] * vec4<f32>(2.0);
      }
    `;
    const fastCode = `
      @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let idx = id.x % arrayLength(&src);
        dst[idx] = src[idx] * vec4<f32>(2.0);
      }
    `;
    // Distinct non-DCE heavy shader vs fast shader for real GPU speedup check
    const heavyRealCode = `
      @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let idx = id.x % arrayLength(&src);
        var acc = src[idx];
        for (var i = 0u; i < 200u; i = i + 1u) {
          acc = sin(acc * vec4<f32>(0.5)) + cos(acc * vec4<f32>(0.25));
        }
        dst[idx] = acc;
      }
    `;
    const wrongCode = `
      @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let idx = id.x % arrayLength(&src);
        dst[idx] = src[idx] * vec4<f32>(3.0);
      }
    `;

    const single = await runKernelBenchmark({
      code: fastCode,
      runner: "dawn-node",
      workgroups: "256,1,1",
      storageBytes: 1024 * 1024,
      warmup: 4,
      rounds: 6,
      dispatches: 2,
      measureLock: false
    });
    assert.equal(single.ok, true);
    assert.equal(single.runner, "dawn-node");
    assert.equal(single.rounds, 6);
    assert.ok(single.gpuMsPerDispatch.mean >= 0);
    assert.match(formatKernelDigest(single), /KERNEL /);

    // 1. Equivalent shaders verify exact bit match and pass readback check.
    const abSame = await runKernelBenchmark({
      baseCode: fastCode,
      candidateCode: fastCode.replace("src[idx] * vec4<f32>(2.0)", "src[idx] + src[idx]"),
      runner: "dawn-node",
      workgroups: "256,1,1",
      storageBytes: 262144,
      warmup: 4,
      rounds: 6,
      dispatches: 2,
      measureLock: false
    });
    assert.equal(abSame.verification.ok, true);
    assert.equal(abSame.verification.exactBitMatch, true);

    // 2. Heavy ALU compute kernel vs fast kernel produces a real hardware speedup.
    const abFast = await runKernelBenchmark({
      baseCode: heavyRealCode,
      candidateCode: fastCode,
      runner: "dawn-node",
      workgroups: "2048,1,1",
      storageBytes: 4 * 1024 * 1024,
      warmup: 8,
      rounds: 16,
      dispatches: 4,
      verify: false,
      measureLock: false
    });
    assert.equal(abFast.comparison.status, "improved", JSON.stringify(abFast.comparison));
    assert.match(formatKernelDigest(abFast), /IMPROVED —/);
    void heavyCode;

    const baseFile = path.join(dir, "base.wgsl");
    const wrongFile = path.join(dir, "wrong.wgsl");
    await writeFile(baseFile, fastCode, "utf8");
    await writeFile(wrongFile, wrongCode, "utf8");

    const cliMismatch = spawnSync(process.execPath, [
      cli, "kernel",
      "--base", baseFile,
      "--candidate", wrongFile,
      "--runner", "dawn-node",
      "--workgroups", "64",
      "--storage-bytes", "65536",
      "--warmup", "2",
      "--rounds", "4",
      "--dispatches", "1",
      "--no-lock",
      "--json"
    ], { encoding: "utf8", timeout: 15000 });
    assert.equal(cliMismatch.status, 2, cliMismatch.stderr);
    const parsedMismatch = JSON.parse(cliMismatch.stdout);
    assert.equal(parsedMismatch.verification.ok, false);
    assert.equal(parsedMismatch.comparison.status, "different-output");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser: runKernelBenchmark --runner chrome fallback executes and verifies WGSL outputs", {
  skip: !browserTests,
  timeout: 45000
}, async () => {
  const baseCode = `
    @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let idx = id.x % arrayLength(&src);
      dst[idx] = src[idx] + src[idx];
    }
  `;
  const candCode = `
    @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let idx = id.x % arrayLength(&src);
      dst[idx] = src[idx] * vec4<f32>(2.0);
    }
  `;
  const res = await runKernelBenchmark({
    baseCode,
    candidateCode: candCode,
    runner: "chrome",
    workgroups: "64,1,1",
    storageBytes: 65536,
    warmup: 2,
    rounds: 4,
    dispatches: 1,
    measureLock: false
  });
  assert.equal(res.runner, "chrome");
  assert.equal(res.verification.ok, true);
  assert.equal(res.verification.exactBitMatch, true);
  assert.equal(res.rounds, 4);
});
