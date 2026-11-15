# Apple Silicon & WebGPU Ultra-Optimization Playbook

Concrete microarchitectural rules, WGSL math patterns, texture/format recipes, and pipeline/TBDR strategies for maximizing WebGPU and Three.js/TSL performance on macOS Apple Silicon (`M1`–`M4`, `MTLGPUFamilyApple7`–`Apple9`).

Always prove any candidate optimization with `gpu-perf-agent ab` on the target metric (`--metric health.autoGpuFrameMs.p50` for GPU changes). Use `gpu-perf-agent shader --base old.wgsl --candidate new.wgsl` first (<100 ms) to verify your WGSL edit actually changed the post-optimization Metal AIR / native `applegpu` ISA rather than getting folded identically by the compiler.

---

## 1. Apple TBDR & M3/M4 (`Apple9`) Microarchitecture

Apple GPUs are **Tile-Based Deferred Renderers (TBDR)** over Unified Memory:

1. **Two Hardware Engines (`agx` `Renderer%` vs `Tiler%`)**:
   - **Tiler (Vertex + Primitive Binning)**: Executes vertex shaders, clips/culls triangles, and writes surviving primitive references into the **Parameter Buffer (PB)** in unified memory (`TiledSceneBytes`).
   - **Renderer (Fragment + Compute)**: Processes 32x32 / 32x16 tiles completely inside fast on-chip **Tile Memory**, performing hardware **Hidden Surface Removal (HSR)** *before* fragment shaders execute.
   - Run `gpu-perf-agent agx --duration-ms 1500` during the workload:
     - **Renderer-dominant (`Renderer% >= 1.5x Tiler%`)**: Bottlenecked by fragment/compute ALU, register occupancy, texture cache misses, or render-target DRAM bandwidth.
     - **Tiler-dominant (`Tiler% >= 1.5x Renderer%`)**: Bottlenecked by vertex count, vertex attribute fetch stride, unculled off-screen draws, or redundant shadow/Z-prepass geometry.
     - **`SplitSceneCount > 0` delta**: Geometry overflowed the Parameter Buffer mid-pass, forcing an expensive partial tile flush + reload to unified DRAM. Fix immediately with frustum/Hi-Z culling, LODs, or fewer triangles per pass.

2. **Hardware Hidden Surface Removal (HSR) vs HSR Killers**:
   - Opaque fragments are depth-tested and occluded pixels are discarded in hardware *before* fragment shader execution, **regardless of draw submission order**!
   - **Opaque Depth Pre-Passes Are Frequently Net-Negative on Apple Silicon**: Unlike desktop IMR GPUs (NVIDIA/AMD), a full-scene opaque Z-prepass doubles vertex + tiler work while HSR already prevented overdraw. If shaders have zero `discard`s, A/B test skipping the opaque depth pre-pass (`gpu-perf-agent audit` flags `tbdr-opaque-depth-prepass`). Keep depth pre-passes only when `ab` proves heavy vertex-position reuse or screen-space effects (GTAO/SSR/Hi-Z) require depth *before* opaque shading.
   - **Never Mix `discard` or `@builtin(frag_depth)` into Opaque Pipelines**:
     - Any pipeline containing `discard;` (even inside an untaken `if (alpha < 0.01)` branch!) or writing `@builtin(frag_depth)` forces the tile hardware out of early-HSR into late-Z / `punch-through` mode, stalling HSR for overlapping tiles.
     - **Fix**: Split materials strictly into (a) pure opaque pipelines (zero `discard` keywords in WGSL) and (b) masked foliage/cutout pipelines.

3. **SIMD32 Execution & Workgroup Sizing (`subgroupSize = 32`)**:
   - Every Apple GPU executes threads in **32-wide SIMD-groups** (`threadExecutionWidth = 32`).
   - **Rule**: Every `@compute @workgroup_size(X, Y, Z)` MUST have `X * Y * Z` as a multiple of `32` (`64`, `128`, `256`). A `@workgroup_size(50)` wastes `14/64 = 22%` of hardware lanes on the second SIMD-group.
   - **2D Image / Texture Compute Passes**: Prefer 2D tiles `@workgroup_size(8, 8, 1)` (`64` threads) or `@workgroup_size(16, 16, 1)` (`256` threads) over `@workgroup_size(64, 1, 1)` so neighboring SIMD lanes sample spatially adjacent 2D texels in the L1 texture cache (Morton/Z-curve swizzle locality).

