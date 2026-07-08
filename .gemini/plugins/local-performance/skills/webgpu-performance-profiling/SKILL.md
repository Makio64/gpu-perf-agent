---
name: webgpu-performance-profiling
description: >-
  Profiles WebGPU and WebGL2 pages on demand using auto-instrumentation and browser trace analysis to diagnose performance bottlenecks, VRAM consumption, and JS heap churn.
---

# WebGPU & WebGL2 Performance Profiling

## Overview
This skill allows agents to profile any WebGPU or WebGL2 web application on demand to capture deep VRAM footprints (textures/buffers), frame rate metrics (average FPS, frame-time variance/stutter), and CPU memory leaks (JS heap growth rate). It provides automated performance recommendations and allows comparative regression checks.

## Dependencies
*   **`chrome-devtools`**: Useful if additional manual DevTools tracing or protocol debugging is needed.
*   **CLI Tool Location**: The runner relies on the local tool located in the repository root.

## Quick Start
To profile a page and generate a diagnostic report:
```bash
node src/cli.js run --url https://localhost:3000/demo/particles-nebula --auto-instrument --chromium-arg=--ignore-certificate-errors --samples 1 --duration-ms 2000 --out reports/nebula.json
```

## Utility Commands
The CLI tool supports three key subcommands:

### 1. `doctor`
Checks if the local system and headless Chrome support WebGPU. Always run this first to ensure the profiling environment is healthy.
```bash
node src/cli.js doctor
```

### 2. `run`
Profiles a local file or live URL.
*   `--url <url>`: Target URL.
*   `--file <path>`: Target local HTML file.
*   `--auto-instrument`: Automatically injects tracking code to hook buffer, texture, and timestamp allocations.
*   `--duration-ms <ms>`: Length of the profile capture (default: `1000`).
*   `--samples <n>`: Number of profiling samples to run (default: `3`).
*   `--out <file>`: Destination path for the JSON report.
*   `--chromium-arg=<arg>`: Extra arguments passed directly to Chromium (e.g. `--chromium-arg=--ignore-certificate-errors`).

```bash
node src/cli.js run --url http://localhost:8080 --auto-instrument --samples 3 --out reports/run-1.json
```

### 3. `compare`
Compares two profiling runs (base and candidate) to look for performance improvements or regressions.
```bash
node src/cli.js compare reports/base.json reports/candidate.json
```

## Workflow

### Step 1: Environment Health Check
Before running any profiling, execute:
```bash
node src/cli.js doctor
```
If it indicates that WebGPU is not supported or that the browser fails to initialize:
*   Fails loudly and explains environment limitations (e.g., driver support, virtualized environment constraints, or missing Chrome configuration).

### Step 2: Target Verification
Ensure the target web page is up and running. If it's a local development site (e.g., port `3000`), confirm the server is responsive. If it is down, fail loudly with a descriptive network error.

### Step 3: Profile the Page
Execute the `run` command with the `--auto-instrument` flag to gather high-fidelity GPU allocations.
```bash
node src/cli.js run --url <url> --auto-instrument --out <out-path>
```

### Step 4: Interpret Diagnostics
The tool outputs a summary of performance highlights and bottlenecks directly to the console. Look for:
*   **VRAM Consumption**: Memory usage above 500 MiB or high individual texture usage.
*   **JS Heap Churn**: growth rate above 5 MB/s (often indicating object creation in the render loop).
*   **Frame Stutter**: High variance between mean frame time and p95 frame time.

### Step 5: Regression Check (Optional)
If assessing an optimization pull request, run a baseline report on the `main` branch, run a candidate report on your feature branch, and use the `compare` command to verify regressions:
```bash
node src/cli.js compare base.json candidate.json
```

## Common Mistakes
*   **Forgetting `--auto-instrument`**: Running without this flag will result in `0.00 MiB` tracked VRAM memory because allocations won't be hooked.
*   **Chrome Certificate Failures**: Local HTTPS servers often use self-signed certificates. You must pass `--chromium-arg=--ignore-certificate-errors` or Chrome will fail to render the page.
*   **Stale Servers**: Ensure you target the correct running local server port.
