/**
 * Installs dependency-free WebGPU/WebGL instrumentation before application code
 * runs. Keep every helper nested: runners serialize this function into a browser
 * init script with Function#toString.
 */
export function installAutoInstrumentation(options = {}) {
  if (globalThis.__gpuPerfAutoInstrumentation?.version === 1) {
    return globalThis.__gpuPerfAutoInstrumentation;
  }

  const config = {
    historyLimit: Math.max(0, Math.min(10000, Math.floor(Number(options.historyLimit ?? 500)) || 0)),
    includeResources: Boolean(options.includeResources)
  };
  const counters = Object.create(null);
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
    increment(`${resource.api}.resourcesCreated`);
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
      increment(`${resource.api}.resourcesReleased`);
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

  function replaceMethod(target, name, factory) {
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
      errors.push({ message: error?.message || String(error), method: name });
      return false;
    }
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
    replaceMethod(adapter, "requestDevice", (original) => async function gpuPerfRequestDevice(...args) {
      const device = await original.apply(this, args);
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

    replaceMethod(device, "createBuffer", (original) => function gpuPerfCreateBuffer(descriptor = {}) {
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
      const texture = original.call(this, descriptor);
      track(texture, {
        api: "webgpu",
        bytes: estimateWebGPUTextureBytes(descriptor),
        descriptor,
        kind: "texture",
        label: descriptor.label
      });
      patchDestroy(texture);
      return texture;
    });

    for (const method of [
      "createBindGroup", "createBindGroupLayout", "createComputePipeline", "createPipelineLayout",
      "createRenderBundleEncoder", "createRenderPipeline", "createSampler", "createShaderModule"
    ]) {
      replaceMethod(device, method, (original) => function gpuPerfDeviceCreate(...args) {
        increment(`webgpu.${method}`);
        return original.apply(this, args);
      });
    }
    for (const method of ["createComputePipelineAsync", "createRenderPipelineAsync"]) {
      replaceMethod(device, method, (original) => async function gpuPerfDeviceCreateAsync(...args) {
        increment(`webgpu.${method}`);
        return original.apply(this, args);
      });
    }

    replaceMethod(device, "createCommandEncoder", (original) => function gpuPerfCreateCommandEncoder(...args) {
      increment("webgpu.commandEncoders");
      const encoder = original.apply(this, args);
      patchCommandEncoder(encoder);
      return encoder;
    });
    patchQueue(device.queue);
  }

  function patchQueue(queue) {
    if (!queue || patched.has(queue)) {
      return;
    }
    patched.add(queue);
    replaceMethod(queue, "submit", (original) => function gpuPerfSubmit(commandBuffers) {
      increment("webgpu.queueSubmits");
      increment("webgpu.commandBuffersSubmitted", commandBuffers?.length || 0);
      return original.call(this, commandBuffers);
    });
    replaceMethod(queue, "writeBuffer", (original) => function gpuPerfWriteBuffer(...args) {
      increment("webgpu.writeBufferCalls");
      const elementSize = args[2]?.BYTES_PER_ELEMENT || 1;
      increment("webgpu.writeBufferBytes", args[4] != null ? args[4] * elementSize
        : Math.max(0, (args[2]?.byteLength || 0) - (args[3] || 0) * elementSize));
      return original.apply(this, args);
    });
    replaceMethod(queue, "writeTexture", (original) => function gpuPerfWriteTexture(...args) {
      increment("webgpu.writeTextureCalls");
      increment("webgpu.writeTextureBytes", args[1]?.byteLength ?? args[1]?.length ?? 0);
      return original.apply(this, args);
    });
  }

  function patchCommandEncoder(encoder) {
    encoder = methodTarget(encoder, "beginRenderPass");
    if (!encoder || patched.has(encoder)) {
      return;
    }
    patched.add(encoder);
    replaceMethod(encoder, "beginRenderPass", (original) => function gpuPerfBeginRenderPass(...args) {
      increment("webgpu.renderPasses");
      const pass = original.apply(this, args);
      patchRenderPass(pass);
      return pass;
    });
    replaceMethod(encoder, "beginComputePass", (original) => function gpuPerfBeginComputePass(...args) {
      increment("webgpu.computePasses");
      const pass = original.apply(this, args);
      patchComputePass(pass);
      return pass;
    });
    for (const method of [
      "clearBuffer", "copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture",
      "resolveQuerySet", "writeTimestamp"
    ]) {
      replaceMethod(encoder, method, (original) => function gpuPerfEncoderOperation(...args) {
        increment(`webgpu.${method}`);
        return original.apply(this, args);
      });
    }
  }

  function patchRenderPass(pass) {
    pass = methodTarget(pass, "draw");
    if (!pass || patched.has(pass)) {
      return;
    }
    patched.add(pass);
    for (const method of ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"] ) {
      replaceMethod(pass, method, (original) => function gpuPerfDraw(...args) {
        increment("webgpu.drawCalls");
        increment(`webgpu.${method}`);
        return original.apply(this, args);
      });
    }
    replaceMethod(pass, "executeBundles", (original) => function gpuPerfExecuteBundles(bundles) {
      increment("webgpu.renderBundles", bundles?.length || 0);
      return original.call(this, bundles);
    });
  }

  function patchComputePass(pass) {
    pass = methodTarget(pass, "dispatchWorkgroups");
    if (!pass || patched.has(pass)) {
      return;
    }
    patched.add(pass);
    for (const method of ["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]) {
      replaceMethod(pass, method, (original) => function gpuPerfDispatch(...args) {
        increment("webgpu.dispatchCalls");
        return original.apply(this, args);
      });
    }
  }

  function patchCanvasContexts() {
    for (const constructor of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
      const prototype = constructor?.prototype;
      replaceMethod(prototype, "getContext", (original) => function gpuPerfGetContext(type, ...args) {
        const context = original.call(this, type, ...args);
        if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
          patchWebGLContext(context, type === "webgl2" ? "webgl2" : "webgl");
        }
        return context;
      });
    }
  }

  function patchWebGLContext(gl, api) {
    if (!gl || patched.has(gl)) {
      return;
    }
    patched.add(gl);
    increment(`${api}.contexts`);
    const bufferBindings = new Map();
    const textureBindings = new Map();
    let renderbufferBinding = null;

    replaceMethod(gl, "createBuffer", (original) => function gpuPerfGLCreateBuffer(...args) {
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
      const texture = original.apply(this, args);
      track(texture, { api, bytes: 0, kind: "texture" });
      return texture;
    });
    replaceMethod(gl, "bindTexture", (original) => function gpuPerfGLBindTexture(target, texture) {
      textureBindings.set(target, texture);
      return original.call(this, target, texture);
    });
    replaceMethod(gl, "texImage2D", (original) => function gpuPerfGLTexImage2D(...args) {
      const result = original.apply(this, args);
      const texture = textureBindings.get(args[0]);
      if (texture) {
        const descriptor = describeTexImage2D(args);
        update(texture, { bytes: descriptor.bytes, descriptor });
      }
      return result;
    });
    replaceMethod(gl, "texStorage2D", (original) => function gpuPerfGLTexStorage2D(target, levels, format, width, height) {
      const result = original.call(this, target, levels, format, width, height);
      const texture = textureBindings.get(target);
      if (texture) {
        update(texture, {
          bytes: mipBytes(width, height, 1, webGLBytesPerPixel(format, null), levels),
          descriptor: { format, height, levels, target, width }
        });
      }
      return result;
    });
    replaceMethod(gl, "texImage3D", (original) => function gpuPerfGLTexImage3D(...args) {
      const result = original.apply(this, args);
      const [target, level, format, width, height, depth, border, sourceFormat, type] = args;
      const texture = textureBindings.get(target);
      if (texture) {
        update(texture, {
          bytes: Number(width || 1) * Number(height || 1) * Number(depth || 1) * webGLBytesPerPixel(format, type),
          descriptor: { border, depth, format, height, level, sourceFormat, target, type, width }
        });
      }
      return result;
    });
    replaceMethod(gl, "texStorage3D", (original) => function gpuPerfGLTexStorage3D(target, levels, format, width, height, depth) {
      const result = original.call(this, target, levels, format, width, height, depth);
      const texture = textureBindings.get(target);
      if (texture) {
        update(texture, {
          bytes: mipBytes(width, height, depth, webGLBytesPerPixel(format, null), levels),
          descriptor: { depth, format, height, levels, target, width }
        });
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

    for (const method of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]) {
      replaceMethod(gl, method, (original) => function gpuPerfGLDraw(...args) {
        increment(`${api}.drawCalls`);
        increment(`${api}.${method}`);
        return original.apply(this, args);
      });
    }
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

  function resourceSnapshot(snapshotOptions = {}) {
    // Copy only the small category totals; snapshots are independent of live-resource count.
    const copyGroups = (groups) => Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, { ...value }]));
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
      bindGroups: {createdCount: counters["webgpu.createBindGroup"] || 0, layoutCount: counters["webgpu.createBindGroupLayout"] || 0},
      api: "auto",
      byApi: copyGroups(byApi),
      byKind: copyGroups(byKind),
      history: snapshotOptions.includeHistory === false ? [] : history.slice(historyCursor).concat(history.slice(0, historyCursor)),
      liveResources,
      totalBytes,
      totalResources: resources.size
    };
  }

  function snapshot(snapshotOptions) {
    return {
      counters: { ...counters },
      errors: errors.slice(),
      resources: resourceSnapshot(snapshotOptions),
      version: 1
    };
  }

  const instrumentation = {
    resetCounters() {
      for (const key of Object.keys(counters)) {
        delete counters[key];
      }
    },
    snapshot,
    version: 1
  };
  globalThis.__gpuReportMemoryTracker = { snapshot: resourceSnapshot };
  globalThis.__gpuReportInstrumentation = instrumentation;
  globalThis.__gpuPerfAutoInstrumentation = instrumentation;

  patchCanvasContexts();
  patchWebGPU();
  return instrumentation;
}

export function autoInstrumentationSource(options = {}) {
  return `(${installAutoInstrumentation.toString()})(${JSON.stringify(options)})`;
}
