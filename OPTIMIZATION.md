# Tool efficiency improvements

Raw capture evidence referenced below is local and intentionally excluded from the public package. Reproduce the checks with the test and benchmark commands; release validation is recorded in the GitHub release notes.

## Agent workflow improvements (unreleased)

Measured on macOS arm64 / Apple M3 Max / Node v24.18.0 against revision `a556cb5`:

| Workload | Baseline | Updated | Result |
| --- | ---: | ---: | ---: |
| Subsequent MCP captures in one server | 1,220.81 ms | 593.88 ms | 51.4% less elapsed time |
| MCP response, median of those captures | 26,443 bytes | 766 bytes | 97.1% fewer bytes |
| Mixed trace, 250,000 events | 69.54 ms | 39.78 ms | 1.75× CPU speedup |
| GPU-heavy trace, 250,000 events | 100.01 ms | 90.57 ms | 1.10× CPU speedup |

The MCP measurement alternated baseline/current order across three paired rounds, each
with three sequential calls. Both used the same WebGL fixture, one 80 ms sample and one
warmup, with instrumentation enabled and tracing disabled. All 18 captures were valid.
The subsequent-call median uses six calls per version; cold medians were 1,129.75 ms
and 1,108.12 ms. Reusing Chrome removes repeated launch/close work while each capture
retains isolated browser state. The updated path also writes complete evidence to disk.
Bytes measure serialized responses, not tokenizer-specific token counts.

Trace results use nine alternating repetitions per workload, with GC between timed
calls and exact output equality against the baseline on every repetition. GPU-heavy
results were more variable; these figures are local medians, not universal guarantees.
The change removes repeated event classification and temporary event arrays while
retaining exact statistics. A separate instrumentation wrapper candidate was rejected
because it did not improve the tested workload.

These are agent turnaround and profiler CPU improvements, not application GPU speedups.
Raw evidence: `reports/agent-efficiency/mcp-turnaround.json`, reproduction script
`reports/agent-efficiency/benchmark-mcp.mjs`, and `reports/trace-summary-benchmark.json`.
Reproduce trace results against a baseline checkout with:

```bash
node --expose-gc scripts/benchmark-trace.mjs --baseline /path/to/baseline
```

MCP now saves unique captures and comparison artifacts, offers full inline capture
output explicitly, exposes readiness controls, and drains accepted jobs at shutdown.
GPU mean comparisons use repeated evidence when timing scopes are unambiguous; a noisy
12 → 11 ms fixture now remains inconclusive instead of reporting a threshold-only win.
The skill loads timing/transport references only when relevant and was independently
exercised against a display-capped scenario with missing GPU timing. That exercise also
led to explicit runnable-baseline preservation and synchronized animation-output checks.

## Second agent efficiency pass (unreleased)

The next pass compares against the working implementation above, not the original
release. Local measurements used the same M3 Max / Node v24.18.0 environment:

| Workload | Before this pass | After | Result |
| --- | ---: | ---: | ---: |
| `doctor --quick --json` | 694.19 ms | 59.21 ms | 11.7× faster |
| Statistics over 250k random numbers | 80.11 ms | 73.01 ms | 8.9% less CPU time |
| Statistics over 250k sorted numbers | 16.58 ms | 8.95 ms | 46.0% less CPU time |
| GPU-heavy 250k-event trace summary | 66.77 ms | 54.76 ms | 18.0% less CPU time |

Quick doctor now skips optional Instruments template enumeration and reports that it
was not queried; full doctor still enumerates it. Five alternating pairs measured process
wall time. This improves a setup check, not browser startup or GPU capability detection.
The baseline was already using warmed native tool caches, unlike some earlier runs.

Statistics now derive median absolute deviation by merging distances around the median
instead of allocating and sorting a second full array. Fifteen alternating pairs tested
the 250k workloads. Every result matched the previous implementation exactly; tests cover
subnormal values, overflow, signed zero and typed-array behavior. The integrated trace
measurement swapped only the statistics implementation; its paired mean-difference 95%
interval was −13.50 to −11.65 ms for the GPU-heavy case. Mixed traces improved less
(33.47 → 32.15 ms). These remain profiler CPU results, not application GPU speedups.

Reproduce statistics with `node --expose-gc scripts/benchmark-stats.mjs --baseline
/path/to/previous/stats.js --size 250000 --repetitions 15`. Raw measurements and the
doctor reproduction script are under `reports/agent-efficiency-2/` locally.

