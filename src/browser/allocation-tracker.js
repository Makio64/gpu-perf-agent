export function trackWebGPUDevice(device, options = {}) {
  const tracker = createTracker("webgpu", options);
  const originalCreateBuffer = device.createBuffer.bind(device);
  const originalCreateTexture = device.createTexture.bind(device);
  const originalCreateRenderPipeline = device.createRenderPipeline?.bind(device);
  const originalCreateRenderPipelineAsync = device.createRenderPipelineAsync?.bind(device);
  const originalCreateComputePipeline = device.createComputePipeline?.bind(device);
  const originalCreateComputePipelineAsync = device.createComputePipelineAsync?.bind(device);
  const originalCreateShaderModule = device.createShaderModule?.bind(device);
  const originalCreateBindGroup = device.createBindGroup?.bind(device);
  const originalCreateBindGroupLayout = device.createBindGroupLayout?.bind(device);

  device.createBuffer = (descriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    const bytes = Number(descriptor?.size || 0);
    const id = tracker.track({
      api: "webgpu",
      bytes,
      descriptor: lightweightDescriptor(descriptor),
      kind: "buffer",
      label: descriptor?.label || null
    });
    patchDestroy(buffer, () => tracker.release(id));
    return buffer;
  };

  device.createTexture = (descriptor) => {
    const texture = originalCreateTexture(descriptor);
    const bytes = estimateWebGPUTextureBytes(descriptor);
    const id = tracker.track({
      api: "webgpu",
      bytes,
      descriptor: lightweightDescriptor(descriptor),
      kind: "texture",
      label: descriptor?.label || null
    });
    patchDestroy(texture, () => tracker.release(id));
    return texture;
  };

  if (originalCreateRenderPipeline) {
    device.createRenderPipeline = (descriptor) => {
      tracker.recordPipeline("render", false, descriptor);
      return originalCreateRenderPipeline(descriptor);
    };
  }

  if (originalCreateRenderPipelineAsync) {
    device.createRenderPipelineAsync = (descriptor) => {
      tracker.recordPipeline("render", true, descriptor);
      return originalCreateRenderPipelineAsync(descriptor);
    };
  }

  if (originalCreateComputePipeline) {
    device.createComputePipeline = (descriptor) => {
      tracker.recordPipeline("compute", false, descriptor);
      return originalCreateComputePipeline(descriptor);
    };
  }

  if (originalCreateComputePipelineAsync) {
    device.createComputePipelineAsync = (descriptor) => {
      tracker.recordPipeline("compute", true, descriptor);
      return originalCreateComputePipelineAsync(descriptor);
    };
  }

  if (originalCreateShaderModule) {
    device.createShaderModule = (descriptor) => {
      tracker.recordShaderModule(descriptor);
      return originalCreateShaderModule(descriptor);
    };
  }

  if (originalCreateBindGroup) {
    device.createBindGroup = (descriptor) => {
      tracker.recordBindGroup(descriptor);
      return originalCreateBindGroup(descriptor);
    };
  }

  if (originalCreateBindGroupLayout) {
    device.createBindGroupLayout = (descriptor) => {
      tracker.recordBindGroupLayout(descriptor);
      return originalCreateBindGroupLayout(descriptor);
    };
  }

  return tracker;
}

