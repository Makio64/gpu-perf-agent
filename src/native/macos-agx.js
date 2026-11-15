import { spawn } from "node:child_process";
import { median } from "../stats.js";

const MIB = 1024 * 1024;

/**
 * Parse `ioreg -r -c IOAccelerator -d 2` output into structured Apple AGX / GPU
 * telemetry without requiring root/sudo privileges.
 */
export function parseIoregAccelerator(stdout = "") {
  if (typeof stdout !== "string" || !stdout.trim()) {
    return { available: false, reason: "Empty ioreg output." };
  }

  const strMatch = (key) => {
    const re = new RegExp(`"${escapeRegExp(key)}"\\s*=\\s*"([^"]*)"`);
    const m = re.exec(stdout);
    return m ? m[1] : null;
  };
  const intMatch = (key) => {
    const re = new RegExp(`"${escapeRegExp(key)}"\\s*=\\s*(-?\\d+)`);
    const m = re.exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const dictMatch = (dictName) => {
    const re = new RegExp(`"${escapeRegExp(dictName)}"\\s*=\\s*\\{([^}]*)\\}`);
    const m = re.exec(stdout);
    if (!m) return null;
    const body = m[1];
    const entries = Object.create(null);
    const kv = /"([^"]+)"\s*=\s*(?:"([^"]*)"|(-?\d+))/g;
    let item;
    while ((item = kv.exec(body)) !== null) {
      entries[item[1]] = item[2] !== undefined ? item[2] : Number(item[3]);
    }
    return entries;
  };

  const perf = dictMatch("PerformanceStatistics");
  const cfg = dictMatch("GPUConfigurationVariable");
  const model = strMatch("model");
  const ioClass = strMatch("IOClass");
  const bundleId = strMatch("CFBundleIdentifier");
  const gpuCoreCount = intMatch("gpu-core-count");
  const maxPbBytes = intMatch("AGXParameterBufferMaxSize");

  if (!perf && !model && !ioClass) {
    return { available: false, reason: "No IOAccelerator / AGX entry found in ioreg output." };
  }

  const numOrNull = (val) => (typeof val === "number" && Number.isFinite(val) ? val : null);
  const inUseBytes = numOrNull(perf?.["In use system memory"]);
  const allocBytes = numOrNull(perf?.["Alloc system memory"]);
  const driverBytes = numOrNull(perf?.["In use system memory (driver)"]);
  const deviceUtil = numOrNull(perf?.["Device Utilization %"]);
  const rendererUtil = numOrNull(perf?.["Renderer Utilization %"]);
  const tilerUtil = numOrNull(perf?.["Tiler Utilization %"]);
  const tiledSceneBytes = numOrNull(perf?.["TiledSceneBytes"]);
  const allocPbBytes = numOrNull(perf?.["Allocated PB Size"]);
  const splitSceneCount = numOrNull(perf?.["SplitSceneCount"]);
  const recoveryCount = numOrNull(perf?.["recoveryCount"]);

  return {
    available: true,
    hardware: {
      model: model || null,
      ioClass: ioClass || null,
      bundleId: bundleId || null,
      gpuCoreCount,
      gpuGen: numOrNull(cfg?.gpu_gen),
      uscGen: numOrNull(cfg?.usc_gen),
      numGps: numOrNull(cfg?.num_gps),
      numFrags: numOrNull(cfg?.num_frags),
      numMgpus: numOrNull(cfg?.num_mgpus),
      variant: typeof cfg?.gpu_var === "string" ? cfg.gpu_var : null,
      maxParameterBufferBytes: maxPbBytes
    },
    telemetry: {
      deviceUtilizationPercent: deviceUtil,
      rendererUtilizationPercent: rendererUtil,
      tilerUtilizationPercent: tilerUtil,
      inUseSystemMemoryBytes: inUseBytes,
      inUseSystemMemoryMiB: inUseBytes != null ? round2(inUseBytes / MIB) : null,
      allocSystemMemoryBytes: allocBytes,
      allocSystemMemoryMiB: allocBytes != null ? round2(allocBytes / MIB) : null,
      inUseDriverMemoryBytes: driverBytes,
      tiledSceneBytes,
      tiledSceneKiB: tiledSceneBytes != null ? round2(tiledSceneBytes / 1024) : null,
      allocatedParameterBufferBytes: allocPbBytes,
      allocatedParameterBufferMiB: allocPbBytes != null ? round2(allocPbBytes / MIB) : null,
      splitSceneCount,
      recoveryCount
    }
  };
}