4. **Register Pressure, Occupancy & Dynamic Caching (`M3`/`M4` `Apple9`)**:
   - Even with `Apple9` Dynamic Caching, high General-Purpose Register (GPR) count per thread caps simultaneous SIMD-groups per core and triggers **stack spills (`alloca` in Metal AIR -> slow DRAM scratch)**.
   - Check `gpu-perf-agent shader --file shader.wgsl`:
     - On Apple GPUs, `maxTotalThreadsPerThreadgroup` starts at `1024`. When `maxThreads` drops below `1024` (e.g. `896`, `768`, `512`), your shader exceeded the full-occupancy register budget!
     - **Top Spill Trigger**: Indexing a local `var arr: array<vec4f, N>;` with a runtime variable `arr[i]` prevents SROA register promotion and emits `alloca` stack traffic. Replace with constant-unrolled loops, `select()` trees (for `N <= 4`), `var<workgroup>` shared LUTs, or a uniform buffer.
     - **Live-Range Shrinkage**: Do not compute 6 UV/normal/TBN vectors *before* a block of `textureSample()` calls and hold them live across the memory latency window; compute cheap ALU derivatives right before use or store medium-precision vectors in `vec3h` / `vec4h`.

5. **Threadgroup (`var<workgroup>`) Memory (`32 KiB` Max)**:
   - Max `32,768 B` per workgroup; bank width is 32 x 32-bit words.
   - Pad shared 2D tiles by `+1` column (`array<f32, 32 * 33>` instead of `32 * 32`) when reading column-wise to eliminate 32-way bank conflicts.
   - Keep total `var<workgroup>` under `8–16 KiB` when `workgroup_size = 256` so at least 2–4 workgroups can stay resident per GPU core concurrently.

---

## 2. Shader & Math Micro-Optimization (WGSL / TSL)

### A. Native `f16` (`enable f16;`) — Highest-ROI ALU & Register Lever
Apple GPUs have native 2x-rate FP16 pipelines and pack two `f16` scalars per 32-bit register slot, cutting register pressure in half and boosting occupancy:
```wgsl
enable f16;

// GOOD: Pure f16 chain with 'h' literals — zero fpext/fptrunc conversions!
fn evalBRDF(n: vec3h, l: vec3h, v: vec3h, rough: f16) -> vec3h {
  let h = normalize(l + v);
  let ndotl = saturate(dot(n, l));
  let ndoth = saturate(dot(n, h));
  let a = rough * rough;
  let denom = fma(ndoth * ndoth, a * a - 1.0h, 1.0h);
  return vec3h(ndotl / max(denom * denom, 1e-3h));
}
```
- **What stays `f32`**: World-space positions, view/projection matrices, `frag_depth` / linear depth reconstruction, accumulated time (`uTime`), and UV coordinates on textures `>= 1024px` (since `f16` has 10 mantissa bits = `1/1024` step precision).
- **What moves to `f16` (`vec2h`/`vec3h`/`vec4h`)**: Unit normals/tangents, albedo/HDR color (`<= 65504`), roughness/metallic/AO, BRDF intermediates, tonemapping, post-FX kernels, and `var<workgroup>` scratch arrays.
- **Critical Pitfall (`excessive-f16-f32-conversions`)**: Mixing `1.0` (`f32`) inside an `f16` expression or calling `f32` helpers forces `fpext` -> `f32` ALU -> `fptrunc` instructions, making the shader *slower* than pure `f32`! Check `conv=0` in `gpu-perf-agent shader`.

### B. Algebraic & Hardware Intrinsic Replacements
| Slow / Naive Pattern | Fast Apple GPU / WGSL Pattern | Why |
| --- | --- | --- |
| `pow(x, 2.0)` / `pow(x, 3.0)` / `pow(x, 4.0)` | `let x2 = x * x;` / `x2 * x` / `x2 * x2` | `pow(x, y)` lowers to `exp2(y * log2(x))` (2 multi-cycle transcendentals). |
| `pow(x, 0.5)` / `pow(x, -0.5)` | `sqrt(x)` / `inverseSqrt(x)` | Hardware single-instruction `rsqrt` on Apple USC. |
| `1.0 / sqrt(x)` | `inverseSqrt(x)` | Eliminates a full reciprocal after `sqrt`. |
| `x / length(x)` | `normalize(x)` | Maps directly to `x * rsqrt(dot(x, x))`. |
| `a * b + c` (critical inner loop) | `fma(a, b, c)` | Explicit single-cycle fused multiply-add without rounding split. |
| `clamp(x, 0.0, 1.0)` | `saturate(x)` | **Zero-cycle** output modifier bit encoded directly on the Apple ALU instruction! |
| `pow(rgb, vec3f(2.2))` on texture sample | Use `rgba8unorm-srgb` / `astc-4x4-unorm-srgb` | Hardware texture unit performs exact sRGB-to-linear decode **for free** during sample! |
| Per-pixel matrix \* constant vector | Precompute on CPU into uniform buffer | Never recompute camera/light uniform expressions per fragment/thread. |
| Polynomial `acos` / `atan2` in inner loop | Degree-3 minimax rational polynomial in `f16` | Replaces ~12-op transcendental expansion with 3 `fma` ops (`< 1e-3` max error). |
| Packed 8-bit quantized weights/normals | `dot4I8Packed(a, b)` / `dot4U8Packed(a, b)` | Hardware 4-wide int8 dot product in a single instruction (`packed_4x8_integer_dot_product`). |

