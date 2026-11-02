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
# Short digest on stdout; full evidence saved to reports/base-1.json.
node src/cli.js agent --url http://127.0.0.1:5173 --label base
# After an edit, capture and compare against base in one call (inherits base options):
node src/cli.js agent --url http://127.0.0.1:5173 --base reports/base-1.json --label cand
# Confirm GPU deltas with interleaved ABBA rounds in one browser:
node src/cli.js ab --base-url http://127.0.0.1:4173 --candidate-url http://127.0.0.1:5173
```

`agent` enables auto-instrumentation, per-pass GPU timing, and the `quick` preset (6 × 250 ms, 2 warmups), and automatically reuses a warm background Chrome daemon (`--no-daemon` disables it). Explicit sampling flags override these defaults. Its bounded digest (`<= 160` tokens) includes verdict, bottleneck classification, frame/GPU timing, top GPU passes, CPU hotspots (`cpuProfile`), hitches, trust status, and the next concrete action. Use `--json` for bounded machine-readable output (`<= 1.6 KB`) or `--json-full` for the full report.

Exit codes across all commands:
- `0`: valid capture, or comparison `improved` / `unchanged` / `unverified` / `inconclusive` / `different-work`
- `1`: confirmed `regression` or breached budget
- `2`: invalid capture (`diagnostics.validity.valid === false`) or compatibility `mismatch`
- `3`: CLI usage, navigation, or runner error (writes a failure report with `runError` when a target was given)

`doctor --quick --json` checks the local runtime and native profiler location without launching Chrome or enumerating Instruments templates. `xctrace.templatesProbed: false` means the template list was intentionally not queried. Full `doctor --json` retains browser capability probing and template enumeration.

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

The zero-dependency stdio MCP server exposes `profile_webgpu`, `compare_webgpu_reports`, `ab_compare_webgpu`, `inspect_webgpu_report`, and `doctor_webgpu`. Profiling lazily starts one Chrome process, reuses it across serialized jobs, and retains isolated contexts. Defaults match `agent`: six fixed 250 ms samples and two warmups. `preset`, explicit sampling options, `api`, and readiness arguments customize capture; use `tools/list` for the schema. Closing stdin or stopping the server drains accepted work and closes its browser.

MCP saves full capture evidence under `reports/mcp` and returns a bounded digest with `structuredContent.reportPath`, validity, and artifact paths. Use those report paths for comparison. Invalid captures and execution failures also retain diagnostic JSON. `screenshot: true` saves a PNG; `includeReport: true` opts into the larger legacy inline `report` field. Earlier releases returned full reports by default and used three adaptive 500 ms samples, so clients depending on that behavior should send explicit sampling and output arguments. Artifact paths belong to the service machine.

The Node API also exports `generateHtmlReport`, `generateAgentDigest`, `generateAgentCompareDigest`, and `runMcpServer`. Detailed digest helpers are available through `gpu-perf-agent/agent`; unlike the bounded CLI/MCP digest, their size depends on the recommendations.

MCP comparisons save complete results at `structuredContent.comparisonPath` and return up to five changed rows with confidence intervals and evidence methods, prioritizing regressions. Set `primaryMetric` to include the selected row even when it passes or would otherwise be omitted. This focuses display only; all metrics are still evaluated. A requested absent metric reports `not-measured`. `status: "INCONCLUSIVE"` can accompany `ok: true`; this is a passing regression gate, not a confirmed gain. Invalid evidence sets `isError: true`.

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

The full report also contains per-sample data, operation counters, API capabilities, browser metadata, retained console/runtime errors, CDP memory metrics, and optional trace summaries.

Both runners bound page diagnostics during capture: at most 200 routine console/log
events, plus 50 each for uncaught exceptions, failed requests, console errors/assertions,
and browser log errors. Payloads are bounded too (2,048 characters per string and 8,192
text characters per event). `pageEvents` contains representative retained records;
`pageEventSummary` exposes total, retained, dropped and shortened-event counts, category
counts, retained category counts and limits. Error totals include dropped events, so a
log flood cannot hide an invalid capture. Network failures remain warnings rather than
automatically invalidating measurements. Old reports without counters use retained events.
Thrown runner errors attach this evidence as `captureDiagnostics`; MCP saves it in its
failed-report artifact when navigation or readiness fails.

## Standardized presets

Presets keep measurements comparable between agents:

| Preset | Warmups | Samples | Sample duration | Intended use |
| --- | ---: | ---: | ---: | --- |
| `quick` | 2 | 6 | 250 ms | Every-edit feedback |
| `confirm` | 4 | 15 | 500 ms | Confirm an apparent improvement |
| `profile` | 2 | 8 | 750 ms | GC plus raw Chrome trace |
| default | 1 | 5 | 1000 ms | General profiling |

Explicit `--samples`, `--duration-ms`, and `--warmup` values override a preset.

### Fixed-work hook sampling

For a compute benchmark that already awaits GPU timestamps or completed work, opt into
`--sampling-mode hook` (`samplingMode: "hook"` in Node, HTTP and MCP). The profiler awaits
each hook without running its rAF observer, initial frame settling, or GC frame settling.
It still executes the configured warmups and samples and retains memory/instrumentation
snapshots. This removes idle observation between fixed batches; it does not make the GPU
workload itself faster. Natural rendering and frame pacing use the default `frames` mode.

```bash
npx gpu-perf-agent agent --url http://127.0.0.1:5173 --api webgpu \
  --sampling-mode hook --wait-until domcontentloaded --out reports/compute.json