export function trackWebGL2Context(gl, options = {}) {
  const tracker = createTracker("webgl2", options);
  const bindings = new Map();
  const textureBindings = new Map();
  const original = {};

  for (const name of [
    "bindBuffer",
    "bufferData",
    "createBuffer",
    "createTexture",
    "deleteBuffer",
    "deleteTexture",
    "bindTexture",
    "texImage2D",
    "texStorage2D"
  ]) {
    original[name] = gl[name]?.bind(gl);
  }

  gl.createBuffer = () => {
    const buffer = original.createBuffer();
    tracker.attach(buffer, {
      api: "webgl2",
      bytes: 0,
      kind: "buffer",
      label: null
    });
    return buffer;
  };

  gl.bindBuffer = (target, buffer) => {
    bindings.set(target, buffer);
    return original.bindBuffer(target, buffer);
  };

  gl.bufferData = (target, srcDataOrSize, usage) => {
    const result = original.bufferData(target, srcDataOrSize, usage);
    const buffer = bindings.get(target);
    if (buffer) {
      const bytes = typeof srcDataOrSize === "number" ? srcDataOrSize : Number(srcDataOrSize?.byteLength || 0);
      tracker.updateAttached(buffer, {
        bytes,
        descriptor: { target, usage },
        kind: "buffer"
      });
    }
    return result;
  };

  gl.deleteBuffer = (buffer) => {
    tracker.releaseAttached(buffer);
    return original.deleteBuffer(buffer);
  };

  gl.createTexture = () => {
    const texture = original.createTexture();
    tracker.attach(texture, {
      api: "webgl2",
      bytes: 0,
      kind: "texture",
      label: null
    });
    return texture;
  };

  gl.bindTexture = (target, texture) => {
    textureBindings.set(target, texture);
    return original.bindTexture(target, texture);
  };

  gl.texImage2D = (...args) => {
    const result = original.texImage2D(...args);
    const target = args[0];
    const texture = textureBindings.get(target);
    if (texture) {
      const descriptor = webGLTexImageDescriptor(args);
      tracker.updateAttached(texture, {
        bytes: descriptor.bytes,
        descriptor,
        kind: "texture"
      });
    }
    return result;
  };

  gl.texStorage2D = (...args) => {
    const result = original.texStorage2D(...args);
    const [target, levels, internalFormat, width, height] = args;
    const texture = textureBindings.get(target);
    if (texture) {
      const bytes = estimateWebGLTextureBytes(width, height, internalFormat, null, levels);
      tracker.updateAttached(texture, {
        bytes,
        descriptor: { height, internalFormat, levels, target, width },
        kind: "texture"
      });
    }
    return result;
  };

  gl.deleteTexture = (texture) => {
    tracker.releaseAttached(texture);
    return original.deleteTexture(texture);
  };

  return tracker;
}

