---
name: webgpu-performance-profiling
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
The CLI ships in the `webgpu-optimizer-report` npm package as the `webgpu-report` binary.

```bash
# One-off (no install):
npx -p webgpu-optimizer-report webgpu-report doctor

# Or install into the project:
npm install -D webgpu-optimizer-report
npx webgpu-report doctor
```

The fast runner uses an installed Chrome/Chromium directly. If none is found, install one via `npx playwright install chromium` or point at a binary with `--executable-path` / `CHROME_PATH`.

All commands below assume `webgpu-report` is on the path (via `npx webgpu-report ...`). When working inside a checkout of the tool itself, `node src/cli.js ...` is equivalent.

## Commands

### 1. `doctor`
Checks that the local system and headless Chrome support WebGPU/WebGL2. Always run this first.
```bash
npx webgpu-report doctor
```

### 2. `run`
Profiles a local file or live URL.
*   `--url <url>`: target URL, or `--file <path>`: local HTML file (served over localhost automatically).
*   `--auto-instrument`: injects tracking code that hooks buffer/texture allocations. Without it, tracked VRAM reads `0.00 MiB`.
*   `--samples <n>` (default `5`) and `--duration-ms <ms>` (default `1000`): sampling shape.
*   `--trace`: include a Chrome trace summary (GPU, frame, memory-infra events). Add `--raw-trace` to keep the raw trace file.
*   `--out <file>`: destination for the JSON report.
*   `--chromium-arg=<arg>`: extra Chromium flags, repeatable (e.g. `--chromium-arg=--ignore-certificate-errors`).
*   `--json`: print a machine-readable `{ out, verdict, summary, diagnostics }` object to stdout — prefer this when running as an agent.
*   `--screenshot`: capture a screenshot for visual validation.

```bash
npx webgpu-report run --url http://localhost:8080 --auto-instrument --samples 3 --out reports/run-1.json --json
```

### 3. `compare`
Compares a base and candidate report; exits `1` when a metric regresses beyond the threshold (percent, default `5`).
```bash
npx webgpu-report compare --base reports/base.json --candidate reports/candidate.json --threshold 5 --json
```
With `--json`, the output includes `diagnostics.resolvedWarnings` / `diagnostics.remainingWarnings` and both verdicts, so you can verify an optimization actually removed the bottleneck.

### 4. `serve`
For repeated agent loops, launch Chrome once and POST jobs to a local server:
```bash
npx webgpu-report serve --port 9099
# then: POST http://127.0.0.1:9099/run with {"url": "...", "samples": 5, "durationMs": 1000}
```

### 5. `xctrace` (macOS only)
Records an Xcode Instruments trace (e.g. `Metal System Trace`) for native GPU analysis:
```bash
npx webgpu-report xctrace --url http://localhost:8080 --template "Metal System Trace" --time-limit 15s --out reports/metal.trace
```

## Reading the Report
Every report JSON (file, `--json` stdout, and `serve` responses) has a top-level `summary` — read this first, before any nested data:

| Field | Meaning |
| --- | --- |
| `summary.verdict` | `excellent` \| `good` \| `needs-work` \| `poor` — overall health in one word. |
| `summary.fps` | Mean frames per second. Note: high-refresh displays may report 120. |
| `summary.frameTimeMsMean` / `frameTimeMsP95` / `frameTimeMsMax` | Frame time distribution; a large p95−mean gap means stutter. |
| `summary.gpuFrameMsMean` | Mean GPU time per frame in ms (when GPU timing hooks are active). >13 ms means GPU-bound. |
| `summary.jsHeapGrowthMBPerSec` | JS heap growth rate. >5 MB/s = allocations in the render loop. |
| `summary.trackedVram` | `{ totalMiB, textureMiB, bufferMiB, textureCount, bufferCount, leakedResources }` from `--auto-instrument`. |
| `summary.slowFrameCount` | Frames exceeding `--slow-frame-threshold` (default 20 ms). |
| `summary.warnings` | Actionable bottleneck descriptions with recommendations — treat each as an optimization task. |

Deeper data when needed: `inPage.samples[*]` (per-sample measurements and per-frame WebGPU op counts for slow frames), `trace.summary` (Chrome GPU/frame/memory-infra events), `cdp.before/after` (browser-level heap metrics).

## Optimization Loop (recommended agent workflow)

1. **Health check** — `npx webgpu-report doctor` (use `--quick` to skip the browser probe on repeat runs). If WebGPU is unsupported or the browser fails to initialize, stop and report the environment limitation.
2. **Target verification** — confirm the target server is responsive before profiling. If it is down, fail loudly with the network error.
3. **Baseline** — profile the unmodified code:
   ```bash
   npx webgpu-report run --url <url> --auto-instrument --out reports/base.json --json
   ```
4. **Diagnose** — read `summary.verdict` and `summary.warnings` from stdout. Each warning names the bottleneck (VRAM, heap churn, stutter, GPU-bound, draw-call count) and the standard fix.
5. **Optimize** — apply ONE targeted change to the app code addressing the highest-impact warning.
6. **Candidate** — re-profile with identical flags to `reports/candidate.json`.
7. **Verify** —
   ```bash
   npx webgpu-report compare --base reports/base.json --candidate reports/candidate.json --json
   ```
   Exit code `1` means a metric regressed. Check `diagnostics.resolvedWarnings` to confirm the bottleneck is gone. Repeat from step 5 until the verdict is `good` or `excellent`.
8. **Many iterations?** — start `npx webgpu-report serve --port 9099` once and POST `/run` jobs instead of relaunching Chrome each time; it is much faster per iteration and returns the same report JSON.

## Common Mistakes
*   **Forgetting `--auto-instrument`** — tracked VRAM will read `0.00 MiB` because allocations are not hooked.
*   **Self-signed HTTPS** — local HTTPS dev servers need `--chromium-arg=--ignore-certificate-errors` or the page will not render.
*   **Mismatched compare runs** — base and candidate must use the same `--samples`, `--duration-ms`, and viewport, or the comparison is meaningless.
*   **Parsing human output** — use `--json` on `run` and `compare` instead of scraping the console tables.
*   **Stale servers** — confirm the target port is the server you think it is.

## Limitations
The web platform does not expose exact VRAM residency. For deep memory analysis combine all three layers: declared allocation tracking (`--auto-instrument`), Chrome trace memory-infra summaries (`--trace`), and native Instruments captures on macOS (`xctrace`).
