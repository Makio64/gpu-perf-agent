# Changelog

## 2.1.0

- A shorter README leads with the value, a one-command capture, and a repeatable compare workflow. The full technical guide now lives in `docs/reference.md` and ships with the npm package.
- A redesigned, responsive website explains profiling, reports, comparisons, and agent integration with copyable commands and clearly labeled examples.
- The website builds with Node.js alone and publishes automatically to GitHub Pages. Its release label comes from the package version.
- Profiling behavior and defaults are unchanged from 2.0.0.

## 2.0.0

### Breaking changes

- Requires Node.js 22 or newer. The fast CDP runner uses Node's built-in WebSocket and has no required npm dependencies; Playwright is an optional peer.
- Persistent browser jobs use isolated contexts by default. Select `contextMode: "shared"` / `--context shared` for intentional state reuse.
- The `agent` CLI uses six 250 ms samples and two warmups, with fixed sampling and bounded output. `--adaptive` is explicit; MCP retains its existing adaptive defaults.
- Independent captures use Welch confidence intervals. Use `--paired` only for matched observations. Invalid or incompatible comparisons exit 2; regressions exit 1.
- Reports use schema version 2 with structured warning codes and explicit measurement validity. The root `analyzeReport` returns `{ summary, diagnostics }`; `finalizeReport` returns a new finalized report rather than mutating its input.

### Improvements

- Incremental allocation accounting and bounded history eliminate resource scans from lightweight snapshots. Tracking handles repeated wrapping and partial upload ranges.
- Reusable GPU timers have bounded reads, explicit reset/destroy lifecycle, and failure cleanup. WebGL timers release queries on timeouts, disjoint results, context loss, and draw failures.
- A/B runs reuse one browser and interleave captures. Comparison budgets validate early and reject missing metrics, failed rounds, and incomplete pairs.
- Persistent CDP sessions serialize jobs, clean up pages and popups, isolate storage, and stop after cleanup failures. The local service bounds its queue and request size.
- Frame sampling and settling have wall-clock bounds, including when background pages stop animation callbacks. Requested API probes avoid unrelated work and retain inherited WebGPU capability fields.
- Compact JSON, short agent digests, async readiness, optional deep-memory capture, and dependency-free startup improve developer and agent workflows.
- Existing MCP tools, detailed recommendations, pipeline counters, HTML reports, adaptive sampling, screenshots, and CDP attachment remain available. Attached browsers are left running after profiling.

Local timing and snapshot microbenchmarks are described in OPTIMIZATION.md; they are not application FPS or GPU speedup claims.