### C. Subgroup Operations (`enable subgroups;`) — 32x Faster Reductions
Chrome on Apple Silicon exposes `subgroups` (`subgroupMinSize = 32`, `subgroupMaxSize = 32`). Instead of allocating `var<workgroup> scratch: array<f32, 256>;` and stalling on 8 `workgroupBarrier()` steps:
```wgsl
enable subgroups;

var<workgroup> sgSums: array<f32, 8>; // max 256 / 32 = 8 subgroups

@compute @workgroup_size(256)
fn reduce256(
  @builtin(local_invocation_index) lid: u32,
  @builtin(subgroup_invocation_id) sgLane: u32,
  @builtin(subgroup_id) sgId: u32
) {
  let val: f32 = loadInput(lid);
  // 1. Register-only 32-lane reduction (ZERO shared memory, ZERO barriers!)
  let waveSum = subgroupAdd(val);
  if (sgLane == 0u) {
    sgSums[sgId] = waveSum;
  }
  workgroupBarrier();
  // 2. First subgroup reduces the 8 partial sums
  if (sgId == 0u) {
    let partial = select(0.0, sgSums[sgLane], sgLane < 8u);
    let total = subgroupAdd(partial);
    if (sgLane == 0u) { writeResult(total); }
  }
}
```
Also use `subgroupBroadcastFirst(idx)` for scalarizing uniform buffer lookups across a SIMD-group, and `subgroupQuadSwapX` / `subgroupQuadSwapY` for custom derivatives in compute shaders!

### D. Control Flow & Divergence
- **Uniform Branches (`if (uniformFlags.enableFog != 0u)`)**: Cheap when all 32 lanes in a SIMD-group take the same path — **better still**, convert static feature toggles to WGSL `override ENABLE_FOG: bool = false;` so dead code and unused bindings are stripped at pipeline creation time!
- **Divergent Branches (`if (noise > 0.5)`)**: When both branches are pure ALU (`<= 4–6` instructions, no texture/memory fetches), replace `if/else` with branchless `select(falseVal, trueVal, cond)` to avoid predicate mask overhead. Keep `if` when skipping an expensive raymarch loop or multiple texture fetches that most 32-lane tiles skip coherently.

### E. Compact Data Packing
- **Octahedral Normal Encoding (`vec3f` -> `u32` via `pack2x16snorm`)**: Cuts G-buffer / storage / vertex normal footprint from `12–16 B` down to `4 B` with `< 0.05°` angular error:
  ```wgsl
  fn octEncode(n: vec3f) -> vec2f {
    let p = n.xy * (1.0 / (abs(n.x) + abs(n.y) + abs(n.z)));
    return select((1.0 - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), p, n.z >= 0.0);
  }
  fn octDecode(e: vec2f) -> vec3f {
    var v = vec3f(e.xy, 1.0 - abs(e.x) - abs(e.y));
    let t = max(-v.z, 0.0);
    v.x += select(t, -t, v.x >= 0.0);
    v.y += select(t, -t, v.y >= 0.0);
    return normalize(v);
  }
  ```
- Use WGSL built-ins `pack2x16float`, `unpack2x16float`, `pack4x8unorm`, `pack4x8snorm` to pack particle/instance structs to tight 16-byte `vec4u` cache lines (`1` `devLoad` instead of `4`).

---

## 3. Texture, Format & Bandwidth Optimization

Apple Silicon has native hardware decoders for **ASTC**, **BC1–BC7**, and **ETC2/EAC** simultaneously in Chrome WebGPU!

