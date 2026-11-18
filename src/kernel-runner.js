import { readFile } from "node:fs/promises";
import path from "node:path";
import { acquireMeasurementLock } from "./measure-lock.js";
import { invalidOption, numberOption } from "./options.js";
import { numericStats, pairedDifferenceStats } from "./stats.js";

const DEFAULT_STORAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_WORKGROUPS = Object.freeze([256, 1, 1]);

/**
 * Parse WGSL compute entry points, @group/@binding resources, and extensions.
 * Pure JS, zero external dependencies.
 */
export function parseWgslBindingsAndEntry(code = "") {
  const source = String(code || "");
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  const usesF16 = /\benable\s+f16\s*;/.test(stripped);
  const usesSubgroups = /\benable\s+subgroups\s*;/.test(stripped);

  const entryPoints = [];
  const entryRe = /@compute\s*(?:@workgroup_size\(\s*([^)]+)\)\s*)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = entryRe.exec(stripped)) !== null) {
    let workgroupSize = [1, 1, 1];
    if (m[1]) {
      const dims = m[1].split(",").map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (dims.length) workgroupSize = [dims[0] || 1, dims[1] || 1, dims[2] || 1];
    }
    entryPoints.push({ name: m[2], workgroupSize });
  }

  const bindings = [];
  const bindRe = /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var(?:<([^>]+)>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;=]+)\s*;/g;
  let b;
  while ((b = bindRe.exec(stripped)) !== null) {
    const group = Number(b[1]);
    const binding = Number(b[2]);
    const qualifier = (b[3] || "").replace(/\s+/g, "").toLowerCase();
    const name = b[4];
    const type = b[5].trim();
    const [space = "handle", access = "read"] = qualifier.split(",");
    const isF16 = /\bf16\b|\bvec[234]h\b|\bmat[234]x[234]h\b/.test(type);
    const isI32 = /\bi32\b|\bvec[234]i\b/.test(type);
    const isU32 = /\bu32\b|\bvec[234]u\b/.test(type);
    const scalar = isF16 ? "f16" : isI32 ? "i32" : isU32 ? "u32" : "f32";
    const kind = space === "uniform"
      ? "uniform"
      : space === "storage"
        ? (access === "read_write" ? "storage-rw" : "storage-ro")
        : "handle";
    bindings.push({ group, binding, name, type, space, access, kind, scalar });
  }

  bindings.sort((a, b2) => (a.group - b2.group) || (a.binding - b2.binding));
  return { entryPoints, bindings, usesF16, usesSubgroups };
}

/**
 * Parse `"X,Y,Z"`, `"X"`, or `[X, Y, Z]` into `[x, y, z]`.
 */
export function parseWorkgroups(input = DEFAULT_WORKGROUPS) {
  if (Array.isArray(input)) {
    const [x = 1, y = 1, z = 1] = input;
    return [
      numberOption(x, "workgroups[0]", { min: 1, max: 65535, integer: true }),
      numberOption(y, "workgroups[1]", { min: 1, max: 65535, integer: true }),
      numberOption(z, "workgroups[2]", { min: 1, max: 65535, integer: true })
    ];
  }
  if (typeof input === "number") {
    return [numberOption(input, "workgroups", { min: 1, max: 65535, integer: true }), 1, 1];
  }
  const parts = String(input).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) {
    throw invalidOption(`Invalid workgroups "${input}". Expected X or X,Y,Z.`);
  }
  const [x = "1", y = "1", z = "1"] = parts;
  return [
    numberOption(x, "workgroups.x", { min: 1, max: 65535, integer: true }),
    numberOption(y, "workgroups.y", { min: 1, max: 65535, integer: true }),
    numberOption(z, "workgroups.z", { min: 1, max: 65535, integer: true })
  ];
}

/**
 * Parse `"0:1=1048576"` buffer byte overrides into a `"group:binding" -> bytes` map.
 */
export function parseBufferOverrides(entries = []) {
  const overrides = {};
  const list = Array.isArray(entries) ? entries : [entries];
  for (const item of list) {
    if (item == null) continue;
    const m = /^(\d+):(\d+)=(\d+)$/.exec(String(item).trim());
    if (!m) throw invalidOption(`Invalid buffer override "${item}". Expected G:B=BYTES (for example 0:1=1048576).`);
    const bytes = numberOption(m[3], `buffers[${m[1]}:${m[2]}]`, { min: 16, max: 1024 * 1024 * 1024, integer: true });
    overrides[`${Number(m[1])}:${Number(m[2])}`] = align4(bytes);
  }
  return overrides;
}