/**
 * Capture a single non-sudo Apple AGX / IOAccelerator snapshot (~10-20 ms).
 */
export async function snapshotMacOSAgx() {
  if (process.platform !== "darwin") {
    return { available: false, reason: "Apple AGX telemetry is only available on macOS (darwin)." };
  }
  const res = await captureCommand("ioreg", ["-r", "-c", "IOAccelerator", "-d", "2"]);
  if (!res.ok) {
    return { available: false, reason: (res.stderr || res.stdout || "ioreg failed").trim() };
  }
  return {
    capturedAt: new Date().toISOString(),
    ...parseIoregAccelerator(res.stdout)
  };
}

/**
 * Sample Apple AGX hardware counters over a time window to distinguish
 * Renderer (fragment/compute ALU + bandwidth) vs Tiler (vertex/binning) load,
 * OS-level unified GPU memory residency, and TBDR split-scene overflows.
 */
export async function sampleMacOSAgx(options = {}) {
  if (process.platform !== "darwin") {
    return { available: false, reason: "Apple AGX telemetry is only available on macOS (darwin)." };
  }
  const durationMs = Math.max(0, Math.min(60000, Number(options.durationMs ?? 1500)));
  const intervalMs = Math.max(50, Math.min(5000, Number(options.intervalMs ?? 200)));
  const samples = [];
  const start = Date.now();

  while (true) {
    const snap = await snapshotMacOSAgx();
    if (!snap.available) return snap;
    samples.push(snap);
    if (durationMs === 0 || Date.now() - start >= durationMs) break;
    await sleep(intervalMs);
  }

  return summarizeAgxSamples(samples);
}

