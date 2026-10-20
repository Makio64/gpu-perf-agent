# Measure the bottleneck and confirm the result

## Display-capped and compute workloads

A 60/120 Hz rAF cadence measures browser scheduling. It cannot reveal how much GPU
headroom a frame has. The profiler's observer is separate from the application's render
loop, so also verify intended draws/dispatches and output. Screenshots alone do not
prove numerical correctness or animation progress.

For animation/simulation, reset the seed and initial state, step both variants to the
same frame with a fixed timestep, and pause ordinary advancement while reading back or
capturing output. Free-running screenshots taken after different capture durations are
not matched frames.

Prefer existing app timestamps. If absent, add narrowly scoped timing to its existing
device/passes, or use a deterministic benchmark hook. Do not create a separate device
to time another device's workload. WebGPU requires `timestamp-query` in the device's
requested features; feature-gate it and retain the normal unsupported path. Batched
timers are exported from `gpu-perf-agent/browser/timing`:

```js
import { createWebGPUTimer } from 'gpu-perf-agent/browser/timing';
const timer = createWebGPUTimer(device); // null without timestamp-query
const batch = timer?.createBatch({ capacity: 8, label: 'profile' });
```

Record with `batch.beginRenderPass(encoder, descriptor, label)` or
`batch.beginComputePass(encoder, descriptor, label)`, end the pass, then
`batch.resolve(encoder)` before finishing/submitting the encoder. Await `batch.read()`
after submission to get `{label, durationNs, durationMs}` entries. Reuse only after
readback completes; separate batches are needed for overlapping frames. Destroy batches
and timer when done. Keep readback off the ordinary frame's critical path when possible.
Time an equivalent scope in both variants; summed passes are not necessarily elapsed
frame time because execution can overlap.

Expose actual measured results through `globalThis.__gpuReportBench`, an async function
receiving `{phase, sampleIndex, durationMs, api}`. Exercise a fixed scene or identical
amount of work and return measured `gpuTimeNs` (nanoseconds) or `gpuMs` (milliseconds).
Do not return hardcoded FPS or estimated durations. Return one aggregate for the claimed
scope; avoid mixing per-pass durations and whole-frame durations in a single GPU mean.
Current captures expose scope evidence at `diagnostics.signal.gpuTiming`. Multiple
recognized GPU durations in one sample, changing paths, or negative durations suppress
the health GPU mean. Keep one `gpuMs`/`gpuTimeNs` field for the claimed scope; additional
pass details can use `durationMs`/`durationNs`. To evaluate an individual pass, choose
its exact custom metric, such as `custom.passes.shadow.durationMs.mean`, and verify
that it measures the same work in both variants. Adding timing details is not a gain.
Default frame mode also observes rAF concurrently. Warmup calls use `phase: 'warmup'`.
An immediate counter-snapshot hook also finishes its warmups immediately; prepare a
real render warmup/readiness period when the scene needs it. For periodic hitches, choose
an observation window that reproduces several cycles instead of blindly using a preset.

For fixed-work compute, use `--sampling-mode hook` if installed help exposes it
(Node/HTTP/MCP: `samplingMode: 'hook'`). It awaits the hook without running the
profiler's frame observer or frame settling. Warmups, sample count, memory snapshots,
instrumentation and timeouts still apply; missing hooks fail and FPS-based `--adaptive`
is incompatible. Hook readiness is enabled by default. The hook must await completed
work or timestamp readback; returning after `queue.submit()` does not measure completion.

```bash
npx gpu-perf-agent agent --url http://127.0.0.1:5173 --api webgpu \
  --sampling-mode hook --wait-until domcontentloaded --out reports/compute-base.json
```

`durationMs` is still passed to the hook, but does not impose a minimum observation
window in this mode. Keep batch size and timing scope equal between variants and gain
confidence with more independent rounds. Reacquire both baseline and candidate in hook
mode; the tool rejects comparisons across modes, and removing inter-sample idle time
can change GPU clocks and thermal behavior. Keep default `frames` sampling for natural
render loops, frame pacing and animation. No observer FPS in hook mode is expected.

If hook sampling is unavailable, choose a short useful frame-observation duration for
fixed-work compute. A longer `durationMs` adds GPU work only if the hook uses that value;
otherwise it adds idle observation. Do not remove real completion synchronization to
make either mode faster.

WebGL2 can use `createWebGL2Timer(gl)` from the same module; it returns null without the
timer extension. `await timer.measure(() => { /* synchronous draw commands */ })`
returns nanoseconds. Disjoint/context-loss/timeout results are invalid; `destroy()`
releases pending queries. An async callback cannot define this timer's draw interval.

