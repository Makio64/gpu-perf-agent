import { createHash } from "node:crypto";
import { FastCDPHarness } from "./fast-cdp-runner.js";
import { parseViewport } from "./options.js";
import { analyzeShaderStatic } from "./shader-analyzer.js";
import { assertFileTarget, createFileTarget } from "./static-server.js";

const GPU_TEXTURE_USAGE = Object.freeze({
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10
});

/**
 * Browser-injected WebGPU structural & TBDR bandwidth instrumentation script.
 * Does not modify v3 `autoGpu` schemas; runs only inside `auditWebGPUPage`.
 */
export function deepAuditInitSource() {
  return `(() => {
    if (globalThis.__gpuPerfDeepAudit) return;
    const state = {
      adapter: null,
      wgslFeatures: [],
      devices: [],
      textures: [],
      samplers: [],
      buffers: [],
      shaders: [],
      pipelines: [],
      totalBindGroupsCreated: 0,
      frameIndex: 0,
      currentFrame: { passes: [], submits: 0, bindGroupsCreated: 0, writeBufferCalls: 0, writeBufferBytes: 0, texturesCreated: 0, buffersCreated: 0 },
      lastCompletedFrame: null,
      fallbackPasses: []
    };

    const viewToTexId = new WeakMap();
    const texToId = new WeakMap();
    const pipeToMeta = new WeakMap();

    try {
      if (navigator.gpu?.wgslLanguageFeatures) {
        state.wgslFeatures = Array.from(navigator.gpu.wgslLanguageFeatures);
      }
    } catch {}

    const bumpFrame = () => {
      if (state.currentFrame.passes.length > 0 || state.currentFrame.submits > 0) {
        state.lastCompletedFrame = state.currentFrame;
      }
      state.frameIndex += 1;
      state.currentFrame = {
        passes: [],
        submits: 0,
        bindGroupsCreated: 0,
        writeBufferCalls: 0,
        writeBufferBytes: 0,
        texturesCreated: 0,
        buffersCreated: 0
      };
    };

    if (typeof globalThis.requestAnimationFrame === "function") {
      const origRaf = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = function(cb) {
        return origRaf.call(this, function(ts) {
          bumpFrame();
          return cb(ts);
        });
      };
    }

    if (globalThis.GPUAdapter?.prototype?.requestDevice) {
      const origReqDevice = globalThis.GPUAdapter.prototype.requestDevice;
      globalThis.GPUAdapter.prototype.requestDevice = async function(desc = {}) {
        try {
          const info = this.info || {};
          state.adapter = {
            vendor: info.vendor || null,
            architecture: info.architecture || null,
            device: info.device || null,
            description: info.description || null,
            subgroupMinSize: info.subgroupMinSize ?? null,
            subgroupMaxSize: info.subgroupMaxSize ?? null,
            features: this.features ? Array.from(this.features) : []
          };
        } catch {}
        const dev = await origReqDevice.call(this, desc);
        try {
          state.devices.push({
            label: desc?.label || null,
            requiredFeatures: Array.from(desc?.requiredFeatures || []),
            activeFeatures: dev?.features ? Array.from(dev.features) : [],
            limits: {
              maxTextureDimension2D: dev?.limits?.maxTextureDimension2D ?? null,
              maxColorAttachmentBytesPerSample: dev?.limits?.maxColorAttachmentBytesPerSample ?? null,
              maxComputeWorkgroupStorageSize: dev?.limits?.maxComputeWorkgroupStorageSize ?? null,
              maxComputeInvocationsPerWorkgroup: dev?.limits?.maxComputeInvocationsPerWorkgroup ?? null
            }
          });
        } catch {}
        return dev;
      };
    }

    if (globalThis.GPUCanvasContext?.prototype?.getCurrentTexture) {
      const origGetCurrent = globalThis.GPUCanvasContext.prototype.getCurrentTexture;
      globalThis.GPUCanvasContext.prototype.getCurrentTexture = function() {
        const tex = origGetCurrent.call(this);
        if (tex && !texToId.has(tex)) {
          const id = -1 - state.textures.length;
          texToId.set(tex, id);
        }
        return tex;
      };
    }

    if (globalThis.GPUTexture?.prototype?.createView) {
      const origCreateView = globalThis.GPUTexture.prototype.createView;
      globalThis.GPUTexture.prototype.createView = function(desc) {
        const view = origCreateView.call(this, desc);
        const tid = texToId.get(this);
        if (tid !== undefined && view) {
          viewToTexId.set(view, tid);
        }
        return view;
      };
    }

    if (globalThis.GPUTexture?.prototype?.destroy) {
      const origDestroy = globalThis.GPUTexture.prototype.destroy;
      globalThis.GPUTexture.prototype.destroy = function() {
        const tid = texToId.get(this);
        if (typeof tid === "number" && tid >= 0 && state.textures[tid]) {
          state.textures[tid].destroyed = true;
        }
        return origDestroy.call(this);
      };
    }

    if (globalThis.GPUBuffer?.prototype?.destroy) {
      const origBufDestroy = globalThis.GPUBuffer.prototype.destroy;
      globalThis.GPUBuffer.prototype.destroy = function() {
        if (this.__gpuAuditBufId !== undefined && state.buffers[this.__gpuAuditBufId]) {
          state.buffers[this.__gpuAuditBufId].destroyed = true;
        }
        return origBufDestroy.call(this);
      };
    }

    const proto = globalThis.GPUDevice?.prototype;
    if (proto) {
      const origCreateTexture = proto.createTexture;
      if (origCreateTexture) {
        proto.createTexture = function(desc = {}) {
          const tex = origCreateTexture.call(this, desc);
          let w = 1, h = 1, d = 1;
          const sz = desc.size;
          if (Array.isArray(sz)) {
            w = sz[0] ?? 1; h = sz[1] ?? 1; d = sz[2] ?? 1;
          } else if (sz && typeof sz === "object") {
            w = sz.width ?? 1; h = sz.height ?? 1; d = sz.depthOrArrayLayers ?? 1;
          }
          const id = state.textures.length;
          state.textures.push({
            id,
            label: desc.label || null,
            width: Number(w) || 1,
            height: Number(h) || 1,
            depthOrArrayLayers: Number(d) || 1,
            mipLevelCount: Number(desc.mipLevelCount ?? 1) || 1,
            sampleCount: Number(desc.sampleCount ?? 1) || 1,
            dimension: desc.dimension || "2d",
            format: desc.format || "unknown",
            usage: Number(desc.usage ?? 0),
            destroyed: false,
            sampledInBindGroup: false,
            renderedAsColor: false,
            renderedAsDepth: false
          });
          texToId.set(tex, id);
          state.currentFrame.texturesCreated += 1;
          return tex;
        };
      }

      const origCreateSampler = proto.createSampler;
      if (origCreateSampler) {
        proto.createSampler = function(desc = {}) {
          const smp = origCreateSampler.call(this, desc);
          state.samplers.push({
            id: state.samplers.length,
            label: desc?.label || null,
            magFilter: desc?.magFilter || "nearest",
            minFilter: desc?.minFilter || "nearest",
            mipmapFilter: desc?.mipmapFilter || "nearest",
            maxAnisotropy: Number(desc?.maxAnisotropy ?? 1) || 1,
            compare: desc?.compare || null
          });
          return smp;
        };
      }

      const origCreateBuffer = proto.createBuffer;
      if (origCreateBuffer) {
        proto.createBuffer = function(desc = {}) {
          const buf = origCreateBuffer.call(this, desc);
          const id = state.buffers.length;
          state.buffers.push({
            id,
            label: desc?.label || null,
            size: Number(desc?.size ?? 0) || 0,
            usage: Number(desc?.usage ?? 0),
            mappedAtCreation: Boolean(desc?.mappedAtCreation),
            destroyed: false
          });
          try { buf.__gpuAuditBufId = id; } catch {}
          state.currentFrame.buffersCreated += 1;
          return buf;
        };
      }

      const origCreateShader = proto.createShaderModule;
      if (origCreateShader) {
        proto.createShaderModule = function(desc = {}) {
          const mod = origCreateShader.call(this, desc);
          const id = state.shaders.length;
          state.shaders.push({
            id,
            label: desc?.label || null,
            code: String(desc?.code || "")
          });
          try { mod.__gpuAuditShaderId = id; } catch {}
          return mod;
        };
      }

      const recordRenderPipeline = (pipe, desc, sync) => {
        const vbs = Array.from(desc?.vertex?.buffers || []).filter(Boolean).map((vb) => ({
          arrayStride: Number(vb.arrayStride ?? 0),
          stepMode: vb.stepMode || "vertex",
          attributes: Array.from(vb.attributes || []).map((a) => ({
            shaderLocation: Number(a.shaderLocation ?? 0),
            offset: Number(a.offset ?? 0),
            format: String(a.format || "")
          }))
        }));
        const targets = Array.from(desc?.fragment?.targets || []).filter(Boolean).map((t) => ({
          format: t.format || null,
          hasBlend: Boolean(t.blend),
          writeMask: t.writeMask ?? 0xF
        }));
        const hasOverrides = Boolean(
          (desc?.vertex?.constants && Object.keys(desc.vertex.constants).length) ||
          (desc?.fragment?.constants && Object.keys(desc.fragment.constants).length)
        );
        const meta = {
          id: state.pipelines.length,
          kind: "render",
          sync,
          label: desc?.label || null,
          vertexShaderId: desc?.vertex?.module?.__gpuAuditShaderId ?? null,
          fragmentShaderId: desc?.fragment?.module?.__gpuAuditShaderId ?? null,
          vertexBuffers: vbs,
          targets,
          depthStencilFormat: desc?.depthStencil?.format || null,
          depthWriteEnabled: Boolean(desc?.depthStencil?.depthWriteEnabled),
          depthCompare: desc?.depthStencil?.depthCompare || null,
          sampleCount: Number(desc?.multisample?.count ?? 1) || 1,
          cullMode: desc?.primitive?.cullMode || "none",
          topology: desc?.primitive?.topology || "triangle-list",
          hasOverrides
        };
        state.pipelines.push(meta);
        if (pipe) pipeToMeta.set(pipe, meta);
      };

      const origCreateRP = proto.createRenderPipeline;
      if (origCreateRP) {
        proto.createRenderPipeline = function(desc = {}) {
          const pipe = origCreateRP.call(this, desc);
          recordRenderPipeline(pipe, desc, true);
          return pipe;
        };
      }
      const origCreateRPAsync = proto.createRenderPipelineAsync;
      if (origCreateRPAsync) {
        proto.createRenderPipelineAsync = async function(desc = {}) {
          const pipe = await origCreateRPAsync.call(this, desc);
          recordRenderPipeline(pipe, desc, false);
          return pipe;
        };
      }

      const recordComputePipeline = (pipe, desc, sync) => {
        const hasOverrides = Boolean(desc?.compute?.constants && Object.keys(desc.compute.constants).length);
        const meta = {
          id: state.pipelines.length,
          kind: "compute",
          sync,
          label: desc?.label || null,
          computeShaderId: desc?.compute?.module?.__gpuAuditShaderId ?? null,
          entryPoint: desc?.compute?.entryPoint || null,
          hasOverrides
        };
        state.pipelines.push(meta);
        if (pipe) pipeToMeta.set(pipe, meta);
      };

      const origCreateCP = proto.createComputePipeline;
      if (origCreateCP) {
        proto.createComputePipeline = function(desc = {}) {
          const pipe = origCreateCP.call(this, desc);
          recordComputePipeline(pipe, desc, true);
          return pipe;
        };
      }
      const origCreateCPAsync = proto.createComputePipelineAsync;
      if (origCreateCPAsync) {
        proto.createComputePipelineAsync = async function(desc = {}) {
          const pipe = await origCreateCPAsync.call(this, desc);
          recordComputePipeline(pipe, desc, false);
          return pipe;
        };
      }

      const origCreateBG = proto.createBindGroup;
      if (origCreateBG) {
        proto.createBindGroup = function(desc = {}) {
          const bg = origCreateBG.call(this, desc);
          state.totalBindGroupsCreated += 1;
          state.currentFrame.bindGroupsCreated += 1;
          for (const entry of (desc?.entries || [])) {
            const res = entry?.resource;
            const tid = res ? (viewToTexId.get(res) ?? texToId.get(res)) : undefined;
            if (typeof tid === "number" && tid >= 0 && state.textures[tid]) {
              state.textures[tid].sampledInBindGroup = true;
            }
          }
          return bg;
        };
      }

      const origCreateEncoder = proto.createCommandEncoder;
      if (origCreateEncoder) {
        proto.createCommandEncoder = function(encDesc) {
          const enc = origCreateEncoder.call(this, encDesc);
          if (enc?.beginRenderPass) {
            const origBeginRP = enc.beginRenderPass;
            enc.beginRenderPass = function(rpDesc = {}) {
              const pass = origBeginRP.call(this, rpDesc);
              const colors = Array.from(rpDesc?.colorAttachments || []).filter(Boolean).map((ca) => {
                const tid = ca.view ? (viewToTexId.get(ca.view) ?? texToId.get(ca.view)) : undefined;
                const isCanvas = typeof tid === "number" && tid < 0;
                const texMeta = (typeof tid === "number" && tid >= 0) ? state.textures[tid] : null;
                if (texMeta) texMeta.renderedAsColor = true;
                return {
                  texId: typeof tid === "number" && tid >= 0 ? tid : null,
                  isCanvas,
                  format: texMeta?.format || null,
                  width: texMeta?.width || null,
                  height: texMeta?.height || null,
                  sampleCount: texMeta?.sampleCount || 1,
                  hasResolveTarget: Boolean(ca.resolveTarget),
                  loadOp: ca.loadOp || null,
                  storeOp: ca.storeOp || null
                };
              });
              let ds = null;
              if (rpDesc?.depthStencilAttachment) {
                const dsa = rpDesc.depthStencilAttachment;
                const tid = dsa.view ? (viewToTexId.get(dsa.view) ?? texToId.get(dsa.view)) : undefined;
                const texMeta = (typeof tid === "number" && tid >= 0) ? state.textures[tid] : null;
                if (texMeta) texMeta.renderedAsDepth = true;
                ds = {
                  texId: typeof tid === "number" && tid >= 0 ? tid : null,
                  format: texMeta?.format || null,
                  width: texMeta?.width || null,
                  height: texMeta?.height || null,
                  sampleCount: texMeta?.sampleCount || 1,
                  depthLoadOp: dsa.depthLoadOp || null,
                  depthStoreOp: dsa.depthStoreOp || null,
                  stencilLoadOp: dsa.stencilLoadOp || null,
                  stencilStoreOp: dsa.stencilStoreOp || null
                };
              }
              const passRec = {
                kind: "render",
                label: rpDesc?.label || null,
                colorAttachments: colors,
                depthStencilAttachment: ds,
                draws: 0,
                indirectDraws: 0,
                bundles: 0,
                pipelineSwitches: 0,
                bindGroupCalls: 0,
                pipelineIds: []
              };
              let lastPipe = null;
              for (const fnName of ["draw", "drawIndexed"]) {
                if (typeof pass[fnName] === "function") {
                  const orig = pass[fnName];
                  pass[fnName] = function(...a) { passRec.draws += 1; return orig.apply(this, a); };
                }
              }
              for (const fnName of ["drawIndirect", "drawIndexedIndirect"]) {
                if (typeof pass[fnName] === "function") {
                  const orig = pass[fnName];
                  pass[fnName] = function(...a) { passRec.draws += 1; passRec.indirectDraws += 1; return orig.apply(this, a); };
                }
              }
              if (typeof pass.executeBundles === "function") {
                const orig = pass.executeBundles;
                pass.executeBundles = function(bundles) {
                  const list = Array.from(bundles || []);
                  passRec.bundles += list.length;
                  return orig.call(this, bundles);
                };
              }
              if (typeof pass.setPipeline === "function") {
                const orig = pass.setPipeline;
                pass.setPipeline = function(p) {
                  if (p !== lastPipe) {
                    passRec.pipelineSwitches += 1;
                    lastPipe = p;
                    const meta = pipeToMeta.get(p);
                    if (meta && passRec.pipelineIds.length < 16 && !passRec.pipelineIds.includes(meta.id)) {
                      passRec.pipelineIds.push(meta.id);
                    }
                  }
                  return orig.call(this, p);
                };
              }
              if (typeof pass.setBindGroup === "function") {
                const orig = pass.setBindGroup;
                pass.setBindGroup = function(...a) { passRec.bindGroupCalls += 1; return orig.apply(this, a); };
              }
              state.currentFrame.passes.push(passRec);
              if (state.fallbackPasses.length < 96) state.fallbackPasses.push(passRec);
              return pass;
            };
          }

          if (enc?.beginComputePass) {
            const origBeginCP = enc.beginComputePass;
            enc.beginComputePass = function(cpDesc = {}) {
              const pass = origBeginCP.call(this, cpDesc);
              const passRec = {
                kind: "compute",
                label: cpDesc?.label || null,
                dispatches: 0,
                indirectDispatches: 0,
                pipelineSwitches: 0,
                bindGroupCalls: 0,
                pipelineIds: []
              };
              let lastPipe = null;
              if (typeof pass.dispatchWorkgroups === "function") {
                const orig = pass.dispatchWorkgroups;
                pass.dispatchWorkgroups = function(...a) { passRec.dispatches += 1; return orig.apply(this, a); };
              }
              if (typeof pass.dispatchWorkgroupsIndirect === "function") {
                const orig = pass.dispatchWorkgroupsIndirect;
                pass.dispatchWorkgroupsIndirect = function(...a) {
                  passRec.dispatches += 1;
                  passRec.indirectDispatches += 1;
                  return orig.apply(this, a);
                };
              }
              if (typeof pass.setPipeline === "function") {
                const orig = pass.setPipeline;
                pass.setPipeline = function(p) {
                  if (p !== lastPipe) {
                    passRec.pipelineSwitches += 1;
                    lastPipe = p;
                    const meta = pipeToMeta.get(p);
                    if (meta && passRec.pipelineIds.length < 16 && !passRec.pipelineIds.includes(meta.id)) {
                      passRec.pipelineIds.push(meta.id);
                    }
                  }
                  return orig.call(this, p);
                };
              }
              if (typeof pass.setBindGroup === "function") {
                const orig = pass.setBindGroup;
                pass.setBindGroup = function(...a) { passRec.bindGroupCalls += 1; return orig.apply(this, a); };
              }
              state.currentFrame.passes.push(passRec);
              if (state.fallbackPasses.length < 96) state.fallbackPasses.push(passRec);
              return pass;
            };
          }
          return enc;
        };
      }
    }

    if (globalThis.GPUQueue?.prototype) {
      const qProto = globalThis.GPUQueue.prototype;
      if (qProto.submit) {
        const origSubmit = qProto.submit;
        qProto.submit = function(cmdBuffers) {
          state.currentFrame.submits += 1;
          return origSubmit.call(this, cmdBuffers);
        };
      }
      if (qProto.writeBuffer) {
        const origWriteBuf = qProto.writeBuffer;
        qProto.writeBuffer = function(buffer, bufferOffset, data, dataOffset, size) {
          state.currentFrame.writeBufferCalls += 1;
          const byteLen = typeof size === "number" ? size : (data?.byteLength ?? 0);
          state.currentFrame.writeBufferBytes += Number(byteLen) || 0;
          return origWriteBuf.call(this, buffer, bufferOffset, data, dataOffset, size);
        };
      }
    }

    globalThis.__gpuPerfDeepAudit = {
      collect() {
        const steadyFrame = state.lastCompletedFrame || (state.currentFrame.passes.length ? state.currentFrame : null);
        return {
          viewport: { width: globalThis.innerWidth || 1280, height: globalThis.innerHeight || 720, dpr: globalThis.devicePixelRatio || 1 },
          adapter: state.adapter,
          wgslFeatures: state.wgslFeatures,
          devices: state.devices,
          textures: state.textures,
          samplers: state.samplers,
          buffers: state.buffers,
          shaders: state.shaders,
          pipelines: state.pipelines,
          totalBindGroupsCreated: state.totalBindGroupsCreated,
          frameIndex: state.frameIndex,
          steadyFrame: steadyFrame || {
            passes: state.fallbackPasses,
            submits: state.currentFrame.submits,
            bindGroupsCreated: 0,
            writeBufferCalls: 0,
            writeBufferBytes: 0,
            texturesCreated: 0,
            buffersCreated: 0
          }
        };
      }
    };
  })();`;
}

