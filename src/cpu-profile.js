// CDP CPU profiler lifecycle and hotspot attribution (CONTRACT.md §1.7, §6.5, §7 L5).

const SPECIAL_FRAMES = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

const LIBRARY_URL_RE = /node_modules|unpkg|jsdelivr|esm\.sh|\/deps\/|three(\.module|\.webgpu|\.core)?(\.min)?\.js/i;

const NATIVE_GPU_API_NAMES = new Set([
  // WebGPU adapter / device / queue / command / pass / bundle / resource methods
  "requestAdapter", "requestAdapterInfo", "requestDevice", "destroy",
  "createBuffer", "createTexture", "createView", "createSampler",
  "createBindGroup", "createBindGroupLayout", "createPipelineLayout",
  "createShaderModule", "createRenderPipeline", "createRenderPipelineAsync",
  "createComputePipeline", "createComputePipelineAsync",
  "createCommandEncoder", "createRenderBundleEncoder", "createQuerySet",
  "beginRenderPass", "beginComputePass", "setPipeline", "setBindGroup",
  "setVertexBuffer", "setIndexBuffer", "setViewport", "setScissorRect",
  "setBlendConstant", "setStencilReference", "beginOcclusionQuery", "endOcclusionQuery",
  "executeBundles", "InsertDebugMarker", "insertDebugMarker", "pushDebugGroup", "popDebugGroup",
  "draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect",
  "dispatchWorkgroups", "dispatchWorkgroupsIndirect", "end", "finish",
  "submit", "onSubmittedWorkDone", "writeBuffer", "writeTexture", "copyExternalImageToTexture",
  "copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture",
  "clearBuffer", "resolveQuerySet", "mapAsync", "getMappedRange", "unmap",
  "getCurrentTexture", "configure", "unconfigure", "getPreferredCanvasFormat",
  "pushErrorScope", "popErrorScope", "getCompilationInfo",
  // WebGL / WebGL2 context methods
  "getContext", "getContextAttributes", "isContextLost", "getSupportedExtensions", "getExtension",
  "activeTexture", "attachShader", "bindAttribLocation", "bindBuffer", "bindBufferBase", "bindBufferRange",
  "bindFramebuffer", "bindRenderbuffer", "bindSampler", "bindTexture", "bindTransformFeedback", "bindVertexArray",
  "blendColor", "blendEquation", "blendEquationSeparate", "blendFunc", "blendFuncSeparate",
  "blitFramebuffer", "bufferData", "bufferSubData", "getBufferSubData", "copyBufferSubData",
  "checkFramebufferStatus", "clear", "clearColor", "clearDepth", "clearStencil",
  "clearBufferfv", "clearBufferiv", "clearBufferuiv", "clearBufferfi",
  "clientWaitSync", "colorMask", "compileShader",
  "compressedTexImage2D", "compressedTexImage3D", "compressedTexSubImage2D", "compressedTexSubImage3D",
  "copyTexImage2D", "copyTexSubImage2D", "copyTexSubImage3D",
  "createFramebuffer", "createProgram", "createQuery", "createRenderbuffer", "createShader", "createTransformFeedback", "createVertexArray",
  "cullFace", "deleteBuffer", "deleteFramebuffer", "deleteProgram", "deleteQuery", "deleteRenderbuffer",
  "deleteSampler", "deleteShader", "deleteSync", "deleteTexture", "deleteTransformFeedback", "deleteVertexArray",
  "depthFunc", "depthMask", "depthRange", "detachShader", "disable", "disableVertexAttribArray",
  "drawArrays", "drawArraysInstanced", "drawBuffers", "drawElements", "drawElementsInstanced", "drawRangeElements",
  "enable", "enableVertexAttribArray", " beginQuery", "beginQuery", "endQuery",
  "beginTransformFeedback", "endTransformFeedback", "fenceSync", "flush",
  "framebufferRenderbuffer", "framebufferTexture2D", "framebufferTextureLayer", "frontFace",
  "generateMipmap", "getActiveAttrib", "getActiveUniform", "getActiveUniformBlockName", "getActiveUniformBlockParameter",
  "getActiveUniforms", "getAttachedShaders", "getAttribLocation", "getError", "getFragDataLocation",
  "getFramebufferAttachmentParameter", "getIndexedParameter", "getInternalformatParameter",
  "getParameter", "getProgramInfoLog", "getProgramParameter", "getQuery", "getQueryParameter",
  "getRenderbufferParameter", "getSamplerParameter", "getShaderInfoLog", "getShaderParameter",
  "getShaderPrecisionFormat", "getShaderSource", "getSyncParameter", "getTexParameter",
  "getTransformFeedbackVarying", "getUniform", "getUniformBlockIndex", "getUniformIndices", "getUniformLocation",
  "getVertexAttrib", "getVertexAttribOffset", "hint", "invalidateFramebuffer", "invalidateSubFramebuffer",
  "lineWidth", "linkProgram", "pauseTransformFeedback", "pixelStorei", "polygonOffset",
  "readBuffer", "readPixels", "renderbufferStorage", "renderbufferStorageMultisample", "resumeTransformFeedback",
  "sampleCoverage", "samplerParameterf", "samplerParameteri", "scissor", "shaderSource",
  "stencilFunc", "stencilFuncSeparate", "stencilMask", "stencilMaskSeparate", "stencilOp", "stencilOpSeparate",
  "texImage2D", "texImage3D", "texParameterf", "texParameteri", "texStorage2D", "texStorage3D",
  "texSubImage2D", "texSubImage3D", "transformFeedbackVaryings", "uniformBlockBinding", "useProgram",
  "validateProgram", "vertexAttribDivisor", "vertexAttribIPointer", "vertexAttribPointer", "viewport", "waitSync"
]);