function align4(n) {
  return Math.max(16, Math.ceil(n / 4) * 4);
}

/**
 * Decode IEEE-754 binary16 (uint16) to JS Number for f16 buffer comparisons.
 */
export function f16ToNumber(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const frac = bits & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 0x1f) return frac === 0 ? sign * Infinity : NaN;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Encode JS Number to IEEE-754 binary16 (uint16) for deterministic f16 seeding.
 */
export function numberToF16Bits(val) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    return sign | ((mant + 0x1000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >>> 13);
}

/**
 * Compare two readback Uint8Arrays representing a storage buffer with scalar type.
 */
export function compareOutputBuffers(baseBytes, candBytes, scalar = "f32", tolerance = 1e-5) {
  if (baseBytes.byteOffset % 4 !== 0) baseBytes = new Uint8Array(baseBytes);
  if (candBytes.byteOffset % 4 !== 0) candBytes = new Uint8Array(candBytes);
  const len = Math.min(baseBytes.byteLength, candBytes.byteLength);
  let exactBitMatch = baseBytes.byteLength === candBytes.byteLength;
  if (exactBitMatch) {
    for (let i = 0; i < len; i += 1) {
      if (baseBytes[i] !== candBytes[i]) {
        exactBitMatch = false;
        break;
      }
    }
  }
  if (exactBitMatch) {
    return { exactBitMatch: true, maxAbsDiff: 0, mismatchedElements: 0, totalElements: elementCount(len, scalar), ok: true };
  }

  let maxAbsDiff = 0;
  let mismatchedElements = 0;
  const totalElements = elementCount(len, scalar);

  if (scalar === "f16") {
    const a = new Uint16Array(baseBytes.buffer, baseBytes.byteOffset, totalElements);
    const b = new Uint16Array(candBytes.buffer, candBytes.byteOffset, totalElements);
    for (let i = 0; i < totalElements; i += 1) {
      const da = f16ToNumber(a[i]);
      const db = f16ToNumber(b[i]);
      const diff = Number.isNaN(da) && Number.isNaN(db) ? 0 : Math.abs(da - db);
      if (!Number.isFinite(diff) || diff > tolerance) mismatchedElements += 1;
      if (diff > maxAbsDiff || Number.isNaN(diff)) maxAbsDiff = Number.isNaN(diff) ? Infinity : diff;
    }
  } else if (scalar === "i32" || scalar === "u32") {
    const View = scalar === "i32" ? Int32Array : Uint32Array;
    const a = new View(baseBytes.buffer, baseBytes.byteOffset, totalElements);
    const b = new View(candBytes.buffer, candBytes.byteOffset, totalElements);
    for (let i = 0; i < totalElements; i += 1) {
      const diff = Math.abs(a[i] - b[i]);
      if (diff > tolerance) mismatchedElements += 1;
      if (diff > maxAbsDiff) maxAbsDiff = diff;
    }
  } else {
    const a = new Float32Array(baseBytes.buffer, baseBytes.byteOffset, totalElements);
    const b = new Float32Array(candBytes.buffer, candBytes.byteOffset, totalElements);
    for (let i = 0; i < totalElements; i += 1) {
      const diff = Number.isNaN(a[i]) && Number.isNaN(b[i]) ? 0 : Math.abs(a[i] - b[i]);
      if (!Number.isFinite(diff) || diff > tolerance) mismatchedElements += 1;
      if (diff > maxAbsDiff || Number.isNaN(diff)) maxAbsDiff = Number.isNaN(diff) ? Infinity : diff;
    }
  }

  return {
    exactBitMatch: false,
    maxAbsDiff: Number.isFinite(maxAbsDiff) ? maxAbsDiff : null,
    mismatchedElements,
    totalElements,
    ok: mismatchedElements === 0 && baseBytes.byteLength === candBytes.byteLength
  };
}

function elementCount(byteLength, scalar) {
  const bytesPer = scalar === "f16" ? 2 : 4;
  return Math.floor(byteLength / bytesPer);
}

/**
 * Deterministic PRNG seeded buffer generator shared identically by dawn-node & chrome runners.
 */