const BLOCK_FORMATS = new Map([
  ["bc1-rgba-unorm", [4, 4, 8]], ["bc1-rgba-unorm-srgb", [4, 4, 8]],
  ["bc2-rgba-unorm", [4, 4, 16]], ["bc2-rgba-unorm-srgb", [4, 4, 16]],
  ["bc3-rgba-unorm", [4, 4, 16]], ["bc3-rgba-unorm-srgb", [4, 4, 16]],
  ["bc4-r-unorm", [4, 4, 8]], ["bc4-r-snorm", [4, 4, 8]],
  ["bc5-rg-unorm", [4, 4, 16]], ["bc5-rg-snorm", [4, 4, 16]],
  ["bc6h-rgb-ufloat", [4, 4, 16]], ["bc6h-rgb-float", [4, 4, 16]],
  ["bc7-rgba-unorm", [4, 4, 16]], ["bc7-rgba-unorm-srgb", [4, 4, 16]],
  ["etc2-rgb8unorm", [4, 4, 8]], ["etc2-rgb8unorm-srgb", [4, 4, 8]],
  ["etc2-rgb8a1unorm", [4, 4, 8]], ["etc2-rgb8a1unorm-srgb", [4, 4, 8]],
  ["etc2-rgba8unorm", [4, 4, 16]], ["etc2-rgba8unorm-srgb", [4, 4, 16]],
  ["eac-r11unorm", [4, 4, 8]], ["eac-r11snorm", [4, 4, 8]],
  ["eac-rg11unorm", [4, 4, 16]], ["eac-rg11snorm", [4, 4, 16]]
]);