const NATIVE_GPU_API_RE = /^(uniform[1234][fi]v?|uniform[1234]ui?v?|uniformMatrix[234](x[234])?fv|vertexAttrib([1234]f|I4u?i|1fv|2fv|3fv|4fv|I4i?v|I4uiv))$/;

function isNativeGpuApiName(name) {
  if (!name) return false;
  return NATIVE_GPU_API_NAMES.has(name) || NATIVE_GPU_API_RE.test(name);
}

function isToolFrame(frame) {
  if (!frame) return false;
  const url = frame.url || "";
  if (url.startsWith("gpu-perf-agent/")) return true;
  const fn = frame.functionName || "";
  if (/^(gpuPerf|collectInPage$|installAutoInstrumentation$)/.test(fn)) return true;
  // Pre-sourceURL injected evaluations have an empty URL and a non-negative 0-based lineNumber.
  if (url === "" && Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0) return true;
  return false;
}

function isNativeFrame(frame) {
  if (!frame) return false;
  return Boolean(frame.functionName) && (frame.url || "") === "" && frame.lineNumber === -1 && !SPECIAL_FRAMES.has(frame.functionName);
}

function isLibraryUrl(url) {
  return LIBRARY_URL_RE.test(url || "");
}

function relativeUrl(url) {
  if (!url || typeof url !== "string") return null;
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/[?#].*$/, "") || url;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function startCpuProfile(session, { intervalUs = 100 } = {}) {
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: Math.max(10, Math.round(Number(intervalUs) || 100)) });
  await session.send("Profiler.start");
}

export async function stopCpuProfile(session) {
  const { profile } = await session.send("Profiler.stop");
  await session.send("Profiler.disable").catch(() => {});
  return profile;
}

