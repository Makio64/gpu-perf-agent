# Efficient capture transports

Use the installed tool version throughout a measurement campaign. Inside its checkout,
replace `npx gpu-perf-agent` with `node src/cli.js` so local changes are actually tested.
Keep report names distinct and retain the original baseline.

## Persistent CLI

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

`npx gpu-perf-agent mcp` exposes profiling, comparison and saved-report inspection over stdio.
Read `tools/list` for the installed version's schema. Current source uses the same fixed
quick sampling as `agent`, saves measurements and retained diagnostics, and returns compact data with
an artifact path. It lazily reuses one Chrome process, serializes captures, and retains
isolated contexts. Request full output only when the raw evidence is needed. Older
releases use three adaptive 500 ms samples and return full reports; explicitly set
`samples`, `durationMs` and `adaptive: false` for comparisons on those versions.

Use the profile result's saved report path in `compare_webgpu_reports`. `includeReport:
true` requests the full inline capture. Comparisons save complete rows and confidence
intervals at `structuredContent.comparisonPath` and return at most five changed rows.
Inspect that file if the primary metric is omitted. Check `isError` and structured
validity/comparison status, not just whether the RPC succeeded. An invalid capture still
needs its diagnostic evidence; a successful comparison may be inconclusive.
Set comparison `primaryMetric` to keep the selected row visible even when it passes;
`not-measured` means absent evidence, not zero. All regression checks remain active.
Screenshots are saved artifacts and require separate visual inspection.

When `tools/list` includes `inspect_webgpu_report`, use it to read a saved artifact on
the MCP server without a new capture. Pass `reportPath`, a `section`, and optionally an
exact `metric` key for `section: 'metrics'`. The selected evidence is in
`structuredContent` and as JSON text for clients that only expose text content.
This also works when the server's artifact path is unavailable on your own machine.

## Select evidence without loading the whole report

Start with the bounded digest. If the installed CLI exposes `inspect`, retrieve the
specific evidence needed for the next decision:

```bash
npx gpu-perf-agent inspect --report reports/base.json --section metrics \
  --metric health.gpuFrameMs.mean
npx gpu-perf-agent inspect --report reports/base.json --section samples --offset 0 --limit 3
npx gpu-perf-agent inspect --report reports/ab.json --run 0 --section errors
```

Inspection returns bounded JSON with selection, totals, validity and omission metadata.
Sections are `overview`, `metrics`, `samples`, `errors`, `environment`, `instrumentation`
and `trace`. Use zero-based `--run` to select an A/B capture, `--offset` to page selected
records and `--limit` up to 10. Missing metrics differ from measured zero. Comparison
artifacts support metric rows, including confidence evidence. Inspection succeeds even
when the saved capture is invalid; inspect its validity separately. For comparisons,
also check `compatibility.compatible` and unverified metadata before trusting a selected
row; inspect `overview` or `environment` for mismatch details. Original evidence
stays in the saved file. The file is still parsed in full locally; bounded selection
reduces agent context, not file I/O. Use direct extraction when omitted detail is needed.
Saved comparison rows retain their original calculations; recompare raw captures with
the current tool before treating an older artifact as newly verified evidence.

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