function generateSeedBytes(byteLength, scalar, bindingSeed) {
  const buf = new Uint8Array(byteLength);
  let state = (0x9e3779b9 ^ (bindingSeed * 0x85ebca6b)) >>> 0;
  const nextU32 = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  if (scalar === "f16") {
    const view = new Uint16Array(buf.buffer);
    for (let i = 0; i < view.length; i += 1) {
      const frac = (nextU32() & 0xffff) / 65536;
      view[i] = numberToF16Bits(0.125 + frac * 0.75);
    }
  } else if (scalar === "i32") {
    const view = new Int32Array(buf.buffer);
    for (let i = 0; i < view.length; i += 1) view[i] = (nextU32() % 1000) - 500;
  } else if (scalar === "u32") {
    const view = new Uint32Array(buf.buffer);
    for (let i = 0; i < view.length; i += 1) view[i] = nextU32() % 1024;
  } else {
    const view = new Float32Array(buf.buffer);
    for (let i = 0; i < view.length; i += 1) {
      view[i] = 0.125 + ((nextU32() & 0xffffff) / 16777216) * 0.75;
    }
  }
  return buf;
}

function isDawnNodeAvailable() {
  try {
    const pkgName = "webgpu";
    return Boolean(import.meta.resolve(pkgName));
  } catch {
    return false;
  }
}

async function resolveKernelSource(codeOpt, fileOpt, role) {
  if (codeOpt && fileOpt) throw invalidOption(`Specify either code or file for ${role}, not both.`);
  if (codeOpt) return { code: String(codeOpt), label: role, filePath: null };
  if (fileOpt) {
    const resolved = path.resolve(fileOpt);
    const code = await readFile(resolved, "utf8").catch(() => {
      throw Object.assign(new Error(`Shader file not found: ${resolved}`), { code: "file-not-found" });
    });
    return { code, label: path.basename(resolved), filePath: resolved };
  }
  return null;
}

function resolveBindingPlan(parsed, { storageBytes, bufferOverrides }) {
  const handles = parsed.bindings.filter((b) => b.space === "handle");
  if (handles.length > 0) {
    throw invalidOption(`Kernel uses unsupported texture/sampler bindings (${handles.map((h) => h.name).join(", ")}); kernel mode supports storage and uniform buffers.`);
  }
  return parsed.bindings.map((b, idx) => {
    const key = `${b.group}:${b.binding}`;
    const defaultSize = b.space === "uniform" ? 256 : storageBytes;
    const size = align4(bufferOverrides[key] ?? defaultSize);
    return {
      ...b,
      key,
      size,
      seedIndex: idx + 1
    };
  });
}

function selectEntryPoint(parsed, requested, label) {
  if (!parsed.entryPoints.length) {
    throw invalidOption(`No @compute fn found in ${label}.`);
  }
  if (requested) {
    const found = parsed.entryPoints.find((e) => e.name === requested);
    if (!found) throw invalidOption(`Compute entry point "${requested}" not found in ${label}.`);
    return found.name;
  }
  return parsed.entryPoints[0].name;
}

function resolveRunner(requested) {
  if (!["auto", "dawn-node", "chrome"].includes(requested)) {
    throw invalidOption('runner must be "auto", "dawn-node", or "chrome".');
  }
  if (requested === "dawn-node") {
    if (!isDawnNodeAvailable()) {
      throw Object.assign(
        new Error('Optional peer dependency "webgpu" is not installed; pass --runner chrome or install "webgpu".'),
        { code: "webgpu-unavailable", hint: "Run with --runner chrome or install the optional peer package `webgpu`." }
      );
    }
    return "dawn-node";
  }
  if (requested === "chrome") return "chrome";
  return isDawnNodeAvailable() ? "dawn-node" : "chrome";
}

function summarizeDurations(nsSamples, dispatchesPerPass) {
  const perDispatchMs = nsSamples.map((ns) => (ns / 1e6) / dispatchesPerPass);
  return {
    rounds: perDispatchMs.length,
    perDispatchMs,
    gpuMsPerDispatch: numericStats(perDispatchMs)
  };
}

function evaluateAbComparison(baseNs, candNs, { dispatchesPerPass, thresholdPercent, verification }) {
  const baseMs = baseNs.map((ns) => (ns / 1e6) / dispatchesPerPass);
  const candMs = candNs.map((ns) => (ns / 1e6) / dispatchesPerPass);
  const paired = pairedDifferenceStats(baseMs, candMs);
  const baseMean = paired.stats.mean !== undefined ? numericStats(baseMs).mean : 0;
  const candMean = numericStats(candMs).mean;
  const deltaMs = paired.stats.mean;
  const deltaPercent = baseMean !== 0 ? (deltaMs / baseMean) * 100 : 0;
  const boundary = Math.abs(baseMean) * (thresholdPercent / 100);
  const ci = paired.confidence95;

  let status = "inconclusive";
  if (verification && verification.ok === false) {
    status = "different-output";
  } else if (ci.high < -boundary) {
    status = "improved";
  } else if (ci.low > boundary) {
    status = "regression";
  } else if (ci.low >= -boundary && ci.high <= boundary) {
    status = "unchanged";
  }

  return {
    metric: "kernel.gpuMsPerDispatch",
    baseMeanMs: baseMean,
    candidateMeanMs: candMean,
    deltaMs,
    deltaPercent,
    confidence95: ci,
    thresholdPercent,
    boundaryMs: boundary,
    status
  };
}

