# Efficient capture transports

Use the installed tool version throughout a measurement campaign. Inside its checkout,
replace `npx gpu-perf-agent` with `node src/cli.js` so local changes are actually tested.
Keep report names distinct and retain the original baseline.

## Warm background daemon & Persistent CLI

By default, `agent` and `run` automatically start and reuse a background warm Chrome daemon (keyed by tool version, `src/*.js` mtime, and launch flags, with a 10-minute idle timeout). Pass `--no-daemon` or set `GPU_PERF_AGENT_NO_DAEMON=1` to force an in-process run. You can also manage an explicit server:

```bash
npx gpu-perf-agent serve --port 9099 --auto-instrument
# Another shell; repeat for candidate builds with identical settings:
npx gpu-perf-agent agent --server http://127.0.0.1:9099 \
  --url http://127.0.0.1:5173 --api webgpu --out reports/base.json
```

The service reuses Chrome and serializes jobs with a bounded queue. Fresh browser
contexts isolate cookies, storage and page caches; browser-process caches and hardware
state persist. Use `--context shared` only for an intentionally stateful experiment.
Configure launch flags on `serve`, not its clients. `GET /health` reports pending,
completed and failed jobs; reuse an existing healthy service only when its launch
configuration matches. Stop only the service you started when finished.

`run --cdp 9222` attaches to a debug-enabled Chrome, creates profiling pages and leaves
the browser running after capture. Attach only when that browser is suitable for the
measurement; unrelated active GPU work introduces contention.

Use `--executable-path` or `CHROME_PATH` to select Chrome. `--runner playwright` is an
optional compatibility path requiring Playwright. `--file-root` is the module root,
not necessarily the HTML's directory. Paths for HTTP/MCP jobs belong to the service
machine. A remote artifact path is not automatically available on the agent's machine.

## MCP

`npx gpu-perf-agent mcp` exposes `profile_webgpu`, `compare_webgpu_reports`, `ab_compare_webgpu`, `inspect_webgpu_report`, and `doctor_webgpu` over stdio (protocol `2025-11-25`).
When configuring the MCP server in Claude Code, Cursor, or other clients on macOS, ensure `NODE_USE_SYSTEM_CA` is **unset** (`"env": { "NODE_USE_SYSTEM_CA": "" }`) so Node and Chrome do not stall on macOS keychain TLS checks:

```json
{
  "mcpServers": {
    "gpu-perf-agent": {
      "command": "node",
      "args": ["/path/to/gpu-perf-agent/src/cli.js", "mcp", "--report-dir", "reports/mcp"],
      "env": { "NODE_USE_SYSTEM_CA": "" }
    }
  }
}
```

`profile_webgpu` supports one-call capture + compare via `baseReportPath` (inheriting baseline options), `screenshot: "none" | "file" | "inline"` (returning an inline 640px JPEG when `"inline"`), `cpuProfile`, `label`, and emits a `resource_link` content item pointing to the saved report JSON. `ab_compare_webgpu` runs interleaved ABBA rounds on the warm browser harness.

## Select evidence without loading the whole report

Start with the bounded digest. Retrieve specific evidence with `inspect`:

```bash
npx gpu-perf-agent inspect --report reports/base-1.json --section gpu
npx gpu-perf-agent inspect --report reports/base-1.json --section cpu
npx gpu-perf-agent inspect --report reports/base-1.json --section metrics \
  --metric health.autoGpuFrameMs.p50
npx gpu-perf-agent inspect --report reports/base-1.json --section samples --offset 0 --limit 3
npx gpu-perf-agent inspect --report reports/base-1.json --section samples --raw --offset 0
npx gpu-perf-agent inspect --report reports/cand-1.compare.json --section metrics --changed
```

Inspection returns bounded JSON with relative `reportPath`, slim stats (`{n, mean, p50, cv, ci95}`), and sections `overview`, `metrics`, `samples`, `errors`, `environment`, `instrumentation`, `trace`, `gpu` (per-pass GPU breakdown), and `cpu` (`cpuProfile` hotspots and caller attribution).

For older versions without inspection, extract relevant fields directly:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify({
  validity: r.diagnostics?.validity,
  signal: r.diagnostics?.signal,
  recommendations: r.summary?.recommendations?.slice(0, 3),
  options: r.options,
  browser: r.browser
}, null, 2));
' reports/base.json
```

For hook failures inspect `inPage.samples[*].error`, `pageEvents` and `pageEventSummary`.
Page events are bounded representatives; summary counts include dropped errors, and
`truncated` marks shortened event payloads. For timing inspect
the relevant `inPage.samples[*].measurement` fields; for tracked allocations inspect
`inPage.instrumentation`. Use `--trace` or `--minimal-trace` for a specific Chrome
diagnostic question, `--raw-trace` only when full trace events are needed. `--html` writes
an interactive report, and `--screenshot` a PNG. `--deep-memory` and forced GC alter cost
and timing. Keep diagnostic and confirmation capture settings compatible.
