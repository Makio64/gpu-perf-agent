---
name: gpu-perf-agent
description: Profile WebGPU and WebGL pages, diagnose frame pacing and declared GPU allocations, and compare performance across builds with measured regression evidence.
---

# GPU performance profiling

Requires Node.js 22+ and Chrome/Chromium. Use a project's installed `gpu-perf-agent`, `npx gpu-perf-agent`, or `node src/cli.js` from the tool checkout. The default CDP runner has no required npm dependencies. `doctor --quick --json` checks local setup; a full `doctor --json` also probes browser capabilities.

## Efficient capture

```bash
npx gpu-perf-agent agent --url http://127.0.0.1:5173 --out reports/base.json
# After a change, repeat with the same settings:
npx gpu-perf-agent agent --url http://127.0.0.1:5173 --out reports/candidate.json
npx gpu-perf-agent agent --base reports/base.json --candidate reports/candidate.json
```

`agent` uses instrumentation, six 250 ms samples, and two warmups. It saves full evidence and prints a bounded digest with up to three warnings. `--json` prints structured compact output. Use the saved report for detailed recommendations and measurements. Missing evidence is not a zero measurement.

For repeated captures, reuse Chrome:

```bash
npx gpu-perf-agent serve --port 9099 --auto-instrument
npx gpu-perf-agent agent --server http://127.0.0.1:9099 --url http://127.0.0.1:5173 --out reports/candidate.json
```

Each job gets a fresh browser context by default. Use `--context shared` only for intentional stateful measurements. Configure browser launch flags on `serve`. Paths in HTTP jobs are resolved on the service machine. `run --cdp 9222` also attaches to an existing debug-enabled Chrome; it creates profiling pages and leaves the browser running afterward.

## Choosing measurement settings

- `--file page.html --file-root .` serves local HTML and its project imports. A running dev server is preferable for bundled applications.
- `--api webgpu`, `--api webgl2`, or `--api webgl` avoids unrelated API probes; `auto` probes WebGPU and WebGL2.
- `--wait-for-hook` waits for asynchronous `globalThis.__gpuReportBench` setup. `--wait-condition 'window.ready === true'` supports custom readiness, bounded by `--wait-condition-timeout` in milliseconds.
- Keep fixed sampling for comparisons. `--adaptive` may stop after three samples when FPS CV is below 1.5%; it is a turnaround aid, not proof of statistical convergence or GPU stability.
- `--preset confirm` provides 15 × 500 ms samples with four warmups. Use `ab` with `--base-url`, `--candidate-url`, and `--rounds 4` to interleave A/B runs in one browser. Local alternatives are `--base-file` and `--candidate-file`.
- `--trace` adds Chrome diagnostics; `--minimal-trace` limits categories to GPU events. `--raw-trace` retains the trace. Keep tracing settings identical between compared captures.
- `--html` writes an interactive HTML report; `--html-out` sets its path. `--screenshot` saves a PNG. Screenshot capture alone does not establish visual equivalence.
- `--executable-path` or `CHROME_PATH` selects a browser. The optional `--runner playwright` needs Playwright installed separately.

## Interpreting evidence

Read `diagnostics.validity` before `summary.verdict`. Failed hooks, uncaught runtime errors, missing requested capture data, and missing workload measurements invalidate a run. Inspect `inPage.samples`, `pageEvents`, and the validity issues before comparing it.

Exit codes: `0` means a valid capture or passing comparison, `1` means an execution error or regression, and `2` means invalid measurements or incompatible comparison settings. `--allow-mismatch` can waive configuration differences but cannot waive invalid measurements.

Independent captures use Welch confidence intervals. `--paired` is only appropriate for genuinely matched samples; interleaved A/B comparisons pair rounds automatically. A regression's interval must cross the allowed threshold. Metrics without enough repeated evidence are labeled `threshold-only`. Budget files can set absolute limits and per-metric regression thresholds; a missing budget metric invalidates the gate.

`summary` includes frame time, FPS, available GPU timing, tracked allocations, draw pressure, structured warnings, and detailed recommendations. API counters describe observed operations, not measured pipeline stall duration. Declared allocation totals are not physical VRAM residency or proof of leaks. rAF timing measures browser frame cadence; GPU duration requires timing hooks. Confirm a recommendation against the workload before changing code.

Use the smallest useful capture, change the suspected bottleneck, and repeat with identical settings. Report uncertainty, unsupported APIs, missing metrics, and visual differences alongside any claimed improvement.

## MCP and API access

`npx gpu-perf-agent mcp` starts the stdio JSON-RPC server with `profile_webgpu` and `compare_webgpu_reports`. MCP profiling retains three 500 ms samples and adaptive mode by default; override sampling arguments when comparing. Responses include text and the full report. Node exports include `runReport`, `FastCDPHarness`, `compareReports`, `generateHtmlReport`, and the detailed digest helpers under `gpu-perf-agent/agent`.