/**
 * Core WebGPU execution body run either directly in Node (`dawn-node`) or inside
 * Chrome's `Runtime.evaluate` (`chrome` fallback). Must remain self-contained so it
 * can also be serialized into the browser.
 */
async function executeKernelWorkloadInWebGPU(payload) {
  const {
    variants, // [{ label, code, entryPoint, bindings: [{ group, binding, key, size, kind, scalar, seedHex }] }]
    workgroups,
    warmup,
    rounds,
    dispatches,
    verify,
    isAb,
    useTimestampQuantizationDisable = true
  } = payload;

  let gpu = globalThis.navigator?.gpu;
  let adapter;
  let device;
  let createdDawn = false;

  if (payload.mode === "dawn-node") {
    const pkgName = "webgpu";
    const mod = await import(pkgName);
    Object.assign(globalThis, mod.globals);
    const flags = ["enable-dawn-features=allow_unsafe_apis"];
    if (useTimestampQuantizationDisable) flags.push("disable-dawn-features=timestamp_quantization");
    gpu = mod.create(flags);
    createdDawn = true;
  }

  if (!gpu) {
    throw new Error("navigator.gpu is unavailable.");
  }

  adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("WebGPU adapter unavailable.");
  }
  if (!adapter.features.has("timestamp-query")) {
    throw new Error("WebGPU adapter does not support timestamp-query.");
  }

  const requiredFeatures = ["timestamp-query"];
  for (const feat of ["shader-f16", "subgroups", "subgroup-size-control"]) {
    if (adapter.features.has(feat) && variants.some((v) => v.usesF16 || v.usesSubgroups)) {
      requiredFeatures.push(feat);
    }
  }

  const adapterInfo = adapter.info || (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : {});
  device = await adapter.requestDevice({ requiredFeatures });

  const uncapturedErrors = [];
  device.addEventListener?.("uncapturederror", (e) => {
    uncapturedErrors.push(e?.error?.message || String(e));
  });

  const BufferUsage = globalThis.GPUBufferUsage;
  const MapMode = globalThis.GPUMapMode;

  try {
    const compiled = [];
    for (const v of variants) {
      const module = device.createShaderModule({ label: v.label, code: v.code });
      const info = await module.getCompilationInfo();
      const errs = (info?.messages || []).filter((m) => m.type === "error");
      if (errs.length > 0) {
        throw new Error(`Shader compilation failed in ${v.label}: line ${errs[0].lineNum}: ${errs[0].message}`);
      }
      const pipeline = await device.createComputePipelineAsync({
        label: v.label,
        layout: "auto",
        compute: { module, entryPoint: v.entryPoint }
      });

      const entriesByGroup = new Map();
      const seedBuffers = [];
      const workBuffers = [];

      for (const b of v.bindings) {
        const seedBytes = new Uint8Array(b.seedData);
        const seedBuf = device.createBuffer({
          size: b.size,
          usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST
        });
        device.queue.writeBuffer(seedBuf, 0, seedBytes);

        const usage = b.kind === "uniform"
          ? (BufferUsage.UNIFORM | BufferUsage.COPY_DST)
          : b.kind === "storage-rw"
            ? (BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC)
            : (BufferUsage.STORAGE | BufferUsage.COPY_DST);
        const workBuf = device.createBuffer({ size: b.size, usage });

        seedBuffers.push({ seedBuf, workBuf, size: b.size, binding: b });
        if (b.kind === "storage-rw") workBuffers.push({ buf: workBuf, binding: b });

        const list = entriesByGroup.get(b.group) || [];
        list.push({ binding: b.binding, resource: { buffer: workBuf } });
        entriesByGroup.set(b.group, list);
      }

      const bindGroups = [];
      for (const [group, entries] of [...entriesByGroup.entries()].sort((a, b) => a[0] - b[0])) {
        bindGroups.push({
          group,
          bindGroup: device.createBindGroup({
            layout: pipeline.getBindGroupLayout(group),
            entries
          })
        });
      }

      compiled.push({ ...v, pipeline, seedBuffers, workBuffers, bindGroups });
    }

    const resetBuffers = (encoder, variant) => {
      for (const pair of variant.seedBuffers) {
        encoder.copyBufferToBuffer(pair.seedBuf, 0, pair.workBuf, 0, pair.size);
      }
    };

    const encodeWork = (pass, variant) => {
      pass.setPipeline(variant.pipeline);
      for (const bg of variant.bindGroups) pass.setBindGroup(bg.group, bg.bindGroup);
      for (let d = 0; d < dispatches; d += 1) {
        pass.dispatchWorkgroups(workgroups[0], workgroups[1], workgroups[2]);
      }
    };

    // 1. Optional output readback verification (runs 1 pass per variant with identical seeded inputs)
    const readbacks = [];
    if (isAb && verify) {
      for (const v of compiled) {
        const enc = device.createCommandEncoder();
        resetBuffers(enc, v);
        const pass = enc.beginComputePass();
        encodeWork(pass, v);
        pass.end();

        const staging = v.workBuffers.map((wb) => {
          const readBuf = device.createBuffer({
            size: wb.binding.size,
            usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ
          });
          enc.copyBufferToBuffer(wb.buf, 0, readBuf, 0, wb.binding.size);
          return { readBuf, binding: wb.binding };
        });
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();

        const outputs = {};
        for (const st of staging) {
          await st.readBuf.mapAsync(MapMode.READ);
          const copy = new Uint8Array(st.readBuf.getMappedRange()).slice();
          st.readBuf.unmap();
          st.readBuf.destroy();
          outputs[st.binding.key] = { scalar: st.binding.scalar, bytes: copy };
        }
        readbacks.push(outputs);
      }
    }

    // 2. Warmup passes (untimed, keeps GPU clocks steady)
    if (warmup > 0) {
      const enc = device.createCommandEncoder();
      for (let w = 0; w < warmup; w += 1) {
        for (const v of compiled) {
          resetBuffers(enc, v);
          const pass = enc.beginComputePass();
          encodeWork(pass, v);
          pass.end();
        }
      }
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
    }

    // 3. Timed passes with hardware timestamp-query (ABBA interleaved when A/B)
    const schedule = [];
    if (isAb) {
      for (let r = 0; r < rounds; r += 1) {
        const seq = r % 2 === 0 ? [0, 1] : [1, 0];
        for (const idx of seq) schedule.push({ round: r, idx });
      }
    } else {
      for (let r = 0; r < rounds; r += 1) schedule.push({ round: r, idx: 0 });
    }

    const queryCount = schedule.length * 2;
    const querySet = device.createQuerySet({ type: "timestamp", count: queryCount });
    const resolveBuf = device.createBuffer({
      size: queryCount * 8,
      usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC
    });
    const mapBuf = device.createBuffer({
      size: queryCount * 8,
      usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ
    });

    for (let i = 0; i < schedule.length; i += 1) {
      const v = compiled[schedule[i].idx];
      const passEnc = device.createCommandEncoder();
      resetBuffers(passEnc, v);
      const pass = passEnc.beginComputePass({
        timestampWrites: {
          querySet,
          beginningOfPassWriteIndex: i * 2,
          endOfPassWriteIndex: i * 2 + 1
        }
      });
      encodeWork(pass, v);
      pass.end();
      device.queue.submit([passEnc.finish()]);
      // Serialize each timed pass so Apple Metal does not run disjoint base/candidate passes concurrently.
      await device.queue.onSubmittedWorkDone();
    }
    const resolveEnc = device.createCommandEncoder();
    resolveEnc.resolveQuerySet(querySet, 0, queryCount, resolveBuf, 0);
    resolveEnc.copyBufferToBuffer(resolveBuf, 0, mapBuf, 0, queryCount * 8);
    device.queue.submit([resolveEnc.finish()]);

    await mapBuf.mapAsync(MapMode.READ);
    const rawTimestamps = new BigInt64Array(mapBuf.getMappedRange());
    const nsByVariant = compiled.map(() => []);
    for (let i = 0; i < schedule.length; i += 1) {
      const delta = Number(rawTimestamps[i * 2 + 1] - rawTimestamps[i * 2]);
      if (!Number.isFinite(delta) || delta < 0) {
        throw new Error(`Invalid WebGPU timestamp delta (${delta}) at slot ${i}.`);
      }
      nsByVariant[schedule[i].idx].push(delta);
    }
    mapBuf.unmap();

    querySet.destroy();
    resolveBuf.destroy();
    mapBuf.destroy();
    for (const v of compiled) {
      for (const pair of v.seedBuffers) {
        pair.seedBuf.destroy();
        pair.workBuf.destroy();
      }
    }

    return {
      adapter: {
        vendor: adapterInfo?.vendor || "",
        architecture: adapterInfo?.architecture || "",
        device: adapterInfo?.device || "",
        description: adapterInfo?.description || ""
      },
      uncapturedErrors,
      nsByVariant,
      readbacks
    };
  } finally {
    if (createdDawn || device) {
      try { device?.destroy?.(); } catch {}
    }
  }
}