### A. Static Asset Compression (`ktx` CLI on macOS)
Never ship `>= 512x512` `rgba8unorm` static textures (`4 B/px` = `16 MiB` at 2K + mips `21.3 MiB`). Compress to `1 B/px` (`4x` less VRAM and `4x` more texels per L1 cache line):
```bash
# Universal KTX2 (UASTC + Zstd, runtime-transcodes cleanly to ASTC-4x4 or BC7 on any GPU):
ktx create --format R8G8B8A8_SRGB --encode uastc --uastc-quality 2 --zstd 18 --generate-mipmap albedo.png albedo.ktx2

# Direct Apple-native ASTC 4x4 (1.0 B/px) or 6x6 (0.44 B/px, 9x compression!):
ktx create --format ASTC_4x4_SRGB_BLOCK --encode astc --astc-quality medium --generate-mipmap albedo.png albedo-astc4x4.ktx2
ktx create --format ASTC_6x6_SRGB_BLOCK --encode astc --astc-quality medium --generate-mipmap roughness-ao.png orm-astc6x6.ktx2
```
- **Normal Maps**: Use 2-channel `bc5-rg-unorm` (`1 B/px`) or UASTC normal mode, reconstructing `z = sqrt(saturate(1.0 - dot(xy, xy)))` in the shader.
- **HDR Environment Maps**: Use `bc6h-rgb-ufloat` (`1 B/px` vs `8 B/px` `rgba16float` — **8x** bandwidth reduction!).

### B. Render Target Format Selection (Bandwidth Multipliers)
| Current Format | Bytes/px | Drop-in Faster Format | Bytes/px | Bandwidth Saved | Notes |
| --- | --- | --- | --- | --- | --- |
| `rgba16float` (HDR no alpha) | `8 B` | `rg11b10ufloat` | `4 B` | **50%** | Enable `"rg11b10ufloat-renderable"` on `requestDevice`! Ideal for HDR scene color, bloom, SSR, volumetric lighting. |
| `rgba16float` (LDR UI/color) | `8 B` | `bgra8unorm` / `rgba8unorm-srgb` | `4 B` | **50%** | Doubles Tile Memory capacity per pixel. |
| `rgba8unorm` (single scalar AO/mask) | `4 B` | `r8unorm` | `1 B` | **75%** | Ideal for SSAO/GTAO, shadow mask, roughness history. |
| `depth32float-stencil8` (no stencil) | `5–8 B` | `depth32float` or `depth24plus` | `4 B` | **20–50%** | Use reverse-Z (`depthCompare: 'greater'`, near=`1.0`, far=`0.0`) with `depth32float`. |

### C. Mipmaps, Samplers & Bilinear Tap Trick
1. **Always Provide Mipmaps on Sampled 2D Textures**: Sampling a 2K/4K `mipLevelCount: 1` texture on distant geometry causes adjacent pixels in a 2x2 quad to hit completely different DRAM pages, collapsing L1 texture cache hit rate from >95% to <20%.
2. **Anisotropy Cap**: Set `maxAnisotropy: 4` by default (use `8` only on primary ground/road materials; `16` is rarely distinguishable from `8` at 2x Retina DPI).
3. **Bilinear Gaussian Blur Tap Reduction (nearly 2x fewer samples)**: Sample *between* texel centers using linear hardware filtering (`offset = (w1 * o1 + w2 * o2) / (w1 + w2)`). A 9-tap separable Gaussian blur drops to **5 bilinear texture fetches** per pass; a 5-tap blur drops to **3 fetches** with mathematically identical output!
4. **Compute Shader Sampling**: In `@compute`, `textureSample()` is unavailable (no implicit quad derivatives). Always call `textureSampleLevel(tex, samp, uv, 0.0)` explicitly, or `textureLoad(tex, coord, 0)` when no filtering is needed!

---

## 4. TBDR Render Passes, Pipelines, Bind Groups & Geometry

