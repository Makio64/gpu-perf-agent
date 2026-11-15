import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeShader,
  analyzeShaderStatic,
  compareShaderAnalyses,
  detectShaderLanguage,
  formatShaderComparisonDigest,
  formatShaderDigest,
  normalizeNagaMslBindings,
  parseMetalAirDisassembly
} from "../src/shader-analyzer.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "src", "cli.js");

test("detectShaderLanguage and analyzeShaderStatic flag TBDR and Apple SIMD32 hazards", () => {
  assert.equal(detectShaderLanguage("", "foo.wgsl"), "wgsl");
  assert.equal(detectShaderLanguage("", "foo.metal"), "msl");
  assert.equal(detectShaderLanguage("#version 450\nvoid main(){}", ""), "glsl");

  const hazardousWgsl = `
    @group(0) @binding(0) var<storage, read_write> outBuf: array<vec4<f32>>;
    @compute @workgroup_size(48)
    fn cs_bad(@builtin(global_invocation_id) id: vec3<u32>) {
      var lut: array<f32, 8>;
      let v = lut[id.x & 7u];
      let p = pow(vec4<f32>(v), vec4<f32>(2.0)) + vec4<f32>(1.0) / sqrt(vec4<f32>(v + 1.0));
      workgroupBarrier();
      workgroupBarrier();
      outBuf[id.x] = clamp(p, vec4<f32>(0.0), vec4<f32>(1.0));
    }

    @fragment
    fn fs_bad(@location(0) alpha: f32) -> @builtin(frag_depth) f32 {
      if (alpha < 0.5) {
        discard;
      }
      return alpha;
    }
  `;

  const stat = analyzeShaderStatic(hazardousWgsl);
  assert.equal(stat.language, "wgsl");
  assert.equal(stat.usesF16, false);
  assert.equal(stat.usesSubgroups, false);
  assert.equal(stat.entryPoints.length, 2);

  const codes = new Set(stat.hazards.map((h) => h.code));
  assert.ok(codes.has("tbdr-hsr-killer-discard"));
  assert.ok(codes.has("tbdr-late-z-frag-depth"));
  assert.ok(codes.has("workgroup-not-simd32-multiple"));
  assert.ok(codes.has("register-spill-dynamic-array-index"));
  assert.ok(codes.has("pow-algebraic-simplification"));
  assert.ok(codes.has("reciprocal-sqrt"));
  assert.ok(codes.has("clamp-to-saturate"));
  assert.ok(codes.has("subgroup-reduction-opportunity"));
});

test("normalizeNagaMslBindings rewrites texture, sampler, and buffer fake bindings safely", () => {
  const rawMsl = `
fragment fs_out fs_main(
  fs_in varyings [[stage_in]],
  metal::texture2d<float, metal::access::sample> albedo [[user(fake0)]],
  metal::depth2d<float, metal::access::sample> shadowTex [[user(fake0)]],
  metal::sampler linSmp [[user(fake0)]],
  constant Globals& globals [[user(fake0)]],
  device float4* storageBuf [[user(fake0)]]
) {
  return {};
}`;
  const normalized = normalizeNagaMslBindings(rawMsl);
  assert.doesNotMatch(normalized, /\[\[user\(fake/);
  assert.match(normalized, /albedo \[\[texture\(0\)\]\]/);
  assert.match(normalized, /shadowTex \[\[texture\(1\)\]\]/);
  assert.match(normalized, /linSmp \[\[sampler\(0\)\]\]/);
  assert.match(normalized, /globals \[\[buffer\(0\)\]\]/);
  assert.match(normalized, /storageBuf \[\[buffer\(1\)\]\]/);
});

test("parseMetalAirDisassembly counts post-optimization AIR instructions without metadata bleed", () => {
  const sampleAir = `
define void @cs_main(<4 x half> addrspace(1)* %0) local_unnamed_addr #0 {
  %2 = load <4 x half>, <4 x half> addrspace(1)* %0, align 8
  %3 = tail call fast <4 x half> @air.fast_rsqrt.v4f16(<4 x half> %2)
  %4 = tail call fast <4 x half> @air.fma.v4f16(<4 x half> %2, <4 x half> %2, <4 x half> %3)
  %5 = tail call { <4 x float>, i8 } @air.sample_texture_2d.v4f32(%struct._texture_2d_t addrspace(1)* undef, %struct._sampler_t addrspace(2)* undef, <2 x float> zeroinitializer)
  store <4 x half> %4, <4 x half> addrspace(1)* %0, align 8
  ret void
}
attributes #0 = { nounwind }
!0 = !{i32 1, !"meta", i32 2}
`;
  const parsed = parseMetalAirDisassembly(sampleAir);
  assert.ok(parsed);
  assert.equal(parsed.totals.airInstructions, 6);
  assert.equal(parsed.totals.f16Ops, 2);
  assert.equal(parsed.totals.fmaOps, 1);
  assert.equal(parsed.totals.transcendentals, 1);
  assert.equal(parsed.totals.textureOps, 1);
  assert.equal(parsed.totals.deviceLoads, 1);
  assert.equal(parsed.totals.deviceStores, 1);
});

test("analyzeShader and CLI shader --base/--candidate compile real Metal AIR & Apple GPU ISA on macOS", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gpu-shader-test-"));
  try {
    const baseCode = `
      @group(0) @binding(0) var<storage, read_write> buf: array<vec4<f32>>;
      @compute @workgroup_size(50)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let x = buf[id.x];
        buf[id.x] = pow(x, vec4<f32>(2.0)) + vec4<f32>(1.0) / sqrt(abs(x) + vec4<f32>(1e-4));
      }
    `;
    const candCode = `
      enable f16;
      @group(0) @binding(0) var<storage, read_write> buf: array<vec4<f16>>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let x = buf[id.x];
        buf[id.x] = fma(x, x, inverseSqrt(abs(x) + vec4<f16>(1e-3h)));
      }
    `;
    const baseFile = path.join(dir, "base.wgsl");
    const candFile = path.join(dir, "cand.wgsl");
    await writeFile(baseFile, baseCode, "utf8");
    await writeFile(candFile, candCode, "utf8");

    const baseRes = await analyzeShader(baseCode, { label: "base.wgsl" });
    const candRes = await analyzeShader(candCode, { label: "cand.wgsl" });
    assert.equal(baseRes.metalAir.available, true);
    assert.equal(candRes.metalAir.available, true);
    assert.ok(candRes.metalAir.totals.f16Ops > 0);
    assert.ok(candRes.metalAir.totals.fmaOps > 0);
    if (candRes.appleGpu.available) {
      assert.ok(candRes.appleGpu.entries[0].nativeCodeBytes > 0);
      assert.ok(candRes.appleGpu.entries[0].maxTotalThreadsPerThreadgroup > 0);
    }

    const cmp = compareShaderAnalyses(baseRes, candRes);
    assert.equal(cmp.metrics.f32Ops.direction, "better");
    assert.ok(cmp.resolvedHazards.includes("workgroup-not-simd32-multiple"));
    assert.match(formatShaderDigest(candRes), /Metal AIR \(-O2\):/);
    assert.match(formatShaderComparisonDigest(cmp), /SHADER A\/B:/);

    const cliRes = spawnSync(process.execPath, [cli, "shader", "--base", baseFile, "--candidate", candFile, "--json"], { encoding: "utf8" });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    const parsed = JSON.parse(cliRes.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "compare");
    assert.equal(parsed.comparison.metrics.transcendentals.direction, "better");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
