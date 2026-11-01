# Measure the bottleneck and confirm the result

## Contents

- Automatic GPU timing (default)
- Custom timing hook (`__gpuReportBench`, `measureWarm`, batches)
- Fixed-work compute: hook sampling mode
- WebGL2 timer and the no-timestamp fallback
- Follow evidence into the application
- Confirmation: screening vs paired A/B, budgets

## Automatic GPU timing (default)

A 60/120 Hz frame cadence measures browser scheduling; it cannot show how much GPU
headroom a frame has. The profiler's frame observer runs separately from the app's render
loop, so also check that the intended draws/dispatches happen and the output is right.
Screenshots alone do not prove numerical correctness or animation progress.

`agent` and `ab` (2.2+) time every WebGPU pass automatically by injecting
`timestampWrites`, and time WebGL2 frames with `EXT_disjoint_timer_query_webgl2`, without
changing app code. `GPU p50` is GPU-busy time per frame with overlapping passes counted
once; `Passes (excl p50)` gives each pass's own time with overlap excluded, so the pass
times need not add up to the frame time. `inspect --section gpu` lists the most expensive
passes (the report keeps the top 16 per capture).

On Apple GPUs, a frame that fits easily in the vsync budget runs at a lower GPU clock, so
the same page can report 2-4x different GPU time in separate browser launches while each
run is internally consistent. That is why separate captures only screen GPU time and
`ab` confirms it.

For animation or simulation, reset the seed and initial state, step both variants to the
same frame with a fixed timestep, and pause normal advancement while reading back or
capturing output. Free-running screenshots taken after different durations are not
matched frames.

## Custom timing hook

Use a hook for a custom scope, or for idempotent passes you want timed at warm GPU clocks
inside one capture. The timing helpers ship in the package
(`gpu-perf-agent/browser/timing`); importing them adds a dev dependency to the user's app,
so ask first. `measureWarm` needs 2.2+.

```js
import { requestTimedWebGPUDevice } from 'gpu-perf-agent/browser/timing';

// Adds 'timestamp-query' when the adapter supports it; timer is null otherwise.
const { device, timer } = await requestTimedWebGPUDevice(adapter);

globalThis.__gpuReportBench = async ({ phase, sampleIndex, durationMs, api }) => {
  if (!timer) throw new Error('timestamp-query unavailable');
  // Idempotent work only: replayed untimed to warm GPU clocks, then one pass is timed.
  // Open the pass through the supplied helper, not encoder.beginRenderPass.
  return timer.measureWarm((encoder, { beginRenderPass }) => {
    const pass = beginRenderPass(encoder, descriptor);
    drawScene(pass);
    pass.end();
  }); // → { gpuTimeNs, gpuTiming: { method: 'warm', passes, warmupMs } }
};
```

Return the whole result. Its `gpuTiming.method` is what marks the timing as warm; a hook
that returns only `gpuTimeNs` is treated as vsync-paced in frame mode (or `unknown` in hook
mode), and its comparisons between separate captures stay `UNVERIFIED`. A fixed-work
benchmark you time yourself can return `gpuTiming: { method: 'fixed-work' }` next to the
value. Warm or fixed-work timings gate separate comparisons only when they are stable
(about 5% CV or better). Capture with `--wait-for-hook` when the hook is installed after load;
it fails after `--wait-for-hook-timeout` (default 15 s, at most `--timeout`).

Without a warm-up, `timer.measure(record)` uses the same helper signature and returns
nanoseconds. For several passes, `timer.createBatch({ capacity: 8, label: 'profile' })`:
record with `batch.beginRenderPass(encoder, descriptor, label)` or
`batch.beginComputePass(encoder, descriptor, label)`, end the pass, call
`batch.resolve(encoder)` before finishing the encoder, then after submission
`await batch.read()` returns `{ label, durationNs, durationMs }` entries (`batch.measureWarm`
sums its passes). Reuse a batch only after its readback completes, use separate batches
for overlapping frames, and destroy batches and timers when done.

Hook contract: an async function receiving `{ phase, sampleIndex, durationMs, api }` that
exercises a fixed scene or a fixed amount of work and returns measured `gpuTimeNs`
(nanoseconds) or `gpuMs` (milliseconds) for one claimed scope. Never return hardcoded FPS
or estimated durations. Keep one `gpuMs`/`gpuTimeNs` field; extra per-pass detail can use
`durationMs`/`durationNs` and is read as custom metrics such as
`custom.passes.shadow.durationMs.mean`. Several GPU durations in one sample suppress the
GPU mean; a scope that changes between samples, negative durations or all-zero durations
make the capture `INVALID`. Check
`diagnostics.signal.gpuTiming` for hook timing and `diagnostics.signal.autoGpu` for
automatic timing. Warmup calls receive `phase: 'warmup'`. An instant counter-snapshot hook
also finishes warmups instantly, so give the scene its own render warm-up when it needs one.

For a correctness check, make the hook throw on an output mismatch; a returned
`oraclePassed: false` does not invalidate the report.

## Fixed-work compute: hook sampling mode

For fixed-work compute use `--sampling-mode hook` (2.2+; Node/HTTP/MCP:
`samplingMode: 'hook'`). It awaits the hook without running the frame observer or frame
settling; warmups, sample count, memory snapshots, instrumentation and timeouts still
apply. A missing hook fails, and `--adaptive` is rejected. The hook must await completed
work or timestamp readback: returning right after `queue.submit()` does not measure completion.

