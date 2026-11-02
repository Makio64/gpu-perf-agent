---
name: gpu-perf-agent
description: Measures and optimizes WebGPU, WebGL and three.js performance in Chrome: low or dropping FPS, janky or stuttering frames, slow render or compute passes, slow WGSL/GLSL shaders, GPU memory leaks (VRAM, buffers, textures). Use to profile a 3D/GPU web page or localhost dev server, find and fix its bottleneck, or prove whether a code, shader or build change made it faster or regressed (A/B). Not for writing scenes or shaders with no performance goal, native GPU apps, or page-load/Lighthouse tuning.
---

# GPU performance optimization

Make the user's workload measurably faster without changing its output or quality.
Optimize the metric that matters for that workload: a healthy verdict, fewer warnings
or display-capped FPS do not prove a GPU speedup.

## Setup

- Needs Node 22+ and Chrome/Chromium. Run `npx gpu-perf-agent <command>` from the project
  being profiled. Inside the tool's own checkout use `node src/cli.js` instead. Keep one
  tool version per comparison.
- Check the version once: `npx gpu-perf-agent --version`. 2.2+ prints `gpu-perf-agent 2.2.x`
  or later. An error or the help text means an older release is installed, usually a project
  pin (it has no automatic GPU timing, and 1.x has no `ab`): run `npx gpu-perf-agent@latest`
  for the whole campaign instead. It does not modify the project, so leave any pin alone and
  mention it in the report. Only if 2.2+ cannot run, use the steps marked *(all versions)* and read "Older
  releases" in [transports.md](references/transports.md).
- Target the URL the app's dev server prints (usually `http://localhost:5173`). If none
  is running, start the project's dev script in the background and wait until the URL
  responds. A standalone HTML page can use `--file page.html --file-root .`; bundled
  apps (Vite, webpack, Next) must be profiled through their dev or preview URL.
- Reports go to `./reports/`. Pass explicit `--out` paths so later steps cannot pick up
  an older report.

## Workflow

Copy this checklist and keep it updated:

```
- [ ] 1. Valid baseline, app visibly rendering
- [ ] 2. Runnable copy of the baseline kept for A/B
- [ ] 3. Diagnosed from the digest; primary metric chosen (or: no bottleneck → step 7)
- [ ] 4. ONE focused change; output still correct
- [ ] 5. Screened against the baseline report
- [ ] 6. Confirmed with paired ab; kept or reverted
- [ ] 7. Stopped, reported, cleaned up
```

**1. Baseline** *(all versions, about 3-8 s)*

```bash
npx gpu-perf-agent agent --url http://localhost:5173 --out reports/base.json --screenshot-out reports/base.png
```

