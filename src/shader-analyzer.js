import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SWIFT_METAL_PROBE_SOURCE = `
import Metal
import Foundation

struct EntryStat: Codable {
    let name: String
    let functionType: String
    let maxTotalThreadsPerThreadgroup: Int?
    let threadExecutionWidth: Int?
    let staticThreadgroupMemoryLength: Int?
    let nativeCodeBytes: Int?
    let vertexAttributeCount: Int?
    let error: String?
}

struct ProbeOutput: Codable {
    let ok: Bool
    let deviceName: String
    let architecture: String
    let apple9DynamicCaching: Bool
    let simdWidth: Int
    let maxThreadgroupMemoryBytes: Int
    let entries: [EntryStat]
    let compileError: String?
}

func vertexFormat(for dataType: MTLDataType) -> (MTLVertexFormat, Int) {
    switch dataType {
    case .float: return (.float, 4)
    case .float2: return (.float2, 8)
    case .float3: return (.float3, 16)
    case .float4: return (.float4, 16)
    case .half: return (.half, 2)
    case .half2: return (.half2, 4)
    case .half3: return (.half3, 8)
    case .half4: return (.half4, 8)
    case .int: return (.int, 4)
    case .int2: return (.int2, 8)
    case .int3: return (.int3, 12)
    case .int4: return (.int4, 16)
    case .uint: return (.uint, 4)
    case .uint2: return (.uint2, 8)
    case .uint3: return (.uint3, 12)
    case .uint4: return (.uint4, 16)
    default: return (.float4, 16)
    }
}

func extractNativeCodeBytes(archiveData: Data) -> Int? {
    let bytes = [UInt8](archiveData)
    guard bytes.count >= 64 else { return nil }
    func u32le(_ at: Int) -> UInt32 {
        return UInt32(bytes[at]) | (UInt32(bytes[at+1]) << 8) | (UInt32(bytes[at+2]) << 16) | (UInt32(bytes[at+3]) << 24)
    }
    func u64le(_ at: Int) -> UInt64 {
        return UInt64(u32le(at)) | (UInt64(u32le(at + 4)) << 32)
    }
    var totalText = 0
    var pos = 0
    while pos + 32 <= bytes.count {
        if u32le(pos) == 0xfeedfacf {
            let ncmds = Int(u32le(pos + 16))
            let sizeofcmds = Int(u32le(pos + 20))
            if ncmds > 0 && ncmds < 256 && pos + 32 + sizeofcmds <= bytes.count {
                var off = pos + 32
                var hasGpuStats = false
                var localText = 0
                for _ in 0..<ncmds {
                    guard off + 8 <= bytes.count else { break }
                    let cmd = u32le(off)
                    let cmdsize = Int(u32le(off + 4))
                    if cmd == 0x19 && off + 72 <= bytes.count {
                        let nsects = Int(u32le(off + 64))
                        var soff = off + 72
                        for _ in 0..<nsects {
                            guard soff + 80 <= bytes.count else { break }
                            let sect = String(bytes: bytes[soff..<(soff+16)].prefix { $0 != 0 }, encoding: .ascii) ?? ""
                            let seg = String(bytes: bytes[(soff+16)..<(soff+32)].prefix { $0 != 0 }, encoding: .ascii) ?? ""
                            let size = Int(u64le(soff + 40))
                            if seg == "__TEXT" && sect == "__text" {
                                localText += size
                            } else if seg.hasPrefix("__GPU_") {
                                hasGpuStats = true
                            }
                            soff += 80
                        }
                    }
                    if cmdsize <= 0 { break }
                    off += cmdsize
                }
                if hasGpuStats && localText > 0 {
                    totalText += localText
                }
            }
        }
        pos += 4
    }
    return totalText > 0 ? totalText : nil
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: metal-probe <shader.metal>\\n", stderr)
    exit(2)
}
let mslPath = args[1]
let mslSource = try String(contentsOfFile: mslPath, encoding: .utf8)

guard let device = MTLCreateSystemDefaultDevice() else {
    let out = ProbeOutput(ok: false, deviceName: "", architecture: "", apple9DynamicCaching: false, simdWidth: 32, maxThreadgroupMemoryBytes: 0, entries: [], compileError: "No Metal device available")
    print(String(data: try JSONEncoder().encode(out), encoding: .utf8)!)
    exit(0)
}

let opts = MTLCompileOptions()
opts.fastMathEnabled = true

do {
    let lib = try device.makeLibrary(source: mslSource, options: opts)
    var entries: [EntryStat] = []
    let tmpDir = FileManager.default.temporaryDirectory
    let vertexFns = lib.functionNames.compactMap { name -> MTLFunction? in
        guard let f = lib.makeFunction(name: name), f.functionType == .vertex else { return nil }
        return f
    }

    for name in lib.functionNames {
        guard let fn = lib.makeFunction(name: name) else { continue }
        switch fn.functionType {
        case .kernel:
            do {
                let desc = MTLComputePipelineDescriptor()
                desc.computeFunction = fn
                let pipe = try device.makeComputePipelineState(descriptor: desc, options: [], reflection: nil)
                var codeBytes: Int? = nil
                if let arch = try? device.makeBinaryArchive(descriptor: MTLBinaryArchiveDescriptor()) {
                    try? arch.addComputePipelineFunctions(descriptor: desc)
                    let url = tmpDir.appendingPathComponent("agx-\\(UUID().uuidString).metallib")
                    if (try? arch.serialize(to: url)) != nil, let data = try? Data(contentsOf: url) {
                        codeBytes = extractNativeCodeBytes(archiveData: data)
                    }
                    try? FileManager.default.removeItem(at: url)
                }
                entries.append(EntryStat(
                    name: name,
                    functionType: "compute",
                    maxTotalThreadsPerThreadgroup: pipe.maxTotalThreadsPerThreadgroup,
                    threadExecutionWidth: pipe.threadExecutionWidth,
                    staticThreadgroupMemoryLength: pipe.staticThreadgroupMemoryLength,
                    nativeCodeBytes: codeBytes,
                    vertexAttributeCount: nil,
                    error: nil
                ))
            } catch {
                entries.append(EntryStat(name: name, functionType: "compute", maxTotalThreadsPerThreadgroup: nil, threadExecutionWidth: nil, staticThreadgroupMemoryLength: nil, nativeCodeBytes: nil, vertexAttributeCount: nil, error: "\\(error)"))
            }
        case .vertex:
            do {
                let desc = MTLRenderPipelineDescriptor()
                desc.vertexFunction = fn
                desc.depthAttachmentPixelFormat = .depth32Float
                let vDesc = MTLVertexDescriptor()
                var offset = 0
                let activeAttrs = (fn.vertexAttributes ?? []).filter { $0.isActive }
                for attr in activeAttrs {
                    let (fmt, sz) = vertexFormat(for: attr.attributeType)
                    vDesc.attributes[attr.attributeIndex].format = fmt
                    vDesc.attributes[attr.attributeIndex].offset = offset
                    vDesc.attributes[attr.attributeIndex].bufferIndex = 30
                    offset += sz
                }
                if !activeAttrs.isEmpty {
                    vDesc.layouts[30].stride = max(16, ((offset + 15) / 16) * 16)
                    desc.vertexDescriptor = vDesc
                }
                let pipe: MTLRenderPipelineState
                if let p = try? device.makeRenderPipelineState(descriptor: desc) {
                    pipe = p
                } else {
                    desc.depthAttachmentPixelFormat = .invalid
                    desc.isRasterizationEnabled = false
                    pipe = try device.makeRenderPipelineState(descriptor: desc)
                }
                var codeBytes: Int? = nil
                if let arch = try? device.makeBinaryArchive(descriptor: MTLBinaryArchiveDescriptor()) {
                    try? arch.addRenderPipelineFunctions(descriptor: desc)
                    let url = tmpDir.appendingPathComponent("agx-\\(UUID().uuidString).metallib")
                    if (try? arch.serialize(to: url)) != nil, let data = try? Data(contentsOf: url) {
                        codeBytes = extractNativeCodeBytes(archiveData: data)
                    }
                    try? FileManager.default.removeItem(at: url)
                }
                entries.append(EntryStat(
                    name: name,
                    functionType: "vertex",
                    maxTotalThreadsPerThreadgroup: pipe.maxTotalThreadsPerThreadgroup > 0 ? pipe.maxTotalThreadsPerThreadgroup : nil,
                    threadExecutionWidth: nil,
                    staticThreadgroupMemoryLength: nil,
                    nativeCodeBytes: codeBytes,
                    vertexAttributeCount: activeAttrs.count,
                    error: nil
                ))
            } catch {
                entries.append(EntryStat(name: name, functionType: "vertex", maxTotalThreadsPerThreadgroup: nil, threadExecutionWidth: nil, staticThreadgroupMemoryLength: nil, nativeCodeBytes: nil, vertexAttributeCount: nil, error: "\\(error)"))
            }
        case .fragment:
            do {
                // Build a minimal dummy vertex shader if none is in the same library, or pair with first vertex fn
                let desc = MTLRenderPipelineDescriptor()
                let helperLib: MTLLibrary? = vertexFns.isEmpty ? (try? device.makeLibrary(source: "#include <metal_stdlib>\\nusing namespace metal;\\nvertex float4 __dummy_vs(uint vid [[vertex_id]]) { return float4(0.0); }", options: opts)) : nil
                if let vfn = vertexFns.first ?? helperLib?.makeFunction(name: "__dummy_vs") {
                    desc.vertexFunction = vfn
                    if let activeAttrs = vfn.vertexAttributes?.filter({ $0.isActive }), !activeAttrs.isEmpty {
                        let vDesc = MTLVertexDescriptor()
                        var offset = 0
                        for attr in activeAttrs {
                            let (fmt, sz) = vertexFormat(for: attr.attributeType)
                            vDesc.attributes[attr.attributeIndex].format = fmt
                            vDesc.attributes[attr.attributeIndex].offset = offset
                            vDesc.attributes[attr.attributeIndex].bufferIndex = 30
                            offset += sz
                        }
                        vDesc.layouts[30].stride = max(16, ((offset + 15) / 16) * 16)
                        desc.vertexDescriptor = vDesc
                    }
                }
                desc.fragmentFunction = fn
                for i in 0..<4 {
                    desc.colorAttachments[i].pixelFormat = .rgba16Float
                }
                let pipe = try device.makeRenderPipelineState(descriptor: desc)
                var codeBytes: Int? = nil
                if let arch = try? device.makeBinaryArchive(descriptor: MTLBinaryArchiveDescriptor()) {
                    try? arch.addRenderPipelineFunctions(descriptor: desc)
                    let url = tmpDir.appendingPathComponent("agx-\\(UUID().uuidString).metallib")
                    if (try? arch.serialize(to: url)) != nil, let data = try? Data(contentsOf: url) {
                        codeBytes = extractNativeCodeBytes(archiveData: data)
                    }
                    try? FileManager.default.removeItem(at: url)
                }
                entries.append(EntryStat(
                    name: name,
                    functionType: "fragment",
                    maxTotalThreadsPerThreadgroup: pipe.maxTotalThreadsPerThreadgroup > 0 ? pipe.maxTotalThreadsPerThreadgroup : nil,
                    threadExecutionWidth: nil,
                    staticThreadgroupMemoryLength: nil,
                    nativeCodeBytes: codeBytes,
                    vertexAttributeCount: nil,
                    error: nil
                ))
            } catch {
                entries.append(EntryStat(name: name, functionType: "fragment", maxTotalThreadsPerThreadgroup: nil, threadExecutionWidth: nil, staticThreadgroupMemoryLength: nil, nativeCodeBytes: nil, vertexAttributeCount: nil, error: "\\(error)"))
            }
        default:
            break
        }
    }
    let out = ProbeOutput(
        ok: true,
        deviceName: device.name,
        architecture: device.architecture.name,
        apple9DynamicCaching: device.supportsFamily(.apple9),
        simdWidth: 32,
        maxThreadgroupMemoryBytes: device.maxThreadgroupMemoryLength,
        entries: entries,
        compileError: nil
    )
    print(String(data: try JSONEncoder().encode(out), encoding: .utf8)!)
} catch {
    let out = ProbeOutput(
        ok: false,
        deviceName: device.name,
        architecture: device.architecture.name,
        apple9DynamicCaching: device.supportsFamily(.apple9),
        simdWidth: 32,
        maxThreadgroupMemoryBytes: device.maxThreadgroupMemoryLength,
        entries: [],
        compileError: "\\(error)"
    )
    print(String(data: try JSONEncoder().encode(out), encoding: .utf8)!)
}
`;