The confirmation workflow also improves: A/B accepts readiness and custom-hook options
directly, compact output retains the selected metric and its evidence, and comparisons
check known browser/GPU/host/launch differences. A/B records per-round environment drift;
unavailable metadata stays explicitly unverified. Full reports and comparison files
remain authoritative when bounded output omits detail.

Compact JSON also has a measured size bound for verbose diagnostics. A synthetic valid
report with 100 warnings/recommendations/request errors and long guidance shrank from
5,117,769 to 7,308 serialized bytes, with explicit omission counts and core measurements
retained. Healthy real captures grew by 38–64 bytes for those counts; this change is
protection against oversized agent responses, not a claim that every response shrinks.
Evidence: `reports/agent-efficiency-2/output-payload.json`.

## Third agent efficiency pass and real workload validation (unreleased)

This pass reuses custom measurement distributions and their statistics during comparison,
skips excluded frame histories before flattening, and avoids duplicate GPU-scope traversal.
Against the previous working version on the same M3 Max / Node v24.18.0 machine:

| Comparison workload | Before | After | CPU speedup |
| --- | ---: | ---: | ---: |
| Independent captures, 15 samples and 24 instrumented passes | 6.415 ms | 2.761 ms | 2.32× |
| Paired captures, missing values and explicit overrides | 16.795 ms | 9.941 ms | 1.69× |
| Independent aggregates, 240 metrics | 3.192 ms | 1.934 ms | 1.65× |
| Paired aggregates, 240 metrics | 2.985 ms | 2.596 ms | 1.15× |

Eleven alternating repetitions with GC between measurements compared exact output and
input immutability on every workload. Each comparison exercised real confidence calculations,
and capture cases also exercised budgets and missing metrics. Public row statistics and
sample arrays remain independent. Reproduce with `node --expose-gc
scripts/benchmark-compare.mjs --baseline /path/to/previous/src/compare.js --repetitions 11`.
Evidence: `reports/agent-efficiency-3/compare-benchmark.json`.

Live page diagnostics are now bounded at their source, including large console strings
and nested stacks. Routine messages cannot consume the reserved runtime/network-error
slots. Exact counters include all omitted events; dropped runtime errors still invalidate
the report, and failed MCP captures keep the bounded evidence. Deterministic replay through
the saved old and new adapters measured **23,546,356 → 251,125 bytes** for 24,000 CDP
events, and **13,291,576 → 145,691 bytes** for 23,000 Playwright events: about 98.9% less
retained diagnostic JSON. A single oversized console call shrank from 5,121,081 to 8,739
bytes. These are serialized sizes, not RSS or runtime speed measurements. Evidence and
reproduction: `reports/agent-efficiency-3/capture-diagnostics.json` and
`reports/agent-efficiency-3/capture-simulation.mjs`.

The skill was also exercised on a real WebGPU optimization: fuse grayscale conversion
and contrast adjustment into one compute dispatch while preserving every integer result.
All **1,048,576 output pixels** from both variants exactly matched an independent CPU
oracle; three shaders compiled cleanly and all 16 confirmation captures were valid.
On this local Chrome/M3 Max setup, eight alternating paired rounds measured summed GPU
pass execution **0.123133 → 0.098976 ms/image (19.62% lower)**. The paired 95% delta
interval was **[−0.038590, −0.009724] ms/image**, beyond the 5% improvement threshold.
The initial four-round experiment remained recorded as inconclusive. Throughput rose
19.61% and declared GPU buffer storage fell 4 MiB. Summed pass time is not elapsed frame
time, declared storage is not physical residency, and this one kernel does not establish
general shader/hardware performance. Raw evidence, runnable variants and reproduction
are under `reports/agent-efficiency-3/skill-workload/`.

That exercise exposed unnecessary idle observation for fixed-work hooks: a longer
`durationMs` does not add GPU work when the hook ignores it. The measurement reference
now explains how to choose observation duration and use more independent rounds for
confirmation. Both installed skill copies are synchronized with the bundled source.

All **218 tests passed with zero skips**, including real Chrome integration, after this
pass (`reports/agent-efficiency-3/all-tests.txt`).

## Fixed-work capture efficiency (unreleased)

An explicit `samplingMode: "hook"` / `--sampling-mode hook` now awaits completed
benchmark hooks without an unrelated rAF observation window. It keeps configured
warmups/sample counts, memory and allocation snapshots, and timeout/error checks.
Default frame sampling remains appropriate for render loops and frame pacing. Hook
mode requires its hook and rejects FPS-based adaptive stopping; comparison and A/B
aggregation reject incompatible sampling settings.

