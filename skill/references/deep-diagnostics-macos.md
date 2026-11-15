# Deep Diagnostics & Offline Shader Tooling on macOS

Use these deep diagnostic commands alongside the standard `gpu-perf-agent agent` -> `ab` workflow whenever a workload is `gpu-bound`, `submission-bound`, memory-heavy, or shader-limited on macOS.

---

## 1. Decision Matrix: Which Tool Answers Which Question?

| Question | Command | Runtime | Requires `sudo`? |
| --- | --- | --- | --- |
| Which pass & frame metric is the bottleneck? | `npx gpu-perf-agent agent --url <URL> --out reports/base.json` | ~4 s | No |
| Are MSAA/depth `storeOp`s leaking bandwidth, textures unmipped/uncompressed, or bind groups churning? | `npx gpu-perf-agent audit --url <URL>` | ~2 s | No |
| Is Apple GPU limited by **Renderer** (fragment/compute) or **Tiler** (vertex/geometry), or overflowing `SplitSceneCount`? | `npx gpu-perf-agent agx --duration-ms 2000` | 2 s | No |
| Did my WGSL/MSL edit reduce post-optimization Metal AIR ops, `f32->f16` conversions, stack spills, or `applegpu` ISA bytes / occupancy ceiling? | `npx gpu-perf-agent shader --base old.wgsl --candidate new.wgsl` | **~80–150 ms** | No |
| What exact WGSL & Dawn-generated MSL is a live Three.js/TSL or WebGPU app compiling? | `npx gpu-perf-agent shader --url <URL> --dump-dir reports/shaders` | ~3 s | No |
| Did the end-to-end change genuinely speed up the GPU in Chrome? | `npx gpu-perf-agent ab --base-url <A> --candidate-url <B> --metric health.autoGpuFrameMs.p50` | ~15–30 s | No |
| What are the sub-millisecond hardware command buffer & GPU interval timelines in Metal? | `npx gpu-perf-agent xctrace --url <URL> --time-limit 8s --out reports/capture.trace` | ~10 s | No |

---

## 2. Structural & TBDR Bandwidth Audit (`audit`)

Run `audit` once right after your baseline capture on any WebGPU page to catch bandwidth & API hazards that frame timers alone cannot explain:

```bash
npx gpu-perf-agent audit --url http://localhost:5173 --out reports/audit.json
# Local HTML:
npx gpu-perf-agent audit --file index.html --file-root . --viewport 1728x1117 --device-scale-factor 2
```

What `audit` inspects automatically:
- **TBDR Pass Attachment Leaks**: Flags multisampled attachments with `resolveTarget` + `storeOp: "store"` (`tbdr-msaa-store-leak`), transient depth attachments cleared & never sampled yet stored (`tbdr-transient-depth-store-leak`), non-sampled opaque depth pre-passes (`tbdr-opaque-depth-prepass`), and chains of single-draw full-screen passes (`pass-fusion-fullscreen-chain`).
- **Texture & Target Bandwidth**: Computes exact mip/array/MSAA byte footprints; flags `>= 512x512` sampled textures missing mipmaps (`texture-missing-mipmaps`), uncompressed `rgba8unorm` static textures (`texture-uncompressed-static`), `rgba16float` render targets replaceable by `rg11b10ufloat` (`render-target-rgba16float-bandwidth`), and `maxAnisotropy > 4`.
- **Pipeline, Vertex & Frame Churn**: Flags synchronous `createRenderPipeline` stalls, duplicate identical WGSL modules, unpacked `float32x3/4` secondary vertex attributes, per-frame `createBindGroup` / `createTexture` / `createBuffer` churn, and excessive `queue.submit()` calls per frame.

---

## 3. Inner-Loop Shader Compiler Verification (`shader`)

Browser A/B runs take 15–30 s. When iterating on WGSL math, `f16` conversions, loop unrolling, or register pressure, verify your shader edits in **~100 ms** against Apple's real Metal compiler (`naga` -> `xcrun metal -O2` AIR disassembly + `MTLDevice` / `MTLBinaryArchive` native `applegpu` machine code):

### Workflow A: Extract Live Shaders from Three.js / TSL / Bundled WebGPU Apps
Three.js `WebGPURenderer` (TSL / `NodeMaterial`) generates WGSL dynamically at runtime. Dump both the exact WGSL and Chrome Dawn's generated Metal Shading Language (`.metal`) directly to disk:

```bash
npx gpu-perf-agent shader --url http://localhost:5173 --dump-dir reports/shaders --limit 8
# Filter to a specific shader label or uniform/function name:
npx gpu-perf-agent shader --url http://localhost:5173 --filter "pbr" --dump-dir reports/shaders
```

