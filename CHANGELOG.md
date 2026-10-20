# Changelog

## 2.2.0

- **Schema v3 & automatic per-pass GPU timing:** `installAutoInstrumentation` now includes a 32-slot × 64-pass WebGPU timestamp ring timer (`timestampWrites`) and WebGL2 `EXT_disjoint_timer_query_webgl2` per-frame timer by default (`--no-gpu-timing` opts out). Reports include interval-union `summary.gpu.frameMsP50`, `overlapRatio`, `idleGapRatio`, and top passes by exclusive duration with call-site labels (`summary.gpu.passes`).
- **Warm GPU timers:** `createWebGPUTimer` / `createBatchedWebGPUTimer` and `createWebGL2Timer` expose `measureWarm()` (`provenance: "warm"`) to stabilize GPU clocks before timing idempotent passes.
- **In-page evidence & GC-bracketed retained heap:** `collectInPage` adds an automatic GPU readiness gate (`--ready-timeout`), overlapped network-idle waiting (`--network-idle-budget`), per-sample CDP `Performance.getMetrics` bracketing via `__gpuPerfProgress`, GC-bracketed retained heap (`summary.heap`, ignoring CDP `JSHeapUsedSize` blindness to `ArrayBuffer`s), Long Animation Frame (`long-animation-frame`) hitch attribution (`summary.hitches`), sampling-window per-frame counters (`summary.perFrame`), and WebGPU/WebGL error & shader compile tracking (`summary.gpuErrors`).
- **Automatic CPU hotspot attribution (`report.cpuProfile`):** When a capture is `cpu-bound` or `mixed` with `mainThreadBusy >= 0.6` (or `--cpu-profile` is passed), the fast runner executes one extra profiled sample after measured samples, classifying `main-thread-bound` vs `submission-bound` and attributing native WebGPU/WebGL API calls (`drawArrays`, `submit`, etc.) to their nearest application JS caller and hot line (`positionTicks`).
- **Pipe CDP transport, cross-process GPU measurement lock & zero-TLS local path:** Owned Chrome instances use `--remote-debugging-pipe` (`stdio` fds 3/4) instead of TCP/WebSocket ports, serialize GPU measurements across processes via `acquireMeasurementLock`, and never load `node:tls`, `node:https`, or `undici` on local paths (avoiding the 26s macOS `NODE_USE_SYSTEM_CA` keychain stall).
- **Unified decisions, validity & comparison v2 (`schemaVersion: 2`):** `classifyBottleneck`, `buildFindings`, `verdictFromFindings`, and `reportValidity` drive a single rule engine. Separate captures mark DVFS clock-sensitive auto GPU rows `unverified` with a directional `screen: "better" | "worse" | "same"` hint (exit `0`), while paired `ab` runs and warm/fixed-work hooks gate directly. Work-equivalence checks (`workEquivalence`) catch dropped draws or new GPU errors (`different-work`).
- **One-call `agent --base`, warm daemon & bounded digests/JSON:** `agent <target> --base base.json` inherits baseline options and screens in one command; `agent`/`run` automatically reuse a warm background daemon (`src/daemon.js`); default digests stay `<= 160` tokens (`--json` `<= 1.6 KB`, `compare --json` `<= 2 KB`, `--json-full` for full output); CLI/runner errors exit `3` with `error[<code>]` and `hint:`.
- **MCP `2025-11-25` & new tools:** Added `ab_compare_webgpu` and `doctor_webgpu`, flat schemas (`tools/list` `<= 3 KB`), `resource_link` content items, inline 640px JPEG screenshots (`screenshot: "inline"`), `notifications/cancelled`, `notifications/progress`, and automatic 200-file / 7-day artifact retention.

## Unreleased

