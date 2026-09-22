# Tool efficiency improvements

Raw capture evidence referenced below is local and intentionally excluded from the public package. Reproduce the checks with the test and benchmark commands; release validation is recorded in the GitHub release notes.

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