Six alternating pairs used the same real WebGPU image transform in one persistent
Chrome process, with isolated contexts, six samples, three warmups and sixteen images
per invocation. Median capture turnaround fell **1,282.89 → 510.19 ms (2.51× faster)**.
Means were 1,396.67 → 504.29 ms; the higher initial frame capture is retained. The paired
95% delta interval was −1,177.31 to −607.45 ms. Timing excludes browser launch but
includes page setup, compilation, output verification, sampling and cleanup.

Every capture preserved all six actual GPU measurements and exact CPU-oracle matches
for 1,048,576 pixels. Hook captures scheduled zero profiler rAF callbacks; frame captures
retained frame evidence. This is a capture-turnaround improvement, **not an application
GPU speedup**. Modes change idle intervals and cannot be compared as equivalent GPU
experiments. Background host activity was not controlled; a transient unrelated browser
process was observed after the validation tests. Raw evidence, caveats and reproduction:
`reports/agent-efficiency-4/workload/`.

Real-browser coverage exercises slow asynchronous hooks, delayed readiness, absent
hooks, failed samples, HTTP, CLI and alternating A/B. A separate optional Playwright
smoke test used existing local dependencies and found its default readiness polling
used rAF. Hook mode now polls readiness on a timer; the verified Playwright capture
also recorded zero rAF callbacks, three actual GPU samples and exact output. Evidence:
`reports/agent-efficiency-4/playwright-check/`.

Review additionally fixed mode metadata loss during direct-API aggregation and removed
the accidental limited-frame warning when the user intentionally disabled observation.
The skill explains mode selection, completion synchronization, matching baseline/candidate
settings and the fallback for older installed versions.

A fresh skill forward test selected frame sampling for a continuously panning dashboard
and hook sampling for awaited image batches, reacquiring both sides after the mode change.
Its source-discovery gaps led to concise guidance on window-p95 aggregation, counter-only
hook warmups, periodic hitch windows and explicit oracle failure handling. This was a
decision/command-plan check, not an additional runtime performance measurement; the plan
is retained at `reports/agent-efficiency-4/skill-forward.md`.

Final validation: **239 tests passed with zero skips**, including all enabled real-browser
tests (`reports/agent-efficiency-4/all-tests.txt`), plus the separate Playwright compute
capture above. Both installed skill copies match the validated packaged skill.

## Fifth agent efficiency pass: analysis and selective evidence (unreleased)

GPU timing extraction now passes property names through its recursive traversal instead
of constructing and splitting full paths at every numeric leaf. Recognition, ordering,
depth limits and outputs are unchanged. Nine alternating measurement groups used the
same frozen dependencies for baseline and candidate, with whole-operation timing and
exact deep/JSON equality checks on every fixture.

On an M3 Max / Node v24.18.0, finalizing a representative verbose hook report (15 samples,
256 dispatch metadata records per sample, 790 KB) fell from **15.72 to 6.56 ms** median
wall time (**2.40×**); process CPU fell from **11.58 to 4.89 ms**. Ordinary saved captures
saved only **0.02–0.05 ms**. The verbose fixture extends a real capture with telemetry;
this result is not an application GPU improvement or a universal capture speedup.
Reproduction, source snapshots and dependency hashes are in
`reports/agent-efficiency-5/analysis/RESULTS.md` and `confirm-benchmark.json` locally.

Saved artifacts can now be inspected through CLI `inspect`, Node `inspectReport`, and
MCP `inspect_webgpu_report`. Select one exact metric, a sample/error page, an A/B run, or
environment/instrumentation/trace evidence. The core result is bounded to 16 KiB with
selection indices, totals, validity, compatibility and omission metadata outside its
clipped evidence payload. MCP supplies the bounded result as both structured data and
JSON text for older clients. The source file is still read and parsed in full; this
reduces response/context bytes, not file I/O. No new browser capture is needed.

An independent skill exercise queried the existing **1,752,302-byte** A/B artifact:
the exact GPU metric with confidence evidence returned **1,692 bytes** of CLI JSON;
one run's sample returned **6,722 bytes**, and its errors returned **997 bytes**.
CLI and exported Node results agreed exactly. These are selected-payload sizes, not
token counts or a new GPU measurement. Omitted nested oracle values were explicitly
marked and checked using the skill's direct-extraction fallback. The exercise also
caught a missing compatibility flag on selected comparison rows; every comparison view
now retains that flag and difference/unverified counts. Reproduction and results:
`reports/agent-efficiency-5/inspect-forward-check.mjs`, `inspection.json` and
`skill-forward.md`.

