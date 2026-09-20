---
name: gpu-perf-agent
description: >-
  Profiles WebGPU and WebGL2 pages on demand using auto-instrumentation and
  browser trace analysis to diagnose performance bottlenecks, VRAM consumption,
  frame stutter, and JS heap churn. Use when asked to profile, benchmark, or
  find regressions in a WebGPU/WebGL2/three.js page, or to compare GPU
  performance between two builds.
---

# WebGPU & WebGL2 Performance Profiling

## Overview
Profile any WebGPU or WebGL2 web application to capture declared VRAM footprints (textures/buffers), frame metrics (average FPS, frame-time p95/variance), and CPU memory behavior (JS heap growth rate). The tool prints automated performance recommendations and supports comparative regression checks between a base and a candidate run.

## Setup
The CLI ships in the `gpu-perf-agent` npm package (binary has the same name).

```bash
# One-off (no install):
npx gpu-perf-agent doctor

# Or install into the project:
npm install -D gpu-perf-agent
npx gpu-perf-agent doctor
```

The fast runner uses an installed Chrome/Chromium directly. If none is found, install one via `npx playwright install chromium` or point at a binary with `--executable-path` / `CHROME_PATH`.

All commands below assume `gpu-perf-agent` is on the path (via `npx gpu-perf-agent ...`). When working inside a checkout of the tool itself, `node src/cli.js ...` is equivalent.

## Agent Fast Path & MCP Server

### 1. `agent` (Recommended for Coding Agents)
Runs an ultra-fast profiling pass with agent-optimized defaults: 3 samples, 500ms duration, `--adaptive` early-stopping, and `--auto-instrument`. Outputs an ultra-dense Markdown digest in **< 250 tokens** directly to stdout, including actionable copy-pasteable `codeHint` and `agentPrompt` tasks:

```bash
# Profile a local file or live URL:
npx gpu-perf-agent agent --file examples/webgpu-clear.html --out reports/base.json
npx gpu-perf-agent agent --url http://localhost:5173 --out reports/base.json

# Fast comparison (< 50 tokens delta):
npx gpu-perf-agent agent --base reports/base.json --candidate reports/candidate.json
```

### 2. `mcp` (Model Context Protocol Server)
Zero-dependency stdio JSON-RPC server for integration with Claude Desktop, Cursor, Antigravity, and AI agent frameworks:
```bash
npx gpu-perf-agent mcp
```
Provides tools:
- `profile_webgpu`: Profiles URL or file, returns markdown digest and report object.
- `compare_webgpu_reports`: Compares baseline and candidate reports for regressions.

## General Commands

### 1. `doctor`
Checks that the local system and headless Chrome support WebGPU/WebGL2. Always run this first.
```bash
npx gpu-perf-agent doctor
```

### 2. `run`
Profiles a local file or live URL with custom parameters.
*   `--url <url>`: target URL, or `--file <path>`: local HTML file (served over localhost automatically).
*   `--auto-instrument`: injects tracking code that hooks buffer/texture allocations. Without it, tracked VRAM reads `0.00 MiB`.
*   `--adaptive`: stop sampling early when FPS variance converges (CV < 1.5%).
*   `--cdp <port|url>`: attach to an already running Chrome (e.g. `--cdp 9222`) for zero browser startup latency.
*   `--agent`: output the concise LLM markdown digest to stdout instead of terminal tables.
*   `--samples <n>` (default `5`) and `--duration-ms <ms>` (default `1000`): sampling shape.
*   `--trace`: include a Chrome trace summary (GPU, frame, memory-infra events). Add `--raw-trace` to keep the raw trace file.
*   `--out <file>`: destination for the JSON report.
*   `--chromium-arg=<arg>`: extra Chromium flags, repeatable (e.g. `--chromium-arg=--ignore-certificate-errors`).
*   `--html`: generate a self-contained, zero-dependency interactive HTML report alongside the JSON.
*   `--html-out <path>`: custom output destination for the HTML report.
*   `--json`: print a machine-readable `{ out, verdict, summary, diagnostics }` object to stdout.
*   `--screenshot`: capture a screenshot for visual validation.

```bash
npx gpu-perf-agent run --url http://localhost:8080 --auto-instrument --samples 3 --out reports/run-1.json --agent
```

### 3. `compare`
Compares a base and candidate report; exits `1` when a metric regresses beyond the threshold (percent, default `5`).
```bash
npx gpu-perf-agent compare --base reports/base.json --candidate reports/candidate.json --threshold 5 --agent
```

### 4. `serve`
For repeated agent loops, launch Chrome once and POST jobs to a local server:
```bash
npx gpu-perf-agent serve --port 9099
# then: POST http://127.0.0.1:9099/run with {"url": "...", "samples": 5, "durationMs": 1000}
```