```

Hook mode requires the named benchmark hook. Readiness defaults to `waitForHook: true`;
API callers can explicitly set false to fail immediately if it is absent at sampling.
`durationMs` is passed to the hook but does not impose a minimum wait; the hook defines
the amount of completed work. FPS-based adaptive stopping is incompatible. Missing
observer FPS and frame percentiles are expected; hook-supplied metrics remain available.
Reports record `options.samplingMode`, `options.frameObservation: "disabled"` and
`inPage.sampling.mode`. Warmup frame settling and absent lag spikes are `null`.

Do not time `queue.submit()` alone: the hook must await actual completion/readback.
Reacquire baseline and candidate in the same mode with identical work and sampling
settings. Comparisons reject different modes and aggregation rejects changed capture
settings within a variant. Removing idle intervals changes scheduling and can affect GPU
clocks/thermals, so timing across modes is not a valid application speedup comparison.
Check installed help for this option when using a published version older than this source.

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

`run --json` avoids repeating warnings in both summary and diagnostics. Bulky guidance, error lists, and nested text are bounded with total/omitted counts and a `truncation` object when applicable. Full details, including code hints, remain in the saved report. Reports from the fast runner also include `timings.navigationMs`, `samplingMs`, and `totalMs` (excluding browser launch and cleanup).

## Selective saved-report inspection

Use `inspect` when the compact capture digest does not expose the evidence you need:

```bash
npx gpu-perf-agent inspect --report reports/base.json --section metrics --metric health.gpuFrameMs.mean
npx gpu-perf-agent inspect --report reports/base.json --section samples --offset 3 --limit 3
npx gpu-perf-agent inspect --report reports/ab.json --run 0 --section errors
npx gpu-perf-agent inspect --report reports/ab.json --section rounds
```

The command emits bounded JSON and never launches Chrome. It accepts captures, saved
comparisons and A/B artifacts. Sections are `overview` (default), `metrics`, `samples`,
`errors`, `environment`, `instrumentation`, `trace`, `gpu` (per-pass GPU breakdown),
`cpu` (CPU-profile hotspots and callers) and `rounds` (A/B artifacts only). `--metric`
selects an exact key from comparison metrics; use it with `--section metrics` or
`--section rounds`. `--offset` and `--limit` page records (default limit 3, maximum 10).
`--run` selects a zero-based A/B run before inspection. Select a run for A/B
sample/error/instrumentation/trace details.

`--section rounds` shows how an A/B result was reached. For the comparison's primary
metric, or the exact key given with `--metric`, `data.table` lists each round's base
value, candidate value, delta (candidate minus base) and ratio (candidate over base),
paired as the paired comparison pairs them, so the per-round values average to the
comparison row's base and candidate (table cells are rounded to 4 decimals;
`data.comparison` keeps that row's exact values and paired CI). `data.signs` counts the rounds where the candidate
was better, worse or tied for the metric's direction (`text`, for example `candidate
faster in 6 of 8 rounds`), and `data.medianDelta` is the median paired delta. Both cover
every round; the table is paged with `--offset` and `--limit` (default limit 10 for
this section). `selection.indices` maps each row to its base and candidate run indices
for `--run`. A capture or saved comparison has no rounds and returns an
`invalid-options` error, as does `--run` or a `prefix*` metric with this section.

Responses identify selected source indices, available totals, validity and omissions.
Comparison selections also retain compatibility status and counts of differing or
unverified fields; a selected metric alone does not establish a compatible comparison.
Missing metrics remain distinct from measured zero. Error totals retain dropped-event
counts from the saved capture. A successful inspection exits 0 even when its captured
measurements are invalid; the returned validity describes that evidence. Files are
still read and parsed in full on the tool host; the output bound reduces transferred
context and never alters the original artifact.

Capture validity is checked with current rules while preserving saved invalidity and
run failures; disagreements with a saved validity flag are disclosed. Exact error totals
stay unknown when counters are incomplete, with retained counts reported separately.
The core selection is capped at 16 KiB; CLI adds the file path and MCP wraps and mirrors
the selection in structured data and text. Check omissions before treating a page as
complete evidence, and extract omitted details from the source when needed.

Node callers can use `inspectReport(report, { section, metric, offset, limit, runIndex })`
and `validateInspectOptions(options)` before file access. MCP exposes the same selection
through `inspect_webgpu_report` with `reportPath`. Its bounded result is in
`structuredContent` and JSON text for clients that only expose text content. Paths belong to the server, so
inspection can retrieve selected evidence from a remote server's saved artifact.

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

GPU health means require one consistent timing scope. Capture metadata at
`diagnostics.signal.gpuTiming` records that scope and unavailable/ambiguous/invalid
reasons; aggregates preserve it at `gpuTiming`. Multiple GPU timing fields in a sample,
scope changes, or negative durations cannot produce an aggregate GPU mean or confidence
interval. Exact custom metrics remain available for deliberately selected pass timings.
Keep one recognized `gpuMs`/`gpuTimeNs` field for the claimed aggregate and label extra
pass details `durationMs`/`durationNs`. Scope mismatch or drift invalidates health
comparisons rather than becoming a threshold-only improvement. Older raw captures are
checked from their sample evidence; scope-less aggregates cannot prove health timing
comparability. Saved comparison inspection displays original calculations, so use a
fresh comparison of the original captures to apply current checks.

For asynchronous scenes, `ab` accepts `--wait-until domcontentloaded`, `--wait-condition 'window.ready === true'`, `--wait-condition-timeout`, `--wait-for-hook`, `--wait-for-hook-timeout`, `--hook`, `--timeout`, and `--device-scale-factor`. Both variants use the same readiness contract before every round. Use `--agent --metric health.gpuFrameMs.mean` instead of `--json` for a bounded digest focused on GPU timing. Full rounds and comparisons remain in `--out`; `--metric` does not exclude other regressions. `ab` accepts `--preset`; explicit `--samples`, `--duration-ms`, and `--warmup` override it.

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

Comparisons also check available browser/version, host, GPU adapter/driver/backend, and meaningful Chromium launch settings. Temporary profiles, debug ports, process IDs, and target URLs are excluded from environment identity. Changed known fields make a comparison incompatible; old/redacted reports expose `compatibility.environment.unverifiedKeys` instead of inventing a match. A/B aggregation retains each round's environment and invalidates detected drift. Capability probes identify the environment, not necessarily the adapter selected by application code. Scene, input and output equivalence still require explicit verification.

With at least three observations on each side (or three pairs), a mean change beyond the threshold must also have its entire 95% interval beyond that threshold to count as a confirmed regression or improvement. Otherwise it is `inconclusive`. Rows without enough observations, and raw maxima/percentiles, have `evidence: "threshold-only"`. GPU/compute/render means use the corresponding repeated hook measurements. The health GPU mean gets an interval only when each capture contains a single consistent GPU timing scope; mixed pass/frame scopes retain threshold-only evidence. A/B uses one metric value per round and can therefore estimate uncertainty for the mean of repeated per-round maxima or percentiles. Intervals assume independent observations or pairs; consecutive frames can be correlated. Use repeated rounds to confirm important changes.

Exit code `1` means a confirmed regression or breached budget; exit code `3` is a CLI or runner error. Exit code `2` means invalid measurement evidence, lost candidate metrics, missing budget metrics, or differing profiling options such as viewport, tracing, readiness, and warmup. Empty reports always fail. `--allow-mismatch` permits deliberate option differences but cannot override invalid evidence. Inconclusive changes do not fail the default gate; automation should inspect `summary.inconclusive` when uncertainty requires more measurements. A passing comparison is not proof of equivalence.

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

Measured auto-instrumentation overhead: on a 100,000 WebGPU `draw` + `setBindGroup` calls/frame encode benchmark, paired median CPU encode overhead is `0.000 ms/frame` (`3.10 ms` instrumented vs `3.20 ms` uninstrumented, well below the `0.3 ms/frame` budget). On a pathological 200,000 WebGL `drawArrays` calls/frame stress test (`draws200k.html`), JS wrapper dispatch lowers frame rate from `52.0 FPS` to `41.4 FPS` (`-20.4%`); whenever WebGL draw calls exceed `20,000/frame` or profiler tool frames exceed `10%` of busy time, the report automatically emits the `instrumentation-overhead` validity warning and advises comparing CPU metrics only against captures with identical options (or `--no-auto-instrument`).

## Optional benchmark hook

Auto-instrumentation can profile any continuously rendering page. For reproducible workloads, expose a hook:

```js
import { requestTimedWebGPUDevice } from "gpu-perf-agent/browser/timing";