Diagnostics also avoid unsupported optimization conclusions: sample elapsed duration
does not establish frame stutter; a screenshot's byte size does not establish visual
correctness; pipeline/bind-group counts do not establish stalls or churn. GPU/compute
timing averages retain measured zeros and guidance preserves the workload and output.
Replaying 29 existing reports removed three false frame-tail warnings from hook-only
captures while preserving their other findings. Evidence is in
`reports/agent-efficiency-5/diagnostics-evidence.json`.

Final validation: **269 tests passed, zero failures or skips**, with real-browser tests
enabled (`reports/agent-efficiency-5/all-tests.txt`). The first run caught one HTML
assertion for the deliberately renamed pipeline recommendation; its original failure
log is preserved. Eighteen inspector tests and 40 additional stress cases checked
bounded output (largest stress result: 15,729 bytes), explicit omissions and unchanged
inputs. The packaged skill validates and both installed copies match its three files;
backups and checksums are preserved locally. Package dry-run contents include the
inspector and references and exclude measurement artifacts.

## Sixth agent pass: prevent false GPU gains (unreleased)

An unchanged 12 ms timing plus two newly reported 2 ms pass details previously changed
the health mean to 5.33 ms: an apparent **55.6% improvement** caused only by adding
diagnostics. A second fixture kept `main` at 10 ms and `shadow` at 1 ms, but changed the
sample mixture from five main/one shadow to one main/five shadow. A/B aggregation
incorrectly turned its pooled 8.5 → 2.5 ms mean into a paired interval of [-6, -6] ms.
These are untimed synthetic semantic reproductions, not GPU performance measurements.

The shared timing collector now retains a consistent scope and positional observations.
Multiple or changing scopes suppress the health GPU mean and percentile while preserving
exact custom measurements. Negative durations invalidate timing evidence. Scope evidence
survives A/B aggregation; mismatches/drift cannot be waived with `allowMismatch`, and
older scope-less aggregates cannot regain unsupported health confidence. Raw samples
override stale health scalars and explicit health sample overrides. Digests show scope
status even when warning rows are hidden, and saved-comparison inspection exposes scope
details alongside the selected health metric.

Independent verification now rejects the changed-mixture fixture (exit 2, no health
GPU row), while both exact pass means remain unchanged and visible. Reaggregating the
preserved eight-round WebGPU workload retains **exactly** its original 0.123132984375 →
0.09897601302083332 ms/image means and paired 95% interval
[-0.03859042530235821, -0.009723517405975135] ms. That is a replay of existing measurements,
not a fresh GPU speedup. Evidence and reproduction are under
`reports/agent-efficiency-6/gpu-scope/` and `reports/agent-efficiency-6/workflow-audit.md`.

Two exact-inspection CPU prototypes were rejected. Ordinary saved-report queries saved
only 0.006–0.015 ms, while a more complex selective-statistics path saved about 2–3 ms
on synthetic verbose telemetry. That benefit did not justify duplicate selection and
overflow-fallback logic. The simpler reduced-statistics variant was also too small to
retain. Frozen benchmarks, 1,513 exact deep/JSON checks and the decision are recorded in
`reports/agent-efficiency-6/inspection/RESULTS.md`. Neither prototype changed production
code.

The correctness checks have a measured cost. Nine alternating groups on the same
M3 Max / Node v24.18.0 added **0.009–0.026 ms** to ordinary metric extraction,
**0.013–0.023 ms** to exact inspection, and **0.004 ms** to finalization. On verbose
15×256 telemetry, the corresponding added wall times were **3.97, 6.31 and 0.56 ms**.
This cost is retained to prevent unsupported conclusions; no speedup is claimed for
this pass. Complete numerical maps/order, selected values and prior diagnostics match
on the three verified single-scope inputs. Frozen source hashes, process CPU results,
all samples and limitations are in
`reports/agent-efficiency-6/inspection/scope-overhead/RESULTS.md`.

Final validation: **284 tests passed with zero failures or skips**, including enabled
real-browser tests (`reports/agent-efficiency-6/all-tests.txt`). The skill validates,
both installed copies match all three packaged files, and prior installed versions are
backed up. Package validation includes the new timing collector and excludes local
benchmark artifacts.