If timestamps are unavailable, measure completed fixed-work throughput using a bounded
batch and completion synchronization. Label it as elapsed throughput including submission
and synchronization. `queue.submit()` CPU duration alone is not GPU duration. Preserve
input sizes, resource reuse, output and quality; reduced resolution is a quality tradeoff.

## Follow evidence into the application

| Evidence | Candidate changes to inspect | Check before accepting |
| --- | --- | --- |
| CPU submission/draw pressure | Instancing, batching, avoid repeated state construction | Same visibility, draw order, output; counters alone are not timing |
| GPU pass dominates | Reduce redundant work, overdraw, reads/writes; test tiling or dispatch sizes | Real pass timing and output; larger tiles/fewer instructions can be slower |
| Pipeline startup cost | Exact descriptor/source cache, async preparation outside hot loop | Time actual completion; creation counts do not prove stalls |
| Upload/GC spikes | Reuse buffers, dirty ranges, reduce transient objects | Same workload; inspect spikes rather than short noisy heap slope |
| Declared resource growth | Pair creation/destruction; bound caches | Repeat load/unload cycles, distinguish retained cache from leak |

For shader changes compile actual assembled variants and pipelines on the GPU, verify
bindings/layouts, compare output, and define any numerical tolerance before testing.
Do not silently lower precision, sample count or quality. Prefer an independent small
CPU oracle for compute results when practical.
Make the hook throw on an output mismatch, or inspect its correctness result separately;
an arbitrary returned `oraclePassed: false` does not automatically invalidate the report.

## Confirmation

Separate captures use Welch intervals; `--paired` is only for genuinely matched samples.
Interleaved A/B preserves GPU scope evidence across rounds. A confidence interval
cannot repair mixed scopes or differing scope identities. Recompare original captures
with the current tool when verifying a result from an older version; inspecting a
saved comparison displays its historical calculations without recomputing them.
At least three observations per side are needed for estimated mean uncertainty, but short
adjacent samples may be correlated. Inspect repeated runs when the effect is small.
`threshold-only` rows do not establish statistical confidence. An interval must lie beyond
the allowed threshold to confirm a regression/improvement. Missing budget metrics fail.

For frame pacing, current `health.frameTimeMs.p95` is the p95 of per-window p95 values;
`frame.frameTimeMs.p95` is their mean. Neither is pooled p95 across every frame. Use
repeated A/B rounds for uncertainty on the selected statistic, or retain raw frame data
and calculate the pooled percentile if that is the actual requirement.

For two runnable builds, alternate A/B order in one browser:

```bash
npx gpu-perf-agent ab \
  --base-url http://127.0.0.1:4173 --candidate-url http://127.0.0.1:5173 \
  --api webgpu --auto-instrument --rounds 4 --samples 3 \
  --duration-ms 500 --warmup 2 --out reports/ab.json \
  --agent --metric health.gpuFrameMs.mean
```

For an asynchronously initialized workload, add `--wait-until domcontentloaded` with
`--wait-for-hook` and/or its real `--wait-condition`; use `--hook` for a custom function
name. `ab` accepts these readiness controls plus `--timeout` and `--device-scale-factor`.
`--agent` returns a bounded digest; full rounds and comparisons stay in the saved JSON.
`--metric` keeps the primary row visible without excluding other regressions. Use `--json`
instead when complete machine-readable comparison rows are needed.

`ab` still has its own sampling flags: it does not accept `--preset`, `--server`, or
`--trace`. Check installed `ab --help` when using an older version; `runABComparison`
from the Node API accepts normalized readiness options if the CLI does not. Alternatively,
confirm separate captures with `agent --preset confirm` (15 × 500 ms, four warmups).
Reacquire the baseline with the confirmation settings too. Do not compare a quick
baseline against a confirmation candidate. With only one server, serve the preserved
baseline build, capture it with the same timing integration/readiness, then serve and
capture the candidate. Repeat alternating build order if needed; these separate captures
are independent, not `--paired`. An earlier capture without GPU timings cannot become
a timed baseline retroactively. If the original runnable workload cannot be recovered,
report that limitation instead of claiming a before/after GPU gain.

For a GPU-time gate, pass a budget file to `compare` or `ab`:

```json
{
  "defaultMaxRegressionPercent": 5,
  "metrics": {
    "health.gpuFrameMs.mean": { "direction": "lower", "maxRegressionPercent": 5 }
  }
}
```

Add an absolute `max` only when a real user/workload target exists. Check the primary
metric explicitly; a passing gate allows inconclusive changes and does not prove a win.
For custom throughput metrics set `direction: "higher"` in the budget; arbitrary names
may otherwise be interpreted as lower-is-better. Do not cherry-pick noisy changes among
many metrics, or delete failed rounds. Repeat both variants with more useful evidence,
or report that the result is neutral/inconclusive.
