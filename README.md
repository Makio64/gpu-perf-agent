# WebGPU Optimizer Report

Node-callable reporting for WebGPU/WebGL2 optimization work. The stack is designed for agents and CI jobs that need repeatable performance/memory artifacts while tuning browser GPU workloads.

The default runner is a fast direct Chrome DevTools Protocol harness. It launches Chrome/Chromium itself and talks CDP over WebSocket, avoiding Playwright's context and driver layers. A Playwright runner remains exported as `runPlaywrightReport()` for compatibility.

## What It Captures

- Fast direct-CDP benchmark samples through Chrome/Chromium.
- Optional Playwright runner for compatibility.
- Optional GPU timestamp helpers for precise WebGPU/WebGL2 command timing.
- WebGPU/WebGL2 capability metadata.
- JS heap and browser CDP metrics.
- Optional Chrome trace summaries for GPU, frame, and memory-infra events.
- Optional declared GPU allocation tracking for buffers/textures created by your app.
- Optional macOS `xctrace` capture using Xcode Instruments templates such as `Metal System Trace`.

Important limitation: the web platform does not expose exact VRAM residency for WebGPU/WebGL2. For deep memory analysis, use all three layers together: declared allocation tracking in the app, Chrome trace memory-infra summaries, and native Instruments captures on macOS.

## Install

From npm:

```bash
npm install -D webgpu-optimizer-report
npx webgpu-report doctor
```

Or run one-off without installing:

```bash
npx -p webgpu-optimizer-report webgpu-report doctor
```

From a checkout of this repository:

```bash
npm install
npm run doctor
```

The fast runner prefers an installed Chrome/Chromium. If it cannot find one, it falls back to Playwright's bundled Chromium path when available. Playwright itself is an optional peer dependency — only needed for the compatibility runner or its bundled browser:

```bash
npm install playwright
npx playwright install chromium
```

## CLI

Run a report against a local file:

```bash
node ./src/cli.js run --file examples/webgl2-draw.html --samples 5 --duration-ms 1000 --out reports/webgl2.json
```

`--file` targets are served through a temporary localhost server, so module imports and secure-context APIs behave like a normal local app. Use `--file-root DIR` when the benchmark imports files outside the benchmark directory.

Run a report against an app URL and include a Chrome trace summary:

```bash
node ./src/cli.js run --url http://localhost:5173/bench.html --samples 10 --duration-ms 2000 --trace --out reports/candidate.json
```

Save the raw Chrome trace too:

```bash
node ./src/cli.js run --url http://localhost:5173/bench.html --trace --raw-trace --out reports/candidate.json
```

For agent loops, launch Chrome once and send repeated jobs to the local server:

```bash
node ./src/cli.js serve --port 9099
```

Then call it from any Node tool:

```js
const response = await fetch("http://127.0.0.1:9099/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "http://localhost:5173/bench.html",
    samples: 5,
    durationMs: 1000
  })
});
const report = await response.json();
```

Compare two reports and fail with exit code `1` when a metric regresses beyond the threshold:

```bash
node ./src/cli.js compare --base reports/base.json --candidate reports/candidate.json --threshold 5
```

Both `run` and `compare` accept `--json` for machine-readable stdout — ideal for agents and CI scripts.

Record an Xcode Instruments trace on macOS:

```bash
node ./src/cli.js xctrace --url http://localhost:5173/bench.html --template "Metal System Trace" --time-limit 15s --out reports/metal.trace
```

## Report Structure

Every report (file, `--json` stdout, `serve` responses, and Node API results) contains a top-level agent-friendly digest:

```jsonc
{
  "summary": {
    "verdict": "excellent",          // excellent | good | needs-work | poor
    "fps": 60,
    "frameTimeMsMean": 16.4,
    "frameTimeMsP95": 17.1,
    "gpuFrameMsMean": 4.2,           // when GPU timing hooks are active
    "jsHeapGrowthMBPerSec": 0.02,
    "trackedVram": { "totalMiB": 128.5, "textureMiB": 96.2, "bufferMiB": 32.3, "textureCount": 14, "bufferCount": 42, "leakedResources": 0 },
    "slowFrameCount": 0,
    "warnings": [ /* actionable bottleneck descriptions */ ]
  },
  "diagnostics": { "warnings": [], "highlights": [], "resources": {} },
  "inPage": { /* per-sample measurements, slow-frame op counts */ },
  "trace": { /* Chrome trace summary when --trace */ },
Record an Xcode Instruments trace on macOS:

```bash
node ./src/cli.js xctrace --url http://localhost:5173/bench.html --template "Metal System Trace" --time-limit 15s --out reports/metal.trace
```

## Node API

```js
import { runReport, compareReports } from "webgpu-optimizer-report";

