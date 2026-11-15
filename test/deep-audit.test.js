import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  analyzeAuditSnapshot,
  estimateTextureBytes,
  formatAuditDigest
} from "../src/deep-audit.js";
import { parseXctraceTocXml } from "../src/native/macos-xctrace.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "src", "cli.js");

test("estimateTextureBytes computes uncompressed, MSAA, mipmapped, and ASTC/BC sizes accurately", () => {
  // 1024x1024 rgba8unorm single mip = 4 MiB
  assert.equal(estimateTextureBytes({ width: 1024, height: 1024, format: "rgba8unorm", mipLevelCount: 1 }), 4 * 1024 * 1024);
  // 1024x1024 astc-4x4-unorm single mip = (256 * 256) * 16 = 1 MiB (4x smaller!)
  assert.equal(estimateTextureBytes({ width: 1024, height: 1024, format: "astc-4x4-unorm", mipLevelCount: 1 }), 1 * 1024 * 1024);
  // 1920x1080 4x MSAA rgba16float = 1920 * 1080 * 8 * 4 = 66,355,200 B
  assert.equal(estimateTextureBytes({ width: 1920, height: 1080, format: "rgba16float", sampleCount: 4 }), 66355200);
});

test("analyzeAuditSnapshot flags TBDR storeOp leaks, unmipped/uncompressed textures, rgba16float targets, and unpacked vertices", () => {
  const snapshot = {
    viewport: { width: 1920, height: 1080, dpr: 2 },
    adapter: { vendor: "apple", architecture: "metal-3", features: ["shader-f16", "subgroups", "rg11b10ufloat-renderable"] },
    wgslFeatures: ["packed_4x8_integer_dot_product"],
    frameIndex: 10,
    totalBindGroupsCreated: 120,
    textures: [
      // id 0: MSAA 4x color attachment
      { id: 0, label: "msaa-color", width: 1920, height: 1080, mipLevelCount: 1, sampleCount: 4, dimension: "2d", format: "rgba16float", usage: 0x10, destroyed: false, sampledInBindGroup: false },
      // id 1: Transient depth attachment (never sampled in bind group!)
      { id: 1, label: "main-depth", width: 1920, height: 1080, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format: "depth32float", usage: 0x10, destroyed: false, sampledInBindGroup: false },
      // id 2: Large uncompressed unmipped static albedo texture (TEXTURE_BINDING = 0x04)
      { id: 2, label: "albedo-4k", width: 2048, height: 2048, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format: "rgba8unorm-srgb", usage: 0x04 | 0x02, destroyed: false, sampledInBindGroup: true }
    ],
    samplers: [
      { id: 0, label: "aniso16", maxAnisotropy: 16 }
    ],
    buffers: [
      { id: 0, size: 1048576, usage: 0x20, destroyed: false }
    ],
    shaders: [
      { id: 0, label: "pbr", code: "@fragment fn fs() -> @location(0) vec4f { discard; return vec4f(1.0); }" },
      { id: 1, label: "pbr-dup", code: "@fragment fn fs() -> @location(0) vec4f { discard; return vec4f(1.0); }" }
    ],
    pipelines: [
      {
        id: 0,
        kind: "render",
        sync: true,
        vertexBuffers: [{
          arrayStride: 48,
          stepMode: "vertex",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" }
          ]
        }]
      },
      { id: 1, kind: "render", sync: true, vertexBuffers: [] },
      { id: 2, kind: "compute", sync: true }
    ],
    steadyFrame: {
      submits: 4,
      bindGroupsCreated: 20,
      writeBufferCalls: 12,
      writeBufferBytes: 4096,
      texturesCreated: 0,
      buffersCreated: 0,
      passes: [
        {
          kind: "render",
          label: "opaque-msaa",
          draws: 42,
          indirectDraws: 0,
          bundles: 0,
          pipelineSwitches: 5,
          colorAttachments: [
            { texId: 0, isCanvas: false, format: "rgba16float", width: 1920, height: 1080, sampleCount: 4, hasResolveTarget: true, loadOp: "clear", storeOp: "store" }
          ],
          depthStencilAttachment: {
            texId: 1, format: "depth32float", width: 1920, height: 1080, sampleCount: 1, depthLoadOp: "clear", depthStoreOp: "store"
          }
        },
        { kind: "render", label: "post-1", draws: 1, colorAttachments: [{ isCanvas: false, loadOp: "clear", storeOp: "store" }], depthStencilAttachment: null },
        { kind: "render", label: "post-2", draws: 1, colorAttachments: [{ isCanvas: false, loadOp: "clear", storeOp: "store" }], depthStencilAttachment: null },
        { kind: "render", label: "post-3", draws: 1, colorAttachments: [{ isCanvas: true, loadOp: "clear", storeOp: "store" }], depthStencilAttachment: null }
      ]
    }
  };

  const audit = analyzeAuditSnapshot(snapshot);
  const codes = new Set(audit.findings.map((f) => f.code));

  assert.ok(codes.has("tbdr-msaa-store-leak"));
  assert.ok(codes.has("tbdr-transient-depth-store-leak"));
  assert.ok(codes.has("pass-fusion-fullscreen-chain"));
  assert.ok(codes.has("texture-missing-mipmaps"));
  assert.ok(codes.has("texture-uncompressed-static"));
  assert.ok(codes.has("render-target-rgba16float-bandwidth"));
  assert.ok(codes.has("sampler-high-anisotropy"));
  assert.ok(codes.has("pipeline-sync-compilation"));
  assert.ok(codes.has("shader-duplicate-modules"));
  assert.ok(codes.has("shader-tbdr-hsr-killer-discard"));
  assert.ok(codes.has("vertex-unpacked-attributes"));
  assert.ok(codes.has("per-frame-bindgroup-churn"));
  assert.ok(codes.has("multiple-queue-submits-per-frame"));

  const digest = formatAuditDigest({ targetUrl: "http://localhost:5173", ...audit });
  assert.match(digest, /WEBGPU DEEP AUDIT:/);
  assert.match(digest, /tbdr-msaa-store-leak/);
});

test("parseXctraceTocXml extracts GPU/Metal tables and ready-to-run XPath expressions", () => {
  const tocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <info>
      <device name="MacBook Pro" model="Mac15,9" os-version="26.3" platform="macOS"/>
      <target><process name="Google Chrome" pid="12345"/></target>
      <summary><start-date>2026-11-15T00:00:00Z</start-date><duration>5.25</duration></summary>
    </info>
    <data>
      <table schema="metal-gpu-interval" target-pid="SINGLE"/>
      <table schema="agx-driver-intervals"/>
      <table schema="os-signpost"/>
    </data>
  </run>
</trace-toc>`;
  const parsed = parseXctraceTocXml(tocXml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.device.model, "Mac15,9");
  assert.equal(parsed.timing.durationSeconds, 5.25);
  assert.equal(parsed.tableCount, 3);
  assert.equal(parsed.gpuTableCount, 2);
  assert.equal(parsed.gpuTables[0].xpath, '/trace-toc/run[@number="1"]/data/table[@schema="metal-gpu-interval"]');
});

test("CLI help covers audit, shader, agx, and xctrace --input", () => {
  for (const cmd of ["audit", "shader", "agx", "xctrace"]) {
    const res = spawnSync(process.execPath, [cli, cmd, "--help"], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`gpu-perf-agent ${cmd}`));
  }
});