export function createTracker(api, options = {}) {
  let nextId = 1;
  const resources = new Map();
  const attached = new WeakMap();
  const history = [];
  let totalCreatedCount = 0;
  let totalReleasedCount = 0;
  const createdByKind = {};
  const releasedByKind = {};

  const pipelines = {
    sync: [],
    syncCount: 0,
    asyncCount: 0,
    shaderModules: 0
  };

  const bindGroups = {
    createdCount: 0,
    layoutCount: 0
  };

  function recordPipeline(type, isAsync, descriptor) {
    if (isAsync) {
      pipelines.asyncCount += 1;
    } else {
      pipelines.syncCount += 1;
      if (pipelines.sync.length < 50) {
        pipelines.sync.push({
          type,
          label: descriptor?.label || "unlabeled",
          atMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
          stack: typeof Error !== "undefined" ? new Error().stack : null
        });
      }
    }
  }

  function recordShaderModule(descriptor) {
    pipelines.shaderModules += 1;
  }

  function recordBindGroup(descriptor) {
    bindGroups.createdCount += 1;
  }

  function recordBindGroupLayout(descriptor) {
    bindGroups.layoutCount += 1;
  }

  function remember(event) {
    if (!options.history) {
      return;
    }
    history.push({
      atMs: performance.now(),
      ...event
    });
    if (history.length > (options.historyLimit || 1000)) {
      history.shift();
    }
  }

  function track(resource) {
    const id = nextId;
    nextId += 1;
    resources.set(id, {
      id,
      ...resource
    });
    totalCreatedCount += 1;
    const kind = resource.kind || "unknown";
    createdByKind[kind] = (createdByKind[kind] || 0) + 1;
    remember({ id, type: "track" });
    return id;
  }

  function attach(object, resource) {
    const id = track(resource);
    attached.set(object, id);
    return id;
  }

  function update(id, patch) {
    const current = resources.get(id);
    if (!current) {
      return;
    }
    resources.set(id, {
      ...current,
      ...patch
    });
    remember({ id, patch, type: "update" });
  }

  function updateAttached(object, patch) {
    const id = attached.get(object);
    if (id) {
      update(id, patch);
    }
  }

  function release(id) {
    const resource = resources.get(id);
    if (resource) {
      totalReleasedCount += 1;
      const kind = resource.kind || "unknown";
      releasedByKind[kind] = (releasedByKind[kind] || 0) + 1;
    }
    if (resources.delete(id)) {
      remember({ id, type: "release" });
    }
  }

  function releaseAttached(object) {
    const id = attached.get(object);
    if (id) {
      release(id);
      attached.delete(object);
    }
  }

  function snapshot() {
    const byKind = {};
    let totalBytes = 0;
    const liveResources = [];

    for (const resource of resources.values()) {
      totalBytes += resource.bytes || 0;
      if (!byKind[resource.kind]) {
        byKind[resource.kind] = {
          bytes: 0,
          count: 0
        };
      }
      byKind[resource.kind].bytes += resource.bytes || 0;
      byKind[resource.kind].count += 1;
      if (options.includeResources) {
        liveResources.push(resource);
      }
    }

    return {
      api,
      byKind,
      history: options.history ? history.slice() : undefined,
      liveResources,
      totalBytes,
      totalResources: resources.size,
      createdCount: totalCreatedCount,
      releasedCount: totalReleasedCount,
      createdByKind: { ...createdByKind },
      releasedByKind: { ...releasedByKind },
      pipelines: {
        syncCount: pipelines.syncCount,
        asyncCount: pipelines.asyncCount,
        shaderModules: pipelines.shaderModules,
        syncPipelines: pipelines.sync.slice()
      },
      bindGroups: {
        createdCount: bindGroups.createdCount,
        layoutCount: bindGroups.layoutCount
      }
    };
  }

  return {
    attach,
    recordBindGroup,
    recordBindGroupLayout,
    recordPipeline,
    recordShaderModule,
    release,
    releaseAttached,
    snapshot,
    track,
    update,
    updateAttached
  };
}

export function estimateWebGPUTextureBytes(descriptor = {}) {
  const size = normalizeExtent3D(descriptor.size);
  const blockInfo = webGPUFormatBlockInfo(descriptor.format);
  const sampleCount = Number(descriptor.sampleCount || 1);
  const mipLevelCount = Number(descriptor.mipLevelCount || 1);
  let bytes = 0;

  for (let level = 0; level < mipLevelCount; level += 1) {
    const levelWidth = Math.max(1, size.width >> level);
    const levelHeight = Math.max(1, size.height >> level);
    const levelDepth = Math.max(1, size.depthOrArrayLayers);

    if (blockInfo) {
      const blocksW = Math.max(1, Math.ceil(levelWidth / blockInfo.blockWidth));
      const blocksH = Math.max(1, Math.ceil(levelHeight / blockInfo.blockHeight));
      bytes += blocksW * blocksH * levelDepth * blockInfo.bytesPerBlock * sampleCount;
    } else {
      const bytesPerPixel = webGPUFormatBytes(descriptor.format);
      bytes += levelWidth * levelHeight * levelDepth * bytesPerPixel * sampleCount;
    }
  }

  return bytes;
}

function patchDestroy(resource, onDestroy) {
  if (typeof resource.destroy !== "function") {
    return;
  }

  const destroy = resource.destroy.bind(resource);
  let released = false;
  resource.destroy = () => {
    if (!released) {
      released = true;
      onDestroy();
    }
    return destroy();
  };
}

function lightweightDescriptor(descriptor) {
  if (!descriptor) return {};
  const out = {};
  if (descriptor.label) out.label = descriptor.label;
  if (descriptor.size) out.size = descriptor.size;
  if (descriptor.usage !== undefined) out.usage = descriptor.usage;
  if (descriptor.format) out.format = descriptor.format;
  if (descriptor.dimension) out.dimension = descriptor.dimension;
  if (descriptor.sampleCount !== undefined) out.sampleCount = descriptor.sampleCount;
  if (descriptor.mipLevelCount !== undefined) out.mipLevelCount = descriptor.mipLevelCount;
  return out;
}