```bash
npx gpu-perf-agent agent --url http://localhost:5173 --api webgpu \
  --sampling-mode hook --wait-until domcontentloaded --out reports/compute-base.json
```

`durationMs` is still passed to the hook but sets no minimum window. Keep batch size and
timing scope identical between variants, capture baseline and candidate both in hook mode
(comparisons across modes are rejected), and confirm with `ab --sampling-mode hook`.
Without hook mode, keep the frame-observation duration short: a longer `durationMs` only
adds GPU work if the hook uses it. Keep the default frame sampling for natural render
loops, frame pacing and animation; hook mode reports no observer FPS.

## WebGL2 timer and the no-timestamp fallback

`createWebGL2Timer(gl)` from the same module returns null without the timer extension.
`await timer.measure(() => { /* synchronous draw commands */ })` returns nanoseconds;
`timer.measureWarm(draw, { passes: 8 })` (2.2+) warms first. Disjoint, context-loss and
timeout results are invalid, an async callback cannot define the timed interval, and
`destroy()` releases pending queries.

Without timestamps, measure completed fixed-work throughput: a bounded batch plus
completion synchronization, labelled as elapsed throughput including submission and
synchronization. The CPU duration of `queue.submit()` is not GPU duration. Keep input
sizes, resource reuse, output and quality; a lower resolution is a quality tradeoff.

## Follow evidence into the application

| Evidence | Candidate changes | Check before accepting |
| --- | --- | --- |
| CPU submission/draw pressure | Instancing, batching, no per-frame state rebuilding | Same visibility, draw order and output; counters alone are not timing |
| One GPU pass dominates | Remove redundant work, overdraw, reads/writes; try tiling or dispatch sizes | Real pass timing and output; larger tiles or fewer instructions can be slower |
| Pipeline startup cost | Cache by exact descriptor/source; create asynchronously outside the hot loop | Time actual completion; creation counts do not prove stalls |
| Upload/GC spikes | Reuse buffers, dirty ranges, fewer transient objects | Same workload; inspect the spikes, not a short noisy heap slope |
| Declared resource growth | Pair creation with destruction; bound caches | Repeat load/unload cycles; tell a retained cache from a leak |

For shader changes, compile the real assembled variants and pipelines on the GPU, check
bindings and layouts, compare output, and fix the numerical tolerance before testing.
Keep precision, sample count and quality; present any reduction as a tradeoff for the user
to accept. Prefer a small independent CPU oracle for compute results when practical.

## Confirmation: screening vs paired A/B, budgets

Separate captures (`compare`, `agent --base`) use independent-sample confidence intervals;
`--paired` is only for genuinely matched samples. Automatic GPU rows from separate captures
are marked `unverified` (reason `separate-capture-gpu`) with a `screen: better|worse|same`
hint and exit 0. The headline shows the screen of the primary metric whenever that metric
is unverified (GPU, frame time or CPU). When automatic GPU time is not the primary, its
screen is not printed: run `inspect --report <compare.json> --section metrics --changed`,
or pass `--metric health.autoGpuFrameMs.p50`.
Only `ab`, or stable warm/fixed-work hook timings, can confirm a GPU change.

`ab` alternates base and candidate in every round (ABBA order) and records each round's
median:

```bash
npx gpu-perf-agent ab \
  --base-url http://localhost:5174 --candidate-url http://localhost:5173 \
  --rounds 4 --out reports/ab.json
```

Use at least 4 rounds; with fewer, paired rows stay `unverified` (`too-few-rounds`). `ab`
accepts the same readiness flags as `agent` (`--wait-until`, `--wait-for-hook`,
`--wait-condition`, `--hook`), plus `--preset`, `--timeout`, `--viewport` and
`--device-scale-factor`. `--json` prints a compact summary and `--json-full` the full result.
MCP `ab_compare_webgpu` accepts only targets, rounds, samples, durationMs, warmup,
primaryMetric, thresholdPercent, autoInstrument, gpuTiming and allowMismatch; use the CLI
for readiness flags, hook mode, `--api`, viewport or budgets.

For a gate, pass a budget file to `ab` or `compare`. Every budgeted metric must exist in
both reports, or the comparison is `INVALID` (exit 2). With automatic timing, budget
`health.autoGpuFrameMs.p50` and apply it with `ab`: a budgeted metric always gates, so on
separate captures it would gate clock-sensitive GPU time. Use `health.gpuFrameMs.mean`
only when the hook returns a single GPU timing.

```json
{
  "defaultMaxRegressionPercent": 5,
  "metrics": {
    "health.autoGpuFrameMs.p50": { "direction": "lower", "maxRegressionPercent": 5 }
  }
}
```

Add an absolute `max` only for a real user or workload target. Set `direction: "higher"`
explicitly for custom throughput metrics: only names containing fps, throughput,
opsPerSecond, score or bandwidth default to higher-is-better, all others to lower. A passing gate
also allows inconclusive changes, so check the primary metric explicitly. Choose the
primary metric before testing, report every round including failed ones, and when the
result stays inconclusive after more rounds, report it as neutral.
