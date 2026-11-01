# Capture transports, inspection and older releases

## Contents

- Warm daemon and `serve`
- MCP server
- Inspect saved reports
- Older releases

Use one tool version for a whole measurement campaign. Inside the tool's checkout, replace
`npx gpu-perf-agent` with `node src/cli.js` so local changes are what you test. Keep report
names distinct and keep the original baseline.

## Warm daemon and `serve`

`agent` and `run` (2.2+) start and reuse a background Chrome daemon automatically. A change
of tool version, source files or launch flags starts a new daemon; each one exits after 10
idle minutes. Use `--no-daemon` or `GPU_PERF_AGENT_NO_DAEMON=1` to run in-process. Any
failure on the daemon path is retried once in-process, so a failing or timed-out capture
can take about twice `--timeout`.

To share one browser explicitly across shells or machines:

```bash
npx gpu-perf-agent serve --port 9099 --auto-instrument
npx gpu-perf-agent agent --server http://127.0.0.1:9099 --url http://localhost:5173 \
  --samples 6 --duration-ms 250 --warmup 2 --out reports/base.json
```

`agent --server` forwards only the flags you type: the `agent` defaults, `--preset` and
options inherited through `--base` are not sent, and the service applies its own defaults
(5 x 1000 ms). Pass the sampling flags explicitly and identically for every capture, and do
not mix `--server` captures with daemon captures in one comparison. Configure launch flags
on `serve`, not on its clients.

The service serializes jobs and gives each a fresh browser context (cookies, storage and
page caches isolated; browser-process caches and hardware state persist). Use
`--context shared` only for an intentionally stateful experiment. `GET /health` reports
pending, completed and failed jobs. `serve` exits after 10 idle minutes
(`--idle-timeout-ms 0` disables that); stop one you started with
`curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:9099/close`.

`run --cdp 9222` attaches to a debug-enabled Chrome and leaves it running afterwards; any
other GPU work in that browser contends with the measurement. `--executable-path` or
`CHROME_PATH` selects Chrome; `--runner playwright` is an optional path that needs
Playwright. `--file-root` is the module root, not necessarily the HTML's folder. Paths in
HTTP and MCP jobs refer to the service machine.

## MCP server

`npx gpu-perf-agent mcp` (2.2+) serves five tools over stdio: `profile_webgpu`,
`compare_webgpu_reports`, `ab_compare_webgpu`, `inspect_webgpu_report` and
`doctor_webgpu`. Give `--report-dir` an absolute path to a dedicated folder: a relative one
resolves against the server's working directory, which each client chooses differently,
and the server prunes that folder at startup (keeps the 200 newest files, deletes files
older than 7 days), so never point it at the folder holding your baselines.

- Claude Code: `claude mcp add gpu-perf-agent -- npx -y gpu-perf-agent mcp --report-dir /abs/project/reports/mcp`
- Cursor (`~/.cursor/mcp.json`) and Antigravity (MCP config JSON):
  `{ "mcpServers": { "gpu-perf-agent": { "command": "npx", "args": ["-y", "gpu-perf-agent", "mcp", "--report-dir", "/abs/project/reports/mcp"] } } }`
- Codex (`~/.codex/config.toml`):
  `[mcp_servers.gpu-perf-agent]`, `command = "npx"`,
  `args = ["-y", "gpu-perf-agent", "mcp", "--report-dir", "/abs/project/reports/mcp"]`
- From a checkout, use `command: "node"` with `args: ["/abs/gpu-perf-agent/src/cli.js", "mcp", ...]`.

If startup stalls on macOS under Claude Code (which sets `NODE_USE_SYSTEM_CA=1`), add
`"env": { "NODE_USE_SYSTEM_CA": "" }` to the server entry.

`profile_webgpu` can capture and compare in one call via `baseReportPath` (inheriting the
same subset of options as `agent --base`), and accepts `screenshot: "none" | "file" | "inline"`,
`cpuProfile` and `label`. It returns a `resource_link` to the saved report JSON. Check
`isError` and the structured status/validity of every result, not only that the call
returned. `ab_compare_webgpu` cannot set readiness flags, hook mode, `--api`, viewport or
budgets (see measurement.md); use the CLI `ab` for those. If `doctor_webgpu` reports WebGPU
unavailable on a machine where captures work, trust CLI `doctor --json` instead: the MCP
probe runs on a page where `navigator.gpu` is not exposed.

## Inspect saved reports