const report = await runReport({
  url: "http://localhost:5173/bench.html",
  samples: 10,
  durationMs: 1000,
  trace: true
});
```

For repeated runs inside one Node process, keep Chrome alive:

```js
import { FastCDPHarness } from "webgpu-optimizer-report";

const harness = await FastCDPHarness.launch({ channel: "chrome" });
try {
  const before = await harness.run({ url: "http://localhost:5173/bench.html" });
  const after = await harness.run({ url: "http://localhost:5173/bench.html" });
} finally {
  await harness.close();
}
```

## Page Hook

For meaningful GPU work, expose a hook in the page. The runner will call it for warmup and sample phases.

```js
globalThis.__gpuReportBench = async ({ phase, sampleIndex, durationMs, api }) => {
  // Run your workload for roughly durationMs.
  return {
    api,
    fps: 60,
    gpuMs: 4.2,
    allocatedBytes: globalThis.__gpuMemoryTracker?.snapshot().totalBytes
  };
};
```

Without the hook, the runner still records capability, memory, and `requestAnimationFrame` timing, but it cannot know which GPU workload you intended to measure.

## Declared GPU Allocation Tracking

Use the browser helper to track resources your app creates. This is not exact VRAM residency; it is a deterministic estimate from API descriptors, which is ideal for regression checks.

```js
import { trackWebGPUDevice } from "webgpu-optimizer-report/browser/allocation-tracker";

const device = await adapter.requestDevice();
globalThis.__gpuMemoryTracker = trackWebGPUDevice(device);
```

For WebGL2:

```js
import { trackWebGL2Context } from "webgpu-optimizer-report/browser/allocation-tracker";

const gl = canvas.getContext("webgl2");
globalThis.__gpuMemoryTracker = trackWebGL2Context(gl);
```

## Precise GPU Timing

For precise GPU command timing, instrument the benchmark page. WebGPU timestamp query results are nanoseconds, but the exact timestamp source is implementation-defined by the browser/GPU stack. The runner records these as custom metrics, so `compare` can gate on them.

```js
import { requestTimedWebGPUDevice } from "webgpu-optimizer-report/browser/timing";

const adapter = await navigator.gpu.requestAdapter();
const { device, timer } = await requestTimedWebGPUDevice(adapter);

const gpuTimeNs = await timer.measure((encoder, gpuTimer) => {
  const pass = gpuTimer.beginComputePass(encoder);
  pass.dispatchWorkgroups(128);
  pass.end();
});
```

For WebGL2, use `EXT_disjoint_timer_query_webgl2` when available:

```js
import { createWebGL2Timer } from "webgpu-optimizer-report/browser/timing";

const timer = createWebGL2Timer(gl);
const gpuTimeNs = timer ? await timer.measure(() => draw()) : null;
```

## Suggested Stack

1. Use the allocation tracker in benchmarks to catch declared buffer/texture growth.
2. Use `webgpu-report run --trace` for repeatable browser traces and CDP metrics.
3. Use `webgpu-report compare` in CI or agent loops to catch regressions.
4. Use `webgpu-report xctrace` when Chrome-level signals are not enough and you need Metal/GPU-driver level evidence on macOS.

## Reusable Agent Skill (Claude / Gemini / Codex / Copilot)

This package ships a pre-packaged agent skill definition in [skill/SKILL.md](skill/SKILL.md) (included in the npm tarball under `node_modules/webgpu-optimizer-report/skill/SKILL.md`). It teaches AI coding assistants to discover, load, and run this performance profiler on demand.

### How to install the skill:

#### 1. Claude Code / agents supporting the skills convention
Copy the skill folder into your skills directory:
```bash
mkdir -p ~/.agents/skills/webgpu-performance-profiling
cp node_modules/webgpu-optimizer-report/skill/SKILL.md ~/.agents/skills/webgpu-performance-profiling/SKILL.md
```
For project-scoped skills, use `.claude/skills/` (Claude Code) or `.github/skills/` (GitHub Copilot) instead.

#### 2. Gemini / Antigravity
```bash
mkdir -p ~/.gemini/config/plugins/science/skills/webgpu_performance_profiling
cp node_modules/webgpu-optimizer-report/skill/SKILL.md ~/.gemini/config/plugins/science/skills/webgpu_performance_profiling/SKILL.md
```

#### 3. Cline / Roo Code / Cursor
Copy the contents of `skill/SKILL.md` into your custom rules or instruction files (e.g., `.clinerules`, `.cursorrules`, or system instructions).

#### 4. General sharing
Anyone who installs `webgpu-optimizer-report` from npm gets the skill alongside the CLI, so their AI coding assistant can immediately run zero-setup, on-demand automated performance testing.

## License

MIT