async function runKernelInChrome(payload, options = {}) {
  const { FastCDPHarness } = await import("./fast-cdp-runner.js");
  const { createFileTarget } = await import("./static-server.js");
  const { fileURLToPath } = await import("node:url");
  const doctorHtml = fileURLToPath(new URL("../examples/doctor.html", import.meta.url));
  const target = await createFileTarget(doctorHtml);

  const harness = await FastCDPHarness.launch({
    channel: options.channel,
    executablePath: options.executablePath,
    headful: Boolean(options.headful),
    chromiumArgs: [
      "--disable-dawn-features=timestamp_quantization",
      ...(options.chromiumArgs || [])
    ]
  });

  let browserContextId = null;
  let session = null;
  try {
    const bs = harness.browserSession;
    const ctx = await bs.send("Target.createBrowserContext", { disposeOnDetach: true });
    browserContextId = ctx.browserContextId;
    const { targetId } = await bs.send("Target.createTarget", { browserContextId, url: "about:blank" });
    const attached = await bs.send("Target.attachToTarget", { targetId, flatten: true });
    session = bs.session(attached.sessionId);
    await session.send("Page.enable");
    await session.send("Runtime.enable");

    const loadDone = new Promise((resolve) => {
      const off = session.once("Page.loadEventFired", () => resolve());
      setTimeout(() => { off(); resolve(); }, 5000);
    });
    await session.send("Page.navigate", { url: target.url });
    await loadDone;

    const fnExpr = `(async (payload) => {
      for (const v of payload.variants) {
        for (const b of v.bindings) {
          b.seedData = Uint8Array.from(atob(b.seedBase64), c => c.charCodeAt(0));
          delete b.seedBase64;
        }
      }
      const res = await (${executeKernelWorkloadInWebGPU.toString()})(payload);
      res.readbacks = (res.readbacks || []).map(map => {
        const out = {};
        for (const [k, v] of Object.entries(map)) {
          let bin = "";
          const bytes = v.bytes;
          for (let i = 0; i < bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
          }
          out[k] = { scalar: v.scalar, bytesBase64: btoa(bin) };
        }
        return out;
      });
      return res;
    })(${JSON.stringify({
      ...payload,
      mode: "chrome",
      variants: payload.variants.map(v => ({
        ...v,
        bindings: v.bindings.map(b => ({
          ...b,
          seedData: undefined,
          seedBase64: Buffer.from(b.seedData).toString("base64")
        }))
      }))
    })})`;
    const evalRes = await session.send("Runtime.evaluate", {
      expression: fnExpr,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000
    }, 65000);
    if (evalRes.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails?.exception?.description || evalRes.exceptionDetails?.text || "Chrome kernel execution failed.");
    }
    const raw = evalRes.result?.value;
    if (Array.isArray(raw?.readbacks)) {
      raw.readbacks = raw.readbacks.map(map => {
        const out = {};
        for (const [k, v] of Object.entries(map)) {
          out[k] = { scalar: v.scalar, bytes: Buffer.from(v.bytesBase64, "base64") };
        }
        return out;
      });
    }
    return raw;
  } finally {
    session?.dispose?.();
    if (browserContextId) await harness.browserSession.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    await harness.close().catch(() => {});
    await target.close().catch(() => {});
  }
}