### Workflow B: 100 ms Offline Compiler A/B Loop
Copy an extracted `.wgsl` or `.metal` file to `cand.wgsl`, edit the math/types, and diff the compiled output before touching the full app:

```bash
npx gpu-perf-agent shader --base reports/shaders/02-shader-2.wgsl --candidate reports/shaders/cand.wgsl
```

Key compiler signals reported by `shader`:
- **`isa=<N>B` (`nativeCodeBytes`)**: Exact byte size of compiled `applegpu` machine instructions (`__TEXT,__text` inside `MTLBinaryArchive`). Smaller ISA reduces instruction cache misses and confirms dead-code / algebraic elimination actually happened.
- **`maxThreads=<N>` (`maxTotalThreadsPerThreadgroup`)**: Hardware compute occupancy ceiling (`1024` = full register headroom; `< 1024` = GPR register pressure is throttling concurrent SIMD-groups!).
- **`f32` vs `f16` vs `conv` (`fpConversions`)**: Confirms `enable f16;` produced pure `f16` ops (`conv=0`) instead of `fpext`/`fptrunc` conversion ping-pong.
- **`fma`, `transc`, `tex`, `devLoad`, `devStore`, `tg`, `br`, `select`, `alloca`**:
  - `alloca > 0` means private arrays failed register promotion and are spilling to stack memory!
  - If `Changed compiler metrics: identical post-optimization output`, `-O2` already folded your rewrite — skip the 30 s browser `ab` test and try a more impactful change!

---

## 4. Non-Sudo Apple AGX Hardware Telemetry (`agx`)

Sample live macOS `IOAccelerator` counters while the target page is running in headful or headless Chrome:

```bash
npx gpu-perf-agent agx --duration-ms 2000 --interval-ms 200
```

- **`Renderer p50 %` vs `Tiler p50 %`**: Immediately separates fragment/compute bottlenecks (`renderer-dominant`) from vertex/culling/binning bottlenecks (`tiler-dominant`).
- **`Unified GPU Memory (in-use MiB)`**: True OS kernel-tracked wired GPU memory residency (unlike WebGPU API allocation estimates, this reflects actual driver allocations, IOSurfaces, and memory leaks across scene reloads).
- **`Split scenes Δ`**: Must stay `0`. Any positive delta during steady-state rendering proves TBDR Parameter Buffer overflow.

---

## 5. Headless Metal System Trace Inspection (`xctrace`)

When you need hardware timeline intervals from Xcode Instruments without opening a GUI:

```bash
# 1. Record an 8s Metal System Trace and auto-generate reports/mst.trace.summary.json:
npx gpu-perf-agent xctrace --url http://localhost:5173 --time-limit 8s --out reports/mst.trace

# 2. Inspect available GPU/Metal schemas and XPath queries in an existing .trace:
npx gpu-perf-agent xctrace --input reports/mst.trace

# 3. Export rows from a specific Metal table:
npx gpu-perf-agent xctrace --input reports/mst.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="metal-gpu-interval"]' --max-bytes 32768
```

> Note: Launching Chrome via `xctrace --url` works without `sudo`. Attaching CPU/Instruments profilers to an already-running PID requires `DevToolsSecurity -status` to be enabled (`sudo DevToolsSecurity -enable`, one-time user action).

---

## 6. Direct CLI Binaries Available on macOS PATH

For custom one-off offline asset or shader pipelines, these CLI tools are installed and ready in non-interactive shells:
- **`naga`** (`~/.cargo/bin/naga`): Validate `.wgsl` (`naga shader.wgsl`) or cross-compile `.wgsl` -> `.metal` / `.spv` / `.glsl` (`naga in.wgsl out.metal`).
- **`xcrun metal` & `xcrun metal-objdump`**: Compile `.metal` (`xcrun metal -O2 -Rpass-missed='.*' shader.metal -o out.metallib`) and inspect LLVM AIR (`xcrun metal-objdump --disassemble out.metallib`). Always quote `'.*'` in `zsh`!
- **`ktx` & `toktx`** (`/usr/local/bin/ktx`): Create, inspect (`ktx info file.ktx2`), mipmap (`--generate-mipmap`), and ASTC/UASTC+Zstd compress KTX2 textures.
- **`glslangValidator`, `spirv-opt`, `spirv-cross`** (`/opt/homebrew/bin/`): Validate WebGL2/GLSL shaders, run `spirv-opt -O`, and cross-compile SPIR-V to MSL/GLSL.
