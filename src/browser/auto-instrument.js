/**
 * Installs dependency-free WebGPU/WebGL instrumentation before application code
 * runs. Keep every helper nested: runners serialize this function into a browser
 * init script with Function#toString.
 */
export function installAutoInstrumentation(options = {}) {
  if (globalThis.__gpuPerfAutoInstrumentation?.version === 2) {
    return globalThis.__gpuPerfAutoInstrumentation;
  }

  const config = {
    callSites: options?.callSites !== false,
    gpuTiming: options?.gpuTiming !== false,
    historyLimit: Math.max(0, Math.min(10000, Math.floor(Number(options?.historyLimit ?? 500)) || 0)),
    includeResources: Boolean(options?.includeResources)
  };
  // Cold counters (creation, setup, errors) live in a dictionary keyed by their dotted report names.
  const counters = Object.create(null);
  for (const name of ["webgpu.uncapturedErrors", "webgpu.deviceLost", "webgl.contextLost", "webgl.shaderCompileFailures", "webgl.programLinkFailures"]) {
    counters[name] = 0;
  }
  // Hot counters: one fixed-shape object, every field predeclared and incremented by a literal property access,
  // once per call. Totals such as webgpu.drawCalls are derived in snapshot().
  const hot = {
    webgpuDraw: 0, webgpuDrawIndexed: 0, webgpuDrawIndirect: 0, webgpuDrawIndexedIndirect: 0,
    webgpuDispatch: 0, webgpuDispatchIndirect: 0, webgpuBundleDraw: 0, webgpuBundleDrawsExecuted: 0, webgpuRenderBundles: 0,
    webgpuRenderPasses: 0, webgpuComputePasses: 0, webgpuCommandEncoders: 0, webgpuQueueSubmits: 0, webgpuCommandBuffers: 0,
    webgpuWriteBufferCalls: 0, webgpuWriteBufferBytes: 0, webgpuWriteTextureCalls: 0, webgpuWriteTextureBytes: 0,
    webgpuCreateBindGroup: 0, webgpuCreateBuffer: 0, webgpuCreateTexture: 0, webgpuCreateView: 0, webgpuCreateSampler: 0,
    webgl2DrawArrays: 0, webgl2DrawElements: 0, webgl2DrawArraysInstanced: 0, webgl2DrawElementsInstanced: 0,
    webgl2DrawRangeElements: 0, webgl2Clear: 0,
    webglDrawArrays: 0, webglDrawElements: 0, webglDrawArraysInstanced: 0, webglDrawElementsInstanced: 0,
    webglDrawRangeElements: 0, webglClear: 0
  };
  let patchedEncoderProto = null;
  let patchedRenderPassProto = null;
  let patchedComputePassProto = null;
  let hasTimedEncoders = false;
  const errors = [];
  const history = [];
  const objectIds = new WeakMap();
  const patched = new WeakSet();
  const resources = new Map();
  let nextId = 1;
  let historyCursor = 0;
  let totalBytes = 0;
  const byApi = Object.create(null);
  const byKind = Object.create(null);

  function adjustTotals(resource, direction) {
    totalBytes += direction * resource.bytes;
    for (const [groups, key] of [[byApi, resource.api], [byKind, resource.kind]]) {
      const group = groups[key] ||= { bytes: 0, count: 0 };
      group.bytes += direction * resource.bytes;
      group.count += direction;
      if (group.count === 0) delete groups[key];
    }
  }

  function increment(name, amount = 1) {
    counters[name] = (counters[name] || 0) + Number(amount || 0);
  }

  // Interned `${api}.${event}` names, so resource tracking builds no strings per call.
  const resourceCounterNames = Object.create(null);
  function resourceCounter(api, event) {
    const names = resourceCounterNames[api] ||= Object.create(null);
    return names[event] ||= `${api}.${event}`;
  }

  function remember(type, resource) {
    if (!config.historyLimit) return;
    const entry = {
      atMs: globalThis.performance?.now?.() || Date.now(),
      bytes: resource?.bytes || 0,
      id: resource?.id || null,
      kind: resource?.kind || null,
      type
    };
    if (history.length < config.historyLimit) history.push(entry);
    else {
      history[historyCursor] = entry;
      historyCursor = (historyCursor + 1) % config.historyLimit;
    }
  }

  function track(object, resource) {
    if (!object || (typeof object !== "object" && typeof object !== "function")) {
      return null;
    }
    let id = objectIds.get(object);
    if (!id) {
      id = nextId;
      nextId += 1;
      objectIds.set(object, id);
    }
    const entry = {
      api: resource.api,
      bytes: Number(resource.bytes || 0),
      descriptor: clone(resource.descriptor),
      id,
      kind: resource.kind,
      label: resource.label || null
    };
    const previous = resources.get(id);
    if (previous) adjustTotals(previous, -1);
    resources.set(id, entry);
    adjustTotals(entry, 1);
    increment(resourceCounter(resource.api, "resourcesCreated"));
    remember("track", entry);
    return id;
  }

  function update(object, patch) {
    const id = objectIds.get(object);
    const current = id ? resources.get(id) : null;
    if (!current) {
      return;
    }
    const next = {
      ...current,
      ...patch,
      bytes: Number(patch.bytes ?? current.bytes ?? 0),
      descriptor: patch.descriptor ? clone(patch.descriptor) : current.descriptor
    };
    adjustTotals(current, -1);
    resources.set(id, next);
    adjustTotals(next, 1);
    remember("update", next);
  }

  function release(object) {
    const id = objectIds.get(object);
    const resource = id ? resources.get(id) : null;
    if (id && resources.delete(id)) {
      adjustTotals(resource, -1);
      increment(resourceCounter(resource.api, "resourcesReleased"));
      remember("release", resource);
    }
  }

  function methodTarget(object, method) {
    // Native encoders/passes share a prototype. Wrap it once, avoiding closures per frame.
    const prototype = object && Object.getPrototypeOf(object);
    return prototype && Object.hasOwn(prototype, method) ? prototype : object;
  }

  function patchDestroy(object) {
    replaceMethod(methodTarget(object, "destroy"), "destroy", (original) => function gpuPerfDestroy(...args) {
      release(this);
      return original.apply(this, args);
    });
  }

  // `onFailure` is for timer-only patches: their failures are handled there and never reach `errors`.
  function replaceMethod(target, name, factory, onFailure) {
    if (!target) {
      return false;
    }
    const original = target[name];
    if (typeof original !== "function" || original.__gpuPerfWrapped) {
      return false;
    }
    try {
      const replacement = factory(original);
      Object.defineProperty(replacement, "__gpuPerfWrapped", { value: true });
      Object.defineProperty(replacement, "__gpuPerfOriginal", { value: original });
      target[name] = replacement;
      if (target[name] !== replacement) {
        Object.defineProperty(target, name, {
          configurable: true,
          value: replacement,
          writable: true
        });
      }
      return true;
    } catch (error) {
      if (onFailure) onFailure(error);
      else errors.push({ message: error?.message || String(error), method: name });
      return false;
    }
  }

  function ignoreFailure() {
    // A missing pipeline label only leaves `pipeline` null.
  }

  function patchWebGPU() {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) {
      return;
    }
    const targets = [gpu, Object.getPrototypeOf(gpu)].filter(Boolean);
    for (const target of targets) {
      replaceMethod(target, "requestAdapter", (original) => async function gpuPerfRequestAdapter(...args) {
        const adapter = await original.apply(this, args);
        patchAdapter(adapter);
        return adapter;
      });
    }
  }

  function patchAdapter(adapter) {
    if (!adapter || patched.has(adapter)) {
      return;
    }
    patched.add(adapter);
    replaceMethod(adapter, "requestDevice", (original) => async function gpuPerfRequestDevice(descriptor, ...rest) {
      // Request timestamp-query through a copy; the caller's descriptor may be frozen or reused.
      const timed = config.gpuTiming && Boolean(this?.features?.has?.("timestamp-query"));
      let next = descriptor;
      if (timed) {
        const features = Array.from(descriptor?.requiredFeatures || []);
        if (!features.includes("timestamp-query")) features.push("timestamp-query");
        next = { ...(descriptor || {}), requiredFeatures: features };
      }
      const device = await original.call(this, next, ...rest);
      // The timer exists before patchDevice, so its query buffers never count as page VRAM.
      if (timed && device && !deviceTimers.has(device) && device.features?.has?.("timestamp-query")) {
        try {
          deviceTimers.set(device, createPassTimer(device));
        } catch {
          // Without a timer the device's frames report status "unsupported"; the page is unaffected.
        }
      }
      patchDevice(device);
      return device;
    });
  }

  function patchDevice(device) {
    if (!device || patched.has(device)) {
      return;
    }
    patched.add(device);
    increment("webgpu.devices");
    watchDeviceErrors(device);

    replaceMethod(device, "createBuffer", (original) => function gpuPerfCreateBuffer(descriptor = {}) {
      hot.webgpuCreateBuffer += 1;
      if (churn.active) sampleChurn(CHURN_BUFFER);
      const buffer = original.call(this, descriptor);
      track(buffer, {
        api: "webgpu",
        bytes: Number(descriptor.size || 0),
        descriptor,
        kind: "buffer",
        label: descriptor.label
      });
      patchDestroy(buffer);
      return buffer;
    });

    replaceMethod(device, "createTexture", (original) => function gpuPerfCreateTexture(descriptor = {}) {
      hot.webgpuCreateTexture += 1;
      if (churn.active) sampleChurn(CHURN_TEXTURE);
      const texture = original.call(this, descriptor);
      track(texture, {
        api: "webgpu",
        bytes: estimateWebGPUTextureBytes(descriptor),
        descriptor,
        kind: "texture",
        label: descriptor.label
      });
      patchDestroy(texture);
      patchTextureViews(texture);
      return texture;
    });

    replaceMethod(device, "createBindGroup", (original) => function gpuPerfCreateBindGroup(...args) {
      hot.webgpuCreateBindGroup += 1;
      if (churn.active) sampleChurn(CHURN_BIND_GROUP);
      return original.apply(this, args);
    });
    replaceMethod(device, "createSampler", (original) => function gpuPerfCreateSampler(...args) {
      hot.webgpuCreateSampler += 1;
      if (churn.active) sampleChurn(CHURN_SAMPLER);
      return original.apply(this, args);
    });
    replaceMethod(device, "createRenderBundleEncoder", (original) => function gpuPerfCreateRenderBundleEncoder(...args) {
      increment("webgpu.createRenderBundleEncoder");
      const encoder = original.apply(this, args);
      if (encoder && (typeof encoder === "object" || typeof encoder === "function")) {
        bundleEncoderDraws.set(encoder, { draws: 0 });
        patchRenderBundleEncoder(encoder);
      }
      return encoder;
    });
    for (const method of [
      "createBindGroupLayout", "createComputePipeline", "createPipelineLayout", "createRenderPipeline", "createShaderModule"
    ]) {
      const labelKind = CREATION_LABEL_KINDS[method];
      const counter = `webgpu.${method}`;
      const churnKind = CHURN_KINDS.indexOf(method);
      replaceMethod(device, method, (original) => function gpuPerfDeviceCreate(...args) {
        increment(counter);
        if (churn.active && churnKind >= 0) sampleChurn(churnKind);
        if (labelKind) args[0] = creationLabel(labelKind, args[0]);
        return original.apply(this, args);
      });
    }
    for (const method of ["createComputePipelineAsync", "createRenderPipelineAsync"]) {
      const counter = `webgpu.${method}`;
      const churnKind = CHURN_KINDS.indexOf(method);
      replaceMethod(device, method, (original) => async function gpuPerfDeviceCreateAsync(...args) {
        increment(counter);
        if (churn.active) sampleChurn(churnKind);
        args[0] = creationLabel("pipeline", args[0]);
        return original.apply(this, args);
      });
    }

    const deviceTimer = deviceTimers.get(device);
    replaceMethod(device, "createCommandEncoder", (original) => function gpuPerfCreateCommandEncoder(...args) {
      hot.webgpuCommandEncoders += 1;
      const encoder = original.apply(this, args);
      if (encoder) {
        if (Object.getPrototypeOf(encoder) !== patchedEncoderProto) patchCommandEncoder(encoder);
        const timer = this === device ? deviceTimer : deviceTimers.get(this);
        if (timer) {
          hasTimedEncoders = true;
          encoderTiming.set(encoder, { generation: 0, partial: null, slot: -1, timer });
        }
      }
      return encoder;
    });
    patchQueue(device.queue, device);
  }

  function patchQueue(queue, device) {
    if (!queue || patched.has(queue)) {
      return;
    }
    patched.add(queue);
    replaceMethod(queue, "submit", (original) => function gpuPerfSubmit(commandBuffers) {
      // The tool's own resolve batch is never page work, even if something routes it back through here.
      if (deviceTimers.get(device)?.resolving) return original.call(this, commandBuffers);
      hot.webgpuQueueSubmits += 1;
      const frame = timing.current;
      frame.submits += 1;
      if (!config.gpuTiming) {
        hot.webgpuCommandBuffers += commandBuffers?.length || 0;
        return original.call(this, commandBuffers);
      }
      if (!deviceTimers.has(device)) frame.untimed += 1;
      const list = Array.from(commandBuffers || []);
      hot.webgpuCommandBuffers += list.length;
      const result = original.call(this, list);
      for (let index = 0; index < list.length; index += 1) {
        const state = list[index] && commandBufferTiming.get(list[index]);
        if (!state) continue;
        commandBufferTiming.delete(list[index]);
        submitTimedCommandBuffer(state, frame);
      }
      const timer = deviceTimers.get(device);
      if (timer && resolveDue(timer)) resolveSubmitted(timer);
      return result;
    });
    replaceMethod(queue, "writeBuffer", (original) => function gpuPerfWriteBuffer(...args) {
      hot.webgpuWriteBufferCalls += 1;
      const elementSize = args[2]?.BYTES_PER_ELEMENT || 1;
      hot.webgpuWriteBufferBytes += Number(args[4] != null ? args[4] * elementSize
        : Math.max(0, (args[2]?.byteLength || 0) - (args[3] || 0) * elementSize)) || 0;
      return original.apply(this, args);
    });
    replaceMethod(queue, "writeTexture", (original) => function gpuPerfWriteTexture(...args) {
      hot.webgpuWriteTextureCalls += 1;
      hot.webgpuWriteTextureBytes += Number(args[1]?.byteLength ?? args[1]?.length ?? 0) || 0;
      return original.apply(this, args);
    });
  }

  // ---- GPU/API errors: uncaptured WebGPU errors, device loss, WebGL context loss, shader/program failures ----
  // Never calls getError (it would consume the page's error flag and force a GPU-process round trip).
  const MAX_ERROR_MESSAGES = 16;
  const gpuErrorLog = { messages: new Map(), deviceLost: [], shaderFailures: [] };

  function firstLine(value, limit = 200) {
    return String(value ?? "").split("\n")[0].slice(0, limit);
  }

  function watchDeviceErrors(device) {
    try {
      device.addEventListener?.("uncapturederror", (event) => {
        counters["webgpu.uncapturedErrors"] += 1;
        const message = firstLine(event?.error?.message ?? event?.message ?? "unknown error") || "unknown error";
        const count = gpuErrorLog.messages.get(message);
        if (count !== undefined) gpuErrorLog.messages.set(message, count + 1);
        else if (gpuErrorLog.messages.size < MAX_ERROR_MESSAGES) gpuErrorLog.messages.set(message, 1);
      });
    } catch {
      // Error counting is evidence only; a device without events is still measured.
    }
    try {
      device.lost?.then?.((info) => {
        const reason = info?.reason == null ? "unknown" : String(info.reason);
        if (gpuErrorLog.deviceLost.length < 8) gpuErrorLog.deviceLost.push({ reason, message: firstLine(info?.message) });
        // A page destroying its own device is not an error.
        if (reason !== "destroyed") counters["webgpu.deviceLost"] += 1;
      }, () => {});
    } catch {
      // As above.
    }
  }

  function watchContextLoss(canvas) {
    if (!canvas || patched.has(canvas)) return;
    patched.add(canvas);
    try {
      canvas.addEventListener?.("webglcontextlost", () => {
        counters["webgl.contextLost"] += 1;
      });
    } catch {
      // As above.
    }
  }

  function recordShaderFailure(type, log) {
    counters[type === "shader" ? "webgl.shaderCompileFailures" : "webgl.programLinkFailures"] += 1;
    if (gpuErrorLog.shaderFailures.length < MAX_ERROR_MESSAGES) {
      gpuErrorLog.shaderFailures.push({ type, log: String(log ?? "").slice(0, 500) });
    }
  }

  function gpuErrorSnapshot() {
    const top = gpuErrorLog.messages.size > 0
      ? Array.from(gpuErrorLog.messages, ([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
      : [];
    return {
      total: counters["webgpu.uncapturedErrors"],
      top,
      deviceLost: gpuErrorLog.deviceLost.length > 0 ? gpuErrorLog.deviceLost.map((entry) => ({ ...entry })) : [],
      contextLost: counters["webgl.contextLost"],
      shaderFailures: gpuErrorLog.shaderFailures.length > 0 ? gpuErrorLog.shaderFailures.map((entry) => ({ ...entry })) : []
    };
  }

  // ---- Render bundles and texture views ----
  // Bundle encoders count their own draws; executeBundles adds each bundle's draw count once per execution.
  const bundleEncoderDraws = new WeakMap();
  const bundleDraws = new WeakMap();

  function patchRenderBundleEncoder(encoder) {
    const target = methodTarget(encoder, "draw");
    if (!target || patched.has(target)) return;
    patched.add(target);
    const note = (self) => {
      hot.webgpuBundleDraw += 1;
      const state = bundleEncoderDraws.get(self);
      if (state) state.draws += 1;
    };
    replaceMethod(target, "draw", (original) => function gpuPerfBundleDraw(...args) {
      note(this);
      return original.apply(this, args);
    });
    replaceMethod(target, "drawIndexed", (original) => function gpuPerfBundleDrawIndexed(...args) {
      note(this);
      return original.apply(this, args);
    });
    replaceMethod(target, "drawIndirect", (original) => function gpuPerfBundleDrawIndirect(...args) {
      note(this);
      return original.apply(this, args);
    });
    replaceMethod(target, "drawIndexedIndirect", (original) => function gpuPerfBundleDrawIndexedIndirect(...args) {
      note(this);
      return original.apply(this, args);
    });
    replaceMethod(methodTarget(encoder, "finish"), "finish", (original) => function gpuPerfBundleFinish(...args) {
      const bundle = original.apply(this, args);
      const state = bundleEncoderDraws.get(this);
      if (state && bundle && (typeof bundle === "object" || typeof bundle === "function")) bundleDraws.set(bundle, state.draws);
      return bundle;
    });
  }

  function patchTextureViews(texture) {
    const target = methodTarget(texture, "createView");
    if (!target || patched.has(target)) return;
    patched.add(target);
    replaceMethod(target, "createView", (original) => function gpuPerfCreateView(...args) {
      hot.webgpuCreateView += 1;
      if (churn.active) sampleChurn(CHURN_VIEW);
      return original.apply(this, args);
    });
  }

  function patchCommandEncoder(encoder) {
    const target = methodTarget(encoder, "beginRenderPass");
    if (!target || patched.has(target)) {
      return;
    }
    patched.add(target);
    if (target !== encoder) patchedEncoderProto = target;
    if (!nativeEncoderMethods.has(target)) nativeEncoderMethods.set(target, encoderMethodsOf(target));
    replaceMethod(target, "beginRenderPass", (original) => function gpuPerfBeginRenderPass(...args) {
      hot.webgpuRenderPasses += 1;
      const state = hasTimedEncoders ? encoderTiming.get(this) : undefined;
      if (state) args[0] = timedPassDescriptor(state, args[0], "render");
      const pass = original.apply(this, args);
      if (state) watchPassPipeline(pass);
      if (pass && Object.getPrototypeOf(pass) !== patchedRenderPassProto) patchRenderPass(pass);
      return pass;
    });
    replaceMethod(target, "beginComputePass", (original) => function gpuPerfBeginComputePass(...args) {
      hot.webgpuComputePasses += 1;
      const state = hasTimedEncoders ? encoderTiming.get(this) : undefined;
      if (state) args[0] = timedPassDescriptor(state, args[0], "compute");
      const pass = original.apply(this, args);
      if (state) watchPassPipeline(pass);
      if (pass && Object.getPrototypeOf(pass) !== patchedComputePassProto) patchComputePass(pass);
      return pass;
    });
    for (const method of [
      "clearBuffer", "copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture",
      "resolveQuerySet", "writeTimestamp"
    ]) {
      const counter = `webgpu.${method}`;
      replaceMethod(target, method, (original) => function gpuPerfEncoderOperation(...args) {
        increment(counter);
        return original.apply(this, args);
      });
    }
    replaceMethod(target, "finish", (original) => function gpuPerfFinish(...args) {
      const state = hasTimedEncoders ? encoderTiming.get(this) : undefined;
      if (state) {
        encoderTiming.delete(this);
        finishEncoderTiming(state);
      }
      const commandBuffer = original.apply(this, args);
      if (state && commandBuffer && (state.slot >= 0 || state.partial)) commandBufferTiming.set(commandBuffer, state);
      return commandBuffer;
    });
  }

  function patchRenderPass(pass) {
    const target = methodTarget(pass, "draw");
    if (!target || patched.has(target)) {
      return;
    }
    patched.add(target);
    if (target !== pass) patchedRenderPassProto = target;
    // One wrapper per method, so each increments its own predeclared field (no computed keys per draw).
    replaceMethod(target, "draw", (original) => function gpuPerfDraw(...args) {
      hot.webgpuDraw += 1;
      return original.apply(this, args);
    });
    replaceMethod(target, "drawIndexed", (original) => function gpuPerfDrawIndexed(...args) {
      hot.webgpuDrawIndexed += 1;
      return original.apply(this, args);
    });
    replaceMethod(target, "drawIndirect", (original) => function gpuPerfDrawIndirect(...args) {
      hot.webgpuDrawIndirect += 1;
      return original.apply(this, args);
    });
    replaceMethod(target, "drawIndexedIndirect", (original) => function gpuPerfDrawIndexedIndirect(...args) {
      hot.webgpuDrawIndexedIndirect += 1;
      return original.apply(this, args);
    });
    replaceMethod(target, "executeBundles", (original) => function gpuPerfExecuteBundles(bundles) {
      // A one-shot iterable would be consumed by counting; pass the page an array instead.
      const list = Array.isArray(bundles) ? bundles : Array.from(bundles ?? []);
      hot.webgpuRenderBundles += list.length;
      for (let index = 0; index < list.length; index += 1) {
        const draws = list[index] ? bundleDraws.get(list[index]) : undefined;
        if (draws) hot.webgpuBundleDrawsExecuted += draws;
      }
      return original.call(this, list);
    });
    patchSetPipeline(target);
  }

  function patchComputePass(pass) {
    const target = methodTarget(pass, "dispatchWorkgroups");
    if (!target || patched.has(target)) {
      return;
    }
    patched.add(target);
    if (target !== pass) patchedComputePassProto = target;
    replaceMethod(target, "dispatchWorkgroups", (original) => function gpuPerfDispatch(...args) {
      hot.webgpuDispatch += 1;
      return original.apply(this, args);
    });
    replaceMethod(target, "dispatchWorkgroupsIndirect", (original) => function gpuPerfDispatchIndirect(...args) {
      hot.webgpuDispatchIndirect += 1;
      return original.apply(this, args);
    });
    patchSetPipeline(target);
  }

  function patchSetPipeline(pass) {
    if (!config.gpuTiming) return;
    // One identity comparison per call; the label is read only for a pass key's first pass.
    replaceMethod(pass, "setPipeline", (original) => function gpuPerfSetPipeline(pipeline) {
      if (this === timing.pipelinePass) {
        timing.pipelinePass = null;
        const key = timing.passKeys[timing.pipelineKey];
        if (key && key.pipeline === undefined) key.pipeline = pipeline?.label || null;
      }
      return original.call(this, pipeline);
    }, ignoreFailure);
  }

  function patchCanvasContexts() {
    for (const constructor of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
      const prototype = constructor?.prototype;
      replaceMethod(prototype, "getContext", (original) => function gpuPerfGetContext(type, ...args) {
        const context = original.call(this, type, ...args);
        // Capability-probe canvases (injected.js) are not page work: no patching, no counters.
        if (this?.__gpuPerfAgentProbe) {
          return context;
        }
        if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
          if (context) watchContextLoss(this);
          patchWebGLContext(context, type === "webgl2" ? "webgl2" : "webgl");
        } else if (type === "webgpu" && context && !patched.has(context)) {
          patched.add(context);
          increment("webgpu.canvasContexts");
          if (!textureViewsPatched) {
            replaceMethod(context, "getCurrentTexture", (original) => function gpuPerfGetCurrentTexture(...args) {
              const texture = original.apply(this, args);
              if (texture) patchTextureViews(texture);
              return texture;
            }, ignoreFailure);
          }
        }
        return context;
      });
    }
    // Off-main-thread rendering is not instrumented; count it so an empty capture can say why.
    replaceMethod(globalThis.HTMLCanvasElement?.prototype, "transferControlToOffscreen", (original) => function gpuPerfTransferControlToOffscreen(...args) {
      increment("page.offscreenTransfers");
      return original.apply(this, args);
    }, ignoreFailure);
    for (const name of ["Worker", "SharedWorker"]) {
      const Original = globalThis[name];
      if (typeof Original !== "function") continue;
      try {
        // A Proxy keeps `instanceof`, statics and subclassing intact.
        const Wrapped = new Proxy(Original, {
          construct(target, args, newTarget) {
            increment("page.workers");
            return Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
          }
        });
        globalThis[name] = Wrapped;
      } catch {
        // Counting workers is evidence only.
      }
    }
  }

  // GPUTexture.prototype.createView is wrapped once at install when the browser exposes it; otherwise
  // textures from createTexture and getCurrentTexture patch their prototype on first sight.
  const textureViewsPatched = Boolean(globalThis.GPUTexture?.prototype && typeof globalThis.GPUTexture.prototype.createView === "function");

  function patchWebGLContext(gl, api) {
    if (!gl || patched.has(gl)) {
      return;
    }
    patched.add(gl);
    increment(`${api}.contexts`);
    const isWebGL2 = api === "webgl2";
    const createBufferCounter = `${api}.createBuffer`;
    const createTextureCounter = `${api}.createTexture`;
    const bufferBindings = new Map();
    // Texture bindings are per texture unit and target; cube faces resolve to TEXTURE_CUBE_MAP.
    const textureBindings = new Map();
    let activeUnit = 0;
    let renderbufferBinding = null;
    const boundTexture = (target) => textureBindings.get(activeUnit * 0x10000 + textureBindingTarget(target));

    replaceMethod(gl, "createBuffer", (original) => function gpuPerfGLCreateBuffer(...args) {
      increment(createBufferCounter);
      const buffer = original.apply(this, args);
      track(buffer, { api, bytes: 0, kind: "buffer" });
      return buffer;
    });
    replaceMethod(gl, "bindBuffer", (original) => function gpuPerfGLBindBuffer(target, buffer) {
      bufferBindings.set(target, buffer);
      return original.call(this, target, buffer);
    });
    replaceMethod(gl, "bufferData", (original) => function gpuPerfGLBufferData(target, dataOrSize, ...args) {
      const result = original.call(this, target, dataOrSize, ...args);
      const buffer = bufferBindings.get(target);
      if (buffer) {
        update(buffer, {
          bytes: typeof dataOrSize === "number" ? dataOrSize
            : args[2] ? Number(args[2]) * (dataOrSize?.BYTES_PER_ELEMENT || 1)
              : Math.max(0, Number(dataOrSize?.byteLength || 0) - Number(args[1] || 0) * (dataOrSize?.BYTES_PER_ELEMENT || 1)),
          descriptor: { target, usage: args[0] }
        });
      }
      return result;
    });
    replaceMethod(gl, "deleteBuffer", (original) => function gpuPerfGLDeleteBuffer(buffer) {
      release(buffer);
      return original.call(this, buffer);
    });

    replaceMethod(gl, "createTexture", (original) => function gpuPerfGLCreateTexture(...args) {
      increment(createTextureCounter);
      const texture = original.apply(this, args);
      track(texture, { api, bytes: 0, kind: "texture" });
      return texture;
    });
    replaceMethod(gl, "activeTexture", (original) => function gpuPerfGLActiveTexture(unit) {
      activeUnit = Math.max(0, Number(unit) - GL_TEXTURE0) || 0;
      return original.call(this, unit);
    });
    replaceMethod(gl, "bindTexture", (original) => function gpuPerfGLBindTexture(target, texture) {
      textureBindings.set(activeUnit * 0x10000 + textureBindingTarget(target), texture);
      return original.call(this, target, texture);
    });
    // Each upload defines one face and level; a texture's bytes are the sum over its faces and levels.
    const defineLevel = (target, level, bytes, descriptor) => {
      const texture = boundTexture(target);
      if (texture) setTextureLevels(texture, [[textureFace(target), Number(level) || 0, bytes]], false, descriptor);
    };
    replaceMethod(gl, "texImage2D", (original) => function gpuPerfGLTexImage2D(...args) {
      const result = original.apply(this, args);
      const descriptor = describeTexImage2D(args);
      defineLevel(args[0], args[1], descriptor.bytes, descriptor);
      return result;
    });
    replaceMethod(gl, "texImage3D", (original) => function gpuPerfGLTexImage3D(...args) {
      const result = original.apply(this, args);
      const [target, level, format, width, height, depth, border, sourceFormat, type] = args;
      defineLevel(target, level, Number(width || 1) * Number(height || 1) * Number(depth || 1) * webGLBytesPerPixel(format, type),
        { border, depth, format, height, level, sourceFormat, target, type, width });
      return result;
    });
    replaceMethod(gl, "copyTexImage2D", (original) => function gpuPerfGLCopyTexImage2D(...args) {
      const result = original.apply(this, args);
      const [target, level, format, , , width, height] = args;
      defineLevel(target, level, Number(width || 1) * Number(height || 1) * webGLBytesPerPixel(format, null),
        { format, height, level, target, width });
      return result;
    });
    replaceMethod(gl, "compressedTexImage2D", (original) => function gpuPerfGLCompressedTexImage2D(...args) {
      const result = original.apply(this, args);
      const [target, level, format, width, height] = args;
      defineLevel(target, level, compressedLevelBytes(format, width, height, 1, args[6]), { format, height, level, target, width });
      return result;
    });
    replaceMethod(gl, "compressedTexImage3D", (original) => function gpuPerfGLCompressedTexImage3D(...args) {
      const result = original.apply(this, args);
      const [target, level, format, width, height, depth] = args;
      defineLevel(target, level, compressedLevelBytes(format, width, height, depth, args[7]), { depth, format, height, level, target, width });
      return result;
    });
    // Sub-image uploads never change an allocation; they only define a level the tool has not seen.
    for (const [method, dims] of [["compressedTexSubImage2D", 2], ["compressedTexSubImage3D", 3]]) {
      replaceMethod(gl, method, (original) => function gpuPerfGLCompressedTexSubImage(...args) {
        const result = original.apply(this, args);
        const [target, level] = args;
        const texture = boundTexture(target);
        if (texture && !textureLevelKnown(texture, textureFace(target), Number(level) || 0)) {
          const [width, height, depth, format, data] = dims === 2
            ? [Number(args[2]) + Number(args[4]), Number(args[3]) + Number(args[5]), 1, args[6], args[7]]
            : [Number(args[2]) + Number(args[5]), Number(args[3]) + Number(args[6]), Number(args[4]) + Number(args[7]), args[8], args[9]];
          setTextureLevels(texture, [[textureFace(target), Number(level) || 0, compressedLevelBytes(format, width, height, depth, data)]], false,
            { format, height, level, target, width });
        }
        return result;
      }, ignoreFailure);
    }
    replaceMethod(gl, "texStorage2D", (original) => function gpuPerfGLTexStorage2D(target, levels, format, width, height) {
      const result = original.call(this, target, levels, format, width, height);
      const texture = boundTexture(target);
      if (texture) {
        const faces = textureBindingTarget(target) === GL_TEXTURE_CUBE_MAP ? 6 : 1;
        const entries = [];
        for (let face = 0; face < faces; face += 1) {
          for (let level = 0; level < Number(levels || 1); level += 1) {
            entries.push([face, level, storageLevelBytes(format, width, height, 1, level, false)]);
          }
        }
        setTextureLevels(texture, entries, true, { format, height, levels, target, width });
      }
      return result;
    });
    replaceMethod(gl, "texStorage3D", (original) => function gpuPerfGLTexStorage3D(target, levels, format, width, height, depth) {
      const result = original.call(this, target, levels, format, width, height, depth);
      const texture = boundTexture(target);
      if (texture) {
        // Only a 3D texture halves its depth per level; array layers stay.
        const halveDepth = Number(target) === GL_TEXTURE_3D;
        const entries = [];
        for (let level = 0; level < Number(levels || 1); level += 1) {
          entries.push([0, level, storageLevelBytes(format, width, height, depth, level, halveDepth)]);
        }
        setTextureLevels(texture, entries, true, { depth, format, height, levels, target, width });
      }
      return result;
    });
    replaceMethod(gl, "deleteTexture", (original) => function gpuPerfGLDeleteTexture(texture) {
      release(texture);
      return original.call(this, texture);
    });

    replaceMethod(gl, "createRenderbuffer", (original) => function gpuPerfGLCreateRenderbuffer(...args) {
      const renderbuffer = original.apply(this, args);
      track(renderbuffer, { api, bytes: 0, kind: "renderbuffer" });
      return renderbuffer;
    });
    replaceMethod(gl, "bindRenderbuffer", (original) => function gpuPerfGLBindRenderbuffer(target, renderbuffer) {
      renderbufferBinding = renderbuffer;
      return original.call(this, target, renderbuffer);
    });
    for (const method of ["renderbufferStorage", "renderbufferStorageMultisample"]) {
      replaceMethod(gl, method, (original) => function gpuPerfGLRenderbufferStorage(...args) {
        const result = original.apply(this, args);
        if (renderbufferBinding) {
          const multisample = method.endsWith("Multisample");
          const samples = multisample ? Number(args[1] || 1) : 1;
          const format = args[multisample ? 2 : 1];
          const width = args[multisample ? 3 : 2];
          const height = args[multisample ? 4 : 3];
          update(renderbufferBinding, {
            bytes: Number(width || 1) * Number(height || 1) * samples * webGLBytesPerPixel(format, null),
            descriptor: { format, height, samples, width }
          });
        }
        return result;
      });
    }
    replaceMethod(gl, "deleteRenderbuffer", (original) => function gpuPerfGLDeleteRenderbuffer(renderbuffer) {
      release(renderbuffer);
      return original.call(this, renderbuffer);
    });

    // Compile and link failures, with their info logs. Each failing shader or program counts once.
    const failed = new WeakSet();
    replaceMethod(gl, "getShaderParameter", (original) => function gpuPerfGLGetShaderParameter(shader, pname) {
      const value = original.call(this, shader, pname);
      if (pname === GL_COMPILE_STATUS && value === false && shader && !failed.has(shader)) {
        failed.add(shader);
        let log = "";
        try { log = this.getShaderInfoLog(shader); } catch { /* The log is optional evidence. */ }
        recordShaderFailure("shader", log);
      }
      return value;
    }, ignoreFailure);
    replaceMethod(gl, "getProgramParameter", (original) => function gpuPerfGLGetProgramParameter(program, pname) {
      const value = original.call(this, program, pname);
      if (pname === GL_LINK_STATUS && value === false && program && !failed.has(program)) {
        failed.add(program);
        let log = "";
        try { log = this.getProgramInfoLog(program); } catch { /* The log is optional evidence. */ }
        recordShaderFailure("program", log);
      }
      return value;
    }, ignoreFailure);

    // Per-context work since the last ledger tick; the GL frame timer discards results without work.
    // One wrapper per draw method, each with its own predeclared counter field.
    const glWork = { timed: false, work: 0 };
    const noteDraw = () => {
      glWork.work += 1;
      const frame = timing.current;
      frame.glDraws += 1;
      if (!glWork.timed) frame.untimed += 1;
    };
    replaceMethod(gl, "drawArrays", (original) => function gpuPerfGLDrawArrays(...args) {
      if (isWebGL2) hot.webgl2DrawArrays += 1;
      else hot.webglDrawArrays += 1;
      noteDraw();
      return original.apply(this, args);
    });
    replaceMethod(gl, "drawElements", (original) => function gpuPerfGLDrawElements(...args) {
      if (isWebGL2) hot.webgl2DrawElements += 1;
      else hot.webglDrawElements += 1;
      noteDraw();
      return original.apply(this, args);
    });
    replaceMethod(gl, "drawArraysInstanced", (original) => function gpuPerfGLDrawArraysInstanced(...args) {
      if (isWebGL2) hot.webgl2DrawArraysInstanced += 1;
      else hot.webglDrawArraysInstanced += 1;
      noteDraw();
      return original.apply(this, args);
    });
    replaceMethod(gl, "drawElementsInstanced", (original) => function gpuPerfGLDrawElementsInstanced(...args) {
      if (isWebGL2) hot.webgl2DrawElementsInstanced += 1;
      else hot.webglDrawElementsInstanced += 1;
      noteDraw();
      return original.apply(this, args);
    });
    replaceMethod(gl, "drawRangeElements", (original) => function gpuPerfGLDrawRangeElements(...args) {
      if (isWebGL2) hot.webgl2DrawRangeElements += 1;
      else hot.webglDrawRangeElements += 1;
      noteDraw();
      return original.apply(this, args);
    });
    replaceMethod(gl, "clear", (original) => function gpuPerfGLClear(mask) {
      if (isWebGL2) hot.webgl2Clear += 1;
      else hot.webglClear += 1;
      glWork.work += 1;
      const frame = timing.current;
      frame.glClears += 1;
      if (!glWork.timed) frame.untimed += 1;
      return original.call(this, mask);
    });
    if (config.gpuTiming && api === "webgl2") {
      setupWebGLFrameTimer(gl, glWork);
    }
  }

  // ---- WebGL texture accounting: bytes per face and mip level ----
  const GL_TEXTURE0 = 0x84c0;
  const GL_TEXTURE_3D = 0x806f;
  const GL_TEXTURE_CUBE_MAP = 0x8513;
  const GL_CUBE_FACE_FIRST = 0x8515;
  const GL_CUBE_FACE_LAST = 0x851a;
  const GL_COMPILE_STATUS = 0x8b81;
  const GL_LINK_STATUS = 0x8b82;
  const textureLevels = new WeakMap();

  function textureBindingTarget(target) {
    const value = Number(target);
    return value >= GL_CUBE_FACE_FIRST && value <= GL_CUBE_FACE_LAST ? GL_TEXTURE_CUBE_MAP : value;
  }

  function textureFace(target) {
    const value = Number(target);
    return value >= GL_CUBE_FACE_FIRST && value <= GL_CUBE_FACE_LAST ? value - GL_CUBE_FACE_FIRST : 0;
  }

  function textureLevelKnown(texture, face, level) {
    return textureLevels.get(texture)?.has(face * 64 + level) === true;
  }

  // `replace` (texStorage*) redefines every level; uploads define one face/level each.
  function setTextureLevels(texture, entries, replace, descriptor) {
    let levels = textureLevels.get(texture);
    if (!levels || replace) {
      levels = new Map();
      textureLevels.set(texture, levels);
    }
    for (const [face, level, bytes] of entries) levels.set(face * 64 + level, Number(bytes) || 0);
    let total = 0;
    for (const bytes of levels.values()) total += bytes;
    update(texture, { bytes: total, descriptor });
  }

  function storageLevelBytes(format, width, height, depth, level, halveDepth) {
    const w = Math.max(1, Math.floor(Number(width || 1) / (2 ** level)));
    const h = Math.max(1, Math.floor(Number(height || 1) / (2 ** level)));
    const d = halveDepth ? Math.max(1, Math.floor(Number(depth || 1) / (2 ** level))) : Math.max(1, Number(depth || 1));
    const block = compressedBlock(format);
    return block ? Math.ceil(w / block[0]) * Math.ceil(h / block[1]) * d * block[2] : w * h * d * webGLBytesPerPixel(format, null);
  }

  // Compressed level bytes from the format's block size; the data length is the fallback for unknown formats.
  function compressedLevelBytes(format, width, height, depth, data) {
    const block = compressedBlock(format);
    if (block) {
      return Math.ceil(Number(width || 1) / block[0]) * Math.ceil(Number(height || 1) / block[1]) * Math.max(1, Number(depth || 1)) * block[2];
    }
    return typeof data === "number" ? data : Number(data?.byteLength || 0);
  }

  // [blockWidth, blockHeight, bytesPerBlock] for S3TC, RGTC, BPTC, ETC1/ETC2/EAC, ASTC and PVRTC.
  function compressedBlock(format) {
    const value = Number(format);
    if (value >= 0x93b0 && value <= 0x93bd) return ASTC_BLOCKS[value - 0x93b0];
    if (value >= 0x93d0 && value <= 0x93dd) return ASTC_BLOCKS[value - 0x93d0];
    return COMPRESSED_BLOCKS[value] || null;
  }

  const ASTC_BLOCKS = [[4, 4, 16], [5, 4, 16], [5, 5, 16], [6, 5, 16], [6, 6, 16], [8, 5, 16], [8, 6, 16], [8, 8, 16],
    [10, 5, 16], [10, 6, 16], [10, 8, 16], [10, 10, 16], [12, 10, 16], [12, 12, 16]];
  const COMPRESSED_BLOCKS = {
    // S3TC (DXT1/3/5) and sRGB variants
    0x83f0: [4, 4, 8], 0x83f1: [4, 4, 8], 0x83f2: [4, 4, 16], 0x83f3: [4, 4, 16],
    0x8c4c: [4, 4, 8], 0x8c4d: [4, 4, 8], 0x8c4e: [4, 4, 16], 0x8c4f: [4, 4, 16],
    // RGTC (BC4/BC5) and BPTC (BC6H/BC7)
    0x8dbb: [4, 4, 8], 0x8dbc: [4, 4, 8], 0x8dbd: [4, 4, 16], 0x8dbe: [4, 4, 16],
    0x8e8c: [4, 4, 16], 0x8e8d: [4, 4, 16], 0x8e8e: [4, 4, 16], 0x8e8f: [4, 4, 16],
    // ETC1, ETC2 and EAC
    0x8d64: [4, 4, 8], 0x9270: [4, 4, 8], 0x9271: [4, 4, 8], 0x9272: [4, 4, 16], 0x9273: [4, 4, 16],
    0x9274: [4, 4, 8], 0x9275: [4, 4, 8], 0x9276: [4, 4, 8], 0x9277: [4, 4, 8], 0x9278: [4, 4, 16], 0x9279: [4, 4, 16],
    // PVRTC 4 bpp and 2 bpp
    0x8c00: [4, 4, 8], 0x8c02: [4, 4, 8], 0x8c01: [8, 4, 8], 0x8c03: [8, 4, 8]
  };

  // ---- Steady-state churn call sites ----
  // After beginSteadyState(), every Nth call of a create* kind captures one stack. N adapts per kind so that
  // all kinds together capture at most 16 stacks per frame; a capture counts for the N calls it stands for
  // (plus any calls skipped over the budget). Sites go into a Map bounded at 32 entries.
  const CHURN_KINDS = ["createBindGroup", "createBuffer", "createTexture", "createView", "createSampler", "createShaderModule",
    "createRenderPipeline", "createComputePipeline", "createRenderPipelineAsync", "createComputePipelineAsync"];
  const CHURN_BIND_GROUP = 0;
  const CHURN_BUFFER = 1;
  const CHURN_TEXTURE = 2;
  const CHURN_VIEW = 3;
  const CHURN_SAMPLER = 4;
  const CHURN_CAPTURES_PER_FRAME = 16;
  const CHURN_MAX_SITES = 32;
  const churn = {
    active: false,
    captures: new Int32Array(CHURN_KINDS.length),
    countdown: new Float64Array(CHURN_KINDS.length).fill(1),
    frameCaptures: 0,
    period: new Float64Array(CHURN_KINDS.length).fill(1),
    sites: new Map(),
    throttled: new Uint8Array(CHURN_KINDS.length),
    weight: new Float64Array(CHURN_KINDS.length)
  };

  function sampleChurn(kind) {
    churn.countdown[kind] -= 1;
    if (churn.countdown[kind] > 0) return;
    const weight = churn.weight[kind] + churn.period[kind];
    if (churn.frameCaptures >= CHURN_CAPTURES_PER_FRAME) {
      // Over this frame's budget: carry the calls into the next capture and sample this kind half as often.
      churn.weight[kind] = weight;
      churn.period[kind] *= 2;
      churn.countdown[kind] = churn.period[kind];
      churn.throttled[kind] = 1;
      return;
    }
    churn.weight[kind] = 0;
    churn.countdown[kind] = churn.period[kind];
    churn.frameCaptures += 1;
    churn.captures[kind] += 1;
    const where = callSite();
    const site = where?.appSite ?? where?.site;
    if (!site) return;
    const key = `${kind}|${site}`;
    let entry = churn.sites.get(key);
    if (!entry) {
      if (churn.sites.size >= CHURN_MAX_SITES) return;
      entry = { count: 0, kind: CHURN_KINDS[kind], site };
      churn.sites.set(key, entry);
    }
    entry.count += weight;
  }

  // Once per ledger tick: kinds that stayed well under the budget are sampled twice as often again.
  function churnTick() {
    for (let kind = 0; kind < CHURN_KINDS.length; kind += 1) {
      if (!churn.throttled[kind] && churn.captures[kind] <= CHURN_CAPTURES_PER_FRAME / 4 && churn.period[kind] > 1) {
        churn.period[kind] /= 2;
        if (churn.countdown[kind] > churn.period[kind]) churn.countdown[kind] = churn.period[kind];
      }
      churn.captures[kind] = 0;
      churn.throttled[kind] = 0;
    }
    churn.frameCaptures = 0;
  }

  function churnSnapshot() {
    const out = {};
    if (churn.sites.size === 0) return out;
    for (const entry of churn.sites.values()) {
      (out[entry.kind] ||= []).push({ site: entry.site, count: Math.round(entry.count) });
    }
    for (const kind of Object.keys(out)) out[kind] = out[kind].sort((a, b) => b.count - a.count).slice(0, 3);
    return out;
  }

  // ---- Frame ledger and automatic GPU timing ----
  // Each native requestAnimationFrame tick closes one ledger frame. WebGPU passes the page does not time
  // itself get timestampWrites into a slot owned by their command encoder; each WebGL2 context gets one
  // TIME_ELAPSED query per frame. Results land in the frame whose tick preceded the submit. Frame records,
  // per-pass rings and scratch arrays are preallocated, so steady-state frames allocate almost nothing.
  // Timer failures never reach `errors`: they mark the frame partial ("timer-error").
  const LEDGER_FRAMES = 4096;
  const PASS_FRAMES = 1024;
  const MAX_PASS_KEYS = 64;
  const MAX_PASSES = 64;
  const SLOTS_PER_SET = 32;
  const MAX_SLOT_SETS = 5;
  const STALE_TICKS = 120;
  const SLOT_BYTES = Math.ceil((MAX_PASSES * 16) / 256) * 256;
  const SLOT_FREE = 0;
  const SLOT_RECORDING = 1;
  const SLOT_RESOLVED = 2;
  const SLOT_SUBMITTED = 3;
  const SLOT_READING = 4;
  const RESOLVE_BATCH_SLOTS = 32;
  const RESOLVE_BATCH_TICKS = 30;
  const MAX_BATCH_BUFFERS = 4;
  const GL_TIME_ELAPSED = 0x88bf;
  const GL_GPU_DISJOINT = 0x8fbb;
  const GL_QUERY_RESULT = 0x8866;
  const GL_QUERY_RESULT_AVAILABLE = 0x8867;
  const GL_MAX_PENDING = 8;
  const PARTIAL_REASONS = ["page-timed-pass", "no-slot", "slot-reclaimed", "invalid-timestamps", "disjoint", "unresolved", "timer-error"];
  const TOOL_SOURCE_PREFIX = "gpu-perf-agent/";
  const LIBRARY_URL = /node_modules|unpkg|jsdelivr|esm\.sh|\/deps\/|three(\.module|\.webgpu|\.core)?(\.min)?\.js/;
  const CREATION_LABEL_KINDS = {
    createBindGroupLayout: "bindGroupLayout",
    createComputePipeline: "pipeline",
    createRenderPipeline: "pipeline",
    createShaderModule: "shader"
  };
  const deviceTimers = new WeakMap();
  // Unwrapped encoder methods per encoder prototype, taken before anything (the tool or the page) wraps them.
  const nativeEncoderMethods = new WeakMap();
  if (globalThis.GPUCommandEncoder?.prototype) {
    nativeEncoderMethods.set(globalThis.GPUCommandEncoder.prototype, encoderMethodsOf(globalThis.GPUCommandEncoder.prototype));
  }
  const encoderTiming = new WeakMap();
  const commandBufferTiming = new WeakMap();
  const nativeRequestAnimationFrame = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame.bind(globalThis) : null;
  const timing = {
    current: null,
    frameId: 0,
    glContexts: 0,
    glTimers: [],
    labelKeys: new Map(),
    ledger: [],
    ordinalKeys: { compute: [], render: [] },
    passKeys: [],
    passTimers: [],
    pipelineKey: -1,
    pipelinePass: null,
    steadyState: false
  };
  // Scratch for one command buffer's intervals; readbacks are processed one at a time.
  const scratchBegin = new Float64Array(MAX_PASSES);
  const scratchEnd = new Float64Array(MAX_PASSES);
  const scratchExclusive = new Float64Array(MAX_PASSES);
  const scratchPoints = new Float64Array(MAX_PASSES * 2);

  for (let index = 0; index < LEDGER_FRAMES; index += 1) {
    timing.ledger.push({
      computeOrdinal: 0, end: 0, glClears: 0, glDraws: 0, id: -1, partial: null, pending: 0, renderOrdinal: 0,
      sources: 0, spanNs: 0, start: 0, submits: 0, sumNs: 0, timed: 0, unionNs: 0, untimed: 0
    });
  }
  timing.current = openFrame(0, nowMs());

  function nowMs() {
    return globalThis.performance?.now?.() ?? Date.now();
  }

  function openFrame(id, start) {
    const frame = timing.ledger[id % LEDGER_FRAMES];
    frame.id = id;
    frame.start = start;
    frame.end = 0;
    frame.submits = 0;
    frame.glDraws = 0;
    frame.glClears = 0;
    frame.pending = 0;
    frame.partial = null;
    frame.timed = 0;
    frame.untimed = 0;
    frame.sources = 0;
    frame.unionNs = 0;
    frame.sumNs = 0;
    frame.spanNs = 0;
    frame.renderOrdinal = 0;
    frame.computeOrdinal = 0;
    return frame;
  }

  function frameById(id) {
    const frame = timing.ledger[id % LEDGER_FRAMES];
    return frame.id === id ? frame : null;
  }

  function markPartial(frame, reason) {
    if (frame && !frame.partial) frame.partial = reason;
  }

  // Timers are held weakly: a dropped device or GL context (and its timer) is collected and pruned here.
  function weakly(value) {
    return typeof globalThis.WeakRef === "function" ? new globalThis.WeakRef(value) : { deref: () => value };
  }

  function liveTimers(list) {
    let kept = 0;
    for (let index = 0; index < list.length; index += 1) {
      const timer = list[index].deref();
      if (timer && !timer.lost) list[kept++] = list[index];
    }
    list.length = kept;
    return list;
  }

  function ledgerTick() {
    // Registered once at install and re-registered first, so it runs before the page's callbacks each frame.
    nativeRequestAnimationFrame(ledgerTick);
    const now = nowMs();
    const closing = timing.current;
    const glTimers = timing.glTimers;
    for (let index = 0; index < glTimers.length; index += 1) {
      const timer = glTimers[index].deref();
      if (timer) webGLFrameTick(timer, closing);
    }
    liveTimers(glTimers);
    const passTimers = liveTimers(timing.passTimers);
    for (let index = 0; index < passTimers.length; index += 1) {
      const timer = passTimers[index].deref();
      try {
        if (timer && resolveDue(timer)) resolveSubmitted(timer);
      } catch {
        // Its slots stay submitted and are retried on the next tick or flush.
      }
    }
    if (churn.active) churnTick();
    closing.end = now;
    timing.frameId += 1;
    timing.current = openFrame(timing.frameId, now);
  }

  if (nativeRequestAnimationFrame) {
    try {
      nativeRequestAnimationFrame(ledgerTick);
    } catch (error) {
      errors.push({ message: error?.message || String(error), method: "requestAnimationFrame" });
    }
  }

  // Call sites: one stack parse, only on a pass key's first occurrence or an unlabelled creation call.
  function callSite() {
    let stack = "";
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 30;
      stack = String(new Error().stack || "");
    } catch {
      return null;
    } finally {
      try { Error.stackTraceLimit = limit; } catch { /* A page may freeze Error. */ }
    }
    const frames = [];
    let firstPageFrame = -1;
    for (const line of stack.split("\n")) {
      const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
      if (!match) continue;
      const fn = (match[1] || "").replace(/^Object\./, "");
      const url = match[2];
      frames.push({ fn, line: match[3], url });
      // Every entry into the tool passes a gpuPerf* wrapper; the helper frames above the innermost one are
      // the tool's even without a sourceURL (Playwright init scripts).
      if (firstPageFrame < 0 && fn.includes("gpuPerf")) firstPageFrame = frames.length - 1;
    }
    // Skip only the contiguous run of tool frames at the top (helpers, then nested gpuPerf* wrappers). Below
    // it, only gpu-perf-agent/ frames are skipped: page code called by collect.js (a benchmark hook) keeps its
    // own frames.
    firstPageFrame = Math.max(0, firstPageFrame);
    while (firstPageFrame < frames.length
      && (frames[firstPageFrame].fn.includes("gpuPerf") || frames[firstPageFrame].url.startsWith(TOOL_SOURCE_PREFIX))) {
      firstPageFrame += 1;
    }
    let site = null;
    let appSite = null;
    for (let index = firstPageFrame; index < frames.length && !appSite; index += 1) {
      const frame = frames[index];
      if (frame.url.startsWith(TOOL_SOURCE_PREFIX)) continue;
      const path = frame.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i, "").replace(/[?#].*$/, "");
      const text = `${frame.fn ? `${frame.fn} ` : ""}${path}:${frame.line}`;
      site ??= text;
      if (!LIBRARY_URL.test(frame.url)) appSite = text;
    }
    return site ? { appSite, site } : null;
  }

  function creationLabel(kind, descriptor) {
    if (!config.callSites || !descriptor || typeof descriptor !== "object" || descriptor.label) {
      return descriptor;
    }
    const where = callSite();
    const at = where?.appSite ?? where?.site;
    return at ? { ...descriptor, label: `${kind}@${at}` } : descriptor;
  }

  // Pass keys: descriptor.label, else `${type}#${ordinalWithinFrame}`. At most 64 keys own duration rings.
  function passKeyIndex(type, label, ordinal) {
    if (label) {
      let index = timing.labelKeys.get(label);
      if (index === undefined) {
        index = createPassKey(label, type, label, true);
        if (timing.labelKeys.size < 256) timing.labelKeys.set(label, index);
      }
      return index;
    }
    const cache = timing.ordinalKeys[type];
    let index = cache[ordinal];
    if (index === undefined) {
      index = createPassKey(`${type}#${ordinal}`, type, null, true);
      if (ordinal < 256) cache[ordinal] = index;
    }
    return index;
  }

  function createPassKey(key, type, label, withSite) {
    if (timing.passKeys.length >= MAX_PASS_KEYS) return -1;
    const where = withSite && config.callSites ? callSite() : null;
    timing.passKeys.push({
      appSite: where?.appSite ?? null,
      duration: new Float64Array(PASS_FRAMES),
      exclusive: new Float64Array(PASS_FRAMES),
      key,
      label,
      pipeline: undefined,
      site: where?.site ?? null,
      tag: new Int32Array(PASS_FRAMES).fill(-1),
      type
    });
    return timing.passKeys.length - 1;
  }

  function recordPass(index, id, durationNs, exclusiveNs) {
    if (index < 0 || id <= timing.frameId - PASS_FRAMES) return;
    const key = timing.passKeys[index];
    const at = id % PASS_FRAMES;
    if (key.tag[at] === id) {
      key.duration[at] += durationNs;
      key.exclusive[at] += exclusiveNs;
    } else {
      key.tag[at] = id;
      key.duration[at] = durationNs;
      key.exclusive[at] = exclusiveNs;
    }
  }

  function watchPassPipeline(pass) {
    if (timing.pipelineKey >= 0) timing.pipelinePass = pass || null;
  }

  // WebGPU pass timer: 32-slot sets (4096 queries, 64 passes x 2 per slot), at most 4 extra sets.
  // Slot lifecycle: free -> recording (encoder open) -> resolved (finished) -> submitted -> reading -> free,
  // with a generation per slot. The page's command buffers carry only timestampWrites. Submitted slots are
  // resolved in batches (every 30 ticks or 32 slots, and on flush) by a tool-owned command buffer submitted
  // after the page's own work: each resolveQuerySet costs a fixed GPU round, about 7% FPS on a 25 ms/frame
  // page when done every frame, and within noise when batched.
  function unwrapped(method) {
    return method?.__gpuPerfOriginal || method;
  }

  function encoderMethodsOf(target) {
    return {
      copyBufferToBuffer: unwrapped(target.copyBufferToBuffer),
      finish: unwrapped(target.finish),
      resolveQuerySet: unwrapped(target.resolveQuerySet)
    };
  }

  // Tool encoders never pass through the page: use their own methods, else the prototype's natives.
  function toolEncoderMethods(encoder) {
    if (Object.hasOwn(encoder, "finish")) return encoderMethodsOf(encoder);
    const prototype = Object.getPrototypeOf(encoder);
    let methods = prototype && nativeEncoderMethods.get(prototype);
    if (!methods) {
      methods = encoderMethodsOf(encoder);
      if (prototype) nativeEncoderMethods.set(prototype, methods);
    }
    return methods;
  }

  function rawCreateBuffer(timer, descriptor) {
    return timer.native.createBuffer.call(timer.device, descriptor);
  }

  function bufferUsage(name, fallback) {
    return globalThis.GPUBufferUsage?.[name] ?? fallback;
  }

  // Runs before patchDevice and before the page sees the device: the device and queue functions captured
  // here are the natives, so a page or library that wraps them later (allocation trackers, submit hooks)
  // never sees the tool's buffers, encoders or resolve submits.
  function createPassTimer(device) {
    const queue = device.queue;
    const timer = {
      acquiredAt: [], batchBuffers: [], busyBatches: 0, cursor: 0, device, generations: [], lastHigh: [], lastLow: [],
      native: {
        createBuffer: unwrapped(device.createBuffer),
        createCommandEncoder: unwrapped(device.createCommandEncoder),
        createQuerySet: unwrapped(device.createQuerySet),
        queue,
        submit: unwrapped(queue?.submit)
      },
      passCounts: [], passKeys: [], querySets: [], readFrame: [], resolveBuffers: [], resolving: false, states: [],
      submitted: [], submittedSince: 0, writes: []
    };
    if (typeof timer.native.submit !== "function" || typeof timer.native.createBuffer !== "function") {
      throw new TypeError("WebGPU device without submit/createBuffer");
    }
    addSlotSet(timer);
    timing.passTimers.push(weakly(timer));
    try {
      // A lost or destroyed device resolves nothing more: fail its unread slots now instead of at flush timeout.
      device.lost?.then?.(() => {
        timer.lost = true;
        const submitted = timer.submitted;
        timer.submitted = [];
        for (const slot of submitted) finishSlot(timer, slot, "timer-error", null);
      }, () => {});
    } catch {
      // Without a lost promise the timer simply stays registered.
    }
    return timer;
  }

  function addSlotSet(timer) {
    const { device } = timer;
    const querySet = timer.native.createQuerySet.call(device, { count: SLOTS_PER_SET * MAX_PASSES * 2, label: "gpu-perf-agent:passes", type: "timestamp" });
    const resolveBuffer = rawCreateBuffer(timer, {
      label: "gpu-perf-agent:resolve",
      size: SLOTS_PER_SET * SLOT_BYTES,
      usage: bufferUsage("COPY_SRC", 0x4) | bufferUsage("QUERY_RESOLVE", 0x200)
    });
    timer.querySets.push(querySet);
    timer.resolveBuffers.push(resolveBuffer);
    timer.batchBuffers.push([]);
    for (let index = 0; index < SLOTS_PER_SET; index += 1) {
      timer.states.push(SLOT_FREE);
      timer.generations.push(0);
      timer.acquiredAt.push(0);
      timer.passCounts.push(0);
      timer.passKeys.push(new Int32Array(MAX_PASSES));
      timer.writes.push([]);
      timer.readFrame.push(-1);
      timer.lastLow.push(0);
      timer.lastHigh.push(0);
    }
  }

  function acquireSlot(timer) {
    const tick = timing.frameId;
    const count = timer.states.length;
    for (let offset = 0; offset < count; offset += 1) {
      const slot = (timer.cursor + offset) % count;
      if (timer.states[slot] === SLOT_FREE) {
        timer.cursor = (slot + 1) % count;
        return claimSlot(timer, slot, tick);
      }
    }
    // Only abandoned recording/resolved slots are reclaimed; submitted and reading slots never are.
    for (let slot = 0; slot < count; slot += 1) {
      const state = timer.states[slot];
      if ((state === SLOT_RECORDING || state === SLOT_RESOLVED) && tick - timer.acquiredAt[slot] > STALE_TICKS) {
        timer.generations[slot] += 1;
        timer.lastLow[slot] = 0;
        timer.lastHigh[slot] = 0;
        return claimSlot(timer, slot, tick);
      }
    }
    if (timer.querySets.length < MAX_SLOT_SETS) {
      addSlotSet(timer);
      return claimSlot(timer, count, tick);
    }
    return -1;
  }

  function claimSlot(timer, slot, tick) {
    timer.states[slot] = SLOT_RECORDING;
    timer.acquiredAt[slot] = tick;
    timer.passCounts[slot] = 0;
    return slot;
  }

  function allocatePass(timer, slot, keyIndex) {
    const count = timer.passCounts[slot];
    if (timer.states[slot] !== SLOT_RECORDING || count >= MAX_PASSES) return null;
    timer.passKeys[slot][count] = keyIndex;
    timer.passCounts[slot] = count + 1;
    const local = slot % SLOTS_PER_SET;
    return timer.writes[slot][count] ||= {
      beginningOfPassWriteIndex: local * MAX_PASSES * 2 + count * 2,
      endOfPassWriteIndex: local * MAX_PASSES * 2 + count * 2 + 1,
      querySet: timer.querySets[Math.floor(slot / SLOTS_PER_SET)]
    };
  }

  function timedPassDescriptor(state, descriptor, type) {
    timing.pipelineKey = -1;
    try {
      const frame = timing.current;
      const ordinal = type === "compute" ? frame.computeOrdinal++ : frame.renderOrdinal++;
      const keyIndex = passKeyIndex(type, descriptor?.label, ordinal);
      if (descriptor?.timestampWrites) {
        // The page times this pass itself; the frame total would miss it.
        state.partial ??= "page-timed-pass";
        return descriptor;
      }
      if (state.slot >= 0 && state.timer.generations[state.slot] !== state.generation) {
        // This encoder sat open past STALE_TICKS and its slot now belongs to another encoder.
        state.partial ??= "slot-reclaimed";
        state.slot = -2;
      }
      if (state.slot === -1) {
        const slot = acquireSlot(state.timer);
        state.slot = slot >= 0 ? slot : -2;
        if (slot >= 0) state.generation = state.timer.generations[slot];
      }
      const writes = state.slot >= 0 ? allocatePass(state.timer, state.slot, keyIndex) : null;
      if (!writes) {
        state.partial ??= state.slot >= 0 ? "unresolved" : "no-slot";
        return descriptor;
      }
      if (keyIndex >= 0 && timing.passKeys[keyIndex].pipeline === undefined) timing.pipelineKey = keyIndex;
      return { ...(descriptor || {}), timestampWrites: writes };
    } catch {
      state.partial ??= "timer-error";
      return descriptor;
    }
  }

  // finish(): nothing is appended to the page's encoder; the slot waits for its command buffer's submit.
  function finishEncoderTiming(state) {
    const { timer, slot } = state;
    if (slot < 0) return;
    if (timer.generations[slot] !== state.generation) {
      // The slot was reclaimed while this encoder sat unfinished.
      state.partial ??= "slot-reclaimed";
      state.slot = -1;
    } else if (timer.states[slot] !== SLOT_RECORDING || timer.passCounts[slot] === 0) {
      if (timer.states[slot] === SLOT_RECORDING) timer.states[slot] = SLOT_FREE;
      state.slot = -1;
    } else {
      timer.states[slot] = SLOT_RESOLVED;
    }
  }

  function submitTimedCommandBuffer(state, frame) {
    if (state.partial) markPartial(frame, state.partial);
    const { timer, slot } = state;
    if (slot < 0) return;
    if (timer.generations[slot] !== state.generation || timer.states[slot] !== SLOT_RESOLVED) {
      markPartial(frame, "slot-reclaimed");
      return;
    }
    if (timer.lost) {
      // A lost device's timer is no longer resolved; never leave the frame pending.
      timer.states[slot] = SLOT_FREE;
      markPartial(frame, "timer-error");
      return;
    }
    timer.states[slot] = SLOT_SUBMITTED;
    timer.readFrame[slot] = frame.id;
    frame.pending += 1;
    if (timer.submitted.length === 0) timer.submittedSince = timing.frameId;
    timer.submitted.push(slot);
  }

  function resolveDue(timer) {
    return timer.submitted.length >= RESOLVE_BATCH_SLOTS
      || (timer.submitted.length > 0 && timing.frameId - timer.submittedSince >= RESOLVE_BATCH_TICKS);
  }

  // One tool command buffer per batch: per slot set, one resolveQuerySet over the submitted slots' range and
  // one copy into a pooled MAP_READ buffer, then one mapAsync. Queue order guarantees the pages' passes ran.
  // Only the natives captured in createPassTimer are used, and `resolving` blocks re-entry.
  function resolveSubmitted(timer) {
    if (timer.resolving || timer.submitted.length === 0) return;
    timer.resolving = true;
    const { device, native } = timer;
    const submitted = timer.submitted;
    timer.submitted = [];
    timer.submittedSince = timing.frameId;
    const sets = timer.querySets.length;
    const remaining = [];
    const batches = [];
    let encoder = null;
    let methods = null;
    try {
      for (let set = 0; set < sets; set += 1) {
        let first = SLOTS_PER_SET;
        let last = -1;
        for (const slot of submitted) {
          if (Math.floor(slot / SLOTS_PER_SET) !== set) continue;
          const local = slot % SLOTS_PER_SET;
          if (local < first) first = local;
          if (local > last) last = local;
        }
        if (last < 0) continue;
        const buffer = batchBuffer(timer, set);
        if (!buffer) {
          for (const slot of submitted) if (Math.floor(slot / SLOTS_PER_SET) === set) remaining.push(slot);
          continue;
        }
        if (!encoder) {
          encoder = native.createCommandEncoder.call(device);
          methods = toolEncoderMethods(encoder);
        }
        const offset = first * SLOT_BYTES;
        const size = (last - first + 1) * SLOT_BYTES;
        methods.resolveQuerySet.call(encoder, timer.querySets[set], first * MAX_PASSES * 2, (last - first + 1) * MAX_PASSES * 2, timer.resolveBuffers[set], offset);
        methods.copyBufferToBuffer.call(encoder, timer.resolveBuffers[set], offset, buffer, offset, size);
        const slots = submitted.filter((slot) => Math.floor(slot / SLOTS_PER_SET) === set);
        for (const slot of slots) timer.states[slot] = SLOT_READING;
        batches.push({ buffer, offset, set, size, slots });
      }
      if (encoder) native.submit.call(native.queue, [methods.finish.call(encoder)]);
    } catch {
      // The batch never reached the GPU: every submitted slot fails as a timer error and is freed.
      for (const batch of batches) timer.batchBuffers[batch.set].push(batch.buffer);
      for (const slot of submitted) finishSlot(timer, slot, "timer-error", null);
      batches.length = 0;
      remaining.length = 0;
    } finally {
      timer.resolving = false;
    }
    if (remaining.length > 0) {
      // No free readback buffer for these sets yet; they go first in the next batch.
      timer.submitted = remaining.concat(timer.submitted);
    }
    for (const batch of batches) {
      timer.busyBatches += 1;
      try {
        batch.buffer.mapAsync(globalThis.GPUMapMode?.READ ?? 1, batch.offset, batch.size)
          .then(() => finishBatch(timer, batch, false), () => finishBatch(timer, batch, true));
      } catch {
        finishBatch(timer, batch, true);
      }
    }
  }

  function batchBuffer(timer, set) {
    const free = timer.batchBuffers[set];
    if (free.length > 0) return free.pop();
    if (timer.busyBatches >= MAX_BATCH_BUFFERS * timer.querySets.length) return null;
    return rawCreateBuffer(timer, {
      label: "gpu-perf-agent:timestamps",
      size: SLOTS_PER_SET * SLOT_BYTES,
      usage: bufferUsage("COPY_DST", 0x8) | bufferUsage("MAP_READ", 0x1)
    });
  }

  function finishBatch(timer, batch, failed) {
    timer.busyBatches -= 1;
    for (const slot of batch.slots) {
      let words = null;
      if (!failed) {
        try {
          // Map only this slot's pairs: a few dozen bytes, not the whole batch range.
          words = new Uint32Array(batch.buffer.getMappedRange((slot % SLOTS_PER_SET) * SLOT_BYTES, timer.passCounts[slot] * 16));
        } catch {
          words = null;
        }
      }
      finishSlot(timer, slot, words ? null : "timer-error", words);
    }
    if (!failed) {
      try { batch.buffer.unmap(); } catch { /* Destroyed with its device. */ }
    }
    timer.batchBuffers[batch.set].push(batch.buffer);
  }

  function finishSlot(timer, slot, failure, words) {
    const frame = frameById(timer.readFrame[slot]);
    let reason = failure;
    if (!reason) {
      try {
        reason = readTimestamps(timer, slot, words, frame);
      } catch {
        reason = "timer-error";
      }
    }
    timer.states[slot] = SLOT_FREE;
    timer.passCounts[slot] = 0;
    if (frame) {
      frame.pending -= 1;
      if (reason) markPartial(frame, reason);
    }
  }

  // Ordering is used only within this one resolve: union, per-pass exclusive time, sum and span.
  function readTimestamps(timer, slot, words, frame) {
    const count = timer.passCounts[slot];
    const firstLow = words[0];
    const firstHigh = words[1];
    // A failed submit writes no timestamps, so the resolve returns this slot's previous values again.
    const stale = (firstLow !== 0 || firstHigh !== 0) && firstLow === timer.lastLow[slot] && firstHigh === timer.lastHigh[slot];
    timer.lastLow[slot] = firstLow;
    timer.lastHigh[slot] = firstHigh;
    if (stale) return "invalid-timestamps";
    let minBegin = Infinity;
    let maxEnd = -Infinity;
    let sumNs = 0;
    for (let index = 0; index < count; index += 1) {
      const at = index * 4;
      if (words[at] === 0 && words[at + 1] === 0) return "invalid-timestamps";
      // Exact relative nanoseconds from 32-bit halves; no BigInt per pass.
      const begin = (words[at + 1] - firstHigh) * 4294967296 + (words[at] - firstLow);
      const end = (words[at + 3] - firstHigh) * 4294967296 + (words[at + 2] - firstLow);
      if (end < begin) return "invalid-timestamps";
      scratchBegin[index] = begin;
      scratchEnd[index] = end;
      scratchExclusive[index] = 0;
      scratchPoints[index * 2] = begin;
      scratchPoints[index * 2 + 1] = end;
      sumNs += end - begin;
      if (begin < minBegin) minBegin = begin;
      if (end > maxEnd) maxEnd = end;
    }
    const points = scratchPoints.subarray(0, count * 2).sort();
    let unionNs = 0;
    for (let index = 0; index + 1 < points.length; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (to <= from) continue;
      let covering = 0;
      let owner = -1;
      for (let pass = 0; pass < count; pass += 1) {
        if (scratchBegin[pass] <= from && scratchEnd[pass] >= to) {
          covering += 1;
          owner = pass;
        }
      }
      if (covering > 0) unionNs += to - from;
      if (covering === 1) scratchExclusive[owner] += to - from;
    }
    if (unionNs > 1e9) return "invalid-timestamps";
    if (!frame) return null;
    frame.timed += 1;
    frame.sources |= 1;
    frame.unionNs += unionNs;
    frame.sumNs += sumNs;
    frame.spanNs += count > 0 ? maxEnd - minBegin : 0;
    const keys = timer.passKeys[slot];
    for (let index = 0; index < count; index += 1) {
      recordPass(keys[index], frame.id, scratchEnd[index] - scratchBegin[index], scratchExclusive[index]);
    }
    return null;
  }

  // WebGL2 frame timer: one TIME_ELAPSED query per context per ledger frame, drained without blocking.
  function setupWebGLFrameTimer(gl, glWork) {
    let ext = null;
    try {
      ext = gl.getExtension?.("EXT_disjoint_timer_query_webgl2") || null;
    } catch {
      ext = null;
    }
    if (!ext || typeof gl.beginQuery !== "function" || typeof gl.createQuery !== "function") return;
    const index = timing.glContexts;
    timing.glContexts += 1;
    const timer = {
      beginQuery: gl.beginQuery,
      endQuery: gl.endQuery,
      gl,
      glWork,
      key: -1,
      lost: false,
      open: null,
      openWork: 0,
      paused: false,
      pendingFrames: [],
      pendingQueries: [],
      pendingWork: [],
      pool: []
    };
    let patchFailed = false;
    const untime = () => {
      patchFailed = true;
    };
    replaceMethod(gl, "beginQuery", (original) => function gpuPerfGLBeginQuery(target, query) {
      if (target === GL_TIME_ELAPSED && !timer.paused) {
        // The page times its own GL work: close the tool's query first and stop timing this context.
        timer.paused = true;
        markPartial(timing.current, "page-timed-pass");
        if (timer.open) {
          try {
            timer.endQuery.call(gl, GL_TIME_ELAPSED);
            gl.deleteQuery(timer.open);
          } catch { /* The page's own call reports any GL error. */ }
          timer.open = null;
        }
      }
      return original.call(this, target, query);
    }, untime);
    replaceMethod(gl, "getQuery", (original) => function gpuPerfGLGetQuery(target, pname) {
      const query = original.call(this, target, pname);
      return query && query === timer.open ? null : query;
    }, untime);
    // Without both patches the tool cannot step aside for the page's own queries: leave the context untimed.
    if (patchFailed) return;
    timer.key = createPassKey(`gl-frame#${index}`, "webgl", null, false);
    glWork.timed = true;
    timing.glTimers.push(weakly(timer));
    beginGLQuery(timer);
  }

  function beginGLQuery(timer) {
    if (timer.paused || timer.lost) return;
    const query = timer.pool.pop() || timer.gl.createQuery();
    if (!query) return;
    timer.beginQuery.call(timer.gl, GL_TIME_ELAPSED, query);
    timer.open = query;
  }

  function dropGLPending(timer, reason) {
    for (let index = 0; index < timer.pendingQueries.length; index += 1) {
      const frame = frameById(timer.pendingFrames[index]);
      if (frame) {
        frame.pending -= 1;
        if (timer.pendingWork[index] > 0) markPartial(frame, reason);
      }
      try { timer.gl.deleteQuery(timer.pendingQueries[index]); } catch { /* Context may be lost. */ }
    }
    timer.pendingQueries.length = 0;
    timer.pendingFrames.length = 0;
    timer.pendingWork.length = 0;
  }

  function webGLFrameTick(timer, closing) {
    if (timer.lost) return;
    const { gl, glWork } = timer;
    try {
      if (gl.isContextLost?.()) {
        // A lost (or later restored) context is no longer timed: its draws count as untimed work.
        timer.lost = true;
        timer.open = null;
        glWork.timed = false;
        dropGLPending(timer, "unresolved");
        return;
      }
      const work = glWork.work;
      glWork.work = 0;
      if (timer.open) {
        timer.endQuery.call(gl, GL_TIME_ELAPSED);
        timer.pendingQueries.push(timer.open);
        timer.pendingFrames.push(closing.id);
        timer.pendingWork.push(work);
        closing.pending += 1;
        timer.open = null;
      } else if (work > 0) {
        markPartial(closing, timer.paused ? "page-timed-pass" : "timer-error");
      }
      if (gl.getParameter(GL_GPU_DISJOINT)) {
        dropGLPending(timer, "disjoint");
      }
      while (timer.pendingQueries.length > 0) {
        const query = timer.pendingQueries[0];
        if (!gl.getQueryParameter(query, GL_QUERY_RESULT_AVAILABLE)) break;
        const elapsedNs = Number(gl.getQueryParameter(query, GL_QUERY_RESULT));
        const frame = frameById(timer.pendingFrames[0]);
        const frameWork = timer.pendingWork[0];
        timer.pendingQueries.shift();
        timer.pendingFrames.shift();
        timer.pendingWork.shift();
        timer.pool.push(query);
        if (!frame) continue;
        frame.pending -= 1;
        // A frame without draws or clears on this context is not GL work: discard its result.
        if (frameWork === 0) continue;
        if (!Number.isFinite(elapsedNs) || elapsedNs < 0 || elapsedNs > 1e9) {
          markPartial(frame, "invalid-timestamps");
          continue;
        }
        frame.timed += 1;
        frame.sources |= 2;
        frame.unionNs += elapsedNs;
        frame.sumNs += elapsedNs;
        frame.spanNs += elapsedNs;
        recordPass(timer.key, frame.id, elapsedNs, elapsedNs);
      }
      while (timer.pendingQueries.length > GL_MAX_PENDING) {
        const frame = frameById(timer.pendingFrames[0]);
        if (frame) {
          frame.pending -= 1;
          if (timer.pendingWork[0] > 0) markPartial(frame, "unresolved");
        }
        try { gl.deleteQuery(timer.pendingQueries[0]); } catch { /* Context may be lost. */ }
        timer.pendingQueries.shift();
        timer.pendingFrames.shift();
        timer.pendingWork.shift();
      }
      beginGLQuery(timer);
    } catch {
      markPartial(closing, "timer-error");
      timer.open = null;
    }
  }

  // Window summaries. Only work frames (a submit, GL draw or gl.clear) enter GPU statistics.
  function percentile(sorted, ratio) {
    if (sorted.length === 0) return null;
    const index = (sorted.length - 1) * ratio;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  function roundTo(value, digits) {
    if (value == null || !Number.isFinite(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  }

  function nsStats(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    return {
      count: sorted.length,
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      mean: Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
      min: Math.round(sorted[0]),
      max: Math.round(sorted[sorted.length - 1])
    };
  }

  function p50p95(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? { p50: Math.round(percentile(sorted, 0.5)), p95: Math.round(percentile(sorted, 0.95)) } : null;
  }

  function median(values) {
    return percentile(values.slice().sort((a, b) => a - b), 0.5);
  }

  // Frames copied out of the rings by window(t0, t1, true): a long run keeps early samples poolable after
  // their frames leave the 4096-frame ledger or the 1024-frame pass rings. Only retained windows allocate.
  const MAX_ARCHIVED = 16384;
  const archive = new Map();

  function frameRecord(id) {
    return frameById(id) || archive.get(id) || null;
  }

  function archiveFrames(ids) {
    const oldestPass = timing.frameId - PASS_FRAMES;
    for (const id of ids) {
      const frame = frameById(id);
      if (!frame || archive.has(id)) continue;
      const passes = [];
      if (id > oldestPass) {
        const at = id % PASS_FRAMES;
        for (let index = 0; index < timing.passKeys.length; index += 1) {
          const key = timing.passKeys[index];
          if (key.tag[at] === id) passes.push(index, key.duration[at], key.exclusive[at]);
        }
      }
      archive.set(id, { ...frame, passes, passesLost: id <= oldestPass });
      if (archive.size > MAX_ARCHIVED) archive.delete(archive.keys().next().value);
    }
  }

  // Ids of frames that started and ended inside a range, plus whether part of a range had already left the
  // rings without being retained.
  function framesInRanges(ranges) {
    const ids = [];
    const first = Math.max(0, timing.frameId - LEDGER_FRAMES + 1);
    const firstStart = first > 0 ? frameById(first)?.start ?? Infinity : -Infinity;
    const inRange = (frame) => ranges.some((range) => frame.start >= Number(range[0]) && frame.end <= Number(range[1]));
    let truncated = false;
    for (const range of ranges) {
      if (Number(range[0]) >= firstStart) continue;
      let retained = false;
      for (const record of archive.values()) {
        if (record.id < first && record.start >= Number(range[0]) && record.end <= Number(range[1])) {
          retained = true;
          break;
        }
      }
      if (!retained) truncated = true;
    }
    for (const record of archive.values()) {
      if (record.id < first && inRange(record)) ids.push(record.id);
    }
    for (let id = first; id < timing.frameId; id += 1) {
      const frame = frameById(id);
      if (frame && inRange(frame)) ids.push(id);
    }
    const oldestPass = timing.frameId - PASS_FRAMES;
    for (const id of ids) {
      if (id > oldestPass) break;
      const record = archive.get(id);
      if (!record || record.passesLost) {
        truncated = true;
        break;
      }
    }
    return { ids, truncated };
  }

  function summarizeWindows(ranges, retain) {
    const { ids, truncated } = framesInRanges(Array.isArray(ranges) ? ranges : []);
    if (retain) archiveFrames(ids);
    let activeTicks = 0;
    let submits = 0;
    let glDraws = 0;
    let glClears = 0;
    let durationMs = 0;
    for (const id of ids) {
      const frame = frameRecord(id);
      durationMs += frame.end - frame.start;
      submits += frame.submits;
      glDraws += frame.glDraws;
      glClears += frame.glClears;
      if (frame.submits > 0 || frame.glDraws > 0 || frame.glClears > 0) activeTicks += 1;
    }
    const activity = {
      ticks: ids.length,
      activeTicks,
      submits,
      glDraws,
      glClears,
      pageFps: durationMs > 0 ? roundTo(activeTicks / (durationMs / 1000), 1) : null,
      activeFrameRatio: ids.length ? roundTo(activeTicks / ids.length, 3) : null
    };
    const autoGpu = config.gpuTiming ? summarizeGpu(ids) : null;
    // Present only when frames of the window had left the rings: its statistics cover the rest.
    if (autoGpu && truncated) autoGpu.truncated = true;
    return { activity, autoGpu };
  }

  function summarizeGpu(ids) {
    const partialReasons = {};
    for (const reason of PARTIAL_REASONS) partialReasons[reason] = 0;
    const unions = [];
    const sums = [];
    const spans = [];
    const overlaps = [];
    const idleGaps = [];
    let workFrames = 0;
    let noWorkFrames = 0;
    let timedFrames = 0;
    let partialFrames = 0;
    let pending = 0;
    let untimedFrames = 0;
    let workSources = 0;
    let timedSources = 0;
    for (const id of ids) {
      const frame = frameRecord(id);
      const gl = frame.glDraws > 0 || frame.glClears > 0;
      if (frame.submits === 0 && !gl) {
        noWorkFrames += 1;
        continue;
      }
      workFrames += 1;
      workSources |= (frame.submits > 0 ? 1 : 0) | (gl ? 2 : 0);
      if (frame.pending > 0) {
        pending += 1;
      } else if (frame.partial || (frame.timed > 0 && frame.untimed > 0)) {
        // An untimed device or GL context beside timed work: the union would miss its work.
        const reason = frame.partial || "unresolved";
        partialFrames += 1;
        partialReasons[reason] = (partialReasons[reason] || 0) + 1;
      } else if (frame.timed > 0) {
        timedFrames += 1;
        timedSources |= frame.sources;
        unions.push(frame.unionNs);
        sums.push(frame.sumNs);
        spans.push(frame.spanNs);
        if (frame.unionNs > 0) {
          overlaps.push(frame.sumNs / frame.unionNs);
          idleGaps.push(frame.spanNs / frame.unionNs);
        }
      } else if (frame.untimed > 0) {
        untimedFrames += 1;
      }
    }
    const sourceBits = timedSources || workSources;
    const source = sourceBits === 3 ? "mixed" : sourceBits === 2 ? "webgl-time-elapsed" : sourceBits === 1 ? "webgpu-timestamp" : null;
    let status = "ok";
    if (timedFrames === 0) {
      status = workFrames > 0 && untimedFrames === workFrames ? "unsupported" : "no-frames";
    } else if (partialFrames > timedFrames) {
      status = "partial";
    }
    return {
      status,
      source,
      frames: ids.length,
      workFrames,
      noWorkFrames,
      timedFrames,
      partialFrames,
      pending,
      partialReasons,
      frameNs: nsStats(unions),
      sumNs: p50p95(sums),
      spanNs: p50p95(spans),
      overlapRatio: overlaps.length ? roundTo(median(overlaps), 3) : null,
      idleGapRatio: idleGaps.length ? roundTo(median(idleGaps), 3) : null,
      passes: summarizePasses(ids)
    };
  }

  function summarizePasses(ids) {
    const oldest = timing.frameId - PASS_FRAMES;
    const values = timing.passKeys.map(() => ({ duration: [], exclusive: [], overlappedFrames: 0 }));
    const add = (index, durationNs, exclusiveNs) => {
      const value = values[index];
      value.duration.push(durationNs);
      value.exclusive.push(exclusiveNs);
      if (durationNs > 1.5 * exclusiveNs) value.overlappedFrames += 1;
    };
    for (const id of ids) {
      if (id > oldest) {
        const at = id % PASS_FRAMES;
        for (let index = 0; index < timing.passKeys.length; index += 1) {
          const key = timing.passKeys[index];
          if (key.tag[at] === id) add(index, key.duration[at], key.exclusive[at]);
        }
      } else {
        const passes = archive.get(id)?.passes;
        for (let at = 0; passes && at < passes.length; at += 3) add(passes[at], passes[at + 1], passes[at + 2]);
      }
    }
    const passes = [];
    for (let index = 0; index < timing.passKeys.length; index += 1) {
      const key = timing.passKeys[index];
      const { duration, exclusive, overlappedFrames } = values[index];
      if (exclusive.length === 0) continue;
      passes.push({
        key: key.key,
        type: key.type,
        label: key.label,
        count: exclusive.length,
        exclusiveP50Ns: Math.round(median(exclusive)),
        durationP50Ns: Math.round(median(duration)),
        overlapped: overlappedFrames > 0.1 * exclusive.length,
        site: key.site,
        appSite: key.appSite,
        pipeline: key.pipeline ?? null
      });
    }
    return passes.sort((a, b) => b.exclusiveP50Ns - a.exclusiveP50Ns).slice(0, 16);
  }

  function pendingBefore(boundary) {
    for (let id = Math.max(0, boundary - LEDGER_FRAMES); id < boundary; id += 1) {
      const frame = frameById(id);
      if (frame && frame.pending > 0) return true;
    }
    return false;
  }

  // Waits for the readbacks of every frame closed before the call; frames opened later do not delay it.
  function flushFrames(timeoutMs = 1000) {
    const boundary = timing.frameId;
    const deadline = nowMs() + Math.max(0, Number(timeoutMs) || 0);
    return new Promise((resolve) => {
      const check = () => {
        try {
          for (const reference of timing.passTimers) {
            const timer = reference.deref();
            if (timer) resolveSubmitted(timer);
          }
        } catch {
          // Unresolved frames stay pending until the deadline.
        }
        if (!pendingBefore(boundary)) resolve(true);
        else if (nowMs() >= deadline) resolve(false);
        else setTimeout(check, 4);
      };
      check();
    });
  }

  function sawGpuWork() {
    for (let id = Math.max(0, timing.frameId - 3); id <= timing.frameId; id += 1) {
      const frame = frameById(id);
      if (frame && (frame.submits > 0 || frame.glDraws > 0 || frame.glClears > 0)) return true;
    }
    return false;
  }

  function describeTexImage2D(args) {
    const [target, level, internalFormat] = args;
    if (args.length >= 9) {
      const [, , , width, height, border, format, type, source] = args;
      return {
        border,
        bytes: Number(width || 1) * Number(height || 1) * webGLBytesPerPixel(internalFormat, type),
        format,
        height: Number(height || 1),
        internalFormat,
        level,
        sourceType: source?.constructor?.name || null,
        target,
        type,
        width: Number(width || 1)
      };
    }
    const [, , , format, type, source] = args;
    const width = Number(source?.width || source?.videoWidth || 1);
    const height = Number(source?.height || source?.videoHeight || 1);
    return {
      bytes: width * height * webGLBytesPerPixel(internalFormat, type),
      format,
      height,
      internalFormat,
      level,
      sourceType: source?.constructor?.name || "source",
      target,
      type,
      width
    };
  }

  function estimateWebGPUTextureBytes(descriptor = {}) {
    const size = normalizeExtent(descriptor.size);
    const layout = webGPUFormatLayout(descriptor.format);
    const mipLevels = Number(descriptor.mipLevelCount || 1);
    const samples = Number(descriptor.sampleCount || 1);
    let total = 0;
    for (let level = 0; level < mipLevels; level += 1) {
      const width = Math.max(1, Math.floor(size.width / (2 ** level)));
      const height = Math.max(1, Math.floor(size.height / (2 ** level)));
      const depth = descriptor.dimension === "3d"
        ? Math.max(1, Math.floor(size.depth / (2 ** level)))
        : size.depth;
      total += Math.ceil(width / layout.blockWidth)
        * Math.ceil(height / layout.blockHeight)
        * depth
        * layout.bytesPerBlock
        * samples;
    }
    return total;
  }

  function normalizeExtent(size = {}) {
    if (Array.isArray(size)) {
      return { depth: Number(size[2] || 1), height: Number(size[1] || 1), width: Number(size[0] || 1) };
    }
    return {
      depth: Number(size.depthOrArrayLayers || size.depth || 1),
      height: Number(size.height || 1),
      width: Number(size.width || 1)
    };
  }

  function webGPUFormatLayout(format = "") {
    const value = String(format).toLowerCase();
    if (/^bc1-|^bc4-|^etc2-rgb8|^etc2-rgb8a1|^eac-r11/.test(value)) {
      return { blockHeight: 4, blockWidth: 4, bytesPerBlock: 8 };
    }
    if (/^bc|^etc2-|^eac-rg11/.test(value)) {
      return { blockHeight: 4, blockWidth: 4, bytesPerBlock: 16 };
    }
    const astc = /^astc-(\d+)x(\d+)-/.exec(value);
    if (astc) {
      return { blockHeight: Number(astc[2]), blockWidth: Number(astc[1]), bytesPerBlock: 16 };
    }
    const sizes = {
      r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, stencil8: 1,
      r16uint: 2, r16sint: 2, r16float: 2, rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2, depth16unorm: 2,
      r32uint: 4, r32sint: 4, r32float: 4, rg16uint: 4, rg16sint: 4, rg16float: 4,
      rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
      bgra8unorm: 4, "bgra8unorm-srgb": 4, rgb10a2uint: 4, rgb10a2unorm: 4,
      rg11b10ufloat: 4, rgb9e5ufloat: 4, depth24plus: 4, "depth24plus-stencil8": 4, depth32float: 4,
      rg32uint: 8, rg32sint: 8, rg32float: 8, rgba16uint: 8, rgba16sint: 8, rgba16float: 8,
      "depth32float-stencil8": 8, rgba32uint: 16, rgba32sint: 16, rgba32float: 16
    };
    return { blockHeight: 1, blockWidth: 1, bytesPerBlock: sizes[value] || 4 };
  }

  function webGLBytesPerPixel(format, type) {
    const sized = {
      0x8229: 1, 0x8f94: 1, 0x8f98: 1, 0x822b: 2, 0x8232: 2, 0x8238: 2,
      0x822d: 2, 0x81a5: 2, 0x8051: 3, 0x8058: 4, 0x8c43: 4, 0x8f97: 4,
      0x8f9b: 4, 0x822e: 4, 0x8cac: 4, 0x88f0: 4, 0x881a: 8, 0x8230: 8,
      0x823a: 8, 0x8cad: 8, 0x8814: 16
    };
    if (sized[Number(format)]) {
      return sized[Number(format)];
    }
    const components = { 0x1903: 1, 0x1906: 1, 0x1909: 1, 0x190a: 2, 0x8227: 2, 0x1907: 3, 0x1908: 4 };
    const typeBytes = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x140b: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4 };
    return (components[Number(format)] || 4) * (typeBytes[Number(type)] || 1);
  }

  function mipBytes(width, height, depth, bytesPerPixel, levels) {
    let total = 0;
    for (let level = 0; level < Number(levels || 1); level += 1) {
      total += Math.max(1, Math.floor(Number(width || 1) / (2 ** level)))
        * Math.max(1, Math.floor(Number(height || 1) / (2 ** level)))
        * Math.max(1, Math.floor(Number(depth || 1) / (2 ** level)))
        * bytesPerPixel;
    }
    return total;
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}));
    } catch {
      return {};
    }
  }

  function copyGroups(groups) {
    const out = {};
    for (const key in groups) {
      const group = groups[key];
      out[key] = { bytes: group.bytes, count: group.count };
    }
    return out;
  }

  function resourceSnapshot(snapshotOptions = {}) {
    // Copy only the small category totals; snapshots are independent of live-resource count.
    const liveResources = [];
    if (config.includeResources && snapshotOptions.includeResources !== false) {
      for (const resource of resources.values()) {
        liveResources.push(clone(resource));
        if (liveResources.length === 1000) break;
      }
    }
    return {
      pipelines: {
        syncCount: (counters["webgpu.createRenderPipeline"] || 0) + (counters["webgpu.createComputePipeline"] || 0),
        asyncCount: (counters["webgpu.createRenderPipelineAsync"] || 0) + (counters["webgpu.createComputePipelineAsync"] || 0),
        shaderModules: counters["webgpu.createShaderModule"] || 0
      },
      bindGroups: {createdCount: hot.webgpuCreateBindGroup, layoutCount: counters["webgpu.createBindGroupLayout"] || 0},
      api: "auto",
      byApi: copyGroups(byApi),
      byKind: copyGroups(byKind),
      history: snapshotOptions.includeHistory === false ? [] : history.slice(historyCursor).concat(history.slice(0, historyCursor)),
      liveResources,
      totalBytes,
      totalResources: resources.size
    };
  }

  // Dotted counter names: the cold dictionary, every hot field, and the derived totals.
  function counterValues() {
    const out = {
      "webgpu.uncapturedErrors": counters["webgpu.uncapturedErrors"],
      "webgpu.deviceLost": counters["webgpu.deviceLost"],
      "webgl.contextLost": counters["webgl.contextLost"],
      "webgl.shaderCompileFailures": counters["webgl.shaderCompileFailures"],
      "webgl.programLinkFailures": counters["webgl.programLinkFailures"],
      "webgpu.draw": hot.webgpuDraw,
      "webgpu.drawIndexed": hot.webgpuDrawIndexed,
      "webgpu.drawIndirect": hot.webgpuDrawIndirect,
      "webgpu.drawIndexedIndirect": hot.webgpuDrawIndexedIndirect,
      "webgpu.dispatchWorkgroups": hot.webgpuDispatch,
      "webgpu.dispatchWorkgroupsIndirect": hot.webgpuDispatchIndirect,
      "webgpu.bundleDrawCalls": hot.webgpuBundleDraw,
      "webgpu.bundleDrawsExecuted": hot.webgpuBundleDrawsExecuted,
      "webgpu.renderBundles": hot.webgpuRenderBundles,
      "webgpu.renderPasses": hot.webgpuRenderPasses,
      "webgpu.computePasses": hot.webgpuComputePasses,
      "webgpu.commandEncoders": hot.webgpuCommandEncoders,
      "webgpu.queueSubmits": hot.webgpuQueueSubmits,
      "webgpu.commandBuffersSubmitted": hot.webgpuCommandBuffers,
      "webgpu.writeBufferCalls": hot.webgpuWriteBufferCalls,
      "webgpu.writeBufferBytes": hot.webgpuWriteBufferBytes,
      "webgpu.writeTextureCalls": hot.webgpuWriteTextureCalls,
      "webgpu.writeTextureBytes": hot.webgpuWriteTextureBytes,
      "webgpu.createBindGroup": hot.webgpuCreateBindGroup,
      "webgpu.createBuffer": hot.webgpuCreateBuffer,
      "webgpu.createTexture": hot.webgpuCreateTexture,
      "webgpu.createView": hot.webgpuCreateView,
      "webgpu.createSampler": hot.webgpuCreateSampler,
      "webgl2.drawArrays": hot.webgl2DrawArrays,
      "webgl2.drawElements": hot.webgl2DrawElements,
      "webgl2.drawArraysInstanced": hot.webgl2DrawArraysInstanced,
      "webgl2.drawElementsInstanced": hot.webgl2DrawElementsInstanced,
      "webgl2.drawRangeElements": hot.webgl2DrawRangeElements,
      "webgl2.clearCalls": hot.webgl2Clear,
      "webgl.drawArrays": hot.webglDrawArrays,
      "webgl.drawElements": hot.webglDrawElements,
      "webgl.drawArraysInstanced": hot.webglDrawArraysInstanced,
      "webgl.drawElementsInstanced": hot.webglDrawElementsInstanced,
      "webgl.drawRangeElements": hot.webglDrawRangeElements,
      "webgl.clearCalls": hot.webglClear,
      "webgpu.drawCalls": hot.webgpuDraw + hot.webgpuDrawIndexed + hot.webgpuDrawIndirect + hot.webgpuDrawIndexedIndirect,
      "webgpu.dispatchCalls": hot.webgpuDispatch + hot.webgpuDispatchIndirect,
      "webgl2.drawCalls": hot.webgl2DrawArrays + hot.webgl2DrawElements + hot.webgl2DrawArraysInstanced + hot.webgl2DrawElementsInstanced + hot.webgl2DrawRangeElements,
      "webgl.drawCalls": hot.webglDrawArrays + hot.webglDrawElements + hot.webglDrawArraysInstanced + hot.webglDrawElementsInstanced + hot.webglDrawRangeElements
    };
    for (const key in counters) {
      out[key] = counters[key];
    }
    return out;
  }

  function snapshot(snapshotOptions) {
    return {
      counters: counterValues(),
      errors: errors.slice(),
      gpuErrors: gpuErrorSnapshot(),
      churnSites: churnSnapshot(),
      resources: resourceSnapshot(snapshotOptions),
      version: 2
    };
  }

  const instrumentation = {
    // Called by collectInPage after warmup: per-pass rings stay as allocated, and churn call-site sampling starts.
    beginSteadyState() {
      timing.steadyState = true;
      churn.active = config.callSites;
    },
    counters: counterValues,
    frames: {
      flush: flushFrames,
      sawGpuWork,
      // `{activity, autoGpu}` for the ledger frames that started and ended inside [startMs, endMs]. With
      // `retain`, those frames stay available to windows() after they leave the rings.
      window(startMs, endMs, retain) {
        return summarizeWindows([[startMs, endMs]], retain === true);
      },
      // Frames a window can span before its oldest frames leave the per-pass rings.
      capacity: PASS_FRAMES,
      // Closed ledger frames that started at or after startMs.
      framesSince(startMs) {
        let count = 0;
        for (let id = timing.frameId - 1; id >= 0 && count < LEDGER_FRAMES; id -= 1) {
          const frame = frameById(id);
          if (!frame || frame.start < Number(startMs)) break;
          count += 1;
        }
        return count;
      },
      // The same summary pooled over several [startMs, endMs] ranges (non-contiguous samples).
      windows(ranges) {
        return summarizeWindows(ranges);
      }
    },
    resetCounters() {
      for (const key of Object.keys(counters)) {
        counters[key] = 0;
      }
      for (const key of Object.keys(hot)) {
        hot[key] = 0;
      }
    },
    snapshot,
    version: 2
  };
  globalThis.__gpuReportMemoryTracker = { snapshot: resourceSnapshot };
  globalThis.__gpuReportInstrumentation = instrumentation;
  globalThis.__gpuPerfAutoInstrumentation = instrumentation;

  if (textureViewsPatched) patchTextureViews(globalThis.GPUTexture.prototype);
  patchCanvasContexts();
  patchWebGPU();
  return instrumentation;
}

/** Browser init-script source; the sourceURL lets stack parsing and LoAF attribution skip the tool's frames. */
export function autoInstrumentationSource(options = {}) {
  return `(${installAutoInstrumentation.toString()})(${JSON.stringify(options ?? {})})\n//# sourceURL=gpu-perf-agent/instrument.js`;
}