/**
 * Benchmark one WGSL compute kernel or run an interleaved ABBA comparison between
 * `--base` and `--candidate` kernels using hardware `timestamp-query` + readback verification.
 */
export async function runKernelBenchmark(options = {}) {
  const startedAt = performance.now();
  const isAb = Boolean(options.base || options.baseCode || options.candidate || options.candidateCode);
  if (isAb && !(options.base || options.baseCode) && !(options.candidate || options.candidateCode)) {
    throw invalidOption("Provide both base and candidate for kernel A/B comparison.");
  }
  if (isAb && (!(options.base || options.baseCode) || !(options.candidate || options.candidateCode))) {
    throw invalidOption("Kernel A/B requires both --base and --candidate.");
  }
  if (!isAb && !options.file && !options.code) {
    throw invalidOption("Pass --file <kernel.wgsl> or --base <A.wgsl> --candidate <B.wgsl>.");
  }

  const runner = resolveRunner(options.runner || "auto");
  const workgroups = parseWorkgroups(options.workgroups ?? DEFAULT_WORKGROUPS);
  const storageBytes = align4(numberOption(options.storageBytes ?? DEFAULT_STORAGE_BYTES, "storageBytes", { min: 16, max: 1024 * 1024 * 1024, integer: true }));
  const bufferOverrides = parseBufferOverrides(options.buffers || []);
  const warmup = numberOption(options.warmup ?? 8, "warmup", { min: 0, max: 1000, integer: true });
  const rounds = numberOption(options.rounds ?? 16, "rounds", { min: isAb ? 2 : 1, max: 1000, integer: true });
  const dispatches = numberOption(options.dispatches ?? 4, "dispatches", { min: 1, max: 1000, integer: true });
  const thresholdPercent = numberOption(options.thresholdPercent ?? 5, "thresholdPercent", { min: 0, max: 1000 });
  const tolerance = numberOption(options.tolerance ?? 1e-5, "tolerance", { min: 0 });
  const verify = options.verify !== false;
  const measureLock = options.measureLock ?? process.env.GPU_PERF_AGENT_NO_LOCK !== "1";

  const variantsRaw = isAb
    ? [
      await resolveKernelSource(options.baseCode, options.base, "base"),
      await resolveKernelSource(options.candidateCode, options.candidate, "candidate")
    ]
    : [await resolveKernelSource(options.code, options.file, "kernel")];

  const preparedVariants = variantsRaw.map((src, idx) => {
    const parsed = parseWgslBindingsAndEntry(src.code);
    const requestedEntry = isAb
      ? (idx === 0 ? (options.baseEntry || options.entryPoint) : (options.candidateEntry || options.entryPoint))
      : options.entryPoint;
    const entryPoint = selectEntryPoint(parsed, requestedEntry, src.label);
    const plan = resolveBindingPlan(parsed, { storageBytes, bufferOverrides });
    const bindings = plan.map((b) => ({
      ...b,
      seedData: generateSeedBytes(b.size, b.scalar, b.seedIndex)
    }));
    return {
      label: src.label,
      filePath: src.filePath,
      code: src.code,
      entryPoint,
      usesF16: parsed.usesF16,
      usesSubgroups: parsed.usesSubgroups,
      bindings
    };
  });

  if (isAb) {
    const baseRwKeys = preparedVariants[0].bindings.filter((b) => b.kind === "storage-rw").map((b) => b.key);
    const candRwKeys = preparedVariants[1].bindings.filter((b) => b.kind === "storage-rw").map((b) => b.key);
    if (verify && (baseRwKeys.length === 0 || baseRwKeys.length !== candRwKeys.length)) {
      throw invalidOption(`Output buffer bindings differ between base (${baseRwKeys.join(",")}) and candidate (${candRwKeys.join(",")}); pass --no-verify to skip output check.`);
    }
  }

  let lock = null;
  let rawResult;
  try {
    if (measureLock) {
      lock = await acquireMeasurementLock({
        timeoutMs: Number(options.lockTimeoutMs ?? 30000),
        label: `kernel:${preparedVariants.map((v) => v.label).join(" vs ")}`
      });
    }

    const execPayload = {
      mode: runner,
      variants: preparedVariants,
      workgroups,
      warmup,
      rounds,
      dispatches,
      verify: isAb && verify,
      isAb
    };

    rawResult = runner === "dawn-node"
      ? await executeKernelWorkloadInWebGPU(execPayload)
      : await runKernelInChrome(execPayload, options);
  } finally {
    await lock?.release?.();
  }

  if (rawResult.uncapturedErrors?.length) {
    throw new Error(`WebGPU uncaptured error during kernel run: ${rawResult.uncapturedErrors[0]}`);
  }

  let verification = null;
  if (isAb && verify && rawResult.readbacks?.length === 2) {
    const [baseOut, candOut] = rawResult.readbacks;
    const baseKeys = Object.keys(baseOut);
    const candKeys = Object.keys(candOut);
    const bufferReports = [];
    let overallOk = baseKeys.length > 0 && baseKeys.length === candKeys.length;
    let maxAbsDiff = 0;
    let exactBitMatch = true;
    for (let i = 0; i < Math.min(baseKeys.length, candKeys.length); i += 1) {
      const bItem = baseOut[baseKeys[i]];
      const cItem = candOut[candKeys[i]];
      const cmp = compareOutputBuffers(
        bItem.bytes instanceof Uint8Array ? bItem.bytes : new Uint8Array(bItem.bytes),
        cItem.bytes instanceof Uint8Array ? cItem.bytes : new Uint8Array(cItem.bytes),
        cItem.scalar,
        tolerance
      );
      bufferReports.push({ binding: candKeys[i], scalar: cItem.scalar, ...cmp });
      if (!cmp.ok) overallOk = false;
      if (!cmp.exactBitMatch) exactBitMatch = false;
      if (cmp.maxAbsDiff == null || !Number.isFinite(cmp.maxAbsDiff)) maxAbsDiff = Infinity;
      else if (cmp.maxAbsDiff > maxAbsDiff) maxAbsDiff = cmp.maxAbsDiff;
    }
    verification = {
      ok: overallOk,
      exactBitMatch,
      maxAbsDiff: Number.isFinite(maxAbsDiff) ? maxAbsDiff : null,
      tolerance,
      buffers: bufferReports
    };
  }

  const wallMs = Math.round((performance.now() - startedAt) * 10) / 10;
  if (!isAb) {
    const summary = summarizeDurations(rawResult.nsByVariant[0], dispatches);
    return {
      ok: true,
      mode: "single",
      runner,
      adapter: rawResult.adapter,
      workgroups,
      dispatchesPerPass: dispatches,
      warmup,
      rounds,
      wallMs,
      variant: {
        label: preparedVariants[0].label,
        entryPoint: preparedVariants[0].entryPoint,
        bindings: preparedVariants[0].bindings.map((b) => ({ key: b.key, kind: b.kind, scalar: b.scalar, size: b.size }))
      },
      ...summary
    };
  }

  const baseSummary = summarizeDurations(rawResult.nsByVariant[0], dispatches);
  const candidateSummary = summarizeDurations(rawResult.nsByVariant[1], dispatches);
  const comparison = evaluateAbComparison(rawResult.nsByVariant[0], rawResult.nsByVariant[1], {
    dispatchesPerPass: dispatches,
    thresholdPercent,
    verification
  });

  return {
    ok: comparison.status !== "regression" && comparison.status !== "different-output",
    mode: "ab",
    runner,
    adapter: rawResult.adapter,
    workgroups,
    dispatchesPerPass: dispatches,
    warmup,
    rounds,
    wallMs,
    base: {
      label: preparedVariants[0].label,
      entryPoint: preparedVariants[0].entryPoint,
      ...baseSummary
    },
    candidate: {
      label: preparedVariants[1].label,
      entryPoint: preparedVariants[1].entryPoint,
      ...candidateSummary
    },
    verification,
    comparison
  };
}