- GPU health summaries and comparisons retain timing-scope evidence through A/B aggregation. Mixed scopes and invalid durations cannot produce health means or confidence intervals; incompatible scopes invalidate comparison evidence. Exact custom metrics remain available. Digests and inspection explain unavailable GPU timing.
- Bounded saved-report inspection is available through `inspect`, `inspectReport` and MCP `inspect_webgpu_report`, with exact metric selection, record paging, A/B run selection and explicit omissions. Inspection does not launch a browser or alter saved evidence.
- Diagnostics use actual frame timing for frame-tail warnings, retain zero GPU timings, distinguish screenshot capture from visual correctness, and avoid attributing stalls or allocation churn from operation counts alone. Optimization guidance preserves the workload and output.
- GPU timing extraction avoids constructing unused full property paths; exact-output whole-report benchmarks show the main CPU benefit on verbose hook telemetry.
- Explicit `--sampling-mode hook` / `samplingMode: "hook"` removes idle frame observation for completed fixed-work benchmarks while retaining warmups, samples and diagnostics. Default frame sampling is unchanged; mismatched modes and within-variant capture setting drift invalidate comparisons.
- Page diagnostic retention is bounded in both runners, with reserved error slots, exact totals and explicit drop/truncation counts. Dropped runtime errors still invalidate evidence; failed MCP captures preserve the retained diagnostics.
- Comparison reuses sample distributions and statistics instead of repeating flattening and sorts. Exact-output CPU benchmarking is available in `scripts/benchmark-compare.mjs`.
- The optimization skill has been exercised on a real WebGPU kernel fusion with exact CPU-oracle verification, and explains how fixed-work hooks avoid idle confirmation time.
- Quick doctor checks skip optional Instruments template enumeration; full doctor retains it. Missing native tools return diagnostic data instead of an unhandled process error.
- Agent comparisons expose confidence evidence, prioritize regressions, and support `--metric` / MCP `primaryMetric` display focus. Compact JSON bounds verbose guidance and errors with omission counts while full files retain the evidence.
- A/B CLI captures support scene/hook readiness and compact agent output. Comparisons reject known environment changes and A/B environment drift while disclosing unavailable identity metadata.
- Median absolute deviation reuses sorted values without a second array/sort, with exact-output benchmarks and numerical edge-case coverage.
- MCP reuses one browser, serializes captures with a bounded queue, saves full reports and screenshots, and returns compact responses. Use `includeReport: true` for the previous inline capture payload. Defaults now match the CLI's fixed quick preset; clients can explicitly retain older sampling settings.
- GPU comparison means now use repeated timing evidence where the scope is unambiguous, so noisy changes can remain inconclusive rather than appearing as threshold-only wins.
- Trace summarization classifies events in one pass with identical statistics. A reproducible CPU benchmark is available through `npm run benchmark:trace`.
- The bundled skill focuses on measured optimization and output verification, with optional timing and transport references. Display-capped FPS and health verdicts are explicitly separated from evidence of GPU speedups.

## 2.1.1

- Lead the README and website with one shared skill-install command for Codex, Claude Code, Gemini CLI, and other supported agents, followed by a short usage prompt.
- Explain the profiling loop with a compact flow diagram, scannable technical details, and measurement limits.
- Improve website readability with larger text, stacked explanations, and aligned header links.
- Profiling behavior and defaults are unchanged from 2.1.0.

## 2.1.0

- A shorter README leads with the value, a one-command capture, and a repeatable compare workflow. The full technical guide now lives in `docs/reference.md` and ships with the npm package.
- A redesigned, responsive website explains profiling, reports, comparisons, and agent integration with copyable commands and clearly labeled examples.
- The website builds with Node.js alone and publishes automatically to GitHub Pages. Its release label comes from the package version.
- Profiling behavior and defaults are unchanged from 2.0.0.

## 2.0.0

### Breaking changes

- Requires Node.js 22 or newer. The fast CDP runner uses Node's built-in WebSocket and has no required npm dependencies; Playwright is an optional peer.
- Persistent browser jobs use isolated contexts by default. Select `contextMode: "shared"` / `--context shared` for intentional state reuse.
- The `agent` CLI uses six 250 ms samples and two warmups, with fixed sampling and bounded output. `--adaptive` is explicit; MCP retains its existing adaptive defaults.
- Independent captures use Welch confidence intervals. Use `--paired` only for matched observations. Invalid or incompatible comparisons exit 2; regressions exit 1.
- Reports use schema version 2 with structured warning codes and explicit measurement validity. The root `analyzeReport` returns `{ summary, diagnostics }`; `finalizeReport` returns a new finalized report rather than mutating its input.

### Improvements

- Incremental allocation accounting and bounded history eliminate resource scans from lightweight snapshots. Tracking handles repeated wrapping and partial upload ranges.
- Reusable GPU timers have bounded reads, explicit reset/destroy lifecycle, and failure cleanup. WebGL timers release queries on timeouts, disjoint results, context loss, and draw failures.
- A/B runs reuse one browser and interleave captures. Comparison budgets validate early and reject missing metrics, failed rounds, and incomplete pairs.
- Persistent CDP sessions serialize jobs, clean up pages and popups, isolate storage, and stop after cleanup failures. The local service bounds its queue and request size.
- Frame sampling and settling have wall-clock bounds, including when background pages stop animation callbacks. Requested API probes avoid unrelated work and retain inherited WebGPU capability fields.
- Compact JSON, short agent digests, async readiness, optional deep-memory capture, and dependency-free startup improve developer and agent workflows.
- Existing MCP tools, detailed recommendations, pipeline counters, HTML reports, adaptive sampling, screenshots, and CDP attachment remain available. Attached browsers are left running after profiling.

Local timing and snapshot microbenchmarks are described in OPTIMIZATION.md; they are not application FPS or GPU speedup claims.
