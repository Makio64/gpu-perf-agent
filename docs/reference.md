# GPU Performance Agent — reference

[← Quick start](../README.md) · [Presets](#standardized-presets) · [Comparisons](#baseline-and-candidate-reports) · [Node API](#node-api) · [GPU timing](#precise-gpu-timestamps)

Agent-oriented WebGPU and WebGL profiling for local projects. It produces stable JSON diagnostics for frame pacing, declared GPU memory, JS heap churn, draw/dispatch pressure, browser traces, and before/after regressions.

The default runner talks directly to Chrome DevTools Protocol and can keep one browser alive across repeated jobs. It has **zero required npm dependencies**. Playwright remains available as an opt-in compatibility fallback.

Requires Node.js 22+ (the direct CDP transport uses the built-in WebSocket) and an installed Chrome/Chromium. The default runner uses only Node.js built-ins; a checkout can run directly without `npm install`. Browsers in standard installation locations are detected automatically. For a custom location, pass `--executable-path /path/to/chrome` or set `CHROME_PATH` / `CHROMIUM_PATH`.

### Optional Playwright runner

Playwright is an optional peer dependency, so a normal install does not download Playwright, its transitive packages, or any browser. Only install it if you need the compatibility runner. Run this in the profiler checkout, or in the project where you installed `gpu-perf-agent`:

```bash
npm install --save-dev playwright
npx gpu-perf-agent run --runner playwright --channel chrome --url http://127.0.0.1:5173
```

From this checkout, use `node src/cli.js` in place of `npx gpu-perf-agent`. To use Playwright's managed Chromium instead of an installed Chrome, run `npx playwright install chromium` and omit `--channel chrome`. The Node API's `runPlaywrightReport()` uses the same optional installation. The default runner can also discover Playwright's managed Chromium when Playwright is installed.

## Agent fast path

```bash
# Short digest on stdout; full evidence saved to JSON.
node src/cli.js agent --url http://127.0.0.1:5173 --out reports/base.json
# After an edit, use the same measurement settings.
node src/cli.js agent --url http://127.0.0.1:5173 --out reports/candidate.json
node src/cli.js agent --base reports/base.json --candidate reports/candidate.json
```

`agent` enables auto-instrumentation and the `quick` preset (6 × 250 ms, 2 warmups). Explicit sampling flags override these defaults. Its digest includes frame/GPU timing, memory, signal counts, and up to three actionable warnings. Missing measurements are shown as `n/a`. Use `--json` instead for structured output, or `run --agent` / `compare --agent` for the same concise format with your own defaults. Sampling stays fixed by default for reproducible comparisons. Opt into `--adaptive` to stop after at least three samples when FPS CV is below 1.5%; this checks FPS stability only, not GPU timing convergence.

For repeated edits, keep Chrome running and connect the CLI to it:

```bash
node src/cli.js serve --port 9099 --auto-instrument
# In another terminal:
node src/cli.js agent --server http://127.0.0.1:9099 \
  --url http://127.0.0.1:5173 --out reports/candidate.json
```

The CLI saves the full returned report locally and prints the same digest. `--file`, screenshot and trace paths must be accessible on the server machine; this workflow is intended for a local service. Configure browser launch settings on `serve`, since they cannot change between jobs.

## HTML, browser attachment, and MCP

```bash
npx gpu-perf-agent run --url http://127.0.0.1:5173 --auto-instrument --html --out reports/run.json
npx gpu-perf-agent run --cdp 9222 --url http://127.0.0.1:5173 --out reports/attached.json
npx gpu-perf-agent mcp
```

`--html-out path.html` chooses the HTML destination; `--json` includes its path without mixing human output into stdout. `--cdp` accepts a debugging port, HTTP endpoint, or browser WebSocket URL. It creates owned profiling contexts and leaves the attached browser running. Browser launch flags cannot be changed on an attached instance.

Use `--wait-condition 'window.ready === true'` for custom readiness, with `--wait-condition-timeout` in milliseconds. `--minimal-trace` captures GPU categories only. `--visual-validation` saves a screenshot like `--screenshot`; it does not automatically compare images.

The zero-dependency stdio MCP server exposes `profile_webgpu` and `compare_webgpu_reports`. MCP retains three 500 ms samples and adaptive mode by default; explicit arguments override these. The Node API also exports `generateHtmlReport`, `generateAgentDigest`, `generateAgentCompareDigest`, and `runMcpServer`. Detailed digest helpers are available through `gpu-perf-agent/agent`; unlike the bounded CLI digest, their size depends on the recommendations.

See [CHANGELOG.md](../CHANGELOG.md) for version 2 migration details and [skill/SKILL.md](../skill/SKILL.md) for the bundled agent workflow.

## Fastest cross-project workflow

From a sibling project such as `../makio3d` or `../Threejs-tile`, start its normal development server, then run the profiler directly from this checkout:

```bash
cd ../makio3d
pnpm dev --host 127.0.0.1

# In another shell, still from ../makio3d:
node ../WebGPUOptimizerReport/src/cli.js doctor --json
node ../WebGPUOptimizerReport/src/cli.js run \
  --url http://127.0.0.1:5173 \
  --preset quick \
  --auto-instrument \
  --screenshot \
  --out reports/gpu-quick.json \
  --json
```

Use `--api webgpu`, `--api webgl2`, or `--api webgl` on `run`/`agent`/`ab` to probe only that API. The default `auto` probes WebGPU and WebGL2. Unrequested APIs have `available: null, skipped: true`, distinct from unsupported APIs. WebGPU capability output includes the adapter's exposed info and limits, including inherited WebIDL attributes; some identifying fields can be empty under the [WebGPU specification's privacy rules](https://www.w3.org/TR/webgpu/#gpuadapterinfo). Temporary WebGL probe contexts are released before measurement using [`WEBGL_lose_context`](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/).

No project integration is required. `--auto-instrument` runs before application scripts and intercepts WebGPU/WebGL resource creation and rendering operations.

To install the local checkout into another project instead:

```bash
npm install -D ../WebGPUOptimizerReport
npx gpu-perf-agent doctor
npx gpu-perf-agent run --url http://127.0.0.1:5173 --preset quick --auto-instrument --json
```

For a built static project, use `--file` and make the project directory the module root:

```bash
node ../WebGPUOptimizerReport/src/cli.js run \
  --file ./dist/index.html \
  --file-root ./dist \
  --preset quick \
  --auto-instrument \
  --json
```

Use the real dev server when source HTML contains bare package imports that require Vite or another bundler.

## What agents receive

`run --json` prints a small machine-readable envelope and writes the complete report to `out`:

```json
{
  "ok": true,
  "out": "/project/reports/gpu-quick.json",
  "verdict": "excellent",
  "summary": {
    "fps": 120.1,
    "frameTimeMsP95": 8.7,
    "gpuFrameMsMean": 4.1,
    "jsHeapGrowthMBPerSec": 0.2,
    "drawCallsPerFrame": 240,
    "slowFrameCount": 0,
    "trackedVram": {
      "totalMiB": 96,
      "textureMiB": 88,
      "bufferMiB": 8,
      "textureCount": 42,
      "bufferCount": 19,
      "leakedResources": 0
    },
    "warnings": []
  },
  "diagnostics": {
    "validity": { "valid": true, "issues": [] },
    "signal": {
      "sampleCount": 6,
      "observedFrameCount": 180,
      "gpuTimingSamples": 6,
      "hookFound": true
    },
    "instrumentation": {
      "enabled": true,
      "errors": []
    }
  }
}
```

Verdicts are `excellent`, `good`, `needs-work`, or `poor`. Warnings contain stable codes, severity, the measured value and threshold, and a concrete recommendation. Current warnings cover runtime errors, insufficient signal, low FPS, stutter, frame jitter, GPU-bound work, heap churn, declared VRAM pressure, live resource growth, and draw-call pressure.

`diagnostics.validity` describes whether the measurements can be trusted, separately from the performance verdict. Failed hooks, uncaught runtime errors, incomplete sampling, missing numeric evidence, and failures of explicitly requested API/instrumentation/trace capture invalidate a run. `run` still saves its full evidence, prints `ok: false` with `--json` (or `INVALID` in the agent digest), and exits `2`. Network request failures remain warnings because optional telemetry can fail without invalidating the workload.

The full report also contains per-sample data, operation counters, API capabilities, browser metadata, console/runtime errors, CDP memory metrics, and optional trace summaries.

## Standardized presets

Presets keep measurements comparable between agents:

| Preset | Warmups | Samples | Sample duration | Intended use |
| --- | ---: | ---: | ---: | --- |
| `quick` | 2 | 6 | 250 ms | Every-edit feedback |
| `confirm` | 4 | 15 | 500 ms | Confirm an apparent improvement |
| `profile` | 2 | 8 | 750 ms | GC plus raw Chrome trace |
| default | 1 | 5 | 1000 ms | General profiling |

Explicit `--samples`, `--duration-ms`, and `--warmup` values override a preset.

Frame observation uses a wall-clock window of `durationMs`, even when animation callbacks stop in a hidden page. With fewer than two callbacks, FPS and frame-time statistics are unavailable (`null`), while successful hook timings remain usable. `observedFrames.observationWindowMs` records the actual observation duration; `durationMs` within that object is the span between observed frame timestamps. Hooks may take longer than the observation window, and a blocked page still depends on the overall capture timeout. Frame settling also has a bounded wait. `options.frameObservation: "wall-clock"` records this sampling method for compatibility checks with older reports. Reports flag insufficient frame signal instead of inventing a zero FPS measurement.

## Persistent agent loop

Launching Chrome is normally the slowest part. Keep it alive when an agent will test many edits:

```bash
node ../WebGPUOptimizerReport/src/cli.js serve --port 9099 --auto-instrument
```

Each job returns the same complete report schema:

```js
const report = await fetch("http://127.0.0.1:9099/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "http://127.0.0.1:5173",
    samples: 6,
    durationMs: 250,
    warmup: 2
  })
}).then((response) => response.json());
```

Jobs are serialized in the harness itself, including concurrent Node API callers, so agents cannot overlap browser traces or corrupt one another’s measurements. Each job defaults to a fresh isolated browser context, keeping cookies, local storage, HTTP/Cache Storage caches, and service workers from previous jobs out of the capture. Chrome itself stays running. Context disposal closes the job's pages and popups, including after failed navigation. Hardware state and browser-process GPU caches are not reset by context isolation.

Use `--context shared` (Node/HTTP: `contextMode: "shared"`) when retaining storage, caches, or service workers between jobs is intentional. Use a stable `--url` origin for state reuse; temporary `--file` servers have per-job ports. Shared mode uses a dedicated context for the lifetime of that harness; job pages and popups still close between captures. Context mode is recorded and checked during comparison. The Playwright compatibility runner supports isolated mode only. Isolation adds context setup/teardown work; shared mode opts into reuse when its stateful behavior suits the benchmark.

`GET /health` includes pending, completed, and failed job counts; `POST /close` drains accepted jobs and stops the service. The queue admits at most eight jobs by default (`serve --max-queue N`); a full queue returns HTTP 429 with `Retry-After: 1`. If context cleanup fails, the harness rejects queued work and the HTTP service returns 503 with `CAPTURE_CLEANUP_FAILED`; restart the service before collecting further measurements.

The API accepts the same presets and validation as the runners. Invalid options return HTTP 400 before browser work; request bodies are limited to 64 KiB. Use `POST /run?format=compact` for a summary response without per-sample data. Full responses remain the default. A completed capture with invalid workload evidence returns HTTP 200 with `diagnostics.validity.valid: false` (and `ok: false` in compact mode), preserving its measurements for inspection. The health counter `failed` includes invalid captures; `completed` counts returned reports. HTTP errors use `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

`run --json` avoids repeating warnings in both summary and diagnostics. Full error details stay in the saved report. Reports from the fast runner also include `timings.navigationMs`, `samplingMs`, and `totalMs` (excluding browser launch and cleanup).

## Interleaved A/B measurements

For two simultaneously available builds or URL-controlled variants, `ab` uses one Chrome process and ABBA ordering to reduce thermal and background-load drift:

```bash
npx gpu-perf-agent ab \
  --base-url http://127.0.0.1:4173/?renderer=base \
  --candidate-url http://127.0.0.1:5173/?renderer=candidate \
  --rounds 4 \
  --duration-ms 250 \
  --auto-instrument \
  --threshold 5 \
  --out reports/ab.json \
  --json
```

The output includes run order and duration, aggregate metrics, paired Student-t confidence intervals between matched rounds, regressions, improvements, and `inconclusive` changes. Failed rounds and metrics missing in any round invalidate the comparison, even if other rounds succeeded. Treat an inconclusive result as a request for more rounds rather than an improvement.

## Baseline and candidate reports

Separate reports can also be compared:

```bash
npx gpu-perf-agent compare \
  --base reports/base.json \
  --candidate reports/candidate.json \
  --threshold 5 \
  --json
```

The compare output includes:

- metric deltas, sample counts, confidence intervals, and the evidence method;
- introduced, remaining, and resolved warning codes;
- both health verdicts;
- configuration compatibility checks.

Independent report captures use [Welch unequal-variance intervals](https://www.itl.nist.gov/div898/handbook/eda/section3/eda353.htm). `--paired` (Node API: `{ paired: true }`) is available for genuinely matched observations; A/B runs select it automatically. Incomplete pairs invalidate an explicitly paired comparison. The implementation uses conservative Student-t table values, including rounding fractional Welch degrees of freedom down.

With at least three observations on each side (or three pairs), a mean change beyond the threshold must also have its entire 95% interval beyond that threshold to count as a confirmed regression or improvement. Otherwise it is `inconclusive`. Rows without enough observations, and raw maxima/percentiles, have `evidence: "threshold-only"`. A/B uses one metric value per round and can therefore estimate uncertainty for the mean of repeated per-round maxima or percentiles. Intervals assume independent observations or pairs; consecutive frames can be correlated. Use repeated rounds to confirm important changes.

Exit code `1` means a regression or breached absolute budget (or a command error). Exit code `2` means invalid measurement evidence, lost candidate metrics, missing budget metrics, or differing profiling options such as viewport, tracing, readiness, and warmup. Empty reports always fail. `--allow-mismatch` permits deliberate option differences but cannot override invalid evidence. Inconclusive changes do not fail the default gate; automation should inspect `summary.inconclusive` when uncertainty requires more measurements. A passing comparison is not proof of equivalence.

Use `--budget budget.json` to enforce required metrics and absolute bounds:

```json
{
  "defaultMaxRegressionPercent": 5,
  "metrics": {
    "frame.fps.mean": { "direction": "higher", "min": 50 },
    "health.gpuFrameMs.mean": { "max": 8 }
  }
}
```

Budget values must be finite numbers; unknown fields, invalid directions, negative percentages, and inverted bounds fail before browser work in A/B mode. Every named metric must be present in the candidate. Absolute-only rules can evaluate a new metric without a baseline value; relative rules require both. Missing metrics are listed explicitly with `status: "missing"`, rather than silently skipped. Absolute limits apply directly to the observed metric, regardless of its confidence interval.

## Auto-instrumentation

`--auto-instrument` tracks declared live GPU allocations and operation counts without changing the target project.

WebGPU coverage includes buffers, textures, command encoders, render/compute passes, draws, dispatches, queue submits, uploads, copies, shader modules, and pipelines. WebGL coverage includes buffers, 2D/3D textures, renderbuffers, draw calls, instanced draws, uploads, and resource deletion.

Texture estimates account for mip levels, array layers, 3D mip depth, multisampling, common sized formats, BC/ETC/EAC compression blocks, and ASTC block dimensions. These are deterministic declared-storage estimates, not exact physical residency.

The manual `createTracker`, `trackWebGPUDevice`, and `trackWebGL2Context` helpers also maintain incremental totals. Summary snapshots scale with resource kinds, rather than the number of live objects. Resource details are capped at 1,000 entries by default (`resourceLimit` changes the cap); `truncatedResources` reports omitted entries. Use `snapshot({ includeHistory: false, includeResources: false })` for inexpensive repeated sampling. Returned details are copies, and reattaching an object updates its existing entry instead of counting it twice. Both manual and automatic tracking account for partial buffer upload ranges.

## Optional benchmark hook

Auto-instrumentation can profile any continuously rendering page. For reproducible workloads, expose a hook:

```js
globalThis.__gpuReportBench = async ({ phase, sampleIndex, durationMs, api }) => {
  // Exercise one deterministic scene/workload for approximately durationMs.
  return {
    api,
    fps: 60,
    gpuMs: 4.2,
    scene: "100k-instanced-cubes"
  };
};
```

For apps that create their benchmark hook after asynchronous initialization, add `--wait-for-hook` (`waitForHook: true` in the API). It waits for the named hook after navigation, bounded by `--timeout`, before detecting capabilities and warming up. This also lets you use `--wait-until domcontentloaded` on applications with persistent network requests. Without explicit readiness, a hook registered later may be missed.

The runner observes `requestAnimationFrame` concurrently with the hook, so it retains independent frame-time and slow-frame measurements. Without a hook, it samples the page’s natural animation loop.

## Precise GPU timestamps

Instrument WebGPU passes when the browser exposes `timestamp-query`:

```js
import { requestTimedWebGPUDevice } from "gpu-perf-agent/browser/timing";

const adapter = await navigator.gpu.requestAdapter();
const { device, timer } = await requestTimedWebGPUDevice(adapter);
const batch = timer?.createBatch({ capacity: 64, label: "main-frame" });

const encoder = device.createCommandEncoder();
const shadow = batch.beginRenderPass(encoder, shadowPassDescriptor, "shadow");
// draw shadow pass
shadow.end();
const main = batch.beginRenderPass(encoder, mainPassDescriptor, "main");
// draw main pass
main.end();
batch.resolve(encoder);
device.queue.submit([encoder.finish()]);

const timings = await batch.read();
// [{ label: "shadow", durationNs, durationMs }, ...]
```

Batching resolves and maps once for many passes. The single-pass `timer.measure()` helper also maps only its result buffer: it no longer waits for unrelated queued work. Buffer mapping provides the required result synchronization under the [WebGPU specification](https://gpuweb.github.io/gpuweb/#dom-gpubuffer-mapasync).

Each batch follows `idle → recording → resolved → reading → idle`. Submit its encoder before calling `read()`, await that read before reusing the batch, and use separate batches for overlapping frames. The helper rejects overlapping reads, foreign timestamp query sets, and invalid capacities (1–2048 timed passes). `reset()` discards unsubmitted recording work; `destroy()` releases all query/buffer resources and rejects a pending read. Destroy the simple timer and any batches you created when profiling ends. Mapped result bytes are consumed directly without an extra buffer copy.

```js
const batch = timer.createBatch({ capacity: 64, timeoutMs: 5000 });
try {
  // Record passes, resolve, submit, and await batch.read() for each frame.
} finally {
  batch.destroy();
  timer.destroy();
}
```

`createWebGL2Timer(gl, { timeoutMs: 10000, pollIntervalMs: 4, maxPending: 64 })` returns a timer when `EXT_disjoint_timer_query_webgl2` is available. Call `await timer.measure(() => { /* synchronous draw commands */ })` for nanoseconds. It uses bounded polling that also works without `requestAnimationFrame`, rejects asynchronous draw callbacks, and cleans up queries on draw failures, timeouts, destruction and context loss. Disjoint events invalidate every outstanding sample, following the [Khronos extension specification](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/). `timer.destroy()` cancels pending queries; `timer.pendingCount` reports queue pressure.

## Chrome traces and screenshots

```bash
npx gpu-perf-agent run --url http://127.0.0.1:5173 --trace --screenshot --json
npx gpu-perf-agent run --url http://127.0.0.1:5173 --raw-trace --json
```

Detailed `performance.measureUserAgentSpecificMemory()` calls are opt-in via `--deep-memory` (`deepMemory: true` in the API) because they can trigger expensive asynchronous GC. Cheap heap counters and declared GPU allocations are still collected by default. Allocation totals are maintained incrementally; detailed allocation history appears once in `inPage.instrumentation.after.resources.history`, rather than being duplicated in every sample. `autoInstrumentOptions.historyLimit` controls retention (default 500, zero disables it).

Chrome trace summaries classify GPU, frame, memory-infra, scheduler, V8, and rendering events. Trace completion has a timeout, trace streams are closed on errors, and reads are capped at 128 MiB. Reduce sample duration or trace categories if a trace exceeds that limit. Screenshots provide a cheap guard against “optimizations” that stop rendering or materially change the scene.

## Native Instruments on macOS

```bash
npx gpu-perf-agent xctrace \
  --url http://127.0.0.1:5173 \
  --template "Metal System Trace" \
  --time-limit 15s \
  --out reports/metal.trace
```

Use Instruments for CPU/GPU overlap, driver stalls, and deeper Metal evidence. Xcode Simulator improves iOS Safari/WebKit compatibility coverage, but it uses the Mac’s hardware and must not be treated as iPhone performance truth. Confirm device frame time, thermals, power, and memory pressure on physical hardware.

## Node API

```js
import { FastCDPHarness, compareReports, runReport } from "gpu-perf-agent";

const report = await runReport({
  url: "http://127.0.0.1:5173",
  autoInstrument: true,
  samples: 6,
  durationMs: 250,
  warmup: 2
});

const harness = await FastCDPHarness.launch({ channel: "chrome" });
try {
  const before = await harness.run({ url: "http://127.0.0.1:5173/?variant=base" });
  const after = await harness.run({ url: "http://127.0.0.1:5173/?variant=candidate" });
  console.log(compareReports(before, after));
} finally {
  await harness.close();
}
```

## Verification

```bash
npm test                 # unit and CLI contract tests; no browser required
npm run test:browser     # real Chrome, localhost static server, screenshot, sibling fixture
npm run doctor
npm pack --dry-run --json
npm run benchmark       # CPU overhead: snapshots, encoder wrappers and CLI startup
# Optional before/after checkout comparison:
node scripts/benchmark.mjs --baseline /path/to/original/checkout
```

Browser tests also exercise stalled navigation, timed-out hooks, trace recovery, concurrent jobs, listener cleanup, HTTP queue limits, compact responses, failed-workload CLI exits, invalid A/B rounds, isolated/shared cookies and caches, popup cleanup, inherited GPU capabilities, and missing animation callbacks. Run GPU measurements serially to avoid contention.

The browser integration fixture lives at `fixtures/sibling-project` and models the way an unrelated WebGL project is served and profiled.

## Limitations

- Browser APIs do not expose exact VRAM residency. Combine declared tracking, Chrome memory-infra traces, and Instruments.
- GPU timestamp sources are implementation-defined. Use them for identical-environment relative comparisons and confirm important results on target hardware.
- FPS is often VSync-limited. Prefer GPU time, frame-time p95/max, slow frames, and memory/operation counts when FPS is pinned at 60 or 120.
- Trace capture and per-pass synchronous readback add overhead. Compare traced runs only with equivalently traced runs and prefer batched timestamps.