### A. Zero-DRAM TBDR `loadOp` / `storeOp` Discipline
On Apple Silicon, Tile Memory only flushes to or loads from unified DRAM when WebGPU's `loadOp` / `storeOp` forces it to!
```js
// OPTIMAL Apple TBDR 4x MSAA + Depth Render Pass (ZERO MSAA & ZERO Depth DRAM traffic!):
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: msaaColorView,          // 4x MSAA transient texture
    resolveTarget: canvasView,    // 1x resolve target
    loadOp: "clear",              // Initializes inside Tile Memory (0 DRAM read!)
    storeOp: "discard",           // CRITICAL: discards 4x MSAA samples after tile resolve (0 DRAM write!)
    clearValue: { r: 0, g: 0, b: 0, a: 1 }
  }],
  depthStencilAttachment: {
    view: depthView,              // Never sampled in post-processing
    depthLoadOp: "clear",         // Cleared in Tile Memory (0 DRAM read!)
    depthStoreOp: "discard",      // CRITICAL: stays 100% on-chip (0 DRAM write!)
    depthClearValue: 0.0          // Reverse-Z clear
  }
});
```
- Leaving `storeOp: "store"` on a 4K (`3456x2234`) 4x MSAA `rgba16float` buffer + `depth32float` flushes **278 MiB per frame** = **33.4 GB/s** at 120 Hz of pure wasted bandwidth!
- **Pass Fusion**: Every `end()` + `beginRenderPass()` boundary flushes `storeOp: "store"` attachments to DRAM. Merge consecutive full-screen post passes (bloom composite + exposure + ACES tonemap + color grading + vignette + dither) into **one** fused pass!
- **Half-Resolution Heavy Effects**: Run volumetric fog, SSAO/GTAO, SSR raymarching, bloom, and DoF at `0.5x` width x `0.5x` height (`25%` pixel count = **4x** faster) with depth-aware bilateral upsampling during composite.

### B. Pipelines, `override` Constants & Bind Group Architecture
1. **Async Pipeline Compilation**: Never compile dozens of pipelines serially via `createRenderPipeline()`. Launch them in parallel at init with `await Promise.all(descs.map(d => device.createRenderPipelineAsync(d)))` to avoid frame-0 / mid-game hitches.
2. **WGSL `override` Specialization over Runtime Branches or String Concatenation**:
   - Compile **one** `GPUShaderModule` and specialize `constants: { USE_CLEARCOAT: 0, SHADOW_CASCADES: 3 }` per `createRenderPipelineAsync`. Dawn lowers `override`s to Metal `[[function_constant(n)]]`, letting Apple's compiler dead-code-eliminate unused branches and registers completely!
3. **Bind Group Hierarchy by Update Frequency**:
   - `@group(0)`: Frame globals (camera viewProj, lights, shadow/env textures, frame samplers) — bound **once per pass**.
   - `@group(1)`: Material textures & material params — bound **once per material bucket** (sort draws by `pipelineId` -> `materialBindGroupId`).
   - `@group(2)`: Per-object / per-batch data — use a **single storage buffer indexed by `@builtin(instance_index)`** (zero per-draw bind group changes!) OR one dynamic-offset uniform buffer (`hasDynamicOffset: true`, 256-byte stride).
   - **Never call `device.createBindGroup()` inside `requestAnimationFrame`** (`per-frame-bindgroup-churn`).
4. **Batch Submissions**: Encode all shadow, compute, opaque, transparent, and post passes onto 1 command encoder (or submit `[cmdA, cmdB]` in **one** `queue.submit(...)` per frame) and coalesce small uniform updates into a single `queue.writeBuffer` upload!

### C. Vertex Packing, Instancing & GPU-Driven Culling
1. **16-bit Vertex Attribute Packing (2x Less Vertex & Tiler Bandwidth)**:
   - Replace `48 B` (`float32x3` pos + `float32x3` normal + `float32x4` tangent + `float32x2` uv) with **`20–24 B`**:
     - Position: `float32x3` (`12 B`) or mesh-local AABB normalized `snorm16x4` (`8 B`)
     - Normal + Tangent: `snorm16x4` (`8 B`) or octahedral `snorm16x2` (`4 B`)
     - UV0: `float16x2` or `unorm16x2` (`4 B`)
     - Color: `unorm8x4` (`4 B`)
2. **GPU-Driven Culling + `drawIndexedIndirect` + `GPURenderBundle`**:
   - If CPU frame time or `draws/f` is high (`> 500–1000` individual `drawIndexed` calls):
     - Static scenes: Record draws once into a `GPURenderBundle` (`device.createRenderBundleEncoder`) and replay with a single `pass.executeBundles([bundle])` (`cpu-bound` JS submission overhead drops by 5x–10x!).
     - Dynamic / large scenes: Pack object transforms + bounding spheres into a `storage` buffer, run a `@compute @workgroup_size(64)` frustum + Hi-Z occlusion culling pass using `atomicAdd` to compact visible instances, and issue `drawIndexedIndirect`!