function cloneDescriptor(descriptor) {
  return lightweightDescriptor(descriptor);
}

function normalizeExtent3D(size = {}) {
  if (Array.isArray(size)) {
    return {
      depthOrArrayLayers: Number(size[2] || 1),
      height: Number(size[1] || 1),
      width: Number(size[0] || 1)
    };
  }

  return {
    depthOrArrayLayers: Number(size.depthOrArrayLayers || size.depth || 1),
    height: Number(size.height || 1),
    width: Number(size.width || 1)
  };
}

function webGPUFormatBlockInfo(format = "") {
  const normalized = String(format).toLowerCase();

  // BC formats (dxt, bc1-7)
  if (/bc1|bc4|dxt1/.test(normalized)) {
    return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 };
  }
  if (/bc2|bc3|bc5|bc6|bc7|dxt3|dxt5/.test(normalized)) {
    return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 };
  }

  // ETC formats
  if (/etc2-rgb8/.test(normalized)) {
    return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 };
  }
  if (/etc2-rgba8|eac/.test(normalized)) {
    return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 };
  }

  // ASTC formats
  if (/astc/.test(normalized)) {
    let blockWidth = 4;
    let blockHeight = 4;
    const match = /astc-(\d+)x(\d+)/.exec(normalized);
    if (match) {
      blockWidth = parseInt(match[1], 10);
      blockHeight = parseInt(match[2], 10);
    }
    return { blockWidth, blockHeight, bytesPerBlock: 16 };
  }

  return null;
}

function webGPUFormatBytes(format = "") {
  const normalized = String(format).toLowerCase();
  if (/rgba32|rg32|depth32|stencil8/.test(normalized)) {
    return 16;
  }
  if (/rgba16|rg16|r32|depth24plus-stencil8/.test(normalized)) {
    return 8;
  }
  if (/rgba8|bgra8|rgb10a2|rg11b10|rg8|r16|depth24|depth32/.test(normalized)) {
    return 4;
  }
  if (/r8/.test(normalized)) {
    return 1;
  }
  return 4;
}

function webGLTexImageDescriptor(args) {
  const [target, level, internalFormat, widthOrFormat, heightOrType, borderOrSource, format, type, source] = args;
  const hasSourceObject = typeof widthOrFormat !== "number";
  if (hasSourceObject) {
    const image = widthOrFormat;
    const width = Number(image?.width || image?.videoWidth || 1);
    const height = Number(image?.height || image?.videoHeight || 1);
    const bytes = estimateWebGLTextureBytes(width, height, internalFormat, heightOrType, 1);
    return { bytes, height, internalFormat, level, sourceType: image?.constructor?.name || "source", target, width };
  }

  const width = Number(widthOrFormat || 1);
  const height = Number(heightOrType || 1);
  const bytes = estimateWebGLTextureBytes(width, height, internalFormat, type, 1);
  return {
    border: borderOrSource,
    bytes,
    format,
    height,
    internalFormat,
    level,
    target,
    type,
    width,
    sourceType: source?.constructor?.name || null
  };
}

function estimateWebGLTextureBytes(width, height, internalFormat, type, levels = 1) {
  let bytes = Number(width || 1) * Number(height || 1) * webGLBytesPerPixel(internalFormat, type);
  let total = 0;
  for (let level = 0; level < Number(levels || 1); level += 1) {
    total += bytes;
    bytes = Math.max(1, Math.floor(bytes / 4));
  }
  return total;
}

function webGLBytesPerPixel(internalFormat, type) {
  const text = `${internalFormat} ${type}`.toLowerCase();
  if (/rgba32|float/.test(text)) {
    return 16;
  }
  if (/rgba16|half_float/.test(text)) {
    return 8;
  }
  if (/rgb|rgba|depth24|depth32|unsigned_int/.test(text)) {
    return 4;
  }
  if (/rg|luminance_alpha/.test(text)) {
    return 2;
  }
  return 4;
}