Add `--api webgpu|webgl2|webgl` when known. On 2.2+, `agent` turns on auto-instrumentation
and automatic per-pass GPU timing, takes 6 x 250 ms samples after 2 warmups, and reuses a
warm background Chrome. Trust the capture only if the first line is not `INVALID`,
`passes/f` or `draws/f` on the `Frame` line is non-zero (the profiler's own frame callbacks
keep running even when the app draws nothing), and the screenshot shows the intended
scene. A loader or intro animation draws too: wait for the real scene with
`--wait-condition` (for example the loader element gone plus the intro's duration).

Hold input, seed, camera, viewport, pixel ratio, quality and browser fixed for every
capture. When the user names a device or display, capture at its CSS viewport and pixel
ratio on every capture and `ab` (14-inch MacBook Pro: `--viewport 1512x982
--device-scale-factor 2`). The default 1280x720 at pixel ratio 1 can understate fill-rate
cost several-fold and hide a GPU bottleneck behind `EXCELLENT`.

**2. Keep a runnable baseline.** `ab` loads baseline and candidate side by side, so save
the unmodified version before editing. Single HTML file: `cp index.html index.base.html`.
Bundled app: `git worktree add ../perf-base HEAD` (copy the tree instead if the baseline
has uncommitted changes), install its dependencies and serve it on a second port in the
same mode as the candidate (dev vs dev, or preview vs preview). If no runnable baseline
is possible, say so in the report instead of claiming a GPU gain.

**3. Diagnose.** Read the digest (see "Reading the output").

- No cost bottleneck: `EXCELLENT` or `vsync-capped`, with GPU under about 50% of the frame
  budget and no `Hitch:` line. If `Bound:` shows `GPU <x> ms (untrusted)` without a %,
  divide by the budget yourself (16.7 ms at 60 Hz), unless `Trust:` says `contended`: then
  stop other GPU work and recapture first. Headless Chrome paces at 60 Hz, so at 50% or more
  a 120 Hz display (MacBook Pro, ProMotion) is likely to miss frames: treat the GPU as the
  limit and use `--metric health.autoGpuFrameMs.p50`. With no cost bottleneck, go to
  step 7 and report the headroom. If the user reported jank anyway,
  follow the jank item in Troubleshooting first. If they still want a change, make one,
  confirm it with `ab`, and report its absolute effect against the frame budget.
- Otherwise pick the primary metric. The `Bound:` line ends with `→ primary <metric>` and
  comparisons gate on it. Pass `--metric <key>` to the screen and to `ab` when your goal
  differs. On a vsync-capped page the default primary is CPU ms/frame, so for GPU-side
  changes (shaders, overdraw, resolution, MSAA) use `--metric health.autoGpuFrameMs.p50`.
  Other common keys are `health.cpuMsPerFrame`, `frame.frameTimeMs.p95` and
  `health.slowFrameRate`.

`Next:` and recommendations are hypotheses: read the implicated source before acting.
Fetch details with `inspect` (2.2+) instead of loading the whole report:
`npx gpu-perf-agent inspect --report reports/base.json --section gpu`.

| Observed | Next useful evidence |
| --- | --- |
| `gpu-bound`, high GPU p50 | `Passes (excl p50)` line, `inspect --section gpu`; separate arithmetic, bandwidth, overdraw and dispatch costs |
| `cpu-bound` / `submission-bound` | `CPU:` line, draws/f, `inspect --section cpu` |
| Slow frames, high p95, `Hitch:` line | Reproduce the spike; look at uploads, pipeline creation and GC |
| Growing allocations | Repeat the same load/unload cycle and check resources are released |

Read [measurement.md](references/measurement.md) for GPU timing hooks, which changes to try
for each kind of evidence, fixed-work compute, budgets and inconclusive results.

**4. Change one thing**, then verify output: compare screenshots (`--screenshot-out`), read
back results, or run the app's tests. Keep precision, sample counts and quality. If a gain
needs lower quality, present it as a tradeoff with numbers and keep it only if the user agrees.

**5. Screen** with exactly the baseline's flags *(all versions)*:

```bash
npx gpu-perf-agent agent --url http://localhost:5173 --out reports/cand.json
npx gpu-perf-agent agent --base reports/base.json --candidate reports/cand.json
```

2.2+ shortcut: `agent --url <url> --base reports/base.json --metric <step 3 metric> --out
reports/cand.json` captures and compares in one call. It reuses the baseline's sampling,
`--api`, viewport, pixel ratio, `--wait-until`/`--wait-condition`, sampling mode and
instrumentation; repeat every other flag yourself (`--metric`, `--wait-for-hook`,
`--timeout`, `--ready-timeout`, `--chromium-arg`, `--trace`, `--gc`, `--deep-memory`,
`--adaptive`, `--context`, `--headful`, `--slow-frame-threshold`). Without `--metric` the
screen gates on the baseline's `→ primary`. Its output starts with the capture digest; the
comparison status is the line after `vs <base>:`. On Apple GPUs a single baseline capture
can be a slow-clock outlier: if every candidate screens 30% or more better, go to `ab`.

**6. Confirm with paired A/B** *(roughly 2-8 s per round)*

```bash
npx gpu-perf-agent ab --base-url http://localhost:5174 --candidate-url http://localhost:5173 --out reports/ab.json
# Local HTML: ab --base-file index.base.html --candidate-file index.html --file-root .
```

`ab` alternates baseline and candidate inside one browser, which is what makes GPU-time
deltas trustworthy; separate captures can differ just because GPU clocks changed. Use at
least 4 rounds (the default) and the same readiness, `--api`, viewport, `--metric` and
`--sampling-mode` flags as the baseline. 2.2+ enables instrumentation and GPU timing in `ab`
by default. Before `ab`, stop other GPU work (other browsers, other profiling agents,
headless Chromes your own scripts started); on a busy machine add `--samples 3` so a round
is not a single 250 ms window. The `Next: confirm with ab ...` line printed after screening
copies the capture flags. After an in-place edit it prints `<baseline-url>` or
`<baseline-copy.html>` for the baseline: replace that with your baseline copy, and check
that it carries your `--metric`, `--chromium-arg` and timeout flags.

**7. Stop, report, clean up.** See the last section.

## Reading the output

Capture digest:

| Line | Meaning |
| --- | --- |
| `<VERDICT> — reason` | `INVALID` means fix the capture before anything else |
| `Bound:` | Limiting side and refresh rate, GPU ms and % of the frame budget, CPU ms/frame, `→ primary <metric>` |
| `Frame ... \| GPU p50 ... \| passes/f, draws/f \| VRAM \| heap` | Frame time and p95; GPU busy time per frame (overlapping passes counted once); work per frame; declared GPU allocations rounded to MiB (an estimate, not residency); JS heap growth |
| `Passes (excl p50):` | Most expensive passes, each with its own time and source location (WebGL2 shows one `gl-frame` pass). Before editing, confirm which code a pass belongs to, for example by turning the effect off with an app flag: 2.2.0 can label an unlabelled pass with the site of an earlier init-time pass |
| `CPU:` / `Hitch:` | Hottest function and its caller / worst slow frame |
| `Trust:` | Validity and GPU stability per side; `unstable` or `clock-sensitive` GPU means confirm GPU deltas with `ab`; `contended` GPU means the timestamps include other GPU work (see measurement.md). In comparisons, `base invalid: <code>`, `cand invalid: <code>` or `comparison invalid: <code>` says why the status is `INVALID` |
| `Next:` / `Report:` | Suggested step (a hypothesis) / saved report path |

Comparison output adds `Matched baseline:` (flags inherited from `--base`),
`Decision rows:` (secondary gated metrics; a `regression` there under an `UNVERIFIED` or
`INCONCLUSIVE` status is a reason to check in `ab`, not a verdict), `Work:` (draws,
dispatches or passes changed by more than 10%: verify output before keeping),
`Not gated:` (changed metrics that do not decide the status; list them with
`inspect --report <cand.compare.json> --section metrics --changed`) and `Saved:`. In `ab`
the paired confidence interval on the status line outranks the `Trust:` wording.
`IMPROVED` and `REGRESSION` need the whole interval beyond ±boundary (by default 5% of the
baseline), not just past zero: an interval that excludes zero but not the boundary is a
likely but small effect, so report it that way.

| Status | Exit | Do this |
| --- | --- | --- |
| `IMPROVED` | 0 | From `ab`: keep. From a separate screen: confirm with `ab` first |
| `UNCHANGED` / `INCONCLUSIVE` | 0 | No proven effect. Decide before looking further whether to run `ab --rounds 8` once more or revert, and report both runs. Per-round values: `inspect --report <ab.json> --section rounds` (2.3+) or `--run <i> --section gpu`. For tiny GPU loads use a warm timing hook |
| `UNVERIFIED (screen: better\|same\|worse)` | 0 | From a separate screen: these captures cannot prove this metric (GPU clock changes, light CPU load, vsync pinning, too few samples); confirm with `ab`. From `ab` (reason at the end of the status line in 2.3+, or the row's `reasons` in the ab JSON): `gpu-contended` (2.3+) means other GPU work inflated a side's timestamps; `gpu-saturated` means a side's GPU time sat near the frame interval in most rounds (in 2.2.0, any round, often from other GPU work); `vsync-pinned` means a frame-time primary, so pass `--metric`. Stop other GPU users, rerun, and meanwhile treat it as `INCONCLUSIVE`. Revert on `worse` unless the change was expected to help |
| `DIFFERENT-WORK` | 0 | The primary improved but new GPU errors appeared or the work collapsed (draws/dispatches near zero): check output; not a like-for-like speedup |
| `REGRESSION` | 1 | Revert or fix; also returned when a budget fails |
| `INVALID` / `MISMATCH` | 2 | Fix the capture. For MISMATCH recapture with the flags the `Mismatch:` line names; use `--allow-mismatch` only if the user accepts the difference, and say so |
| error | 3 | Follow the printed `hint:` line |

Older releases use a different output format and exit 1 for any metric row past the
threshold as well as for CLI errors; see "Older releases" in transports.md.

## Troubleshooting

- `INVALID — api-unavailable`: run `npx gpu-perf-agent doctor --json` (probes WebGPU and
  WebGL2; `--quick` only checks Node and Chrome), then retry with `--headful`,
  `--channel canary` or `--executable-path <chrome>`. Headless Linux/CI often has no GPU:
  report a software or fallback adapter instead of its numbers.
- `no-gpu-work`, or 0 passes and draws: the page is not rendering while sampled. Use
  `--wait-for-hook` if the app defines `globalThis.__gpuReportBench` (2.2+ gives up after
  `--wait-for-hook-timeout`, default 15 s), or
  `--wait-condition 'window.ready === true'` with a real readiness signal (it fails after
  `--wait-condition-timeout`: 20 s, or `--timeout` when given; `--ready-timeout` only
  bounds the wait for the first GPU work); add `--wait-until domcontentloaded` when the
  page keeps requests open.
- `capture-cleanup-failed`: rerun the same command once; if it repeats with `agent` or `run`, add `--no-daemon`.
- Page errors (`runtime-errors`, `critical-resource-failed`): `inspect --report <r> --section errors`.
- User reports jank but the capture is clean: headless Chrome paces at 60 Hz. Recapture
  with `--headful --preset confirm` to use the real display's refresh rate (shown on the
  `Bound:` line) and set `--slow-frame-threshold` to about 1.5 frame intervals (12 at 120 Hz)
  so single dropped frames count. If frames are still on time, the jank is not rendering
  cost: look for animation advanced per frame instead of by elapsed time (its speed changes
  with refresh rate), main-thread work outside the sampled window, or loads triggered by
  interaction, and report that instead of optimizing GPU time.
- Jank that needs interaction (camera moves, streaming assets): the profiler does not
  touch the page. Make the app drive the scenario (URL flag or scripted camera) and use
  `--preset confirm` (15 x 500 ms) so the window spans several hitches.
- Self-signed HTTPS dev server: `--chromium-arg=--ignore-certificate-errors`.

## Stop, report, clean up

Stop when the user's target is met in `ab`; when there is no cost bottleneck (step 3);
after about three candidates in a row fail to improve in `ab`; or when the next gain needs
a quality tradeoff (ask the user).

Report in this shape:

```
Diagnosis: <verdict, Bound line, key evidence; if no cost bottleneck, say so and name the likely cause>
Result: <status> on <metric>: <base> → <candidate> <unit> (<Δ%>, 95% CI <lo..hi>, ab <N> rounds; list earlier ab runs) — <absolute effect vs frame budget>
Kept: <changes and files>. Tried and reverted: <list>. Tradeoffs for you to decide: <change, gain, quality cost>
Output check: <how output equality was verified>
Evidence: <report and ab paths>. Reproduce: <exact ab command>
Limits: <browser, GPU, headless or headful, refresh rate, scenes not measured>
```

Stop dev servers, `serve` instances and baseline worktrees you started
(`git worktree remove ../perf-base`). The background Chrome daemon exits on its own after
10 idle minutes.

For repeated captures, the MCP server, `serve`, `inspect` queries and older releases, read
[transports.md](references/transports.md). `--trace`, `--deep-memory` and `--gc` add
overhead: use them for a specific question and keep them identical across compared captures.