export function summarizeCpuProfile(profile, {
  frames,
  windowMs,
  budgetMs = 16.67,
  hz,
  fps,
  trigger = "auto",
  intervalUs = 100,
  overheadMs = 0
} = {}) {
  const nodeList = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const nodes = new Map(nodeList.map(node => [node.id, node]));
  const parent = new Map();
  for (const node of nodeList) {
    for (const childId of node.children || []) parent.set(childId, node.id);
  }

  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const profileSpanMs = Math.max(0, ((Number(profile?.endTime) || 0) - (Number(profile?.startTime) || 0)) / 1000);
  const hits = new Map();
  let totalSampledMs = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const rawUs = deltas[i + 1] ?? deltas[i] ?? 0;
    const dtMs = Math.max(0, Number(rawUs) / 1000);
    totalSampledMs += dtMs;
    hits.set(samples[i], (hits.get(samples[i]) || 0) + dtMs);
  }
  if (totalSampledMs === 0 && samples.length > 0 && profileSpanMs > 0) {
    const fallbackDt = profileSpanMs / samples.length;
    for (const sampleId of samples) {
      totalSampledMs += fallbackDt;
      hits.set(sampleId, (hits.get(sampleId) || 0) + fallbackDt);
    }
  }

  const effectiveBudgetMs = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 16.67;
  const effectiveHz = Number.isFinite(hz) && hz > 0 ? hz : 1000 / effectiveBudgetMs;
  const actualWindowMs = Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : (profileSpanMs > 0 ? profileSpanMs : totalSampledMs);
  const hasExplicitFrames = Number.isFinite(frames) && frames > 0;
  const frameCount = hasExplicitFrames
    ? frames
    : Math.max(1, Math.round((actualWindowMs || effectiveBudgetMs) / effectiveBudgetMs));
  const effectiveFps = Number.isFinite(fps) && fps >= 0
    ? fps
    : (hasExplicitFrames && actualWindowMs > 0 ? (frames * 1000) / actualWindowMs : null);

  const findJsAncestor = (startId) => {
    let sawTool = false;
    for (let cur = parent.get(startId); cur != null; cur = parent.get(cur)) {
      const node = nodes.get(cur);
      const frame = node?.callFrame;
      if (!frame || SPECIAL_FRAMES.has(frame.functionName)) continue;
      if (isToolFrame(frame)) {
        sawTool = true;
        continue;
      }
      if (frame.url) {
        return {
          caller: {
            fn: frame.functionName || "(anonymous)",
            url: relativeUrl(frame.url),
            line: Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber + 1 : null
          },
          sawTool
        };
      }
    }
    return { caller: null, sawTool };
  };

  const buckets = {
    appJs: 0,
    libraryJs: 0,
    nativeGpuApi: 0,
    gc: 0,
    tool: 0,
    idle: 0,
    other: 0
  };

  const hotspots = new Map();

  for (const [id, ms] of hits) {
    if (!(ms > 0)) continue;
    const node = nodes.get(id);
    const frame = node?.callFrame;
    if (!frame) continue;
    const fn = frame.functionName || "";

    if (fn === "(root)") continue;
    if (fn === "(idle)") {
      buckets.idle += ms;
      continue;
    }
    if (fn === "(garbage collector)") {
      const { caller, sawTool } = findJsAncestor(id);
      if (!caller && sawTool) buckets.tool += ms;
      else buckets.gc += ms;
      continue;
    }
    if (fn === "(program)" || ((frame.url || "") === "" && frame.lineNumber === -1 && !fn)) {
      buckets.other += ms;
      continue;
    }

    if (isNativeFrame(frame)) {
      const { caller, sawTool } = findJsAncestor(id);
      if (!caller && sawTool) {
        buckets.tool += ms;
        continue;
      }
      if (isNativeGpuApiName(fn)) buckets.nativeGpuApi += ms;
      else buckets.other += ms;

      const key = `native|${fn}`;
      let entry = hotspots.get(key);
      if (!entry) {
        entry = { fn, kind: "native", url: null, line: null, selfMs: 0, callers: new Map() };
        hotspots.set(key, entry);
      }
      entry.selfMs += ms;
      if (caller) {
        const callerKey = `${caller.fn}|${caller.url}|${caller.line}`;
        const prev = entry.callers.get(callerKey) || { caller, ms: 0 };
        prev.ms += ms;
        entry.callers.set(callerKey, prev);
      }
      continue;
    }

    if (isToolFrame(frame)) {
      buckets.tool += ms;
      continue;
    }

    const kind = isLibraryUrl(frame.url) ? "library" : "app";
    if (kind === "library") buckets.libraryJs += ms;
    else buckets.appJs += ms;

    const relUrl = relativeUrl(frame.url);
    const line = Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber + 1 : null;
    const key = `${kind}|${fn || "(anonymous)"}|${relUrl}|${line}`;
    let entry = hotspots.get(key);
    if (!entry) {
      entry = { fn: fn || "(anonymous)", kind, url: relUrl, line, selfMs: 0, lines: new Map() };
      hotspots.set(key, entry);
    }
    entry.selfMs += ms;
    for (const tick of node.positionTicks || []) {
      if (Number.isInteger(tick?.line) && tick.line > 0 && Number.isFinite(tick?.ticks)) {
        entry.lines.set(tick.line, (entry.lines.get(tick.line) || 0) + tick.ticks);
      }
    }
  }

  const totalMs = totalSampledMs > 0 ? totalSampledMs : actualWindowMs;
  const busyMs = Math.max(0, totalMs - buckets.idle);
  const busy = totalMs > 0 ? round(Math.min(1, busyMs / totalMs), 2) : 0;
  const belowRefresh = effectiveFps === null ? true : effectiveFps < 0.95 * effectiveHz;

  let classification = "mixed";
  if (busy >= 0.85 && belowRefresh) {
    classification = buckets.nativeGpuApi > 0.5 * busyMs ? "submission-bound" : "main-thread-bound";
  } else if (busy < 0.3 && belowRefresh) {
    classification = "gpu-side-bound";
  }

  const top = [...hotspots.values()]
    .filter(entry => entry.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 5)
    .map(entry => {
      if (entry.kind === "native") {
        let bestCaller = null;
        let bestMs = -1;
        for (const item of entry.callers.values()) {
          if (item.ms > bestMs) {
            bestMs = item.ms;
            bestCaller = item.caller;
          }
        }
        return {
          fn: entry.fn,
          kind: "native",
          url: null,
          line: null,
          selfMsPerFrame: round(entry.selfMs / frameCount, 2),
          caller: bestCaller
        };
      }
      let hotLine = null;
      let maxTicks = -1;
      for (const [lineNo, tickCount] of entry.lines.entries()) {
        if (tickCount > maxTicks) {
          maxTicks = tickCount;
          hotLine = lineNo;
        }
      }
      return {
        fn: entry.fn,
        kind: entry.kind,
        url: entry.url,
        line: entry.line,
        hotLine,
        selfMsPerFrame: round(entry.selfMs / frameCount, 2),
        caller: null
      };
    });

  return {
    trigger: trigger === "requested" ? "requested" : "auto",
    windowMs: round(actualWindowMs, 1),
    frames: frameCount,
    intervalUs: Math.round(Number(intervalUs) || 100),
    overheadMs: round(Math.max(0, Number(overheadMs) || 0), 1),
    busy,
    msPerFrame: {
      appJs: round(buckets.appJs / frameCount, 2),
      libraryJs: round(buckets.libraryJs / frameCount, 2),
      nativeGpuApi: round(buckets.nativeGpuApi / frameCount, 2),
      gc: round(buckets.gc / frameCount, 2),
      tool: round(buckets.tool / frameCount, 2),
      idle: round(buckets.idle / frameCount, 2),
      other: round(buckets.other / frameCount, 2)
    },
    classification,
    top
  };
}