export function summarizeAgxSamples(samples = []) {
  if (!Array.isArray(samples) || samples.length === 0 || !samples[0]?.available) {
    return { available: false, reason: "No valid AGX samples collected." };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const vals = (key) => samples.map((s) => s.telemetry?.[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
  const med = (arr) => (arr.length ? round2(median(arr)) : null);
  const max = (arr) => (arr.length ? round2(Math.max(...arr)) : null);

  const devArr = vals("deviceUtilizationPercent");
  const renArr = vals("rendererUtilizationPercent");
  const tilArr = vals("tilerUtilizationPercent");
  const memArr = vals("inUseSystemMemoryMiB");
  const allocArr = vals("allocSystemMemoryMiB");
  const tileKiBArr = vals("tiledSceneKiB");

  const renMed = med(renArr);
  const tilMed = med(tilArr);
  const devMed = med(devArr);

  let unitBalance = "unknown";
  if (devMed != null && devMed < 5 && (renMed ?? 0) < 5 && (tilMed ?? 0) < 5) {
    unitBalance = "idle";
  } else if (renMed != null && tilMed != null) {
    if (renMed >= tilMed * 1.5 && renMed >= 10) unitBalance = "renderer-dominant";
    else if (tilMed >= renMed * 1.5 && tilMed >= 10) unitBalance = "tiler-dominant";
    else unitBalance = "balanced";
  }

  const splitStart = first.telemetry?.splitSceneCount;
  const splitEnd = last.telemetry?.splitSceneCount;
  const splitSceneDelta = splitStart != null && splitEnd != null ? splitEnd - splitStart : null;

  const recStart = first.telemetry?.recoveryCount;
  const recEnd = last.telemetry?.recoveryCount;
  const recoveryDelta = recStart != null && recEnd != null ? recEnd - recStart : null;

  const memStart = first.telemetry?.inUseSystemMemoryMiB;
  const memEnd = last.telemetry?.inUseSystemMemoryMiB;
  const inUseMemoryDeltaMiB = memStart != null && memEnd != null ? round2(memEnd - memStart) : null;

  const hints = [];
  if (splitSceneDelta != null && splitSceneDelta > 0) {
    hints.push(`TBDR Parameter Buffer overflow (${splitSceneDelta} split scene(s)): geometry exceeded tile parameter buffer and forced mid-pass DRAM flushes. Cull off-screen draws, simplify dense meshes/LODs, or reduce draw/vertex count per pass.`);
  }
  if (recoveryDelta != null && recoveryDelta > 0) {
    hints.push(`GPU driver recovery detected (+${recoveryDelta}): a command buffer timed out or faulted.`);
  }
  if (unitBalance === "tiler-dominant") {
    hints.push("Tiler utilization exceeds Renderer by >=1.5x: workload is vertex/geometry/binning-heavy. Prioritize GPU/frustum culling, Mesh LODs, packed 16-bit vertex attributes, triangle count reduction, and avoiding redundant opaque depth pre-passes on Apple TBDR.");
  } else if (unitBalance === "renderer-dominant") {
    hints.push("Renderer utilization exceeds Tiler by >=1.5x: workload is fragment/compute ALU or bandwidth-heavy. Prioritize shader math/f16, ASTC/BC7 mipmapped textures, rg11b10ufloat targets, tile-memory loadOp='clear'/storeOp='discard', and half-res heavy effects.");
  }

  return {
    available: true,
    sampleCount: samples.length,
    hardware: first.hardware,
    summary: {
      unitBalance,
      deviceUtilizationPercent: { median: devMed, max: max(devArr) },
      rendererUtilizationPercent: { median: renMed, max: max(renArr) },
      tilerUtilizationPercent: { median: tilMed, max: max(tilArr) },
      inUseSystemMemoryMiB: { median: med(memArr), max: max(memArr), delta: inUseMemoryDeltaMiB },
      allocSystemMemoryMiB: { median: med(allocArr), max: max(allocArr) },
      tiledSceneKiB: { median: med(tileKiBArr), max: max(tileKiBArr) },
      splitSceneDelta,
      recoveryDelta
    },
    hints,
    latest: last.telemetry
  };
}

export function formatAgxDigest(report) {
  if (!report?.available) {
    return `AGX UNAVAILABLE — ${report?.reason || "unsupported platform"}`;
  }
  const hw = report.hardware || {};
  const s = report.summary || {};
  const lines = [
    `AGX ${hw.model || hw.ioClass || "Apple GPU"}${hw.gpuCoreCount ? ` (${hw.gpuCoreCount} cores${hw.gpuGen ? `, gen ${hw.gpuGen}` : ""})` : ""} — ${s.unitBalance} (${report.sampleCount} sample${report.sampleCount === 1 ? "" : "s"})`,
    `Utilization: Device p50 ${fmt(s.deviceUtilizationPercent?.median)}% (max ${fmt(s.deviceUtilizationPercent?.max)}%) | Renderer p50 ${fmt(s.rendererUtilizationPercent?.median)}% | Tiler p50 ${fmt(s.tilerUtilizationPercent?.median)}%`,
    `Unified GPU Memory: in-use p50 ${fmt(s.inUseSystemMemoryMiB?.median)} MiB (max ${fmt(s.inUseSystemMemoryMiB?.max)} MiB, Δ ${fmtSigned(s.inUseSystemMemoryMiB?.delta)} MiB) | alloc p50 ${fmt(s.allocSystemMemoryMiB?.median)} MiB`,
    `TBDR Tile Scene: p50 ${fmt(s.tiledSceneKiB?.median)} KiB (max ${fmt(s.tiledSceneKiB?.max)} KiB) | Split scenes Δ: ${s.splitSceneDelta ?? "n/a"} | GPU recoveries Δ: ${s.recoveryDelta ?? "n/a"}`
  ];
  if (report.hints?.length) {
    for (const hint of report.hints) lines.push(`Hint: ${hint}`);
  }
  return lines.join("\n");
}

function fmt(val) {
  return val == null ? "n/a" : String(val);
}

function fmtSigned(val) {
  if (val == null) return "n/a";
  return val > 0 ? `+${val}` : String(val);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      resolve({ code: null, ok: false, stderr: err.message, stdout });
    });
    child.on("close", (code) => {
      resolve({ code, ok: code === 0, stderr, stdout });
    });
  });
}
