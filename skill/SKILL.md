---
name: gpu-perf-agent
description: Profile and optimize WebGPU, WebGL, and three.js applications using measured bottlenecks, GPU timing, allocation evidence, and before/after regression checks. Use for performance investigations and optimization loops, not ordinary scene authoring.
---

# GPU performance optimization

Improve the user's workload while preserving its output and quality. Optimize the metric
that matters to that workload; a healthy verdict, fewer warnings, or display-capped FPS
does not establish a GPU speedup.

## Start with the smallest useful capture

Use the project's installed `gpu-perf-agent`, `npx gpu-perf-agent`, or `node src/cli.js`
in this tool's checkout. Keep the same tool version throughout a comparison. Node 22+
and Chrome/Chromium are required; the default runner needs no npm dependencies.
Check installed help once before using optional flags; a published version may lag this
skill's source checkout. Unsupported flags need a compatible checkout or the documented fallback.
Run `doctor --quick --json` for setup problems, not before every capture; it does not
probe browser/GPU support or enumerate Instruments templates. Full `doctor --json`
probes browser capabilities and native templates.

Establish the target scene, readiness, primary metric, and output checks before editing.
Preserve a runnable baseline build/revision and its capture, fixed input/seed, camera, viewport, pixel density,
quality, and browser/adapter. Confirm the app is doing its intended work: the profiler's
own animation callbacks can continue even when the app stops drawing.

```bash
# 1. Capture baseline (auto-instrumentation + per-pass GPU timing on by default)
npx gpu-perf-agent agent --url http://127.0.0.1:5173 --label base
# 2. Edit code, then capture + screen against baseline in one call (inherits base options)
npx gpu-perf-agent agent --url http://127.0.0.1:5173 --base reports/base-1.json --label cand
# 3. Confirm GPU or frame-time deltas with interleaved paired A/B rounds
npx gpu-perf-agent ab --base-url http://127.0.0.1:4173 --candidate-url http://127.0.0.1:5173
```

Choose the app's API (`webgpu`, `webgl2`, or `webgl`); omit `--api` when unknown.
`agent` enables auto-instrumentation, per-pass GPU timing, six fixed 250 ms samples and two warmups, and automatically reuses a warm background Chrome daemon (`--no-daemon` disables it). Its bounded digest (`<= 160` tokens) points to saved measurements on disk; use `--json` for bounded machine-readable output (`<= 1.6 KB`) or `--json-full` for the complete report.
Page logs retain bounded examples with exact error totals and explicit omission counts.
Read only the relevant report fields, rather than loading the entire report into context.

For asynchronous initialization, add `--wait-for-hook` when the app exposes
`globalThis.__gpuReportBench`, or `--wait-condition 'window.ready === true'` when it
has a real readiness signal. With persistent network traffic, use
`--wait-until domcontentloaded` plus explicit readiness. For local HTML use
`--file page.html --file-root .`; bundled apps generally need their normal dev server.

## Diagnose, change, confirm

Check `diagnostics.validity`, signal counts, and actual rendering first. Failed or
missing measurements need repair before optimization. Missing GPU time is not zero.
Check `diagnostics.signal.gpuTiming` when present: mixed or changing timing scopes
cannot establish a GPU mean, even when every sample contains a number.
Recommendations and code hints are hypotheses: inspect the implicated source and
evidence before applying them.

| Observed signal | Next useful evidence |
| --- | --- |
| FPS pinned at refresh rate | GPU timestamps or a fixed-work throughput measurement |
| Slow frames / high p95 | Reproduce the spike; inspect CPU work, uploads and pipeline creation |
| High GPU time | Time relevant passes; separate arithmetic, bandwidth, overdraw and dispatch costs |
| Growing allocations | Repeat the same lifecycle and verify resource release |

Read [measurement.md](references/measurement.md) for timing integration, bottleneck
choices, fast fixed-work hook sampling, confirmation commands, budgets, or inconclusive results.

Make a focused change, check rendered and numerical output, then screen with `agent <target> --base reports/base-1.json` (which automatically inherits capture options from the baseline report).
Because automatic GPU timestamps are clock-sensitive across separate browser launches, separate captures report `UNVERIFIED (screen: better|worse|same)` on auto GPU rows and print the exact `ab` command needed to confirm. Run `ab` (or MCP `ab_compare_webgpu`) to confirm GPU deltas with interleaved paired rounds (`--auto-instrument` and `--gpu-timing` are enabled by default in `ab`).
Exit codes: `0` ok / improved / unchanged / unverified / inconclusive; `1` confirmed regression or budget failure; `2` invalid capture or compatibility mismatch; `3` CLI/runner/navigation error. Do not waive mismatches to manufacture
a win. The tool checks capture options and available environment identity; missing
metadata and complete scene equivalence still require verification.

Keep a change when its benefit repeats, output checks pass, and relevant costs remain
acceptable. Stop when the requested budget is met or tested candidates yield no supported
gain; do not iterate just to make the verdict excellent. Deliver the retained changes,
before/after metric and uncertainty, correctness result, report paths, and reproduction
command. State unmeasured hardware/workload limits.

## Keep iteration cheap

For multiple captures, reuse Chrome via `serve` or the MCP server. Keep isolated contexts
and serialize measurements; parallel agents can inspect code and prepare candidates while
one owns timed runs. Read [transports.md](references/transports.md) for persistent CLI,
MCP, readiness options and bounded `inspect` queries for saved reports.

Trace, deep-memory sampling, and forced GC are diagnostic tools with overhead; enable
them only for a specific question and match settings across comparisons. Screenshots
help check rendering but require inspection/comparison to establish visual correctness.
Allocation totals estimate declared storage, not physical VRAM residency; operation
counts do not measure pipeline stalls or prove a resource leak.