export function formatBytesPerPixel(format = "") {
  const f = String(format).toLowerCase();
  if (/^(?:r8|stencil8)/.test(f)) return 1;
  if (/^(?:r16|rg8|depth16)/.test(f)) return 2;
  if (/^(?:r32|rg16|rgba8|bgra8|rgb10a2|rg11b10|rgb9e5|depth24|depth32float$)/.test(f)) return 4;
  if (f === "depth24plus-stencil8") return 4;
  if (f === "depth32float-stencil8") return 5;
  if (/^(?:rg32|rgba16)/.test(f)) return 8;
  if (/^rgba32/.test(f)) return 16;
  return 4;
}

export function isCompressedTextureFormat(format = "") {
  const f = String(format).toLowerCase();
  return f.startsWith("astc-") || f.startsWith("bc") || f.startsWith("etc2-") || f.startsWith("eac-");
}

export function estimateTextureBytes(tex = {}) {
  const fmt = String(tex.format || "").toLowerCase();
  let blockInfo = BLOCK_FORMATS.get(fmt);
  if (!blockInfo && fmt.startsWith("astc-")) {
    const m = /^astc-(\d+)x(\d+)-/.exec(fmt);
    blockInfo = m ? [Number(m[1]), Number(m[2]), 16] : [4, 4, 16];
  }
  const mips = Math.max(1, Number(tex.mipLevelCount ?? 1));
  const layers = Math.max(1, Number(tex.depthOrArrayLayers ?? 1));
  const samples = Math.max(1, Number(tex.sampleCount ?? 1));
  const is3D = tex.dimension === "3d";

  let total = 0;
  for (let mip = 0; mip < mips; mip += 1) {
    const mw = Math.max(1, Math.floor((tex.width || 1) / (1 << mip)));
    const mh = Math.max(1, Math.floor((tex.height || 1) / (1 << mip)));
    const md = is3D ? Math.max(1, Math.floor(layers / (1 << mip))) : layers;
    if (blockInfo) {
      const [bw, bh, bBytes] = blockInfo;
      const blocksX = Math.ceil(mw / bw);
      const blocksY = Math.ceil(mh / bh);
      total += blocksX * blocksY * md * bBytes;
    } else {
      total += mw * mh * md * formatBytesPerPixel(fmt) * samples;
    }
  }
  return total;
}

