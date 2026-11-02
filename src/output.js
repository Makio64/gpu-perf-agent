import path from "node:path";
import { reportValidity, pageErrorCounts } from "./validity.js";
import { comparisonStatus } from "./compare.js";

/** Round a number to `sig` significant digits (default 4) for bounded JSON output. */
function roundSig(value, sig = 4) {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return 0;
  return Number(value.toPrecision(sig));
}

function fmtSmart(value, maxDecimals = 2) {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 100) {
    const dec = Math.min(1, maxDecimals);
    const r = Math.round(value * 10 ** dec) / 10 ** dec;
    return r.toFixed(dec).replace(/\.0$/, "");
  }
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded.toFixed(maxDecimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

function fmtFixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function fmtSigned(value, digits = 2) {
  if (!Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${ fmtSmart(value, digits) }`;
}

function fmtCount(value) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : fmtSmart(value, 1);
}

function fmtHeap(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) < 0.005) return "0.00";
  return value.toFixed(2);
}

function cleanLine(value, max = 240) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function stripPeriod(value) {
  return cleanLine(value).replace(/\.$/, "");
}

function truncStr(value, max = 140) {
  if (value == null) return null;
  const s = String(value).replace(/[\r\n]+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function normFsPath(p) {
  return process.platform === "darwin" ? p.replace(/^\/private\/(var|tmp)\//, "/$1/") : p;
}

export function relPath(targetPath, cwd = process.cwd()) {
  if (!targetPath || typeof targetPath !== "string") return null;
  if (!path.isAbsolute(targetPath)) return targetPath;
  const rel = path.relative(normFsPath(cwd), normFsPath(targetPath));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : targetPath;
}

/** Describe the timing scope even when the general warning list is clipped. */
export function formatGpuTimingSignal(timing) {
  if (!timing) return null;
  if (timing.status === "single-scope") {
    return `GPU timing scope: ${cleanLine(timing.scope === "" ? "(root)" : timing.scope)}; ${fmtFixed(timing.validSampleCount, 0)}/${fmtFixed(timing.sampleCount, 0)} samples.`;
  }
  const reasons = Array.isArray(timing.reasons) ? timing.reasons.slice(0, 4).map( (r) => cleanLine(r) ).join(", ") : "";
  return `GPU timing scope: ${cleanLine(timing.status)}; aggregate GPU time unavailable${reasons ? ` (${reasons})` : ""}.`;
}

function formatPassLabel(pass) {
  const key = pass.key || pass.type || "pass";
  if (key.includes("@") || !pass.site) return key;
  const site = String(pass.site).trim();
  const match = /^(\S+)\s+(\S+)$/.exec(site);
  if (match) return `${key}@${match[1]}(${match[2]})`;
  return `${key}@${site}`;
}

function shortFindingText(finding) {
  if (!finding) return "";
  if (finding.code === "resource-churn" && Number.isFinite(finding.value)) {
    return `${finding.code}: ${fmtSmart(finding.value, 1)} createBuffer/f`;
  }
  if (finding.code === "bind-group-churn" && Number.isFinite(finding.value)) {
    return `${finding.code}: ${fmtSmart(finding.value, 1)} createBindGroup/f`;
  }
  if (finding.code === "startup-sync-pipelines" && Number.isFinite(finding.value)) {
    return `${finding.code}: ${finding.value} sync pipelines at startup`;
  }
  return `${finding.code}: ${truncStr(stripPeriod(finding.message), 56)}`;
}

function summarizePageErrors(report) {
  const events = report.diagnostics?.pageErrors || (report.pageEvents || []).filter(
    (e) => e?.type === "pageerror" || e?.type === "requestfailed" || e?.type === "httperror"
  );
  const items = [];
  for (const ev of events.slice(0, 2)) {
    if (ev.type === "httperror" || ev.status) {
      const urlPath = typeof ev.url === "string" ? ev.url.replace(/^https?:\/\/[^/]+/i, "") : "";
      items.push(`${ev.status || "HTTP"} ${urlPath || ev.message || ""}`.trim());
    } else if (ev.type === "requestfailed") {
      const urlPath = typeof ev.url === "string" ? ev.url.replace(/^https?:\/\/[^/]+/i, "") : "";
      items.push(`${ev.errorText || "failed"} ${urlPath}`.trim());
    } else {
      items.push(truncStr(cleanLine(ev.message || ev.text || "error"), 48));
    }
  }
  return items;
}

function formatCaptureAnomalies(timings) {
  if (!timings) return null;
  const anomalies = Array.isArray(timings.anomalies) ? timings.anomalies : [];
  const parts = [];
  const nav = anomalies.find((a) => a.code === "slow-navigation");
  const tls = anomalies.find((a) => a.code === "slow-tls");
  if (nav && tls) {
    parts.push(`slow navigation ${(nav.ms / 1000).toFixed(1)} s (TLS ${(tls.ms / 1000).toFixed(1)} s${tls.host ? ` on ${tls.host}` : ""}); keep Chrome warm (daemon/serve)`);
  } else if (nav) {
    parts.push(`slow navigation ${(nav.ms / 1000).toFixed(1)} s; keep Chrome warm (daemon/serve)`);
  } else if (tls) {
    parts.push(`slow TLS ${(tls.ms / 1000).toFixed(1)} s${tls.host ? ` on ${tls.host}` : ""}; keep Chrome warm (daemon/serve)`);
  }
  const lockWait = anomalies.find((a) => a.code === "lock-wait");
  if (lockWait) {
    parts.push(`lock wait ${(lockWait.ms / 1000).toFixed(1)} s`);
  }
  if (timings.networkIdle?.status === "budget-exceeded") {
    const waitS = ((timings.networkIdleWaitMs ?? 10000) / 1000).toFixed(1);
    const pending = timings.networkIdle.pendingAtSamplingStart ?? 1;
    parts.push(`network not idle after ${waitS} s (${pending} pending)`);
  }
  return parts.length ? `Capture: ${parts.join("; ")}` : null;
}

/**
 * §8.1 Capture digest (`agent` / `run` default stdout).
 * Hard ceiling: <= 160 tokens (~600 chars), <= 10 non-empty lines.
 */
export function formatAgentReport(report, { out, cwd = process.cwd() } = {}) {
  const s = report?.summary || {};
  const b = s.bottleneck || {};
  const gpu = s.gpu || {};
  const validity = report?.diagnostics?.validity || reportValidity(report || {});
  const valid = validity.valid !== false && s.verdict !== "invalid" && !report?.runError;
  const verdict = valid ? String(s.verdict || "unknown").toUpperCase() : "INVALID";
  const issues = Array.isArray(validity.issues) && validity.issues.length
    ? validity.issues
    : report?.runError
      ? [{ code: report.runError.code || "run-failed", message: report.runError.message || "run failed" }]
      : [];

  // Line 1: <VERDICT> — <reason>
  let reason;
  let topCause = null;
  if (!valid) {
    const first = issues[0];
    const noGpu = issues.find((issue, index) => index > 0 && issue.code === "no-gpu-work");
    reason = first ? `${first.code}: ${stripPeriod(first.message)}` : "capture is invalid";
    if (noGpu) reason += "; no GPU work during sampling";
  } else if (s.verdict === "excellent") {
    const hz = b.hz ?? b.refreshHz ?? s.cadence?.hz ?? 60;
    const vsync = b.class === "vsync-capped" || b.classification === "vsync-capped" || b.vsyncCapped;
    reason = s.verdictReasons?.[0]?.message
      ? stripPeriod(s.verdictReasons[0].message)
      : `no limiting cause${vsync ? `; vsync-capped at ${Math.round(hz)} Hz` : ""}`;
  } else if (s.verdict === "unknown") {
    const unobs = (validity.warnings || []).find((w) => w.code === "gpu-work-unobserved");
    const limited = (s.findings || []).find((f) => f.code === "limited-frame-signal" || f.code === "limited-signal");
    reason = s.verdictReasons?.[0]?.message
      ? stripPeriod(s.verdictReasons[0].message)
      : unobs
        ? "no main-thread GPU work observed"
        : limited
          ? stripPeriod(limited.message)
          : stripPeriod(b.reason || "insufficient frame or GPU signal");
  } else {
    topCause = (s.findings || []).find((f) => f.role === "cause") || s.findings?.[0] || null;
    const msg = s.verdictReasons?.[0]?.message || s.verdictReasons?.[0]?.cause || topCause?.message || b.reason || "performance threshold exceeded";
    reason = stripPeriod(msg);
  }

  const lines = [`${verdict} — ${reason}`];

  if (valid) {
    // Line 2: Bound: <class>[ (<subtype>)] <hz> Hz; GPU <x> ms (<share>% of <budget>), CPU <y> ms/frame → primary <metric>
    const bClass = b.class || b.classification || "unknown";
    const subtype = b.subtype ? ` (${b.subtype})` : "";
    const hz = Math.round(b.hz ?? b.refreshHz ?? s.cadence?.hz ?? 60);
    const budgetMs = b.budgetMs ?? (hz > 0 ? 1000 / hz : 16.67);
    // The classifier leaves bottleneck.gpuMs null when GPU timing is untrusted (unstable auto
    // GPU, between-run hook): the measured value then gets no budget share.
    const measuredGpuMs = gpu.frameMsP50 ?? s.gpuFrameMsMean;
    const gpuMs = Object.hasOwn(b, "gpuMs") ? b.gpuMs : measuredGpuMs;
    let gpuPart;
    if (b.gpuSaturated) {
      gpuPart = "GPU ≥ budget (saturated)";
    } else if (Number.isFinite(gpuMs)) {
      const sharePct = Number.isFinite(b.gpuShare) ? Math.round(b.gpuShare * 100) : Math.round((gpuMs / budgetMs) * 100);
      gpuPart = `GPU ${fmtSmart(gpuMs, 2)} ms (${sharePct}% of ${fmtSmart(budgetMs, 2)} ms)`;
    } else if (Number.isFinite(measuredGpuMs)) {
      gpuPart = `GPU ${fmtSmart(measuredGpuMs, 2)} ms (untrusted)`;
    } else {
      gpuPart = "GPU n/a";
    }
    const cpuMs = b.cpuMsPerFrame ?? s.cpuMsPerFrame;
    const cpuPart = Number.isFinite(cpuMs) ? `CPU ${fmtSmart(cpuMs, 2)} ms/frame` : "CPU n/a";
    const primary = b.primaryMetric || "frame.frameTimeMs.mean";
    lines.push(`Bound: ${bClass}${subtype} ${hz} Hz; ${gpuPart}, ${cpuPart} → primary ${primary}`);

    // Line 3: Frame <mean> ms p95 <p95> | GPU p50 <x> ms (<auto|hook warm|…>, <timed>/<workFrames> frames) | <passes> pass/f, <draws> draws/f | VRAM <MiB> MiB | heap <retained> MiB/s retained
    const framePart = `Frame ${fmtSmart(s.frameTimeMsMean, 2)} ms p95 ${fmtSmart(s.frameTimeMsP95, 2)}`;
    const gpuP50 = gpu.frameMsP50 ?? s.gpuFrameMsMean;
    let gpuLinePart;
    if (Number.isFinite(gpuP50)) {
      if (gpu.source === "auto" || (!gpu.source && gpu.timedFrames != null)) {
        const timed = gpu.timedFrames ?? report?.diagnostics?.signal?.autoGpu?.timedFrames ?? s.observedFrameCount ?? 0;
        const workFrames = report?.diagnostics?.signal?.autoGpu?.workFrames ?? s.observedFrameCount ?? timed;
        gpuLinePart = `GPU p50 ${fmtSmart(gpuP50, 2)} ms (auto, ${timed}/${workFrames} frames)`;
      } else {
        const prov = gpu.provenance ? `hook ${gpu.provenance}` : "hook";
        const timed = report?.diagnostics?.signal?.gpuTimingSamples ?? s.sampleCount ?? 0;
        const total = s.sampleCount ?? timed;
        gpuLinePart = `GPU p50 ${fmtSmart(gpuP50, 2)} ms (${prov}, ${timed}/${total} frames)`;
      }
    } else {
      gpuLinePart = "GPU n/a";
    }
    const pf = s.perFrame || {};
    const passesPerFrame = (Number.isFinite(pf.renderPasses) || Number.isFinite(pf.computePasses))
      ? (pf.renderPasses || 0) + (pf.computePasses || 0)
      : (s.webgpuOps?.renderPasses || 0) + (s.webgpuOps?.computePasses || 0);
    const passWord = passesPerFrame === 1 ? "pass/f" : "passes/f";
    const draws = s.drawCallsPerFrame ?? pf.drawCalls ?? 0;
    const vramPart = `VRAM ${Number.isFinite(s.trackedVram?.totalMiB) ? fmtSmart(s.trackedVram.totalMiB, 1) : "n/a"} MiB`;
    const retainedRate = s.heap?.retainedMiBPerSec ?? s.jsHeapGrowthMBPerSec;
    const heapPart = Number.isFinite(retainedRate)
      ? `heap ${fmtHeap(retainedRate)} MiB/s retained`
      : s.heap?.method === "hook-median" && Number.isFinite(s.heap?.retainedBytes)
        ? `heap ${fmtSmart(s.heap.retainedBytes / 1024, 1)} KiB/sample`
        : "heap n/a";
    lines.push(`${framePart} | ${gpuLinePart} | ${fmtCount(passesPerFrame)} ${passWord}, ${fmtCount(draws)} draws/f | ${vramPart} | ${heapPart}`);

    // Line 4 (when GPU passes present): Passes (excl p50): <key> <ms>[~] …
    if (Array.isArray(gpu.passes) && gpu.passes.length > 0) {
      const topPasses = gpu.passes.slice(0, 3).map((p) => {
        const ms = p.exclusiveMs ?? p.durationMs;
        return `${formatPassLabel(p)} ${fmtSmart(ms, 2)} ms${p.overlapped ? "~" : ""}`;
      });
      lines.push(`Passes (excl p50): ${topPasses.join("  ")}`);
    }

    // Line 5 (when CPU profile present): CPU: <top native/app> <ms>/f <- <caller file:line>; app JS <ms>; GC <ms>
    const cp = report?.cpuProfile;
    if (cp && Array.isArray(cp.top) && cp.top.length > 0) {
      const top = cp.top[0];
      const topLabel = top.kind === "native"
        ? `native ${top.fn}`
        : `${top.fn}${top.url ? ` ${top.url}${top.hotLine ?? top.line ? `:${top.hotLine ?? top.line}` : ""}` : ""}`;
      const caller = top.caller
        ? ` <- ${top.caller.fn ? `${top.caller.fn} ` : ""}${top.caller.url || "?"}${top.caller.line ? `:${top.caller.line}` : ""}`
        : "";
      const appJs = cp.msPerFrame?.appJs ?? 0;
      const gc = cp.msPerFrame?.gc ?? 0;
      lines.push(`CPU: ${topLabel} ${fmtSmart(top.selfMsPerFrame, 2)} ms/f${caller}; app JS ${fmtSmart(appJs, 2)} ms; GC ${fmtSmart(gc, 2)} ms`);
    }

    // Line 6 (when hitch present): Hitch: <ms> ms frame @ <fn file:line> | <no LoAF: <50 ms> | <no long main-thread work (GPU/compositor side)>
    if (Array.isArray(s.hitches) && s.hitches.length > 0) {
      const h = s.hitches[0];
      if (h.where) {
        lines.push(`Hitch: ${fmtSmart(h.durationMs, 1)} ms frame @ ${h.where}`);
      } else if (!h.loaf && h.durationMs < 50) {
        lines.push(`Hitch: ${fmtSmart(h.durationMs, 1)} ms frame (no LoAF: <50 ms)`);
      } else {
        lines.push(`Hitch: ${fmtSmart(h.durationMs, 1)} ms frame — no long main-thread work (GPU/compositor side)`);
      }
    }
  }

  // Line 7 (when capture anomaly): Capture: <anomaly summary>
  const captureLine = formatCaptureAnomalies(report?.timings);
  if (captureLine) lines.push(captureLine);

  // Line 8: Trust: <valid|invalid (N issues)>[; <warnings summary>][; GPU clock-sensitive: confirm GPU deltas with ab][; GPU contended (…)|GPU unstable within run][; instrumentation overhead]
  const trustParts = [];
  if (!valid) {
    const n = issues.length || 1;
    trustParts.push(`invalid (${n} ${n === 1 ? "issue" : "issues"})`);
    const pCount = pageErrorCounts(report || {}).total;
    if (pCount > 0) {
      const errSummaries = summarizePageErrors(report || {});
      trustParts.push(`${pCount} page/network ${pCount === 1 ? "error" : "errors"}${errSummaries.length ? ` (${errSummaries.join(", ")})` : ""}`);
    }
  } else {
    trustParts.push("valid");
    const otherFindings = (s.findings || []).filter((f) => f && f.code !== topCause?.code && f.role !== "info");
    if (otherFindings.length > 0) {
      const shown = otherFindings.slice(0, 2).map(shortFindingText);
      const count = otherFindings.length;
      trustParts.push(`${count} ${count === 1 ? "finding" : "findings"} (${shown.join(", ")})`);
    }
    const hasOverhead = (validity.warnings || []).some((w) => w.code === "instrumentation-overhead")
      || ((s.drawCallsPerFrame ?? 0) > 500 && report?.options?.autoInstrument !== false);
    if (hasOverhead) {
      trustParts.push("instrumentation overhead (use --no-auto-instrument)");
    }
    const stab = gpu.stability;
    if (gpu.source === "auto" && gpu.plausibility?.status === "contended") {
      trustParts.push("GPU contended (timestamps exceed the frame interval while frames are on time)");
    } else if (stab?.status === "unstable") {
      trustParts.push("GPU unstable within run");
    } else if (!hasOverhead && (stab?.clockSensitive || gpu.source === "auto")) {
      trustParts.push("GPU clock-sensitive: confirm GPU deltas with ab");
    }
  }
  lines.push(`Trust: ${trustParts.join("; ")}`);

  // Line 9: Next: <top finding.next or validity hint or default action>
  let nextText;
  if (!valid) {
    const pCount = pageErrorCounts(report || {}).total;
    if (issues.some((i) => i.code === "page-errors") || pCount > 0) {
      nextText = `Fix the ${pCount || issues.length} runtime/network errors first (inspect <report> --section errors).`;
    } else if (issues.some((i) => i.code === "no-gpu-work")) {
      nextText = "Ensure the page renders during sampling, increase --ready-timeout, or pass --allow-idle.";
    } else if (report?.runError?.hint) {
      nextText = cleanLine(report.runError.hint);
    } else {
      nextText = "Inspect report errors (inspect <report> --section errors).";
    }
  } else if (gpu.source === "auto" && gpu.plausibility?.status === "contended") {
    nextText = "Stop other GPU work (other browsers, profiling agents, leftover headless Chrome) and recapture; this GPU timing is not the page's cost.";
  } else if (s.verdict === "excellent") {
    nextText = "No action needed; use this report as a baseline (compare --base <report> or ab).";
  } else {
    const actionable = topCause || (s.findings || []).find((f) => f?.next);
    nextText = actionable?.next || s.recommendations?.[0]?.action || "Compare against a baseline with compare or ab.";
  }
  lines.push(`Next: ${cleanLine(nextText)}`);

  // Line 10 (when out): Report: <relpath>
  if (out) {
    lines.push(`Report: ${relPath(out, cwd)}`);
  }

  return lines.join("\n");
}

export function comparisonExitCode(result, { allowMismatch = false } = {}) {
  const cmp = result?.comparison && Array.isArray(result.comparison.rows) ? result.comparison : result;
  return comparisonStatus(cmp, { allowMismatch }).exitCode;
}

function shortenMetricKey(key) {
  if (!key) return "";
  return String(key)
    .replace(/^(frame|health|memory\.heap|memory\.trackedVram|memory|gpu)\./, "");
}

const OPTION_TO_FLAG = {
  autoInstrument: (v) => (v === false ? "--no-auto-instrument" : "--auto-instrument"),
  gpuTiming: (v) => (v === false ? "--no-gpu-timing" : ""),
  api: (v) => `--api ${v}`,
  samplingMode: (v) => `--sampling-mode ${v}`,
  viewport: (v) => `--viewport ${v.width && v.height ? `${v.width}x${v.height}` : v}`,
  deviceScaleFactor: (v) => `--device-scale-factor ${v}`,
  angle: (v) => `--angle ${v}`,
  headful: (v) => (v ? "--headful" : ""),
  hookName: (v) => `--hook-name ${v}`
};

function shellArg(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

// Reports record Chrome's whole launch argv as options.chromiumArgs. These entries are the
// runners' own (chromiumArgs() and launchChromeForCDP() in fast-cdp-runner.js, runner.js);
// the rest came from --chromium-arg.
const RUNNER_CHROMIUM_ARGS = new Set([
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--enable-precise-memory-info", "--enable-unsafe-webgpu", "--enable-dawn-features=allow_unsafe_apis",
  "--js-flags=--expose-gc", "--no-first-run", "--headless=new", "--remote-debugging-pipe", "about:blank"
]);
const RUNNER_CHROMIUM_ARG_PREFIXES = ["--user-data-dir=", "--window-size="];

function userChromiumArgs(args) {
  if (!Array.isArray(args)) return [];
  // --angle's --use-angle=<angle> is kept: ab has no --angle, so it reproduces the backend as a --chromium-arg.
  return args.filter((arg) => typeof arg === "string" && arg
    && !RUNNER_CHROMIUM_ARGS.has(arg) && !RUNNER_CHROMIUM_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix)));
}

/** The baseline's capture flags that change what `ab` measures (non-default values only). */
function copiedAbFlags(baseOptions = {}, cwd = process.cwd()) {
  if (!baseOptions || typeof baseOptions !== "object") return "";
  const flags = [];
  if (baseOptions.fileRoot) {
    const root = path.resolve(baseOptions.fileRoot) === path.resolve(cwd) ? "." : relPath(baseOptions.fileRoot, cwd);
    flags.push(`--file-root ${shellArg(root)}`);
  }
  if (baseOptions.autoInstrument === false) flags.push("--no-auto-instrument");
  if (baseOptions.gpuTiming === false) flags.push("--no-gpu-timing");
  if (baseOptions.api && baseOptions.api !== "auto") flags.push(`--api ${baseOptions.api}`);
  if (baseOptions.samplingMode === "hook") flags.push("--sampling-mode hook");
  if (baseOptions.hookName && baseOptions.hookName !== "__gpuReportBench") flags.push(`--hook-name ${shellArg(baseOptions.hookName)}`);
  if (baseOptions.waitForHook === true && baseOptions.samplingMode !== "hook") flags.push("--wait-for-hook");
  if (baseOptions.waitUntil && baseOptions.waitUntil !== "networkidle") flags.push(`--wait-until ${baseOptions.waitUntil}`);
  // Timeout defaults as normalizeOptions() sets them; an explicit --timeout also sets the condition timeout.
  const timeoutMs = Number(baseOptions.timeoutMs);
  const customTimeout = baseOptions.timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs !== 60000;
  if (baseOptions.waitCondition) {
    flags.push(`--wait-condition ${shellArg(baseOptions.waitCondition)}`);
    const conditionMs = Number(baseOptions.waitConditionTimeoutMs);
    if (baseOptions.waitConditionTimeoutMs != null && Number.isFinite(conditionMs) && conditionMs !== (customTimeout ? timeoutMs : 20000)) {
      flags.push(`--wait-condition-timeout ${conditionMs}`);
    }
  }
  const readyMs = Number(baseOptions.readyTimeoutMs);
  if (baseOptions.readyTimeoutMs != null && Number.isFinite(readyMs) && readyMs !== 3000) flags.push(`--ready-timeout ${readyMs}`);
  if (customTimeout) flags.push(`--timeout ${timeoutMs}`);
  const viewport = baseOptions.viewport?.width && baseOptions.viewport?.height
    ? `${baseOptions.viewport.width}x${baseOptions.viewport.height}` : baseOptions.viewport;
  if (typeof viewport === "string" && viewport !== "1280x720") flags.push(`--viewport ${viewport}`);
  const dpr = Number(baseOptions.deviceScaleFactor);
  if (baseOptions.deviceScaleFactor != null && Number.isFinite(dpr) && dpr !== 1) flags.push(`--device-scale-factor ${dpr}`);
  if (baseOptions.headful === true) flags.push("--headful");
  // `=` keeps parseArgs from reading a leading "--" value as another flag.
  for (const arg of userChromiumArgs(baseOptions.chromiumArgs)) flags.push(`--chromium-arg=${shellArg(arg)}`);
  return flags.length ? ` ${flags.join(" ")}` : "";
}

/** GPU stability as both sides' evidence states it, or null without GPU timing. */
function gpuTrustText(cmp, mode) {
  const sideEvidence = (side) => {
    const auto = cmp.gpuTiming?.auto?.[side];
    if (auto) return { status: auto.stability?.status ?? "unknown", clockSensitive: auto.clockSensitive ?? auto.stability?.clockSensitive, contended: auto.contended === true || auto.plausibility?.status === "contended" };
    const hook = cmp.gpuTiming?.[side];
    if (hook?.status === "single-scope") return { status: hook.stability?.status ?? "unknown", clockSensitive: hook.stability?.clockSensitive };
    return null;
  };
  const sides = [["base", sideEvidence("base")], ["cand", sideEvidence("candidate")]].filter(([, evidence]) => evidence);
  if (sides.length === 0) return null;
  const named = (list) => (list.length === 2 ? "both sides" : list.map(([name]) => name).join(""));
  const contended = sides.filter(([, evidence]) => evidence.contended);
  if (contended.length) return `GPU contended ${named(contended)}`;
  const unstable = sides.filter(([, evidence]) => evidence.status === "unstable");
  if (unstable.length) return `GPU unstable ${named(unstable)}`;
  // Paired rounds share one browser and alternate sides, which is what controls GPU clocks.
  const sensitive = mode === "paired" ? [] : sides.filter(([, evidence]) => evidence.clockSensitive === true);
  if (sensitive.length) return `GPU clock-sensitive ${named(sensitive)}`;
  const stable = sides.filter(([, evidence]) => evidence.status === "stable");
  if (stable.length === 2) return "GPU stable both sides";
  return `GPU ${sides.map(([name, evidence]) => `${name} ${evidence.status}`).join(", ")}`;
}

/**
 * §8.2 Comparison digest (`compare` / `ab` default stdout).
 * Hard ceiling: <= 140 tokens (~520 chars), <= 8 non-empty lines.
 */
export function formatAgentComparison(result, { out, cwd = process.cwd(), baseOptions, primaryMetric, allowMismatch = false } = {}) {
  const cmp = result?.comparison && Array.isArray(result.comparison.rows) ? result.comparison : result || {};
  const cs = comparisonStatus(cmp, { allowMismatch });
  const statusUpper = String(cs.status || cmp.status || "inconclusive").toUpperCase();
  const mode = cmp.mode || "separate";
  const rows = Array.isArray(cmp.rows) ? cmp.rows : [];
  const pRow = (primaryMetric ? rows.find((r) => r.key === primaryMetric) : null)
    || cmp.primary?.row
    || (cmp.primary?.key ? rows.find((r) => r.key === cmp.primary.key) : null)
    || rows[0]
    || null;
  const pKey = primaryMetric || cmp.primary?.key || pRow?.key || "frame.frameTimeMs.mean";
  const pSel = primaryMetric ? "explicit" : (cmp.primary?.selection || "default");

  const lines = [];

  // Line 1: <STATUS>[ (screen: <worse|better|same>)] — primary <key> <base> → <cand> <unit> (<±%>[, 95% CI <lo>..<hi> <unit>]; <paired|separate>[, <unverified reason / N rounds[, <row unverified reason / needs CI beyond ±<boundary> <unit>>] / warm>])[ (primary from base bottleneck)]
  const screenSuffix = cs.status === "unverified" && pRow?.screen ? ` (screen: ${pRow.screen})` : "";
  if (pRow && Number.isFinite(pRow.base) && Number.isFinite(pRow.candidate)) {
    const unit = pRow.unit ? ` ${pRow.unit}` : "";
    const pct = Number.isFinite(pRow.deltaPercent)
      ? `${pRow.deltaPercent >= 0 ? "+" : ""}${pRow.deltaPercent.toFixed(1)}%`
      : "n/a";
    const hasCi = Number.isFinite(pRow.confidence95?.low) && Number.isFinite(pRow.confidence95?.high);
    const ciPart = mode === "paired" && hasCi
      ? `, 95% CI ${fmtSigned(pRow.confidence95.low)}..${fmtSigned(pRow.confidence95.high)}${unit}`
      : "";
    let modeDetail = "";
    if (cs.status === "invalid") {
      // Say why the comparison is invalid (e.g. missing-metric), not an unrelated row reason.
      modeDetail = `, ${cs.reasons?.[0] || cmp.statusReasons?.[0] || "invalid evidence"}`;
    } else if (mode === "paired") {
      const rounds = pRow.baseStats?.count ?? pRow.candidateStats?.count ?? result?.rounds ?? null;
      if (rounds) modeDetail = `, ${rounds} rounds`;
      // Say why the paired CI did not decide: the gate that closed, or the boundary a
      // zero-excluding CI still has to clear (IMPROVED/REGRESSION need it beyond ±boundary).
      if (pRow.status === "unverified" && pRow.reasons?.[0]) {
        modeDetail += `, ${pRow.reasons[0]}`;
      } else if (pRow.status === "inconclusive" && hasCi && Number.isFinite(pRow.boundary)) {
        const { low, high } = pRow.confidence95;
        const excludesZero = low > 0 || high < 0;
        const clearsBoundary = low > pRow.boundary || high < -pRow.boundary;
        if (excludesZero && !clearsBoundary) modeDetail += `, needs CI beyond ±${fmtSmart(pRow.boundary, 2)}${unit}`;
      }
    } else if (pRow.status === "unverified" || cs.status === "unverified") {
      const reason = pRow.reasons?.[0] || cs.reasons?.[0] || "auto GPU is clock-sensitive across separate Chrome launches";
      modeDetail = `, ${reason}`;
    } else if (pRow.notes?.length) {
      modeDetail = `, ${pRow.notes[0]}`;
    }
    const selSuffix = pSel === "bottleneck"
      ? " (primary from base bottleneck)"
      : pSel === "default" || pSel === "fallback"
        ? " (default primary)"
        : "";
    lines.push(
      `${statusUpper}${screenSuffix} — primary ${pKey} ${fmtSmart(pRow.base, 2)} → ${fmtSmart(pRow.candidate, 2)}${unit} (${pct}${ciPart}; ${mode}${modeDetail})${selSuffix}`
    );
  } else {
    const reason = cs.reasons?.[0] || cmp.statusReasons?.[0] || "primary metric unavailable";
    lines.push(`${statusUpper}${screenSuffix} — primary ${pKey} (${reason})`);
  }

  // Line 2: Decision rows: <shortKey> <status>[ (<reason|screen <s>>)] | …
  const rank = { regression: 0, unverified: 1, inconclusive: 2, improved: 3, unchanged: 4, pass: 4 };
  const decisionCandidates = rows
    .filter((r) => (r.gated || r.budgeted) && r.key !== pKey)
    .sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5))
    .slice(0, 4);
  if (decisionCandidates.length > 0) {
    const formatted = decisionCandidates.map((r) => {
      const note = r.notes?.[0]
        ? ` (${r.notes[0]})`
        : r.status === "unverified" && r.screen
          ? ` (screen ${r.screen})`
          : (r.status === "regression" || r.status === "improved") && Number.isFinite(r.deltaPercent)
            ? ` (${r.deltaPercent >= 0 ? "+" : ""}${r.deltaPercent.toFixed(1)}%)`
            : "";
      return `${shortenMetricKey(r.key)} ${r.status}${note}`;
    });
    lines.push(`Decision rows: ${formatted.join(" | ")}`);
  }

  // Line 3 (when work ≠): Work: <diffs> — confirm identical output
  if (cmp.workEquivalence?.differences?.length > 0) {
    const diffs = cmp.workEquivalence.differences
      .slice(0, 3)
      .map((d) => `${shortenMetricKey(d.key)} ${fmtSmart(d.base, 1)} → ${fmtSmart(d.candidate, 1)}`)
      .join(", ");
    lines.push(`Work: ${diffs} — confirm identical output`);
  }

  // Line 4 (when compatibility ≠): Mismatch: <key> base <v> ≠ cand <v> → recapture with --<flag> <baseVal>, or use agent --base
  if (cmp.compatibility?.compatible === false && Array.isArray(cmp.compatibility.differences) && cmp.compatibility.differences.length > 0) {
    const diffs = cmp.compatibility.differences.slice(0, 3);
    const diffText = diffs.map((d) => `${d.key} base ${JSON.stringify(d.base)} ≠ cand ${JSON.stringify(d.candidate)}`).join(", ");
    const flags = diffs.map((d) => OPTION_TO_FLAG[d.key]?.(d.base)).filter(Boolean).join(" ");
    const fixHint = flags ? `recapture with ${flags}, or use agent --base` : "use agent --base or --allow-mismatch";
    lines.push(`Mismatch: ${diffText} → ${fixHint}`);
  }

  // Line 5: Trust: base <valid|invalid: code>, cand <valid|invalid: code>; GPU <stable|unstable|clock-sensitive> both sides[; baseline schemaVersion <n>: recapture]
  const baseValid = cmp.validity?.base ? cmp.validity.base.valid !== false : !cmp.validity?.issues?.some((i) => i.code === "invalid-base");
  const candValid = cmp.validity?.candidate ? cmp.validity.candidate.valid !== false : !cmp.validity?.issues?.some((i) => i.code === "invalid-candidate");
  const baseCode = cmp.validity?.base?.issues?.[0]?.code
    || cmp.validity?.issues?.find((i) => i.code === "invalid-base")?.issues?.[0]?.code
    || "invalid";
  const candCode = cmp.validity?.candidate?.issues?.[0]?.code
    || cmp.validity?.issues?.find((i) => i.code === "invalid-candidate")?.issues?.[0]?.code
    || "invalid";
  const trustItems = [
    `base ${baseValid ? "valid" : `invalid: ${baseCode}`}, cand ${candValid ? "valid" : `invalid: ${candCode}`}`
  ];
  // Comparison-level problems (missing budget metric, scope mismatch, ...) with both captures valid.
  const comparisonIssues = (cmp.validity?.issues || []).filter((i) => i.code !== "invalid-base" && i.code !== "invalid-candidate");
  if (comparisonIssues.length > 0) {
    const first = comparisonIssues[0];
    const more = comparisonIssues.length > 1 ? ` (+${comparisonIssues.length - 1} more)` : "";
    trustItems.push(`comparison invalid: ${first.code}${first.message ? ` (${truncStr(stripPeriod(first.message), 80)})` : ""}${more}`);
  }
  const gpuTrust = gpuTrustText(cmp, mode);
  if (gpuTrust) trustItems.push(gpuTrust);
  const schemaWarn = (cmp.compatibility?.warnings || []).find((w) => w.key === "schemaVersion");
  if (schemaWarn) {
    const side = schemaWarn.base <= schemaWarn.candidate ? "baseline" : "candidate";
    const ver = Math.min(schemaWarn.base, schemaWarn.candidate);
    trustItems.push(`${side} schemaVersion ${ver}: recapture`);
  }
  lines.push(`Trust: ${trustItems.join("; ")}`);

  // Line 6 (when informational rows changed): Not gated: <n> changed (<top 3 keys>)
  const infoChanged = rows.filter((r) => !r.gated && (r.status === "changed" || r.status === "regression" || r.status === "improved"));
  const changedCount = infoChanged.length || cmp.summary?.changed || 0;
  if (changedCount > 0) {
    const topKeys = infoChanged.slice(0, 3).map((r) => shortenMetricKey(r.key));
    const unnamed = changedCount - topKeys.length;
    if (unnamed > 0) topKeys.push(topKeys.length ? `+${unnamed} more` : "inspect --changed");
    lines.push(`Not gated: ${changedCount} changed (${topKeys.join(", ")})`);
  }

  // Line 7 (when separate & unverified/inconclusive): Next: confirm with ab --base-file <…> --candidate-file <…> --metric <primary>[ copied flags]
  if (mode === "separate" && (cs.status === "unverified" || cs.status === "inconclusive")) {
    // Same target on both sides (in-place edit): the baseline now lives in a copy only the caller knows.
    const sameTarget = cmp.baseFile ? cmp.baseFile === cmp.candidateFile : Boolean(cmp.baseUrl) && !cmp.candidateFile && cmp.baseUrl === cmp.candidateUrl;
    const baseTarget = sameTarget
      ? (cmp.baseFile ? "--base-file <baseline-copy.html>" : "--base-url <baseline-url>")
      : cmp.baseFile ? `--base-file ${shellArg(relPath(cmp.baseFile, cwd))}` : cmp.baseUrl ? `--base-url ${shellArg(cmp.baseUrl)}` : "--base-file <base>";
    const candTarget = cmp.candidateFile ? `--candidate-file ${shellArg(relPath(cmp.candidateFile, cwd))}` : cmp.candidateUrl ? `--candidate-url ${shellArg(cmp.candidateUrl)}` : "--candidate-file <cand>";
    lines.push(`Next: confirm with ab ${baseTarget} ${candTarget} --metric ${pKey}${copiedAbFlags(baseOptions, cwd)}`);
  }

  // Line 8 (when out): Saved: <relpath>
  if (out) {
    lines.push(`Saved: ${relPath(out, cwd)}`);
  }

  return lines.join("\n");
}

/**
 * §8.2 Combined `agent <target> --base base.json` digest.
 */
export function formatCaptureAndCompare(
  report,
  result,
  { out, comparisonOut, baseReportPath, overrides = [], cwd = process.cwd(), baseOptions, allowMismatch = false } = {}
) {
  const captureLines = formatAgentReport(report, { cwd })
    .split("\n")
    .filter((line) => !/^(Trust|Next|Report):/.test(line));
  const lines = [...captureLines];
  if (Array.isArray(overrides) && overrides.length > 0) {
    const text = overrides
      .map((o) => `${o.key}=${o.value}${o.flag ? ` (override with ${o.flag})` : ""}`)
      .join(", ");
    lines.push(`Matched baseline: ${text}`);
  }
  const baseRel = relPath(baseReportPath || result?.baseReportPath || "base.json", cwd);
  lines.push(`vs ${baseRel}:`);
  const cmpText = formatAgentComparison(result, {
    cwd,
    baseOptions: baseOptions || report?.options,
    allowMismatch
  });
  lines.push(cmpText);
  const saved = [out ? relPath(out, cwd) : null, comparisonOut ? relPath(comparisonOut, cwd) : null].filter(Boolean);
  if (saved.length > 0) {
    lines.push(`Saved: ${saved.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * §8.3 Bounded JSON output for `run --json` / `agent --json` (<= 1.6 KB).
 */
export function compactReport(report, out) {
  const s = report?.summary || {};
  const b = s.bottleneck || null;
  const validity = report?.diagnostics?.validity || reportValidity(report || {});
  const valid = validity.valid !== false && s.verdict !== "invalid" && !report?.runError;
  const exitCode = valid ? 0 : 2;
  const pf = s.perFrame || {};
  const passesPerFrame = (Number.isFinite(pf.renderPasses) || Number.isFinite(pf.computePasses))
    ? (pf.renderPasses || 0) + (pf.computePasses || 0)
    : (s.webgpuOps?.renderPasses || 0) + (s.webgpuOps?.computePasses || 0);
  const compactValidity = {
    valid,
    issues: (validity.issues || []).slice(0, 3).map((i) => ({ code: i.code, message: truncStr(i.message, 80) })),
    warnings: (validity.warnings || []).slice(0, 3).map((w) => ({ code: w.code, message: truncStr(w.message, 80) }))
  };
  const relOut = out ? relPath(out) : null;

  const topPasses = (s.gpu?.passes || []).slice(0, 3).map((p) => ({
    key: p.key,
    type: p.type ?? null,
    exclusiveMs: roundSig(p.exclusiveMs),
    share: roundSig(p.share),
    overlapped: Boolean(p.overlapped),
    site: p.site ?? null
  }));
  const reasonText = !valid
    ? (validity.issues?.[0]?.message ? truncStr(validity.issues[0].message, 80) : "invalid")
    : s.verdict === "excellent"
      ? "no limiting cause"
      : truncStr(s.verdictReasons?.[0]?.message || b?.reason || null, 80);
  const headline = {
    fps: roundSig(s.fps),
    pageFps: roundSig(s.pageFps ?? s.fps),
    frameTimeMsMean: roundSig(s.frameTimeMsMean),
    frameTimeMsP95: roundSig(s.frameTimeMsP95),
    gpuFrameMsP50: roundSig(s.gpu?.frameMsP50 ?? s.gpuFrameMsMean),
    gpuFrameMsP95: roundSig(s.gpu?.frameMsP95 ?? s.gpuFrameMsP95),
    gpuSource: s.gpu?.source ?? (Number.isFinite(s.gpuFrameMsMean) ? "hook" : null),
    gpuTimedFrames: s.gpu?.timedFrames ?? null,
    gpuStability: s.gpu?.stability?.status ?? null,
    gpuClockSensitive: Boolean(s.gpu?.stability?.clockSensitive),
    cpuMsPerFrame: roundSig(s.cpuMsPerFrame),
    passesPerFrame: roundSig(passesPerFrame),
    drawCallsPerFrame: roundSig(s.drawCallsPerFrame),
    trackedVramMiB: roundSig(s.trackedVram?.totalMiB),
    leakedResources: s.trackedVram?.leakedResources ?? 0,
    heapRetainedMiBPerSec: roundSig(s.heap?.retainedMiBPerSec ?? s.jsHeapGrowthMBPerSec),
    heapAllocKiBPerFrame: roundSig(s.heap?.allocKiBPerFrame),
    slowFrameCount: s.slowFrameCount ?? 0,
    slowFrameRate: roundSig(s.slowFrameRate),
    observedFrameCount: s.observedFrameCount ?? 0,
    sampleCount: s.sampleCount ?? 0
  };

  return {
    schemaVersion: report?.schemaVersion ?? 3,
    ok: valid,
    exitCode,
    reportPath: relOut,
    ...(out && out !== relOut ? { out } : {}),
    verdict: s.verdict ?? "unknown",
    reason: reasonText,
    verdictReasons: (s.verdictReasons || []).slice(0, 3).map((r) => ({
      code: r.code,
      severity: r.severity,
      message: truncStr(r.message || r.cause, 80)
    })),
    bottleneck: b ? {
      class: b.class ?? b.classification ?? "unknown",
      subtype: b.subtype ?? null,
      hz: roundSig(b.hz ?? b.refreshHz ?? 60),
      budgetMs: roundSig(b.budgetMs),
      gpuShare: roundSig(b.gpuShare),
      gpuSaturated: Boolean(b.gpuSaturated),
      mainThreadBusy: roundSig(b.mainThreadBusy),
      primaryMetric: b.primaryMetric ?? null,
      reason: truncStr(b.reason, 80)
    } : null,
    headline,
    topPasses,
    cpuHotspot: report?.cpuProfile?.top?.[0] ? {
      fn: report.cpuProfile.top[0].fn,
      kind: report.cpuProfile.top[0].kind,
      selfMsPerFrame: roundSig(report.cpuProfile.top[0].selfMsPerFrame),
      caller: report.cpuProfile.top[0].caller ?? null
    } : null,
    hitch: s.hitches?.[0] ? {
      durationMs: roundSig(s.hitches[0].durationMs),
      where: s.hitches[0].where ?? null,
      loaf: Boolean(s.hitches[0].loaf)
    } : null,
    findings: (s.findings || []).slice(0, 3).map((f) => ({
      code: f.code,
      role: f.role,
      severity: f.severity,
      value: roundSig(f.value),
      threshold: roundSig(f.threshold),
      unit: f.unit ?? null,
      message: truncStr(f.message, 60),
      next: truncStr(f.next, 60)
    })),
    findingsOmitted: Math.max(0, (s.findings || []).length - 3),
    validity: compactValidity,
    timings: report?.timings ? {
      totalMs: roundSig(report.timings.totalMs),
      samplingMs: roundSig(report.timings.samplingMs),
      anomalies: (report.timings.anomalies || []).slice(0, 3)
    } : null,
    artifacts: {
      screenshotPath: report?.artifacts?.screenshotPath ? relPath(report.artifacts.screenshotPath) : null,
      rawTracePath: report?.trace?.rawTracePath
        ? relPath(report.trace.rawTracePath)
        : report?.artifacts?.rawTracePath
          ? relPath(report.artifacts.rawTracePath)
          : null
    }
  };
}

/**
 * §8.3 Bounded JSON output for `compare --json` / `ab --json` (<= 2 KB).
 */
export function compactComparison(result, comparisonPath = null, { allowMismatch = false } = {}) {
  const cmp = result?.comparison && Array.isArray(result.comparison.rows) ? result.comparison : result || {};
  const cs = comparisonStatus(cmp, { allowMismatch });
  const pRow = cmp.primary?.row || null;
  const rows = Array.isArray(cmp.rows) ? cmp.rows : [];
  const decisionRows = rows
    .filter((r) => r.gated && r.key !== cmp.primary?.key)
    .slice(0, 6)
    .map((r) => ({
      key: r.key,
      base: roundSig(r.base),
      candidate: roundSig(r.candidate),
      deltaPercent: roundSig(r.deltaPercent),
      status: r.status,
      evidence: r.evidence ?? null,
      screen: r.screen ?? null,
      confidence95: r.confidence95 ? {
        low: roundSig(r.confidence95.low),
        high: roundSig(r.confidence95.high)
      } : null
    }));
  const infoChanged = rows.filter((r) => !r.gated && (r.status === "changed" || r.status === "regression" || r.status === "improved"));

  return {
    kind: "comparison",
    schemaVersion: cmp.schemaVersion ?? 2,
    ok: cs.exitCode === 0,
    status: cs.status,
    exitCode: cs.exitCode,
    statusReasons: cs.reasons || cmp.statusReasons || [],
    comparisonPath: comparisonPath ? relPath(comparisonPath) : (cmp.comparisonPath ? relPath(cmp.comparisonPath) : null),
    mode: cmp.mode || "separate",
    primary: cmp.primary ? {
      key: cmp.primary.key,
      selection: cmp.primary.selection,
      unit: pRow?.unit ?? null,
      direction: pRow?.direction ?? null,
      base: roundSig(pRow?.base),
      candidate: roundSig(pRow?.candidate),
      delta: roundSig(pRow?.delta),
      deltaPercent: roundSig(pRow?.deltaPercent),
      status: pRow?.status ?? null,
      gated: Boolean(pRow?.gated),
      evidence: pRow?.evidence ?? null,
      confidence95: pRow?.confidence95 ? {
        low: roundSig(pRow.confidence95.low),
        high: roundSig(pRow.confidence95.high),
        method: pRow.confidence95.method ?? null
      } : null,
      boundary: roundSig(pRow?.boundary),
      screen: pRow?.screen ?? null,
      reasons: (pRow?.reasons || []).slice(0, 3)
    } : null,
    decisionRows,
    failures: (cmp.failures || []).slice(0, 5).map((f) => ({
      key: f.key,
      status: f.status,
      deltaPercent: roundSig(f.deltaPercent)
    })),
    workEquivalence: cmp.workEquivalence ?? { status: "same", differences: [] },
    compatibility: {
      compatible: cmp.compatibility?.compatible ?? true,
      differences: (cmp.compatibility?.differences || []).slice(0, 5),
      warnings: (cmp.compatibility?.warnings || []).slice(0, 5)
    },
    validity: {
      valid: cmp.validity?.valid ?? true,
      issues: (cmp.validity?.issues || []).slice(0, 3).map((i) => ({ code: i.code, message: truncStr(i.message, 120) }))
    },
    informationalChangedCount: infoChanged.length || cmp.summary?.changed || 0,
    informationalChangedTop: infoChanged.slice(0, 3).map((r) => r.key),
    verdicts: cmp.verdicts ?? { base: null, candidate: null }
  };
}

function inferErrorCode(error, message) {
  if (error?.code && typeof error.code === "string" && !error.code.startsWith("ERR_")) return error.code;
  if (error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return "invalid-options";
  if (error?.code === "ENOENT" || /not found|ENOENT/i.test(message)) return "file-not-found";
  if (/unknown command|requires --url or --file|must be one of|must be a/i.test(message)) return "invalid-options";
  if (/navigation|ERR_CONNECTION/i.test(message)) return "navigation-failed";
  if (/timed? out/i.test(message)) return "capture-timeout";
  // Only launch wording: page errors that merely mention "browser" (or load src/browser/*) are not launch failures.
  if (/failed to launch|executable|chrome.*(not found|exited|failed)|browser.*(launch|not found|exited|closed unexpectedly)/i.test(message)) return "browser-launch-failed";
  return "command-failed";
}

function defaultErrorHint(code) {
  switch (code) {
    case "invalid-options":
      return "Run gpu-perf-agent <command> --help to see supported flags.";
    case "file-not-found":
      return "Check the file path and current working directory.";
    case "navigation-failed":
      return "Verify the target URL/server is reachable or pass --file for local HTML.";
    case "capture-timeout":
      return "Pass --wait-until load, increase --timeout, or check if the page hangs.";
    case "browser-launch-failed":
      return "Run gpu-perf-agent doctor --quick or pass --executable-path.";
    default:
      return "Re-run with GPU_PERF_DEBUG=1 for a stack trace.";
  }
}

export function normalizeCliError(error) {
  const message = String(error?.message ?? error ?? "Unknown error")
    .replace(/^(?:Error:\s*)+/i, "")
    .trim();
  // Page exception messages carry their stack ("    at fn (http://…/src/browser/x.js:1:2)"):
  // infer from the message lines only, never from frame URLs.
  const code = inferErrorCode(error, message.split("\n").filter((line) => !/^\s*at\s/.test(line)).join("\n"));
  const hint = error?.hint ? cleanLine(error.hint) : defaultErrorHint(code);
  return { code, message, hint };
}

/**
 * §6.5 & §7 L4a #5 Structured CLI error formatting.
 * Unwraps nested `Error: Error:`, prints `error[<code>]: <msg>\nhint: <hint>`,
 * and hides stack unless `GPU_PERF_DEBUG=1`.
 */
export function formatCliError(error, { reportPath, cwd = process.cwd(), debug = process.env.GPU_PERF_DEBUG === "1" } = {}) {
  const { code, message, hint } = normalizeCliError(error);
  const lines = [`error[${code}]: ${message}`];
  if (hint) lines.push(`hint: ${hint}`);
  if (reportPath) lines.push(`Report: ${relPath(reportPath, cwd)}`);
  if (debug && error?.stack) lines.push(String(error.stack));
  return lines.join("\n");
}