const { device, timer } = await requestTimedWebGPUDevice(adapter); // timer is null without timestamp-query

globalThis.__gpuReportBench = async ({ phase, sampleIndex, durationMs, api }) => {
  // Exercise one deterministic, idempotent workload and return measured values only.
  const { gpuTimeNs, gpuTiming } = await timer.measureWarm((encoder, { beginRenderPass }) => {
    const pass = beginRenderPass(encoder, descriptor);
    drawScene(pass);
    pass.end();
  });
  return { api, gpuTimeNs, gpuTiming, scene: "100k-instanced-cubes" };
};
```

For apps that create their benchmark hook after asynchronous initialization, add `--wait-for-hook` (`waitForHook: true` in the API). It waits for the named hook after navigation, bounded by `--wait-for-hook-timeout` (default 15000 ms, at most `--timeout`; `waitForHookTimeoutMs` in the API), before detecting capabilities and warming up. This also lets you use `--wait-until domcontentloaded` on applications with persistent network requests. Without explicit readiness, a hook registered later may be missed.

In default `frames` mode the runner observes `requestAnimationFrame` concurrently with the hook, so it retains independent frame-time and slow-frame measurements. Without a hook, it samples the page’s natural animation loop. Explicit `hook` mode requires the hook and skips that observer.

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