/**
 * Pure structural & TBDR bandwidth analyzer over a collected WebGPU audit snapshot.
 */
export function analyzeAuditSnapshot(snapshot = {}) {
  const liveTextures = (snapshot.textures || []).filter((t) => !t.destroyed);
  const liveBuffers = (snapshot.buffers || []).filter((b) => !b.destroyed);
  const samplers = snapshot.samplers || [];
  const shaders = snapshot.shaders || [];
  const pipelines = snapshot.pipelines || [];
  const steady = snapshot.steadyFrame || { passes: [], submits: 0, bindGroupsCreated: 0, writeBufferCalls: 0, writeBufferBytes: 0 };
  const passes = steady.passes || [];

  const texById = new Map(liveTextures.map((t) => [t.id, t]));
  let totalTextureBytes = 0;
  for (const t of liveTextures) {
    t.estimatedBytes = estimateTextureBytes(t);
    totalTextureBytes += t.estimatedBytes;
  }
  const totalBufferBytes = liveBuffers.reduce((acc, b) => acc + (b.size || 0), 0);

  // Analyze shaders & deduplication
  const hashCounts = new Map();
  let duplicateShaderCount = 0;
  let totalDiscards = 0;
  const shaderSummaries = shaders.map((s) => {
    const hash = createHash("sha256").update(s.code || "").digest("hex").slice(0, 12);
    const prev = hashCounts.get(hash) || 0;
    if (prev > 0) duplicateShaderCount += 1;
    hashCounts.set(hash, prev + 1);
    const stat = analyzeShaderStatic(s.code || "", { language: "wgsl" });
    totalDiscards += stat.counts.discards;
    return {
      id: s.id,
      label: s.label,
      hash,
      lines: stat.counts.lines,
      usesF16: stat.usesF16,
      usesSubgroups: stat.usesSubgroups,
      entryPoints: stat.entryPoints,
      hazards: stat.hazards
    };
  });

  const findings = [];

  // 1. TBDR MSAA color storeOp: "store" leak
  let msaaLeakBytes = 0;
  const msaaLeakPasses = [];
  for (const p of passes) {
    if (p.kind !== "render") continue;
    for (const ca of (p.colorAttachments || [])) {
      if (ca.hasResolveTarget && ca.sampleCount > 1 && ca.storeOp === "store") {
        const w = ca.width || snapshot.viewport?.width || 1280;
        const h = ca.height || snapshot.viewport?.height || 720;
        msaaLeakBytes += w * h * ca.sampleCount * formatBytesPerPixel(ca.format || "rgba8unorm");
        msaaLeakPasses.push(p.label || "unnamed-pass");
      }
    }
  }
  if (msaaLeakBytes > 0) {
    findings.push({
      code: "tbdr-msaa-store-leak",
      severity: "high",
      category: "tbdr-bandwidth",
      estimatedSavingsBytesPerFrame: msaaLeakBytes,
      message: `${msaaLeakPasses.length} multisampled color attachment(s) (${msaaLeakPasses.slice(0, 3).join(", ")}) specify a resolveTarget AND storeOp: "store", flushing ~${formatMiB(msaaLeakBytes)}/frame of MSAA tile samples to DRAM.`,
      fix: "Set storeOp: \"discard\" on every multisampled color attachment that resolves via resolveTarget so MSAA samples stay 100% inside Apple GPU Tile Memory."
    });
  }

  // 2. TBDR transient depth storeOp: "store" leak
  let depthLeakBytes = 0;
  const depthLeakPasses = [];
  for (const p of passes) {
    if (p.kind !== "render" || !p.depthStencilAttachment) continue;
    const ds = p.depthStencilAttachment;
    const tex = ds.texId != null ? texById.get(ds.texId) : null;
    const neverSampled = tex ? !tex.sampledInBindGroup : false;
    if (neverSampled && ds.depthLoadOp === "clear" && ds.depthStoreOp === "store") {
      const w = ds.width || tex?.width || snapshot.viewport?.width || 1280;
      const h = ds.height || tex?.height || snapshot.viewport?.height || 720;
      const samples = ds.sampleCount || tex?.sampleCount || 1;
      depthLeakBytes += w * h * samples * formatBytesPerPixel(ds.format || "depth24plus");
      depthLeakPasses.push(p.label || tex?.label || "depth-pass");
    }
  }
  if (depthLeakBytes > 0) {
    findings.push({
      code: "tbdr-transient-depth-store-leak",
      severity: "high",
      category: "tbdr-bandwidth",
      estimatedSavingsBytesPerFrame: depthLeakBytes,
      message: `${depthLeakPasses.length} render pass(es) (${depthLeakPasses.slice(0, 3).join(", ")}) clear a transient depth attachment (never sampled in any bind group) yet write it back to DRAM with depthStoreOp: "store" (~${formatMiB(depthLeakBytes)}/frame).`,
      fix: "Set depthStoreOp: \"discard\" (and stencilStoreOp: \"discard\") on transient depth buffers so depth stays strictly in on-chip Tile Memory (0 B DRAM traffic)."
    });
  }

  // 3. Opaque depth pre-pass candidate on Apple TBDR
  const vpPixels = Math.max(1, (snapshot.viewport?.width || 1280) * (snapshot.viewport?.height || 720));
  const depthPrepasses = passes.filter((p) => {
    if (p.kind !== "render" || (p.colorAttachments?.length || 0) !== 0 || !p.depthStencilAttachment) return false;
    const ds = p.depthStencilAttachment;
    const tex = ds.texId != null ? texById.get(ds.texId) : null;
    // Exclude shadow maps (which are sampled in bind groups by later lighting passes!)
    if (tex?.sampledInBindGroup) return false;
    const px = (ds.width || vpPixels) * (ds.height || 1);
    return p.draws >= 4 && px >= vpPixels * 0.5;
  });
  if (depthPrepasses.length > 0 && totalDiscards === 0) {
    findings.push({
      code: "tbdr-opaque-depth-prepass",
      severity: "medium",
      category: "tbdr-bandwidth",
      message: `Detected ${depthPrepasses.length} non-sampled depth-only pre-pass(es) (${depthPrepasses.reduce((a, p) => a + p.draws, 0)} draws) with 0 discard shaders. Apple TBDR GPUs perform hardware Hidden Surface Removal (HSR) before fragment shading automatically.`,
      fix: "Run an A/B test (`gpu-perf-agent ab`) skipping the opaque Z-prepass on Apple Silicon to eliminate duplicate vertex shading and tiler Parameter Buffer pressure (`agx` Tiler%)."
    });
  }

  // 4. Back-to-back single-draw full-screen pass chain (pass fusion opportunity)
  let maxFsChain = 0;
  let curChain = 0;
  for (const p of passes) {
    if (p.kind === "render" && p.draws === 1 && p.colorAttachments?.length === 1 && !p.depthStencilAttachment) {
      curChain += 1;
      if (curChain > maxFsChain) maxFsChain = curChain;
    } else {
      curChain = 0;
    }
  }
  if (maxFsChain >= 3) {
    findings.push({
      code: "pass-fusion-fullscreen-chain",
      severity: "medium",
      category: "tbdr-bandwidth",
      message: `Frame executes ${maxFsChain} consecutive single-draw full-screen render passes, forcing intermediate render targets to round-trip through unified DRAM.`,
      fix: "Fuse adjacent full-screen post-processing steps (tonemap + color grade + vignette + grain + FXAA) into a single pass, or evaluate half-resolution compute for blur/AO/bloom."
    });
  }

  // 5. Missing mipmaps on sampled >= 512x512 2D textures
  const unmippedSampled = liveTextures.filter((t) =>
    t.dimension === "2d" &&
    t.width >= 512 &&
    t.height >= 512 &&
    t.mipLevelCount === 1 &&
    (t.usage & GPU_TEXTURE_USAGE.TEXTURE_BINDING) !== 0 &&
    (t.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0 &&
    (t.usage & GPU_TEXTURE_USAGE.STORAGE_BINDING) === 0 &&
    !/depth|stencil/.test(t.format)
  );
  if (unmippedSampled.length > 0) {
    const bytes = unmippedSampled.reduce((a, t) => a + t.estimatedBytes, 0);
    findings.push({
      code: "texture-missing-mipmaps",
      severity: bytes >= 8 * 1024 * 1024 ? "high" : "medium",
      category: "texture-bandwidth",
      message: `${unmippedSampled.length} sampled 2D texture(s) >= 512x512 (${formatMiB(bytes)} total) have mipLevelCount = 1, causing severe L1 texture cache thrashing and aliasing under minification.`,
      fix: "Generate full mipchains offline in KTX2 (`ktx create --generate-mipmap`) or via a single startup downsample pass."
    });
  }

  // 6. Uncompressed static sampled rgba8/bgra8 textures >= 512x512
  const uncompressedStatic = liveTextures.filter((t) =>
    t.dimension === "2d" &&
    t.width >= 512 &&
    t.height >= 512 &&
    /^(?:rgba8unorm|bgra8unorm)(?:-srgb)?$/i.test(t.format) &&
    (t.usage & GPU_TEXTURE_USAGE.TEXTURE_BINDING) !== 0 &&
    (t.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0 &&
    (t.usage & GPU_TEXTURE_USAGE.STORAGE_BINDING) === 0
  );
  if (uncompressedStatic.length > 0) {
    const bytes = uncompressedStatic.reduce((a, t) => a + t.estimatedBytes, 0);
    const estSavings = Math.round(bytes * 0.75);
    findings.push({
      code: "texture-uncompressed-static",
      severity: bytes >= 16 * 1024 * 1024 ? "high" : "medium",
      category: "texture-bandwidth",
      estimatedSavingsBytes: estSavings,
      message: `${uncompressedStatic.length} static sampled RGBA8 texture(s) >= 512x512 consume ${formatMiB(bytes)} uncompressed (~${formatMiB(estSavings)} savable with GPU block compression).`,
      fix: "Transcode static color/normal/ORM maps to KTX2 UASTC + Zstd (`ktx create --encode uastc --zstd 18`) and upload directly to hardware `astc-4x4` or `bc7` (4x less VRAM & sample bandwidth on Apple Silicon)."
    });
  }

  // 7. Offscreen rgba16float render targets -> rg11b10ufloat candidate
  const hdr16Targets = liveTextures.filter((t) =>
    t.format === "rgba16float" &&
    (t.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) !== 0 &&
    t.width >= 256 &&
    t.height >= 256
  );
  if (hdr16Targets.length > 0) {
    const bytes = hdr16Targets.reduce((a, t) => a + t.estimatedBytes, 0);
    findings.push({
      code: "render-target-rgba16float-bandwidth",
      severity: "medium",
      category: "texture-bandwidth",
      estimatedSavingsBytes: Math.round(bytes * 0.5),
      message: `${hdr16Targets.length} render target(s) use rgba16float (8 B/px, ${formatMiB(bytes)} total).`,
      fix: "Where HDR alpha is not needed (scene color, bloom, lighting), enable `\"rg11b10ufloat-renderable\"` and use `rg11b10ufloat` (4 B/px) to halve bandwidth and double effective tile memory capacity."
    });
  }

  // 8. High anisotropy samplers
  const highAniso = samplers.filter((s) => s.maxAnisotropy > 4);
  if (highAniso.length > 0) {
    findings.push({
      code: "sampler-high-anisotropy",
      severity: "low",
      category: "texture-bandwidth",
      message: `${highAniso.length} sampler(s) use maxAnisotropy > 4 (max=${Math.max(...highAniso.map((s) => s.maxAnisotropy))}), multiplying texture sample taps at grazing angles.`,
      fix: "Cap maxAnisotropy at 4 for general materials and reserve 8-16 strictly for hero ground planes."
    });
  }

  // 9. Synchronous pipeline compilation
  const syncPipelines = pipelines.filter((p) => p.sync);
  if (syncPipelines.length >= 3) {
    findings.push({
      code: "pipeline-sync-compilation",
      severity: syncPipelines.length >= 10 ? "medium" : "low",
      category: "pipeline-shader",
      message: `${syncPipelines.length}/${pipelines.length} GPU pipelines were compiled synchronously via createRenderPipeline/createComputePipeline, blocking Dawn/Metal compilation serially.`,
      fix: "Compile pipelines concurrently at load time with `Promise.all([...device.createRenderPipelineAsync(...)])` and specialize variants with WGSL `override` constants."
    });
  }

  // 10. Duplicate shader modules
  if (duplicateShaderCount > 0) {
    findings.push({
      code: "shader-duplicate-modules",
      severity: "low",
      category: "pipeline-shader",
      message: `${duplicateShaderCount} createShaderModule call(s) compiled duplicate identical WGSL source strings.`,
      fix: "Cache GPUShaderModule instances by WGSL content hash and share them across pipelines."
    });
  }

  // 11. Propagate high/medium static shader hazards
  const shaderHazardCounts = new Map();
  for (const sh of shaderSummaries) {
    for (const h of sh.hazards) {
      if (h.severity === "high" || h.severity === "medium") {
        const entry = shaderHazardCounts.get(h.code) || { count: 0, sample: h, labels: [] };
        entry.count += 1;
        if (sh.label && entry.labels.length < 3) entry.labels.push(sh.label);
        shaderHazardCounts.set(h.code, entry);
      }
    }
  }
  for (const [code, info] of shaderHazardCounts.entries()) {
    findings.push({
      code: `shader-${code}`,
      severity: info.sample.severity,
      category: "pipeline-shader",
      message: `${info.count} shader module(s)${info.labels.length ? ` (${info.labels.join(", ")})` : ""}: ${info.sample.message}`,
      fix: info.sample.fix
    });
  }

  // 12. Unpacked vertex attributes (float32x2/3/4 on non-position attributes)
  const unpackedVertexPipelines = pipelines.filter((p) => {
    if (p.kind !== "render") return false;
    const totalStride = (p.vertexBuffers || []).reduce((a, vb) => a + (vb.arrayStride || 0), 0);
    if (totalStride < 32) return false;
    return (p.vertexBuffers || []).some((vb) =>
      (vb.attributes || []).some((attr) => attr.shaderLocation >= 1 && /^float32x[234]$/.test(attr.format))
    );
  });
  if (unpackedVertexPipelines.length > 0) {
    findings.push({
      code: "vertex-unpacked-attributes",
      severity: "medium",
      category: "vertex-layout",
      message: `${unpackedVertexPipelines.length} render pipeline(s) fetch unpacked float32x2/3/4 secondary vertex attributes (stride >= 32 B/vertex).`,
      fix: "Pack normals/tangents into `snorm16x4` or octahedral `snorm16x2`, UVs into `float16x2` / `unorm16x2`, and vertex colors into `unorm8x4` (halving vertex fetch & TBDR Parameter Buffer pressure)."
    });
  }

  // 13. Per-frame bind group or resource churn
  if ((steady.bindGroupsCreated || 0) > 0 && (snapshot.frameIndex || 0) >= 3) {
    findings.push({
      code: "per-frame-bindgroup-churn",
      severity: steady.bindGroupsCreated >= 16 ? "high" : "medium",
      category: "pipeline-shader",
      message: `Steady-state frame allocates ${steady.bindGroupsCreated} new GPUBindGroup object(s) per frame (${snapshot.totalBindGroupsCreated} total created).`,
      fix: "Cache GPUBindGroups on material/mesh init and vary per-draw transforms using dynamic uniform buffer offsets (`hasDynamicOffset: true`, 256-byte aligned)."
    });
  }
  if (((steady.texturesCreated || 0) > 0 || (steady.buffersCreated || 0) > 0) && (snapshot.frameIndex || 0) >= 3) {
    findings.push({
      code: "per-frame-resource-allocation",
      severity: "high",
      category: "tbdr-bandwidth",
      message: `Steady-state frame allocates ${steady.texturesCreated || 0} texture(s) and ${steady.buffersCreated || 0} buffer(s) inside the render loop.`,
      fix: "Pool transient render targets and ring-buffer uniform/staging GPUBuffers outside `requestAnimationFrame`."
    });
  }

  // 14. Multiple queue.submit calls per frame
  if ((steady.submits || 0) >= 3) {
    findings.push({
      code: "multiple-queue-submits-per-frame",
      severity: steady.submits >= 6 ? "medium" : "low",
      category: "pipeline-shader",
      message: `Frame calls queue.submit() ${steady.submits} times instead of batching passes into a single submission.`,
      fix: "Encode passes on one GPUCommandEncoder (or submit an array `queue.submit([cmdA, cmdB])` once at frame end) to minimize Dawn/Metal submission overhead."
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));

  const renderPasses = passes.filter((p) => p.kind === "render");
  const computePasses = passes.filter((p) => p.kind === "compute");

  return {
    adapter: snapshot.adapter || null,
    wgslFeatures: snapshot.wgslFeatures || [],
    viewport: snapshot.viewport || null,
    resources: {
      liveTextures: liveTextures.length,
      estimatedTextureBytes: totalTextureBytes,
      compressedTextures: liveTextures.filter((t) => isCompressedTextureFormat(t.format)).length,
      samplers: samplers.length,
      liveBuffers: liveBuffers.length,
      totalBufferBytes,
      shaderModules: shaders.length,
      duplicateShaderModules: duplicateShaderCount,
      f16ShaderModules: shaderSummaries.filter((s) => s.usesF16).length,
      subgroupShaderModules: shaderSummaries.filter((s) => s.usesSubgroups).length,
      renderPipelines: pipelines.filter((p) => p.kind === "render").length,
      computePipelines: pipelines.filter((p) => p.kind === "compute").length,
      syncPipelines: syncPipelines.length
    },
    frameTopology: {
      observedFrames: snapshot.frameIndex || 0,
      renderPasses: renderPasses.length,
      computePasses: computePasses.length,
      draws: renderPasses.reduce((a, p) => a + (p.draws || 0), 0),
      indirectDraws: renderPasses.reduce((a, p) => a + (p.indirectDraws || 0), 0),
      renderBundles: renderPasses.reduce((a, p) => a + (p.bundles || 0), 0),
      dispatches: computePasses.reduce((a, p) => a + (p.dispatches || 0), 0),
      indirectDispatches: computePasses.reduce((a, p) => a + (p.indirectDispatches || 0), 0),
      submits: steady.submits || 0,
      perFrameBindGroupsCreated: steady.bindGroupsCreated || 0,
      perFrameWriteBufferCalls: steady.writeBufferCalls || 0,
      perFrameWriteBufferBytes: steady.writeBufferBytes || 0,
      passes: passes.slice(0, 32).map((p, idx) => (
        p.kind === "render"
          ? {
            index: idx,
            kind: "render",
            label: p.label,
            draws: p.draws,
            indirectDraws: p.indirectDraws,
            bundles: p.bundles,
            pipelineSwitches: p.pipelineSwitches,
            colors: (p.colorAttachments || []).map((c) => `${c.isCanvas ? "canvas" : (c.format || "tex")}${c.sampleCount > 1 ? `@${c.sampleCount}x` : ""}[${c.loadOp}->${c.storeOp}${c.hasResolveTarget ? "+resolve" : ""}]`),
            depth: p.depthStencilAttachment
              ? `${p.depthStencilAttachment.format || "depth"}[${p.depthStencilAttachment.depthLoadOp}->${p.depthStencilAttachment.depthStoreOp}]`
              : null
          }
          : {
            index: idx,
            kind: "compute",
            label: p.label,
            dispatches: p.dispatches,
            indirectDispatches: p.indirectDispatches,
            pipelineSwitches: p.pipelineSwitches
          }
      ))
    },
    findings,
    shaders: shaderSummaries
  };
}

/**
 * Launch Chrome via FastCDPHarness, run the target WebGPU page to steady state,
 * and return a structural + Apple TBDR optimization audit.
 */
export async function auditWebGPUPage(options = {}, { harness: sharedHarness = null } = {}) {
  if (!options.url && !options.file) {
    throw Object.assign(new Error("Pass --url <URL> or --file <HTML> to audit."), { code: "invalid-options" });
  }
  if (options.url && options.file) {
    throw Object.assign(new Error("Choose --url or --file, not both."), { code: "invalid-options" });
  }

  let fileTarget = null;
  let targetUrl = options.url || null;
  if (options.file) {
    await assertFileTarget(options.file, { fileArg: options.file });
    fileTarget = await createFileTarget(options.file, { fileRoot: options.fileRoot });
    targetUrl = fileTarget.url;
  }

  const viewport = parseViewport(options.viewport || "1280x720");
  const dpr = Number(options.deviceScaleFactor ?? 1) || 1;
  const externalHarness = sharedHarness || options.harness || null;
  const harness = externalHarness || await FastCDPHarness.launch({
    channel: options.channel,
    executablePath: options.executablePath,
    headful: Boolean(options.headful),
    cdpUrl: options.cdpUrl || options.cdp,
    viewport: options.viewport || "1280x720",
    chromiumArgs: [
      "--enable-unsafe-webgpu",
      ...(options.chromiumArgs || [])
    ]
  });

  let browserContextId = null;
  let pageSession = null;
  try {
    const browserSession = harness.browserSession;
    const context = await browserSession.send("Target.createBrowserContext", { disposeOnDetach: true });
    browserContextId = context.browserContextId;
    const { targetId } = await browserSession.send("Target.createTarget", { browserContextId, url: "about:blank" });
    const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId, flatten: true });
    pageSession = browserSession.session(sessionId);

    await pageSession.send("Page.enable");
    await pageSession.send("Runtime.enable");
    await pageSession.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: dpr,
      mobile: false
    });
    await pageSession.send("Page.addScriptToEvaluateOnNewDocument", {
      source: deepAuditInitSource()
    });

    await pageSession.send("Page.navigate", { url: targetUrl });

    if (options.waitCondition) {
      const deadline = Date.now() + Math.max(500, Number(options.waitConditionTimeoutMs ?? 15000));
      while (Date.now() < deadline) {
        const res = await pageSession.send("Runtime.evaluate", {
          expression: `Boolean(${options.waitCondition})`,
          awaitPromise: true,
          returnByValue: true
        }).catch(() => null);
        if (res?.result?.value === true) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const settleMs = Math.max(200, Math.min(30000, Number(options.settleMs ?? 1500)));
    await new Promise((r) => setTimeout(r, settleMs));

    const evalRes = await pageSession.send("Runtime.evaluate", {
      expression: "JSON.stringify(globalThis.__gpuPerfDeepAudit ? globalThis.__gpuPerfDeepAudit.collect() : null)",
      returnByValue: true
    });

    const rawSnapshot = evalRes?.result?.value ? JSON.parse(evalRes.result.value) : {};
    const audit = analyzeAuditSnapshot(rawSnapshot);
    return {
      ok: true,
      targetUrl,
      file: options.file ? fileTarget?.file : null,
      ...audit
    };
  } finally {
    pageSession?.dispose?.();
    if (browserContextId) {
      await harness.browserSession.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    }
    if (!externalHarness) await harness.close().catch(() => {});
    if (fileTarget) await fileTarget.close().catch(() => {});
  }
}

export function formatAuditDigest(audit) {
  const r = audit.resources || {};
  const ft = audit.frameTopology || {};
  const ad = audit.adapter;
  const lines = [
    `WEBGPU DEEP AUDIT: ${audit.file || audit.targetUrl || "target"}`,
    `Adapter: ${ad ? `${ad.vendor || "gpu"}/${ad.architecture || "arch"} (${ad.features?.length || 0} GPU features, ${audit.wgslFeatures?.length || 0} WGSL extensions)` : "no WebGPU device requested"}`,
    `Resources: ${r.liveTextures ?? 0} tex (${formatMiB(r.estimatedTextureBytes || 0)}, ${r.compressedTextures ?? 0} compressed), ${r.liveBuffers ?? 0} buf (${formatMiB(r.totalBufferBytes || 0)}), ${r.shaderModules ?? 0} shaders (f16=${r.f16ShaderModules ?? 0}, subgroups=${r.subgroupShaderModules ?? 0}), ${r.renderPipelines ?? 0} render + ${r.computePipelines ?? 0} compute pipelines (${r.syncPipelines ?? 0} sync)`,
    `Frame topology (${ft.observedFrames ?? 0} frames): ${ft.renderPasses ?? 0} render passes (${ft.draws ?? 0} draws, ${ft.indirectDraws ?? 0} indirect, ${ft.renderBundles ?? 0} bundles), ${ft.computePasses ?? 0} compute passes (${ft.dispatches ?? 0} dispatches), ${ft.submits ?? 0} submit(s), writeBuffer=${ft.perFrameWriteBufferCalls ?? 0} (${formatMiB(ft.perFrameWriteBufferBytes || 0)})`
  ];

  if (ft.passes?.length) {
    lines.push("Passes:");
    for (const p of ft.passes.slice(0, 10)) {
      if (p.kind === "render") {
        const atts = [...(p.colors || []), ...(p.depth ? [p.depth] : [])].join(", ");
        lines.push(`  #${p.index} render "${p.label || "pass"}": ${p.draws} draws -> ${atts || "no-attachments"}`);
      } else {
        lines.push(`  #${p.index} compute "${p.label || "pass"}": ${p.dispatches} dispatches`);
      }
    }
    if (ft.passes.length > 10) lines.push(`  ... +${ft.passes.length - 10} more passes`);
  }

  if (audit.findings?.length) {
    lines.push(`Optimization findings (${audit.findings.length}):`);
    for (const f of audit.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
      lines.push(`    Fix: ${f.fix}`);
    }
  } else {
    lines.push("Optimization findings: none (clean TBDR/resource configuration)");
  }

  return lines.join("\n");
}

function formatMiB(bytes = 0) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