function fmtMs(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

export function formatKernelDigest(result) {
  const adapterLabel = result.adapter?.description || result.adapter?.device || result.adapter?.architecture || "WebGPU";
  const wgLabel = Array.isArray(result.workgroups) ? result.workgroups.join("x") : "256x1x1";

  if (result.mode === "single") {
    const g = result.gpuMsPerDispatch;
    return [
      `KERNEL ${result.variant.label}:${result.variant.entryPoint} (${result.runner}, ${adapterLabel}, wg=${wgLabel}, wall=${result.wallMs} ms)`,
      `GPU/dispatch (${result.rounds}x${result.dispatchesPerPass}): mean ${fmtMs(g.mean)} ms | p50 ${fmtMs(g.p50)} ms | p95 ${fmtMs(g.p95)} ms`
    ].join("\n");
  }

  const cmp = result.comparison;
  const statusUpper = cmp.status.toUpperCase();
  const sign = cmp.deltaMs >= 0 ? "+" : "";
  const ci = cmp.confidence95;
  const verLine = result.verification
    ? (result.verification.ok
      ? `Output check: PASS (${result.verification.exactBitMatch ? "exact bit match" : `maxAbsDiff=${result.verification.maxAbsDiff} <= ${result.verification.tolerance}`})`
      : `Output check: FAIL (maxAbsDiff=${result.verification.maxAbsDiff ?? "NaN/Inf"}, buffers mismatched)`)
    : "Output check: skipped (--no-verify)";

  return [
    `${statusUpper} — ${result.base.label} -> ${result.candidate.label} (${result.runner}, ${adapterLabel}, wg=${wgLabel}, wall=${result.wallMs} ms)`,
    `GPU/dispatch: ${fmtMs(cmp.baseMeanMs)} -> ${fmtMs(cmp.candidateMeanMs)} ms (${sign}${cmp.deltaPercent.toFixed(1)}%, 95% CI [${fmtMs(ci.low)}, ${fmtMs(ci.high)}] ms, paired ${result.rounds} rounds x ${result.dispatchesPerPass} dispatches)`,
    verLine
  ].join("\n");
}