### 5. `xctrace` (macOS only)
Records an Xcode Instruments trace (e.g. `Metal System Trace`) for native GPU analysis:
```bash
npx gpu-perf-agent xctrace --url http://localhost:8080 --template "Metal System Trace" --time-limit 15s --out reports/metal.trace
```

## Reading the Report
Every report JSON (file, `--json` stdout, and `serve` responses) has a top-level `summary` and `diagnostics` — read this first, before any nested data:

| Field | Meaning |
| --- | --- |
| `summary.verdict` | `excellent` \| `good` \| `needs-work` \| `poor` — overall health in one word. |
| `summary.fps` | Mean frames per second. |
| `summary.cadence` | Detected refresh rate (`{ hz, intervalMs, hitRate }`) e.g. 60Hz or 120Hz and % of frames hitting interval. |
| `summary.frameTimeMsMean` / `frameTimeMsP95` / `frameTimeMsMax` | Frame time distribution; a large p95−mean gap means stutter. |
| `summary.gpuFrameMsMean` | Mean GPU time per frame in ms (when GPU timing hooks are active). >13 ms means GPU-bound. |
| `summary.pipelines` | `{ syncCount, asyncCount, shaderModules }` — synchronous pipeline compiles cause main-thread jank. |
| `summary.bindGroups` | `{ createdCount, layoutCount }` — high creation counts indicate missing bind group pooling. |
| `summary.warmup` | `{ durationMs, lagSpikeMs, settled }` — warmup duration and initial load lag spike. |
| `summary.jsHeapGrowthMBPerSec` | JS heap growth rate. >5 MB/s = allocations in the render loop. |
| `summary.trackedVram` | `{ totalMiB, textureMiB, bufferMiB, textureCount, bufferCount, leakedResources }` from `--auto-instrument`. |
| `summary.slowFrameCount` | Frames exceeding `--slow-frame-threshold` (default 20 ms). |
| `summary.warnings` | Actionable bottleneck descriptions with recommendations — treat each as an optimization task. |
| `summary.recommendations` | Structured array of `{ id, category, severity, title, action, evidence, value, threshold, unit }`. |

Deeper data when needed: `inPage.samples[*]` (per-sample measurements and per-frame WebGPU op counts for slow frames), `trace.summary` (Chrome GPU/frame/memory-infra events), `cdp.before/after` (browser-level heap metrics).

## Optimization Loop (recommended agent workflow)

1. **Health check** — `npx gpu-perf-agent doctor --quick`. If WebGPU is unsupported, report the environment limitation.
2. **Target verification** — confirm the target server is responsive before profiling.
3. **Baseline** — profile the unmodified code with the agent fast-path:
   ```bash
   npx gpu-perf-agent agent --url <url> --out reports/base.json
   ```
4. **Diagnose** — read the Markdown digest on stdout. It lists the verdict and top actionable recommendations with exact copy-pasteable `Code Hint` snippets and `Agent Task` instructions.
5. **Optimize** — apply ONE targeted change to the codebase addressing the highest-severity recommendation.
6. **Candidate** — re-profile with identical flags to `reports/candidate.json`:
   ```bash
   npx gpu-perf-agent agent --url <url> --out reports/candidate.json
   ```
7. **Verify & Diff** —
   ```bash
   npx gpu-perf-agent agent --base reports/base.json --candidate reports/candidate.json
   ```
   Exit code `1` flags any metric regression. The delta lists all `Resolved Bottlenecks` with checkmarks and any remaining or new bottlenecks. Repeat from step 5 until verdict is `GOOD` or `EXCELLENT`.
8. **Many iterations or zero startup delay?** — connect to an already running Chrome via `--cdp <port>` or use `npx gpu-perf-agent serve --port 9099`.

## Common Mistakes
*   **Forgetting `--auto-instrument`** — tracked VRAM will read `0.00 MiB` because allocations are not hooked.
*   **Self-signed HTTPS** — local HTTPS dev servers need `--chromium-arg=--ignore-certificate-errors` or the page will not render.
*   **Mismatched compare runs** — base and candidate must use the same `--samples`, `--duration-ms`, and viewport, or the comparison is meaningless.
*   **Parsing human output** — use `--json` on `run` and `compare` instead of scraping the console tables.
*   **Stale servers** — confirm the target port is the server you think it is.

## Limitations
The web platform does not expose exact VRAM residency. For deep memory analysis combine all three layers: declared allocation tracking (`--auto-instrument`), Chrome trace memory-infra summaries (`--trace`), and native Instruments captures on macOS (`xctrace`).