Start with the digest, then pull specific evidence with `inspect` (2.2+):

```bash
npx gpu-perf-agent inspect --report reports/base.json --section gpu
npx gpu-perf-agent inspect --report reports/base.json --section cpu
npx gpu-perf-agent inspect --report reports/base.json --section metrics --metric health.autoGpuFrameMs.p50
npx gpu-perf-agent inspect --report reports/base.json --section samples --offset 0 --limit 3
npx gpu-perf-agent inspect --report reports/base.json --section samples --raw --offset 0
npx gpu-perf-agent inspect --report reports/cand.compare.json --section metrics --changed
```

Sections: `overview`, `metrics`, `samples`, `errors`, `environment`, `instrumentation`,
`trace`, `gpu` (per-pass GPU breakdown, with stats condensed to `{n, mean, p50, cv, ci95}`)
and `cpu` (CPU-profile hotspots and callers). Output is bounded JSON with a relative
`reportPath`. `--limit` is 1-10 (default 3); page with `--offset`. For `ab` reports select
a run with `--run <i>` (runs alternate base, candidate, candidate, base, ...); `samples`
needs a capture report or `--run`. `agent --base` saves its comparison next to the
candidate as `<candidate>.compare.json`.

`--trace` or `--minimal-trace` answer a specific Chrome-level question; `--raw-trace` keeps
every trace event. `--html` writes an interactive report and `--screenshot` a PNG.
`--deep-memory` and forced GC change cost and timing. Keep diagnostic and confirmation
capture settings compatible.

## Older releases

`npx gpu-perf-agent --version` failing with `Unknown command "--version"` means 2.0/2.1.x;
printing the help text means 1.x (npm `latest` may lag the skill, and projects often pin
an older version). These forms work on all versions (`ab` needs 2.0+):

```bash
npx gpu-perf-agent agent --url http://localhost:5173 --out reports/base.json
npx gpu-perf-agent agent --url http://localhost:5173 --out reports/cand.json
npx gpu-perf-agent agent --base reports/base.json --candidate reports/cand.json
npx gpu-perf-agent ab --base-url <baseline url> --candidate-url <candidate url> --auto-instrument --out reports/ab.json
```

Differences in 2.0/2.1.x: no `--label`, combined `agent --url ... --base`, `inspect`,
`--sampling-mode`, `--json-full`, `--no-daemon`, `--gpu-timing`, `--metric`, daemon or exit
code 3. The capture digest starts `GPU <VERDICT> | <fps> FPS | ...` with draws as
`draws/frame` on the `VRAM` line, and idle pages are not flagged, so check draws yourself.
Comparisons print no status word: `compare`/`agent --base` start with
`Compare: N regressions, M improvements, K inconclusive.` and `ab` prints a per-metric
table. Exit 1 means any metric row (including informational ones such as warmup duration
or heap sizes) moved past the threshold, or a CLI error: read stderr and the `regression`
rows before reverting.

There is no automatic GPU timing: `--auto-instrument` only counts resources, draws and
passes, so GPU time exists only when the page's hook returns `gpuMs`/`gpuTimeNs`. Time
passes in a hook with `createWebGPUTimer(device).measure((encoder, { beginRenderPass }) => ...)`
on a device created with `timestamp-query` (for example via `requestTimedWebGPUDevice`), or
judge by frame-time rows. Treat any GPU delta between separate captures as a hint. `ab`
cannot wait for readiness and reads only a hook named `__gpuReportBench` that exists once
the network is idle; for async apps, alternate repeated `agent --out` captures (base, cand,
cand, base) and report the result as screening. The MCP server has only `profile_webgpu`
and `compare_webgpu_reports`, saves no report file and defaults to 3 x 500 ms adaptive
samples: pass `samples`, `durationMs` and `adaptive: false` identically for every capture.

Read 2.1.x reports directly instead of `inspect`:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify({
  validity: r.diagnostics?.validity,
  signal: r.diagnostics?.signal,
  recommendations: r.summary?.recommendations?.slice(0, 3),
  options: r.options
}, null, 2));
' reports/base.json
```

On 2.1.x the GPU mean is `summary.gpuFrameMsMean` (compare key `health.gpuFrameMs.mean`)
and per-pass data is only in `inPage.samples[*].measurement`. For hook failures inspect
`inPage.samples[*].error` and `pageEvents` (2.1.x keeps every console, page-error and
failed-request event; 2.2+ keeps bounded examples plus `pageEventSummary` counts).