The profiler now spends less CPU time on its own instrumentation, produces concise agent output, and recovers cleanly between jobs. It has zero required npm dependencies: Playwright is an optional peer for the compatibility runner. Node.js 22+ is required for the built-in WebSocket transport.

## Measured overhead

Local measurements on macOS arm64 / Node v24.18.0. Seven repetitions per workload, reporting the median. The baseline is the original source copied before editing; both versions ran on the same machine with the same benchmark script.

| Workload | Original | Updated | Speedup |
| --- | ---: | ---: | ---: |
| CLI `--help` startup | 260.22 ms | 36.26 ms | 7.2× |
| 1,000 snapshots with 10,000 live resources | 56.16 ms | 1.84 ms | 30.6× |
| 10,000 instrumented encoder/pass creations and draws | 37.68 ms | 13.81 ms | 2.7× |

These are CPU/tool-overhead microbenchmarks using mock GPU objects, not measurements of application GPU performance. They isolate snapshot complexity, wrapper allocation, and CLI module loading. Results vary by runtime and machine. The benchmark requests disabled allocation history; the original implementation incorrectly interpreted zero as its default 500-entry history.

Reproduce the current measurements with `npm run benchmark`, or compare another checkout with `node scripts/benchmark.mjs --baseline /path/to/original/checkout`. Raw measurements are in `reports/optimization-benchmark.json` (local evidence).

## Changes

- Keep Playwright as an optional peer, so normal installs pull in no packages. Load it only for the compatibility runner or as a last resort to locate a managed Chromium; help, comparison, agent formatting and system-browser profiling work without it.
- Maintain GPU allocation totals incrementally; snapshots copy category totals instead of scanning all live resources. Use a bounded ring buffer for history and include detailed history once in the full report.
- Wrap shared WebGPU encoder/pass prototypes once, avoiding wrapper closures on every frame.
- Add `agent`, `run --agent`, `compare --agent`, and `--server` for concise output and reuse of a persistent Chrome process. Keep full evidence in the saved report.
- Validate sampling values, targets, readiness, viewport and browser settings consistently before work. Reject conflicting artifact paths and preserve filenames without a `.json` extension.
- Serialize calls inside `FastCDPHarness`, recover after rejected jobs, dispose page listeners, close failed targets, and clean up failed browser launches. Graceful close drains accepted jobs.
- Close leftover speculative sockets on temporary file-server shutdown. This fixed a real browser recovery test that previously waited around a minute after page cleanup; the complete scenario now finishes in about 4.4 seconds.
- Bound the HTTP queue and request body size, expose queue health, return explicit client errors, and support compact responses.
- Bound trace completion and stream size; close streams on failures and select the top trace events without sorting every event.
- Make expensive user-agent memory sampling opt-in. Existing heap counters and GPU allocation tracking remain available by default.
- Support DOMContentLoaded readiness correctly and add bounded `--wait-for-hook` readiness for asynchronous applications.
- Report benchmark exceptions, preserve independently observed percentiles when hooks supply partial statistics, correct the Student-t sample-variance calculation, preserve missing A/B sample positions, and check more measurement settings for compatibility.

## Validation

Before release reconciliation, all **132 tests passed**, with real-browser and localhost tests enabled, with zero skips:

```bash
GPU_PERF_BROWSER_TESTS=1 node --test --test-reporter=spec --test-concurrency=1 test/*.test.js
```

The suite covers allocation accounting, retained-history ordering, shared wrappers, CLI failures, input validation, CDP listener cleanup, timeouts, queue recovery, trace cleanup, asynchronous readiness, HTTP overload, and speculative-socket shutdown. See `reports/iteration-4/all-tests.txt` (local evidence).

Additional checks exercised the persistent service through the CLI, saved reports, the Playwright compatibility runner, and the WebGPU example with screenshot capture. `npm pack --dry-run --json` verified package contents.

## Further improvements: timing lifecycle and manual tracking

The second pass removed another scan from manual allocation tracking. In the same 10,000-resource / 1,000-snapshot CPU benchmark (seven repetitions), the median fell from **29.22 ms to 0.25 ms**, about **119×**. This is a snapshot microbenchmark, not an application FPS or GPU speed claim. Full data: `reports/iteration-2/benchmark.json` (local evidence).