/**
 * Detect shader source language from file extension or code content.
 */
export function detectShaderLanguage(code = "", filePath = "") {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".wgsl") return "wgsl";
  if (ext === ".metal" || ext === ".msl") return "msl";
  if ([".glsl", ".vert", ".frag", ".comp"].includes(ext)) return "glsl";
  if (/#include\s*<metal_stdlib>|using\s+namespace\s+metal|\bmetal::/.test(code)) return "msl";
  if (/@compute|@fragment|@vertex|\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*\(|var<(?:uniform|storage|workgroup|private)>/.test(code)) return "wgsl";
  if (/#version\s+\d+|\bgl_Position\b|\bgl_FragColor\b/.test(code)) return "glsl";
  return "wgsl";
}

/**
 * Rewrite `naga`'s placeholder `[[user(fakeN)]]` resource attributes in MSL into valid
 * sequential `[[buffer(N)]]`, `[[texture(N)]]`, and `[[sampler(N)]]` attributes per
 * entry point so `xcrun metal` and `MTLDevice` can compile offline WGSL shaders directly.
 */
export function normalizeNagaMslBindings(msl = "") {
  if (typeof msl !== "string" || !msl.includes("[[user(fake")) return msl;

  return msl.replace(
    /\b(kernel|vertex|fragment)\s+([A-Za-z0-9_:<>]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*\{/g,
    (full, stage, retType, fnName, params) => {
      let bufIdx = 0;
      let texIdx = 0;
      let smpIdx = 0;
      const topLevelParams = splitTopLevelParams(params).map((param) => {
        if (!param.includes("[[user(fake")) return param;
        return param.replace(/\[\[user\(fake\d+\)\]\]/, () => {
          if (/\b(?:texture(?:1d|2d|3d|cube|buffer)\w*|depth(?:2d|cube)\w*)\b/.test(param)) {
            return `[[texture(${texIdx++})]]`;
          }
          if (/\bsampler\b/.test(param)) {
            return `[[sampler(${smpIdx++})]]`;
          }
          return `[[buffer(${bufIdx++})]]`;
        });
      });
      return `${stage} ${retType} ${fnName}(${topLevelParams.join(",")}) {`;
    }
  );
}

function splitTopLevelParams(params = "") {
  const parts = [];
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let start = 0;
  for (let i = 0; i < params.length; i += 1) {
    const ch = params[i];
    if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "(") paren += 1;
    else if (ch === ")" && paren > 0) paren -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]" && bracket > 0) bracket -= 1;
    else if (ch === "," && angle === 0 && paren === 0 && bracket === 0) {
      parts.push(params.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(params.slice(start));
  return parts;
}

/**
 * Fast, dependency-free static analysis of WGSL / MSL / GLSL source for Apple Silicon
 * and WebGPU hazards, precision opportunities, and structural counts.
 */
export function analyzeShaderStatic(code = "", options = {}) {
  const language = options.language || detectShaderLanguage(code, options.filePath);
  const stripped = stripComments(code);
  const lines = code ? code.split(/\r?\n/).length : 0;

  const entryPoints = [];
  if (language === "wgsl") {
    const wgslEntry = /@(vertex|fragment|compute)(?:\s+@workgroup_size\(\s*([^)]+)\))?[\s\S]*?\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = wgslEntry.exec(stripped)) !== null) {
      const stage = m[1];
      let workgroupSize = null;
      if (m[2]) {
        const dims = m[2].split(",").map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n > 0);
        if (dims.length) {
          const [x = 1, y = 1, z = 1] = dims;
          workgroupSize = [x, y, z];
        }
      }
      entryPoints.push({ name: m[3], stage, workgroupSize });
    }
  } else if (language === "msl") {
    const mslEntry = /\b(vertex|fragment|kernel)\s+[A-Za-z0-9_:<>]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let m;
    while ((m = mslEntry.exec(stripped)) !== null) {
      entryPoints.push({
        name: m[2],
        stage: m[1] === "kernel" ? "compute" : m[1],
        workgroupSize: null
      });
    }
  }

  const countMatches = (re) => (stripped.match(re) || []).length;
  const usesF16 = language === "wgsl"
    ? /\benable\s+f16\s*;|\bf16\b|\bvec[234]h\b|\bmat[234]x[234]h\b/.test(stripped)
    : /\bhalf[234]?\b|\bhalf[234]x[234]\b/.test(stripped);
  const usesSubgroups = language === "wgsl"
    ? /\benable\s+subgroups\s*;|\bsubgroup[A-Z]\w*/.test(stripped)
    : /\bsimd_(?:sum|prefix|shuffle|broadcast|ballot|all|any|min|max)\b/.test(stripped);

  const counts = {
    lines,
    bytes: Buffer.byteLength(code, "utf8"),
    bindings: countMatches(/@binding\s*\(/g) + countMatches(/\[\[(?:buffer|texture|sampler)\(\d+\)\]\]/g),
    overrides: countMatches(/\boverride\s+[A-Za-z_]/g) + countMatches(/\[\[function_constant\(/g),
    textureSamples: countMatches(/\btexture(?:Sample\w*|Gather\w*)\s*\(/g) + countMatches(/\.\s*(?:sample|gather)\s*\(/g),
    textureLoadsStores: countMatches(/\btexture(?:Load|Store)\s*\(/g) + countMatches(/\.\s*(?:read|write)\s*\(/g),
    atomics: countMatches(/\batomic[A-Z]\w*\s*\(/g),
    barriers: countMatches(/\b(?:workgroupBarrier|storageBarrier|textureBarrier|threadgroup_barrier|simdgroup_barrier)\s*\(/g),
    loops: countMatches(/\b(?:for|while|loop)\b/g),
    branches: countMatches(/\b(?:if|switch)\b/g),
    selects: countMatches(/\bselect\s*\(/g),
    fmaCalls: countMatches(/\bfma\s*\(/g),
    transcendentals: countMatches(/\b(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|exp2|log|log2|pow|sqrt|inverseSqrt|rsqrt)\s*\(/g),
    discards: language === "wgsl"
      ? countMatches(/\bdiscard\s*;/g)
      : countMatches(/\bdiscard_fragment\s*\(\s*\)|\bdiscard\s*;/g),
    fragDepthWrites: countMatches(/@builtin\(\s*frag_depth\s*\)|\[\[\s*depth\s*\(/g)
  };

  const hazards = [];
  if (counts.discards > 0) {
    hazards.push({
      code: "tbdr-hsr-killer-discard",
      severity: "high",
      message: `Fragment shader uses discard (${counts.discards}x), disabling Apple TBDR hardware Hidden Surface Removal (early-Z) for this pipeline.`,
      fix: "Split opaque geometry into a non-discard pipeline, or use alpha-to-one / pre-sorted alpha blending where possible."
    });
  }
  if (counts.fragDepthWrites > 0) {
    hazards.push({
      code: "tbdr-late-z-frag-depth",
      severity: "high",
      message: "Fragment shader writes frag_depth, forcing late-Z evaluation and disabling Apple TBDR early HSR.",
      fix: "Move depth offsets to vertex position / pipeline depthBias unless per-pixel depth replacement is strictly required."
    });
  }

  for (const ep of entryPoints) {
    if (ep.stage === "compute" && ep.workgroupSize) {
      const total = ep.workgroupSize[0] * ep.workgroupSize[1] * ep.workgroupSize[2];
      if (total > 1 && total % 32 !== 0) {
        hazards.push({
          code: "workgroup-not-simd32-multiple",
          severity: "medium",
          message: `Compute entry "${ep.name}" uses @workgroup_size(${ep.workgroupSize.join(", ")}) = ${total} threads, which is not a multiple of Apple GPU SIMD width (32).`,
          fix: "Use a multiple of 32 (e.g. 64, 128, 256, or 8x8 = 64 for 2D image passes) so all 32 SIMD lanes stay occupied."
        });
      }
    }
  }

  // Detect local fixed-size array indexed dynamically (classic register spill trigger).
  const localArrays = new Set();
  const arrayDecl = /\b(?:var|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*array\s*</g;
  let arrMatch;
  while ((arrMatch = arrayDecl.exec(stripped)) !== null) {
    localArrays.add(arrMatch[1]);
  }
  for (const name of localArrays) {
    const idxRe = new RegExp(`\\b${escapeRegExp(name)}\\s*\\[\\s*([^\\]]+)\\]`, "g");
    let idxMatch;
    while ((idxMatch = idxRe.exec(stripped)) !== null) {
      const expr = idxMatch[1].trim();
      if (!/^\d+u?$/.test(expr)) {
        hazards.push({
          code: "register-spill-dynamic-array-index",
          severity: "high",
          message: `Local array "${name}" is indexed dynamically (${name}[${expr}]), which prevents register promotion and spills to stack/DRAM.`,
          fix: "Unroll with constant indices, use select() chains for small tables, or place read-only tables in a uniform/storage buffer."
        });
        break;
      }
    }
  }

  const vecCtorPrefix = "(?:(?:vec[234](?:<\\s*(?:f32|f16)\\s*>|[fh])?|(?:float|half)[234])\\s*\\(\\s*)?";
  const powExpRe = new RegExp(`\\bpow\\s*\\([^,]+,\\s*${vecCtorPrefix}(?:2(?:\\.0)?[fh]?|0\\.5[fh]?)\\s*\\)?\\s*\\)`);
  if (powExpRe.test(stripped)) {
    hazards.push({
      code: "pow-algebraic-simplification",
      severity: "low",
      message: "Shader calls pow(x, 2.0) or pow(x, 0.5), which expands to exp2(y * log2(x)) unless folded.",
      fix: "Replace pow(x, 2.0) with x * x and pow(x, 0.5) with sqrt(x)."
    });
  }
  const rsqrtRe = new RegExp(`(?:1(?:\\.0)?[fh]?|${vecCtorPrefix}1(?:\\.0)?[fh]?\\s*\\))\\s*\\/\\s*sqrt\\s*\\(`);
  if (rsqrtRe.test(stripped)) {
    hazards.push({
      code: "reciprocal-sqrt",
      severity: "low",
      message: "Shader computes 1.0 / sqrt(x) instead of hardware single-op inverseSqrt(x).",
      fix: "Use inverseSqrt(x) in WGSL (rsqrt(x) in MSL)."
    });
  }
  const clamp01Re = new RegExp(`\\bclamp\\s*\\([^,]+,\\s*${vecCtorPrefix}0(?:\\.0)?[fh]?\\s*\\)?\\s*,\\s*${vecCtorPrefix}1(?:\\.0)?[fh]?\\s*\\)?\\s*\\)`);
  if (language === "wgsl" && clamp01Re.test(stripped)) {
    hazards.push({
      code: "clamp-to-saturate",
      severity: "info",
      message: "clamp(x, 0.0, 1.0) can be written as saturate(x) (free result modifier on Apple GPUs).",
      fix: "Use saturate(x) for [0, 1] clamping."
    });
  }
  if (!usesF16 && (counts.transcendentals >= 6 || lines >= 80)) {
    hazards.push({
      code: "f16-opportunity",
      severity: "info",
      message: "Shader uses only f32 across a non-trivial ALU body (`enable f16;` not active).",
      fix: "Evaluate f16 / vec4h for medium-precision color, BRDF, normals, and threadgroup scratch (keep f32 for world positions, depth, and UV derivatives)."
    });
  }
  if (counts.barriers >= 2 && !usesSubgroups) {
    hazards.push({
      code: "subgroup-reduction-opportunity",
      severity: "info",
      message: `Compute shader uses ${counts.barriers} workgroup barriers without subgroup intrinsics.`,
      fix: "On Apple GPUs (subgroupSize = 32), use `enable subgroups;` (subgroupAdd / subgroupShuffleXor) to reduce 32x within registers before touching workgroup memory."
    });
  }

  return {
    language,
    usesF16,
    usesSubgroups,
    entryPoints,
    counts,
    hazards
  };
}

/**
 * Parse disassembled Apple AIR LLVM IR (`metal-objdump --disassemble`) into concrete
 * post-optimization instruction & memory operation counts.
 */
export function parseMetalAirDisassembly(disassembly = "") {
  if (typeof disassembly !== "string" || !disassembly.trim()) return null;

  const functions = [];
  const fnBlocks = disassembly.split(/\n(?=define\s+)/);
  for (const block of fnBlocks) {
    if (!block.startsWith("define ")) continue;
    const nameMatch = /@([A-Za-z0-9_.$]+|"[^"]+")\s*\(/.exec(block);
    const name = nameMatch ? nameMatch[1].replace(/^"|"$/g, "") : "unknown";
    const bodyStart = block.indexOf("{");
    if (bodyStart < 0) continue;
    const closeBraceMatch = /\n\}/.exec(block.slice(bodyStart));
    const bodyEnd = closeBraceMatch ? bodyStart + closeBraceMatch.index : block.lastIndexOf("}");
    if (bodyEnd <= bodyStart) continue;
    const bodyLines = block.slice(bodyStart + 1, bodyEnd)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(";") && !/^[A-Za-z0-9_.-]+:\s*(?:;.*)?$/.test(l));

    let f32Ops = 0;
    let f16Ops = 0;
    let fmaOps = 0;
    let fpConversions = 0;
    let transcendentals = 0;
    let textureOps = 0;
    let deviceLoads = 0;
    let deviceStores = 0;
    let constantLoads = 0;
    let threadgroupOps = 0;
    let simdgroupOps = 0;
    let conditionalBranches = 0;
    let selectOps = 0;
    let stackAllocas = 0;

    for (const line of bodyLines) {
      if (/\balloca\b/.test(line)) stackAllocas += 1;
      if (/\b(?:fpext|fptrunc)\b/.test(line)) fpConversions += 1;
      if (/@air\.fma\b/.test(line)) fmaOps += 1;
      if (/@air\.(?:fast_)?(?:sin|cos|tan|asin|acos|atan|atan2|exp|exp2|log|log2|powr?|sqrt|rsqrt|div)\b/.test(line)) {
        transcendentals += 1;
      }
      if (/@air\.(?:sample_|gather_|read_|write_|get_width|get_height|get_num_mip_levels|sample\b|gather\b|read\b|write\b)/.test(line)) {
        textureOps += 1;
      }
      if (/\bload\b.*addrspace\(1\)|@air\.atomic\..*addrspace\(1\)/.test(line)) deviceLoads += 1;
      if (/\bstore\b.*addrspace\(1\)/.test(line)) deviceStores += 1;
      if (/\bload\b.*addrspace\(2\)/.test(line)) constantLoads += 1;
      if (/addrspace\(3\)|@air\.wg\.barrier/.test(line)) threadgroupOps += 1;
      if (/@air\.simd/.test(line)) simdgroupOps += 1;
      if (/^br\s+i1\b/.test(line)) conditionalBranches += 1;
      if (/\bselect\s+/.test(line)) selectOps += 1;

      const isMathOp = /\b(?:fadd|fsub|fmul|fdiv|frem|fcmp|fneg)\b|@air\.(?:fma|fast_|fmin|fmax|saturate|abs|floor|ceil|fract|rint|dot)/.test(line);
      if (isMathOp) {
        if (/\bhalf\b|v[234]f16|\.f16\b/.test(line)) f16Ops += 1;
        else f32Ops += 1;
      }
    }

    functions.push({
      name,
      airInstructions: bodyLines.length,
      f32Ops,
      f16Ops,
      fmaOps,
      fpConversions,
      transcendentals,
      textureOps,
      deviceLoads,
      deviceStores,
      constantLoads,
      threadgroupOps,
      simdgroupOps,
      conditionalBranches,
      selectOps,
      stackAllocas
    });
  }

  if (!functions.length) return null;

  const totals = functions.reduce((acc, fn) => {
    for (const key of Object.keys(acc)) acc[key] += fn[key] || 0;
    return acc;
  }, {
    airInstructions: 0,
    f32Ops: 0,
    f16Ops: 0,
    fmaOps: 0,
    fpConversions: 0,
    transcendentals: 0,
    textureOps: 0,
    deviceLoads: 0,
    deviceStores: 0,
    constantLoads: 0,
    threadgroupOps: 0,
    simdgroupOps: 0,
    conditionalBranches: 0,
    selectOps: 0,
    stackAllocas: 0
  });

  return { totals, functions };
}

/**
 * Full shader analysis: static WGSL/GLSL/MSL inspection + optional transpilation to MSL +
 * macOS `xcrun metal` AIR disassembly + native Apple GPU (`MTLBinaryArchive`) hardware stats.
 */
export async function analyzeShader(code, options = {}) {
  const compiler = options.compiler || "auto";
  if (!["auto", "dawn", "tint", "naga"].includes(compiler)) {
    throw Object.assign(new TypeError('compiler must be "auto", "dawn", "tint", or "naga".'), { code: "invalid-options" });
  }
  const staticAnalysis = analyzeShaderStatic(code, options);
  const result = {
    label: options.label || (options.filePath ? path.basename(options.filePath) : "inline"),
    filePath: options.filePath || null,
    static: staticAnalysis,
    msl: { available: false, source: null, transpiler: null, error: null },
    metalAir: { available: false, totals: null, functions: null, missedOptimizations: [], error: null },
    appleGpu: { available: false, deviceName: null, architecture: null, apple9DynamicCaching: null, entries: [], error: null }
  };

  if (options.skipCompiler) return result;

  // 1. Obtain MSL source
  if (staticAnalysis.language === "msl") {
    result.msl = { available: true, source: code, transpiler: "native-msl", error: null };
  } else if (options.mslSource) {
    result.msl = { available: true, source: options.mslSource, transpiler: "dawn-dump", error: null };
  } else {
    const transpiled = await transpileToMsl(code, staticAnalysis.language, { compiler, staticAnalysis });
    if (Array.isArray(transpiled.compilationMessages) && transpiled.compilationMessages.length) {
      result.compilationMessages = transpiled.compilationMessages;
    }
    const { compilationMessages: _msgs, ...mslInfo } = transpiled;
    result.msl = mslInfo;
  }

  if (!result.msl.available || process.platform !== "darwin") {
    return result;
  }

  // 2. Compile MSL -> Apple AIR via xcrun metal + metal-objdump, and native AGX via cached Swift probe
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-shader-"));
  try {
    const mslPath = path.join(tmpDir, "shader.metal");
    const metallibPath = path.join(tmpDir, "shader.metallib");
    await writeFile(mslPath, result.msl.source, "utf8");

    const [airRes, nativeRes] = await Promise.all([
      compileMetalAir(mslPath, metallibPath),
      options.skipNativeBinary ? Promise.resolve(null) : runNativeAppleGpuProbe(mslPath)
    ]);

    result.metalAir = airRes;
    if (nativeRes) result.appleGpu = nativeRes;

    // Augment hazards with post-compiler evidence!
    if (airRes.available && airRes.totals) {
      if (airRes.totals.stackAllocas > 0) {
        result.static.hazards.push({
          code: "compiler-stack-alloca-spill",
          severity: "high",
          message: `Metal AIR emitted ${airRes.totals.stackAllocas} stack alloca instruction(s), indicating unpromoted private memory / high register spill risk.`,
          fix: "Eliminate dynamic indexing of local arrays and shrink live struct temporaries across barriers/loops."
        });
      }
      if (airRes.totals.f16Ops > 0 && airRes.totals.fpConversions > airRes.totals.f16Ops) {
        result.static.hazards.push({
          code: "excessive-f16-f32-conversions",
          severity: "medium",
          message: `Shader performs ${airRes.totals.fpConversions} fpext/fptrunc conversions vs ${airRes.totals.f16Ops} f16 math ops (conversion ping-pong overhead).`,
          fix: "Keep entire intermediate chains in f16/vec4h with f16 literals (e.g. 0.5h) instead of mixing f32 literals inside f16 expressions."
        });
      }
    }
    if (nativeRes?.available && Array.isArray(nativeRes.entries)) {
      for (const entry of nativeRes.entries) {
        if (typeof entry.maxTotalThreadsPerThreadgroup === "number" && entry.maxTotalThreadsPerThreadgroup > 0 && entry.maxTotalThreadsPerThreadgroup < 1024) {
          result.static.hazards.push({
            code: "apple-gpu-occupancy-throttled",
            severity: "high",
            message: `Entry "${entry.name}" (${entry.functionType}) caps maxTotalThreadsPerThreadgroup at ${entry.maxTotalThreadsPerThreadgroup} (< 1024) on ${nativeRes.deviceName}: high GPR register pressure is reducing hardware occupancy.`,
            fix: "Convert intermediate vectors to f16 (half), recompute cheap values instead of holding live registers across texture/memory waits, or split uber-shaders using WGSL override constants."
          });
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  return result;
}

/**
 * Compare two shader analyses (`--base` vs `--candidate`) for rapid (<100 ms) offline
 * compiler verification before running full browser A/B benchmarks.
 */
export function compareShaderAnalyses(base, candidate) {
  const deltaMetric = (bVal, cVal, lowerIsBetter = true) => {
    if (typeof bVal !== "number" || typeof cVal !== "number") return null;
    const delta = cVal - bVal;
    const deltaPercent = bVal !== 0 ? Math.round(((delta / bVal) * 100) * 10) / 10 : (delta === 0 ? 0 : null);
    let direction = "same";
    if (delta !== 0) {
      direction = (lowerIsBetter ? delta < 0 : delta > 0) ? "better" : "worse";
    }
    return { base: bVal, candidate: cVal, delta, deltaPercent, direction };
  };

  const bAir = base?.metalAir?.totals || {};
  const cAir = candidate?.metalAir?.totals || {};
  const bNativeBytes = sumNativeBytes(base?.appleGpu?.entries);
  const cNativeBytes = sumNativeBytes(candidate?.appleGpu?.entries);
  const bMinMaxThreads = minThreadsCeiling(base?.appleGpu?.entries);
  const cMinMaxThreads = minThreadsCeiling(candidate?.appleGpu?.entries);

  const metrics = {
    nativeCodeBytes: deltaMetric(bNativeBytes, cNativeBytes, true),
    minOccupancyThreadCeiling: deltaMetric(bMinMaxThreads, cMinMaxThreads, false),
    airInstructions: deltaMetric(bAir.airInstructions, cAir.airInstructions, true),
    f32Ops: deltaMetric(bAir.f32Ops, cAir.f32Ops, true),
    f16Ops: deltaMetric(bAir.f16Ops, cAir.f16Ops, false),
    fmaOps: deltaMetric(bAir.fmaOps, cAir.fmaOps, false),
    fpConversions: deltaMetric(bAir.fpConversions, cAir.fpConversions, true),
    transcendentals: deltaMetric(bAir.transcendentals, cAir.transcendentals, true),
    textureOps: deltaMetric(bAir.textureOps, cAir.textureOps, true),
    deviceLoads: deltaMetric(bAir.deviceLoads, cAir.deviceLoads, true),
    deviceStores: deltaMetric(bAir.deviceStores, cAir.deviceStores, true),
    threadgroupOps: deltaMetric(bAir.threadgroupOps, cAir.threadgroupOps, true),
    conditionalBranches: deltaMetric(bAir.conditionalBranches, cAir.conditionalBranches, true),
    selectOps: deltaMetric(bAir.selectOps, cAir.selectOps, false),
    stackAllocas: deltaMetric(bAir.stackAllocas, cAir.stackAllocas, true)
  };

  const baseCodes = new Set((base?.static?.hazards || []).map((h) => h.code));
  const candCodes = new Set((candidate?.static?.hazards || []).map((h) => h.code));
  const resolvedHazards = [...baseCodes].filter((c) => !candCodes.has(c));
  const newHazards = (candidate?.static?.hazards || []).filter((h) => !baseCodes.has(h.code));

  return {
    baseLabel: base?.label || "base",
    candidateLabel: candidate?.label || "candidate",
    deviceName: candidate?.appleGpu?.deviceName || base?.appleGpu?.deviceName || null,
    architecture: candidate?.appleGpu?.architecture || base?.appleGpu?.architecture || null,
    metrics,
    resolvedHazards,
    newHazards
  };
}

/**
 * Extract compiled WebGPU WGSL shaders + Dawn's dumped MSL directly from a live URL or HTML file,
 * and run offline compiler analysis on matching shaders.
 */
export async function extractAndAnalyzePageShaders(options = {}) {
  const { FastCDPHarness } = await import("./fast-cdp-runner.js");
  const { createFileTarget } = await import("./static-server.js");

  let fileTarget = null;
  let targetUrl = options.url || null;
  if (!targetUrl && options.file) {
    fileTarget = await createFileTarget(options.file, { fileRoot: options.fileRoot });
    targetUrl = fileTarget.url;
  }
  if (!targetUrl) {
    throw Object.assign(new Error("Pass --url, --html-file, or --file <shader.wgsl|.metal>."), { code: "invalid-options" });
  }

  const dawnMslDumps = [];
  const harness = await FastCDPHarness.launch({
    channel: options.channel,
    executablePath: options.executablePath,
    headful: Boolean(options.headful),
    chromiumArgs: [
      "--enable-unsafe-webgpu",
      "--enable-dawn-features=allow_unsafe_apis,dump_shaders,disable_symbol_renaming",
      ...(options.chromiumArgs || [])
    ]
  });

  try {
    const browserSession = harness.browserSession;
    const { targetId } = await browserSession.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId, flatten: true });
    const pageSession = browserSession.session(sessionId);

    const offConsole = pageSession.on("Runtime.consoleAPICalled", (params) => {
      const text = (params?.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (text.includes("#include <metal_stdlib>") || text.includes("// Dumped WGSL")) {
        dawnMslDumps.push(text);
      }
    });
    const offLog = pageSession.on("Log.entryAdded", (params) => {
      const text = params?.entry?.text || "";
      if (text.includes("#include <metal_stdlib>")) {
        dawnMslDumps.push(text);
      }
    });

    await pageSession.send("Page.enable");
    await pageSession.send("Runtime.enable");
    await pageSession.send("Log.enable");
    await pageSession.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const captured = [];
        globalThis.__gpuPerfCapturedShaders = captured;
        if (globalThis.GPUDevice?.prototype?.createShaderModule) {
          const orig = globalThis.GPUDevice.prototype.createShaderModule;
          globalThis.GPUDevice.prototype.createShaderModule = function(desc = {}) {
            const code = String(desc?.code || "");
            const mod = orig.call(this, desc);
            const entry = {
              index: captured.length,
              label: desc?.label || null,
              code,
              messages: []
            };
            captured.push(entry);
            mod?.getCompilationInfo?.().then((info) => {
              entry.messages = (info?.messages || []).map((m) => ({
                type: m.type, lineNum: m.lineNum, linePos: m.linePos, message: m.message
              }));
            }).catch(() => {});
            return mod;
          };
        }
      })();`
    });

    await pageSession.send("Page.navigate", { url: targetUrl });
    const settleMs = Math.max(200, Math.min(30000, Number(options.settleMs ?? 1500)));
    const waitDeadline = Date.now() + Math.max(settleMs, 2500);
    let sawShadersAt = null;
    while (Date.now() < waitDeadline) {
      const probe = await pageSession.send("Runtime.evaluate", {
        expression: "(globalThis.__gpuPerfCapturedShaders || []).length",
        returnByValue: true
      }).catch(() => null);
      if ((probe?.result?.value || 0) > 0) {
        sawShadersAt ??= Date.now();
        if (Date.now() - sawShadersAt >= Math.min(settleMs, 400)) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const evalRes = await pageSession.send("Runtime.evaluate", {
      expression: "JSON.stringify(globalThis.__gpuPerfCapturedShaders || [])",
      returnByValue: true
    });
    const rawModules = JSON.parse(evalRes?.result?.value || "[]");

    offConsole();
    offLog();
    await browserSession.send("Target.closeTarget", { targetId }).catch(() => {});

    const mslBlocks = dawnMslDumps
      .map((chunk) => {
        const idx = chunk.indexOf("#include <metal_stdlib>");
        return idx >= 0 ? chunk.slice(idx).trim() : null;
      })
      .filter(Boolean);

    const filter = options.filter ? String(options.filter).toLowerCase() : null;
    const filtered = rawModules.filter((mod) => {
      if (!filter) return true;
      return (mod.label && mod.label.toLowerCase().includes(filter)) || mod.code.toLowerCase().includes(filter);
    });

    const maxAnalyze = Math.max(1, Math.min(32, Number(options.limit ?? 8)));
    const selected = filtered.slice(0, maxAnalyze);

    if (options.dumpDir) {
      const absDump = path.resolve(options.dumpDir);
      await mkdir(absDump, { recursive: true });
      for (let i = 0; i < selected.length; i += 1) {
        const mod = selected[i];
        const slug = String(mod.label || `shader-${mod.index}`).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
        const prefix = `${String(mod.index).padStart(2, "0")}-${slug}`;
        await writeFile(path.join(absDump, `${prefix}.wgsl`), mod.code, "utf8");
      }
      for (let i = 0; i < mslBlocks.length; i += 1) {
        await writeFile(path.join(absDump, `dawn-${String(i).padStart(2, "0")}.metal`), mslBlocks[i], "utf8");
      }
    }

    const analyses = [];
    for (const mod of selected) {
      const analysis = await analyzeShader(mod.code, {
        label: mod.label || `shader#${mod.index}`,
        language: "wgsl",
        compiler: options.compiler || "auto",
        skipCompiler: Boolean(options.skipCompiler)
      });
      analysis.compilationMessages = mod.messages || [];
      analyses.push(analysis);
    }

    return {
      targetUrl,
      totalShaderModules: rawModules.length,
      matchedShaderModules: filtered.length,
      analyzedCount: analyses.length,
      dawnMslDumpCount: mslBlocks.length,
      dumpDir: options.dumpDir ? path.resolve(options.dumpDir) : null,
      shaders: analyses
    };
  } finally {
    await harness.close().catch(() => {});
    if (fileTarget) await fileTarget.close().catch(() => {});
  }
}

export function formatShaderDigest(analysis) {
  const s = analysis.static;
  const eps = s.entryPoints.map((ep) => `${ep.stage}:${ep.name}${ep.workgroupSize ? `(${ep.workgroupSize.join("x")})` : ""}`).join(", ") || "none";
  const transpilerTag = analysis.msl?.transpiler ? ` -> ${analysis.msl.transpiler}` : "";
  const lines = [
    `SHADER ${analysis.label} (${s.language.toUpperCase()}${transpilerTag}, ${s.counts.lines} lines, f16=${s.usesF16 ? "on" : "off"}, subgroups=${s.usesSubgroups ? "on" : "off"})`,
    `Entries: ${eps}`
  ];

  if (analysis.appleGpu?.available && analysis.appleGpu.entries?.length) {
    const parts = analysis.appleGpu.entries.map((e) => {
      if (e.error) return `${e.name}: compile-error`;
      const occ = e.maxTotalThreadsPerThreadgroup != null ? `maxThreads=${e.maxTotalThreadsPerThreadgroup}` : null;
      const bytes = e.nativeCodeBytes != null ? `isa=${e.nativeCodeBytes}B` : null;
      const tgm = e.staticThreadgroupMemoryLength ? `tgMem=${e.staticThreadgroupMemoryLength}B` : null;
      return `${e.name}[${[bytes, occ, tgm].filter(Boolean).join(", ")}]`;
    });
    lines.push(`Apple GPU (${analysis.appleGpu.deviceName} / ${analysis.appleGpu.architecture}): ${parts.join(" | ")}`);
  }

  if (analysis.metalAir?.available && analysis.metalAir.totals) {
    const t = analysis.metalAir.totals;
    lines.push(
      `Metal AIR (-O2): ${t.airInstructions} inst | f32=${t.f32Ops}, f16=${t.f16Ops}, fma=${t.fmaOps}, conv=${t.fpConversions}, transc=${t.transcendentals} | tex=${t.textureOps}, devLoad=${t.deviceLoads}, devStore=${t.deviceStores}, tg=${t.threadgroupOps} | br=${t.conditionalBranches}, select=${t.selectOps}, alloca=${t.stackAllocas}`
    );
  } else if (analysis.msl?.error || analysis.metalAir?.error) {
    const errLine = String(analysis.msl?.error || analysis.metalAir?.error).split("\n")[0];
    lines.push(`Compiler: unavailable (${errLine})`);
  }

  if (s.hazards.length) {
    lines.push(`Findings (${s.hazards.length}):`);
    for (const h of s.hazards) {
      lines.push(`  [${h.severity.toUpperCase()}] ${h.code}: ${h.message} -> ${h.fix}`);
    }
  } else {
    lines.push("Findings: none (clean)");
  }
  return lines.join("\n");
}

export function formatShaderComparisonDigest(cmp) {
  const lines = [
    `SHADER A/B: ${cmp.baseLabel} -> ${cmp.candidateLabel}${cmp.deviceName ? ` (${cmp.deviceName} / ${cmp.architecture})` : ""}`
  ];
  const labels = [
    ["nativeCodeBytes", "Native ISA bytes"],
    ["minOccupancyThreadCeiling", "Occupancy thread ceiling"],
    ["airInstructions", "AIR instructions"],
    ["f32Ops", "f32 math ops"],
    ["f16Ops", "f16 math ops"],
    ["fmaOps", "FMA ops"],
    ["fpConversions", "f16<->f32 conversions"],
    ["transcendentals", "Transcendentals"],
    ["textureOps", "Texture ops"],
    ["deviceLoads", "Device loads"],
    ["deviceStores", "Device stores"],
    ["threadgroupOps", "Threadgroup ops"],
    ["conditionalBranches", "Conditional branches"],
    ["selectOps", "Branchless selects"],
    ["stackAllocas", "Stack allocas (spills)"]
  ];
  const changed = [];
  for (const [key, label] of labels) {
    const row = cmp.metrics[key];
    if (!row || row.delta === 0) continue;
    const sign = row.delta > 0 ? "+" : "";
    const pct = row.deltaPercent != null ? ` (${sign}${row.deltaPercent}%)` : "";
    changed.push(`  ${label}: ${row.base} -> ${row.candidate} (${sign}${row.delta}${pct}) [${row.direction}]`);
  }
  if (changed.length) {
    lines.push("Changed compiler metrics:");
    lines.push(...changed);
  } else {
    lines.push("Changed compiler metrics: identical post-optimization output (compiler folded the change to the same IR/ISA).");
  }
  if (cmp.resolvedHazards.length) {
    lines.push(`Resolved findings: ${cmp.resolvedHazards.join(", ")}`);
  }
  if (cmp.newHazards.length) {
    lines.push(`New findings: ${cmp.newHazards.map((h) => `${h.code} (${h.severity})`).join(", ")}`);
  }
  return lines.join("\n");
}

function sumNativeBytes(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const nums = entries.map((e) => e.nativeCodeBytes).filter((n) => typeof n === "number");
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function minThreadsCeiling(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const nums = entries.map((e) => e.maxTotalThreadsPerThreadgroup).filter((n) => typeof n === "number" && n > 0);
  return nums.length ? Math.min(...nums) : null;
}

const DAWN_SHADER_WORKER_SOURCE = `
import readline from "node:readline";

const pkgName = "webgpu";
const { create, globals } = await import(pkgName);
Object.assign(globalThis, globals);

const gpu = create(["enable-dawn-features=allow_unsafe_apis,dump_shaders,disable_symbol_renaming"]);
const adapter = await gpu.requestAdapter();
const wantedFeatures = ["shader-f16", "subgroups", "subgroup-size-control"].filter(f => adapter?.features?.has?.(f));
const device = await adapter.requestDevice({ requiredFeatures: wantedFeatures });

function stripWgslComments(code) {
  return String(code).replace(/\\/\\*[\\s\\S]*?\\*\\//g, " ").replace(/\\/\\/[^\\n]*/g, " ");
}

function vertexFormatForWgslType(wgslType) {
  const t = wgslType.replace(/\\s+/g, "");
  if (/^vec4<f32>$|^vec4f$/.test(t)) return { format: "float32x4", stride: 16 };
  if (/^vec3<f32>$|^vec3f$/.test(t)) return { format: "float32x3", stride: 16 };
  if (/^vec2<f32>$|^vec2f$/.test(t)) return { format: "float32x2", stride: 8 };
  if (/^f32$/.test(t)) return { format: "float32", stride: 4 };
  if (/^vec4<f16>$|^vec4h$/.test(t)) return { format: "float16x4", stride: 8 };
  if (/^vec2<f16>$|^vec2h$/.test(t)) return { format: "float16x2", stride: 4 };
  if (/^vec4<u32>$|^vec4u$/.test(t)) return { format: "uint32x4", stride: 16 };
  if (/^vec2<u32>$|^vec2u$/.test(t)) return { format: "uint32x2", stride: 8 };
  if (/^u32$/.test(t)) return { format: "uint32", stride: 4 };
  if (/^vec4<i32>$|^vec4i$/.test(t)) return { format: "sint32x4", stride: 16 };
  if (/^i32$/.test(t)) return { format: "sint32", stride: 4 };
  return { format: "float32x4", stride: 16 };
}

function parseEntryDetails(code, entryName) {
  const stripped = stripWgslComments(code);
  const escaped = entryName.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const fnRe = new RegExp("fn\\\\s+" + escaped + "\\\\s*\\\\(([\\\\s\\\\S]*?)\\\\)(?:\\\\s*->\\\\s*([\\\\s\\\\S]*?))?\\\\s*\\\\{");
  const m = fnRe.exec(stripped);
  const params = m?.[1] || "";
  const ret = m?.[2] || "";

  const locations = [];
  const locRe = /@location\\(\\s*(\\d+)\\s*\\)\\s*[A-Za-z_][A-Za-z0-9_]*\\s*:\\s*([^,)]+)/g;
  let lm;
  while ((lm = locRe.exec(params)) !== null) {
    locations.push({ location: Number(lm[1]), type: lm[2].trim() });
  }
  // Also check struct parameters used as @stage inputs.
  const structParamRe = /\\b([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let sp;
  while ((sp = structParamRe.exec(params)) !== null) {
    const structName = sp[2];
    const stRe = new RegExp("struct\\\\s+" + structName + "\\\\s*\\\\{([\\\\s\\\\S]*?)\\\\}");
    const stMatch = stRe.exec(stripped);
    if (stMatch) {
      const memberRe = /@location\\(\\s*(\\d+)\\s*\\)\\s*[A-Za-z_][A-Za-z0-9_]*\\s*:\\s*([^,;\\n]+)/g;
      let mm;
      while ((mm = memberRe.exec(stMatch[1])) !== null) {
        locations.push({ location: Number(mm[1]), type: mm[2].trim() });
      }
    }
  }

  const outLocations = [];
  const retLocMatch = /@location\\(\\s*(\\d+)\\s*\\)/.exec(ret);
  if (retLocMatch) {
    outLocations.push(Number(retLocMatch[1]));
  } else {
    const retStruct = ret.trim().replace(/^([A-Za-z_][A-Za-z0-9_]*)[\\s\\S]*$/, "$1");
    if (retStruct) {
      const stRe = new RegExp("struct\\\\s+" + retStruct + "\\\\s*\\\\{([\\\\s\\\\S]*?)\\\\}");
      const stMatch = stRe.exec(stripped);
      if (stMatch) {
        const memberRe = /@location\\(\\s*(\\d+)\\s*\\)/g;
        let mm;
        while ((mm = memberRe.exec(stMatch[1])) !== null) outLocations.push(Number(mm[1]));
      }
    }
  }
  return { locations, outLocations };
}

function buildVertexStub(locations) {
  const needsF16 = locations.some(loc => /\\bf16\\b|\\bvec[234]h\\b/.test(loc.type));
  const f16Header = needsF16 ? "enable f16;\\n" : "";
  const fields = locations.map(loc => "  @location(" + loc.location + ") f" + loc.location + ": " + loc.type + ",").join("\\n");
  const assigns = locations.map(loc => "  out.f" + loc.location + " = " + loc.type + "();").join("\\n");
  return \`\${f16Header}
    struct VsStubOut {
      @builtin(position) pos: vec4<f32>,
    \${fields}
    };
    @vertex fn vs_stub() -> VsStubOut {
      var out: VsStubOut;
      out.pos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    \${assigns}
      return out;
    }
  \`;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, code, entryPoints = [] } = req;
  const errors = [];
  let compilationMessages = [];
  try {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    compilationMessages = (info?.messages || []).map(m => ({
      type: m.type,
      lineNum: m.lineNum,
      linePos: m.linePos,
      message: m.message
    }));
    if (compilationMessages.some(m => m.type === "error")) {
      const firstErr = compilationMessages.find(m => m.type === "error");
      errors.push(\`line \${firstErr.lineNum}: \${firstErr.message}\`);
    } else {
      const computeEps = entryPoints.filter(ep => ep.stage === "compute");
      const vertexEps = entryPoints.filter(ep => ep.stage === "vertex");
      const fragmentEps = entryPoints.filter(ep => ep.stage === "fragment");

      for (const ep of computeEps) {
        try {
          await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: ep.name } });
        } catch (err) {
          errors.push(\`compute \${ep.name}: \${err.message}\`);
        }
      }
      for (const ep of vertexEps) {
        try {
          const { locations } = parseEntryDetails(code, ep.name);
          const buffers = locations.map(loc => {
            const vf = vertexFormatForWgslType(loc.type);
            return { arrayStride: vf.stride, attributes: [{ shaderLocation: loc.location, offset: 0, format: vf.format }] };
          });
          await device.createRenderPipelineAsync({
            layout: "auto",
            vertex: { module, entryPoint: ep.name, buffers },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" }
          });
        } catch (err) {
          errors.push(\`vertex \${ep.name}: \${err.message}\`);
        }
      }
      for (const ep of fragmentEps) {
        try {
          const { locations, outLocations } = parseEntryDetails(code, ep.name);
          const stubMod = device.createShaderModule({ code: buildVertexStub(locations) });
          const maxOut = outLocations.length ? Math.max(...outLocations) : 0;
          const writesDepth = /@builtin\\(\\s*frag_depth\\s*\\)/.test(code);
          const targets = Array.from({ length: maxOut + 1 }, (_, idx) =>
            outLocations.includes(idx)
              ? { format: "rgba16float" }
              : (outLocations.length === 0 && idx === 0)
                ? { format: "rgba16float", ...(writesDepth ? { writeMask: 0 } : {}) }
                : null
          );
          await device.createRenderPipelineAsync({
            layout: "auto",
            vertex: { module: stubMod, entryPoint: "vs_stub" },
            fragment: { module, entryPoint: ep.name, targets },
            ...(writesDepth ? { depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } } : {})
          });
        } catch (err) {
          errors.push(\`fragment \${ep.name}: \${err.message}\`);
        }
      }
      // Give Dawn C++ stdout flushes a microtask tick to arrive before the marker.
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch (err) {
    errors.push(err?.message || String(err));
  }
  process.stdout.write("\\n__DAWN_SHADER_RES__" + JSON.stringify({ id, errors, compilationMessages }) + "\\n");
}
`;

let shaderWorker = null;

export async function closeShaderWorker() {
  if (!shaderWorker) return;
  const w = shaderWorker;
  shaderWorker = null;
  try { w.child.kill("SIGTERM"); } catch {}
}

function isDawnNodeAvailable() {
  try {
    const pkgName = "webgpu";
    return Boolean(import.meta.resolve(pkgName));
  } catch {
    return false;
  }
}

function getDawnShaderWorker() {
  if (shaderWorker && shaderWorker.alive) return shaderWorker;
  const child = spawn(process.execPath, ["--input-type=module", "-e", DAWN_SHADER_WORKER_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  // Never keep the parent CLI process alive once commands finish.
  child.unref();
  child.stdin?.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();

  let buffer = "";
  let rawDump = "";
  let stderrTail = "";
  let nextId = 1;
  let queue = Promise.resolve();
  const pending = new Map();

  const state = {
    child,
    alive: true,
    compile(code, entryPoints) {
      const run = queue.then(() => new Promise((resolve, reject) => {
        if (!state.alive) return reject(new Error("Dawn shader worker exited."));
        const id = nextId++;
        rawDump = "";
        stderrTail = "";
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error("Timed out compiling WGSL via dawn-node."));
        }, 15000);
        timer.unref?.();
        pending.set(id, {
          resolve: (res) => { clearTimeout(timer); resolve(res); },
          reject: (err) => { clearTimeout(timer); reject(err); }
        });
        child.stdin.write(JSON.stringify({ id, code, entryPoints }) + "\n");
      }));
      queue = run.catch(() => {});
      return run;
    }
  };

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    buffer += text;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("__DAWN_SHADER_RES__")) {
        try {
          const payload = JSON.parse(line.slice("__DAWN_SHADER_RES__".length));
          const entry = pending.get(payload.id);
          if (entry) {
            pending.delete(payload.id);
            const msl = extractDawnMslBlocks(rawDump);
            entry.resolve({ ...payload, msl, stderr: stderrTail });
          }
        } catch {
          // Ignore malformed marker line.
        }
        rawDump = "";
      } else {
        rawDump += line + "\n";
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrTail += text;
    if (text.includes("#include <metal_stdlib>") || rawDump.includes("/* Dumped generated MSL */")) {
      rawDump += text;
    }
  });
  const onExit = (code) => {
    state.alive = false;
    if (shaderWorker === state) shaderWorker = null;
    for (const entry of pending.values()) {
      entry.reject(new Error(`Dawn shader worker exited (code=${code})${stderrTail ? `: ${stderrTail.trim()}` : ""}`));
    }
    pending.clear();
  };
  child.once("exit", onExit);
  child.once("error", onExit);
  shaderWorker = state;
  return state;
}

function extractDawnMslBlocks(dumpText = "") {
  const marker = "/* Dumped generated MSL */";
  const parts = String(dumpText).split(marker);
  if (parts.length <= 1) {
    const idx = dumpText.indexOf("#include <metal_stdlib>");
    return idx >= 0 ? dumpText.slice(idx).trim() : "";
  }
  const blocks = [];
  for (let i = 1; i < parts.length; i += 1) {
    // Strip trailing `info:` / `// Dumped WGSL:` sections from subsequent dumps.
    const nextWgsl = parts[i].indexOf("// Dumped WGSL:");
    let body = nextWgsl >= 0 ? parts[i].slice(0, nextWgsl) : parts[i];
    body = body.replace(/\ninfo:\s*$/, "").trim();
    if (body) blocks.push(body);
  }
  if (blocks.length === 0) return "";
  if (blocks.length === 1) return blocks[0];
  // Multiple entry points: keep the full first MSL unit and append distinct kernel/vertex/fragment bodies.
  const seenFns = new Set();
  const merged = [blocks[0]];
  for (const m of blocks[0].matchAll(/\b(?:kernel|vertex|fragment)\s+[\w:<>]+\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    seenFns.add(m[1]);
  }
  for (let i = 1; i < blocks.length; i += 1) {
    // Rename duplicate `dawn_entry_point` symbols across separate pipeline dumps so Metal can compile them together.
    let block = blocks[i].replace(/\bdawn_entry_point\b/g, `dawn_entry_point_${i}`);
    const incIdx = block.indexOf("using namespace metal;");
    if (incIdx >= 0) block = block.slice(incIdx + "using namespace metal;".length).trim();
    if (block) merged.push(block);
  }
  return merged.join("\n\n");
}

async function transpileWgslViaDawnNode(code, staticAnalysis) {
  if (!isDawnNodeAvailable()) {
    return { available: false, source: null, transpiler: "dawn-node", error: 'Optional peer dependency "webgpu" is not installed.' };
  }
  try {
    // Ref stdout/stderr briefly during active request, then unref again so CLI exits immediately.
    const worker = getDawnShaderWorker();
    worker.child.stdout?.ref?.();
    worker.child.stderr?.ref?.();
    try {
      const res = await worker.compile(code, staticAnalysis?.entryPoints || []);
      if (res.msl && res.msl.includes("#include <metal_stdlib>")) {
        return {
          available: true,
          source: res.msl,
          transpiler: "dawn-node",
          compilationMessages: res.compilationMessages || [],
          error: null
        };
      }
      const errText = (res.errors || []).join("; ") || res.stderr?.trim() || "Dawn did not emit MSL (no valid pipeline compiled).";
      return {
        available: false,
        source: null,
        transpiler: "dawn-node",
        compilationMessages: res.compilationMessages || [],
        error: errText
      };
    } finally {
      worker.child.stdout?.unref?.();
      worker.child.stderr?.unref?.();
    }
  } catch (err) {
    return { available: false, source: null, transpiler: "dawn-node", error: err?.message || String(err) };
  }
}

async function transpileWgslViaTintCli(code, tmpDir) {
  const tintBin = await findExecutable("tint", [
    path.join(os.homedir(), ".cargo", "bin", "tint"),
    "/opt/homebrew/bin/tint",
    "/usr/local/bin/tint"
  ]);
  if (!tintBin) {
    return { available: false, source: null, transpiler: "tint", error: "tint CLI not found" };
  }
  const inPath = path.join(tmpDir, "input.wgsl");
  const outPath = path.join(tmpDir, "output.metal");
  await writeFile(inPath, code, "utf8");
  const res = await captureExec(tintBin, ["--format", "msl", inPath, "-o", outPath]);
  if (!res.ok) {
    return { available: false, source: null, transpiler: "tint", error: (res.stderr || res.stdout).trim() };
  }
  const source = await readFile(outPath, "utf8");
  return { available: true, source, transpiler: "tint", error: null };
}

async function transpileWgslViaNagaCli(code, tmpDir) {
  const nagaBin = await findExecutable("naga", [
    path.join(os.homedir(), ".cargo", "bin", "naga"),
    "/opt/homebrew/bin/naga",
    "/usr/local/bin/naga"
  ]);
  if (!nagaBin) {
    return { available: false, source: null, transpiler: null, error: "naga CLI not found (install via cargo install naga-cli)" };
  }
  const inPath = path.join(tmpDir, "input.wgsl");
  const outPath = path.join(tmpDir, "output.metal");
  await writeFile(inPath, code, "utf8");
  const res = await captureExec(nagaBin, [inPath, outPath]);
  if (!res.ok) {
    return { available: false, source: null, transpiler: "naga", error: (res.stderr || res.stdout).trim() };
  }
  const rawMsl = await readFile(outPath, "utf8");
  return {
    available: true,
    source: normalizeNagaMslBindings(rawMsl),
    transpiler: "naga",
    error: null
  };
}

async function transpileToMsl(code, language, { compiler = "auto", staticAnalysis = null } = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gpu-perf-transpile-"));
  try {
    if (language === "wgsl") {
      if (compiler === "dawn") return await transpileWgslViaDawnNode(code, staticAnalysis);
      if (compiler === "tint") return await transpileWgslViaTintCli(code, tmpDir);
      if (compiler === "naga") return await transpileWgslViaNagaCli(code, tmpDir);

      // Auto priority: Chromium Dawn/Tint (node-webgpu) -> tint CLI -> naga CLI
      const dawnRes = await transpileWgslViaDawnNode(code, staticAnalysis);
      if (dawnRes.available) return dawnRes;
      // Preserve WGSL syntax/validation errors from Dawn instead of masking them with naga.
      if (dawnRes.compilationMessages?.some((m) => m.type === "error")) return dawnRes;

      const tintRes = await transpileWgslViaTintCli(code, tmpDir);
      if (tintRes.available) return tintRes;

      const nagaRes = await transpileWgslViaNagaCli(code, tmpDir);
      if (nagaRes.available) return nagaRes;

      return {
        available: false,
        source: null,
        transpiler: null,
        error: [dawnRes.error, tintRes.error, nagaRes.error].filter(Boolean).join(" | ")
      };
    }

    if (language === "glsl") {
      const glslang = await findExecutable("glslangValidator", ["/opt/homebrew/bin/glslangValidator", "/usr/local/bin/glslangValidator"]);
      const spirvCross = await findExecutable("spirv-cross", ["/opt/homebrew/bin/spirv-cross", "/usr/local/bin/spirv-cross"]);
      if (!glslang || !spirvCross) {
        return { available: false, source: null, transpiler: null, error: "glslangValidator or spirv-cross not found" };
      }
      const stage = /\bgl_Position\b/.test(code) ? "vert" : /\blayout\s*\([^)]*local_size_/.test(code) ? "comp" : "frag";
      const inPath = path.join(tmpDir, `input.${stage}`);
      const spvPath = path.join(tmpDir, "shader.spv");
      await writeFile(inPath, code, "utf8");
      const gRes = await captureExec(glslang, ["-V", inPath, "-o", spvPath]);
      if (!gRes.ok) {
        return { available: false, source: null, transpiler: "glslang+spirv-cross", error: (gRes.stderr || gRes.stdout).trim() };
      }
      const scRes = await captureExec(spirvCross, ["--msl", spvPath]);
      if (!scRes.ok) {
        return { available: false, source: null, transpiler: "glslang+spirv-cross", error: (scRes.stderr || scRes.stdout).trim() };
      }
      return { available: true, source: scRes.stdout, transpiler: "glslang+spirv-cross", error: null };
    }

    return { available: false, source: null, transpiler: null, error: `Unsupported shader language: ${language}` };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function compileMetalAir(mslPath, metallibPath) {
  const compile = await captureExec("xcrun", ["metal", "-O2", "-Rpass-missed=.*", mslPath, "-o", metallibPath]);
  if (!compile.ok) {
    return {
      available: false,
      totals: null,
      functions: null,
      missedOptimizations: [],
      error: (compile.stderr || compile.stdout || "xcrun metal failed").trim()
    };
  }
  const missedOptimizations = (compile.stderr || "")
    .split("\n")
    .filter((line) => line.includes("remark:"))
    .map((line) => line.trim())
    .slice(0, 16);

  const disasm = await captureExec("xcrun", ["metal-objdump", "--disassemble", metallibPath]);
  if (!disasm.ok) {
    return {
      available: false,
      totals: null,
      functions: null,
      missedOptimizations,
      error: (disasm.stderr || disasm.stdout || "metal-objdump failed").trim()
    };
  }
  const parsed = parseMetalAirDisassembly(disasm.stdout);
  return {
    available: Boolean(parsed),
    totals: parsed?.totals || null,
    functions: parsed?.functions || null,
    missedOptimizations,
    error: parsed ? null : "No AIR functions parsed from metallib"
  };
}

let cachedProbeBinaryPromise = null;

async function ensureNativeMetalProbeBinary() {
  if (cachedProbeBinaryPromise) return cachedProbeBinaryPromise;
  cachedProbeBinaryPromise = (async () => {
    const hash = createHash("sha256").update(SWIFT_METAL_PROBE_SOURCE).digest("hex").slice(0, 12);
    const binPath = path.join(os.tmpdir(), `gpu-perf-agent-metal-probe-${hash}`);
    try {
      await access(binPath, fsConstants.X_OK);
      return binPath;
    } catch {
      // Compile once via xcrun swiftc -O
      const srcPath = `${binPath}-${process.pid}.swift`;
      await writeFile(srcPath, SWIFT_METAL_PROBE_SOURCE, "utf8");
      try {
        const res = await captureExec("xcrun", ["swiftc", "-O", srcPath, "-framework", "Metal", "-framework", "Foundation", "-o", binPath]);
        if (!res.ok) return null;
        return binPath;
      } finally {
        await rm(srcPath, { force: true }).catch(() => {});
      }
    }
  })();
  return cachedProbeBinaryPromise;
}

async function runNativeAppleGpuProbe(mslPath) {
  const bin = await ensureNativeMetalProbeBinary();
  if (!bin) {
    return { available: false, deviceName: null, architecture: null, apple9DynamicCaching: null, entries: [], error: "Unable to compile Swift Metal probe helper." };
  }
  const res = await captureExec(bin, [mslPath]);
  if (!res.ok) {
    return { available: false, deviceName: null, architecture: null, apple9DynamicCaching: null, entries: [], error: (res.stderr || res.stdout || "Metal probe failed").trim() };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return {
      available: Boolean(parsed.ok),
      deviceName: parsed.deviceName || null,
      architecture: parsed.architecture || null,
      apple9DynamicCaching: parsed.apple9DynamicCaching ?? null,
      simdWidth: parsed.simdWidth ?? 32,
      maxThreadgroupMemoryBytes: parsed.maxThreadgroupMemoryBytes ?? null,
      entries: parsed.entries || [],
      error: parsed.compileError || null
    };
  } catch (err) {
    return { available: false, deviceName: null, architecture: null, apple9DynamicCaching: null, entries: [], error: err.message };
  }
}

async function findExecutable(name, extraCandidates = []) {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((d) => path.join(d, name)),
    ...extraCandidates
  ];
  for (const cand of candidates) {
    try {
      await access(cand, fsConstants.X_OK);
      return cand;
    } catch {
      // continue
    }
  }
  return null;
}

function stripComments(code = "") {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function captureExec(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      resolve({ code: null, ok: false, stderr: error.message, stdout });
    });
    child.on("close", (code) => {
      resolve({ code, ok: code === 0, stderr, stdout });
    });
  });
}