WebGPU timers now validate query capacity, reserve their query pairs, reject overlapping reads, bound readback time, and expose `reset()` / `destroy()` lifecycle operations. Failure cleanup covers partial allocations, callback errors, mapping failures and destruction during readback. The simple helper avoids a queue-wide fence; both helpers read mapped bytes without copying the entire result buffer. A real Chrome fixture reuses simple and batched timers, checks validation error scopes, and confirms all tracked timer buffers are destroyed.

WebGL timers bound polling time and pending query count, work without animation-frame callbacks, and release queries on draw exceptions, context loss, disjoint timing, timeout, or destruction. Asynchronous draw callbacks are rejected because they cannot define a valid synchronous query interval.

Manual trackers now maintain running totals, use bounded history, return independent resource details, and avoid double-counting reattached objects. Partial upload ranges are measured consistently in manual and automatic trackers, and rectangular mip estimates retain the correct pixel dimensions.

The repository's optional Playwright packaging changes were preserved. Benchmark-only dependencies were installed inside the ignored baseline directory; the main installation remains dependency-free for system Chrome profiling.

## Comparison correctness and automation validity

Independent reports now use Welch intervals instead of treating unrelated captures as pairs. Explicit `--paired` captures and interleaved A/B rounds retain paired intervals. A confidence interval must exceed the allowed regression threshold, not just exclude zero. Every evaluated row labels whether it has statistical evidence or only a threshold check.

Budgets are validated before expensive A/B browser work. Missing budget metrics, lost candidate metrics, incomplete pairs, and invalid rounds produce exit `2`; absolute bounds also work for new candidate metrics. Malformed rules cannot silently disable a gate. The full report and compact output expose structured validity issues, while agent digests label invalid runs clearly. A failed hook still leaves a saved report for diagnosis. HTTP health counters include invalid captures.

Verification includes mathematical interval fixtures, shuffled independent observations, threshold-boundary cases, missing metrics, budget typos, and real Chrome runs with an intentionally failing benchmark hook. The CLI saved the failure evidence and returned `2`; A/B retained failed rounds instead of averaging them away.

## Persistent capture isolation and bounded observation

A five-capture reproduction showed local storage leaking between jobs: the page's visit counter returned `[1, 2, 3, 4, 5]`. Fresh contexts now return `[1, 1, 1, 1, 1]`; explicit shared mode preserves the original stateful behavior. Both modes clean up job pages and popups. Failed context cleanup stops subsequent jobs, and the HTTP service exposes the failure instead of claiming it is healthy. Session disposal immediately rejects pending commands and releases their timers.

The same local 40 ms capture diagnostic measured median job durations of 193 ms with isolated contexts and 154 ms with shared contexts (five captures each). This is an illustrative state-isolation tradeoff, not a GPU benchmark or controlled speedup claim. The old shared-default median was 173 ms, but frame observation also changed during this pass. Raw evidence: `reports/iteration-4/capture-before.json` (local evidence), `reports/iteration-4/capture-after.json` (local evidence).

An opening popup reproduced a stopped-animation-callback case that previously waited for the full 60-second capture timeout. Frame observation now finishes on its wall-clock deadline, cancels its outstanding animation callback, and reports absent frame metrics while retaining successful hook measurements. Frame settling is bounded too. The observation method is recorded for comparison compatibility; blocked JavaScript still relies on the overall timeout.

WebGPU capability serialization now reads inherited WebIDL attributes: the local GPU report changed from empty objects to adapter information and 36 limits. Selecting an API skips unrelated capability probes, and temporary WebGL probe contexts are released before sampling. Unit and real-browser checks cover these results, missing animation callbacks, explicit WebGL 1/2 probing, cookies/local storage/Cache Storage isolation, and popup cleanup. An additional smoke check exercised the optional Playwright runner against the WebGPU example: valid capture, populated GPU capabilities, frame and GPU timings, and isolated context metadata. Evidence: `reports/iteration-4/playwright-webgpu.json` (local evidence). Package contents were verified with `npm pack --dry-run --json`.

## Fastest everyday workflow

```bash
node src/cli.js serve --port 9099 --auto-instrument
# In another terminal, run this after each edit:
node src/cli.js agent --server http://127.0.0.1:9099 \
  --url http://127.0.0.1:5173 --out reports/candidate.json
```

Use `--wait-for-hook` if the project exposes its benchmark asynchronously. Keep baseline and candidate sampling settings identical. See [README.md](README.md) for the complete workflow and limitations.
