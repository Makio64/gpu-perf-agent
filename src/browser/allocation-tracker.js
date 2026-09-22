export function trackWebGPUDevice(device, options = {}) {
  const tracker = createTracker("webgpu", options);
  const originalCreateBuffer = device.createBuffer.bind(device);
  const originalCreateTexture = device.createTexture.bind(device);

  device.createBuffer = (descriptor) => {
    const buffer = originalCreateBuffer(descriptor);
    const bytes = Number(descriptor?.size || 0);
    const id = tracker.track({
      api: "webgpu",
      bytes,
      descriptor: cloneDescriptor(descriptor),
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
      descriptor: cloneDescriptor(descriptor),
      kind: "texture",
      label: descriptor?.label || null
    });
    patchDestroy(texture, () => tracker.release(id));
    return texture;
  };

  for (const [method, record] of [
    ["createRenderPipeline", descriptor => tracker.recordPipeline("render", false, descriptor)],
    ["createRenderPipelineAsync", descriptor => tracker.recordPipeline("render", true, descriptor)],
    ["createComputePipeline", descriptor => tracker.recordPipeline("compute", false, descriptor)],
    ["createComputePipelineAsync", descriptor => tracker.recordPipeline("compute", true, descriptor)],
    ["createShaderModule", tracker.recordShaderModule], ["createBindGroup", tracker.recordBindGroup], ["createBindGroupLayout", tracker.recordBindGroupLayout]
  ]) {
    if (typeof device[method] !== "function") continue;
    const original = device[method].bind(device);
    device[method] = (...args) => { const result = original(...args); record(args[0]); return result; };
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

  gl.bufferData = (target, srcDataOrSize, usage, ...range) => {
    const result = original.bufferData(target, srcDataOrSize, usage, ...range);
    const buffer = bindings.get(target);
    if (buffer) {
      const elementSize = srcDataOrSize?.BYTES_PER_ELEMENT || 1;
      const remaining = Math.max(0, Number(srcDataOrSize?.byteLength || 0) - Number(range[0] || 0) * elementSize);
      const bytes = typeof srcDataOrSize === "number" ? srcDataOrSize : range[1] ? Number(range[1]) * elementSize : remaining;
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
  const historyLimit = options.history ? Number(options.historyLimit ?? 1000) : 0;
  const resourceLimit = Number(options.resourceLimit ?? 1000);
  for (const [name, value] of [['historyLimit', historyLimit], ['resourceLimit', resourceLimit]]) {
    if (!Number.isInteger(value) || value < 0 || value > 100000) throw new TypeError(`${name} must be an integer between 0 and 100000.`);
  }
  let nextId = 1, totalBytes = 0, historyCursor = 0;
  const resources = new Map();
  const attached = new WeakMap();
  const byKind = Object.create(null);
  const history = [];

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

  let totalCreatedCount = 0, totalReleasedCount = 0;
  const createdByKind = {}, releasedByKind = {};

  function remember(event) {
    if (!historyLimit) return;
    const entry = { atMs: performance.now(), ...cloneDescriptor(event) };
    if (history.length < historyLimit) history.push(entry);
    else { history[historyCursor] = entry; historyCursor = (historyCursor + 1) % historyLimit; }
  }

  function normalize(resource, id) {
    const bytes = Number(resource.bytes ?? 0);
    if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError('Tracked resource bytes must be finite and non-negative.');
    return { ...resource, bytes, id, kind: resource.kind ?? 'unknown' };
  }

  function adjust(resource, sign) {
    totalBytes += resource.bytes * sign;
    const group = byKind[resource.kind] ||= {bytes:0,count:0};
    group.bytes += resource.bytes * sign;
    group.count += sign;
    if (!group.count) delete byKind[resource.kind];
  }

  function track(resource) {
    const id = nextId++;
    const entry = normalize(resource, id);
    resources.set(id, entry);
    totalCreatedCount++; createdByKind[entry.kind] = (createdByKind[entry.kind] || 0) + 1;
    adjust(entry, 1);
    remember({id,type:'track'});
    return id;
  }

  function attach(object, resource) {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return null;
    const existing = attached.get(object);
    if (existing && resources.has(existing)) { update(existing, resource); return existing; }
    const id = track(resource);
    attached.set(object,id);
    return id;
  }

  function update(id, patch) {
    const current = resources.get(id);
    if (!current) return;
    const next = normalize({...current,...patch},id);
    adjust(current,-1);
    resources.set(id,next);
    adjust(next,1);
    remember({id,patch,type:'update'});
  }

  function updateAttached(object, patch) {
    const id = attached.get(object);
    if (id) update(id,patch);
  }

  function release(id) {
    const current = resources.get(id);
    if (!current) return;
    adjust(current,-1);
    resources.delete(id);
    totalReleasedCount++; releasedByKind[current.kind] = (releasedByKind[current.kind] || 0) + 1;
    remember({id,type:'release'});
  }

  function releaseAttached(object) {
    const id = attached.get(object);
    if (id) { release(id); attached.delete(object); }
  }

  function snapshot(snapshotOptions = {}) {
    const includeResources = snapshotOptions.includeResources ?? options.includeResources;
    const liveResources = [];
    if (includeResources && resourceLimit) {
      for (const resource of resources.values()) {
        liveResources.push(cloneDescriptor(resource));
        if (liveResources.length >= resourceLimit) break;
      }
    }
    return {
      api,
      byKind: Object.fromEntries(Object.entries(byKind).map(([key,value])=>[key,{...value}])),
      history: options.history && snapshotOptions.includeHistory !== false
        ? history.slice(historyCursor).concat(history.slice(0,historyCursor)).map(cloneDescriptor) : undefined,
      liveResources,
      truncatedResources: includeResources ? resources.size - liveResources.length : 0,
      createdCount: totalCreatedCount, releasedCount: totalReleasedCount,
      createdByKind: {...createdByKind}, releasedByKind: {...releasedByKind},
      pipelines: {syncCount: pipelines.syncCount, asyncCount: pipelines.asyncCount, shaderModules: pipelines.shaderModules, syncPipelines: snapshotOptions.includeResources === false ? [] : pipelines.sync.map(item => ({...item}))},
      bindGroups: {...bindGroups},
      totalBytes,
      totalResources: resources.size
    };
  }

  return { recordPipeline, recordShaderModule, recordBindGroup, recordBindGroupLayout, attach, release, releaseAttached, snapshot, track, update, updateAttached };
}

export function estimateWebGPUTextureBytes(descriptor = {}) {
  const size = normalizeExtent3D(descriptor.size);
  const layout = webGPUFormatLayout(descriptor.format);
  const sampleCount = Number(descriptor.sampleCount || 1);
  const mipLevelCount = Number(descriptor.mipLevelCount || 1);
  let bytes = 0;

  for (let level = 0; level < mipLevelCount; level += 1) {
    const width = Math.max(1, Math.floor(size.width / (2 ** level)));
    const height = Math.max(1, Math.floor(size.height / (2 ** level)));
    const depth = descriptor.dimension === "3d"
      ? Math.max(1, Math.floor(size.depthOrArrayLayers / (2 ** level)))
      : Math.max(1, size.depthOrArrayLayers);
    bytes += Math.ceil(width / layout.blockWidth)
      * Math.ceil(height / layout.blockHeight)
      * depth
      * layout.bytesPerBlock
      * sampleCount;
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

function cloneDescriptor(descriptor) {
  try {
    return JSON.parse(JSON.stringify(descriptor || {}));
  } catch {
    return {};
  }
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

export function webGPUFormatLayout(format = "") {
  const normalized = String(format).toLowerCase();
  if (/^bc1-|^bc4-|^etc2-rgb8|^etc2-rgb8a1|^eac-r11/.test(normalized)) {
    return { blockHeight: 4, blockWidth: 4, bytesPerBlock: 8 };
  }
  if (/^bc|^etc2-|^eac-rg11/.test(normalized)) {
    return { blockHeight: 4, blockWidth: 4, bytesPerBlock: 16 };
  }
  const astc = /^astc-(\d+)x(\d+)-/.exec(normalized);
  if (astc) {
    return {
      blockHeight: Number(astc[2]),
      blockWidth: Number(astc[1]),
      bytesPerBlock: 16
    };
  }

  const byteSizes = new Map([
    ["r8unorm", 1], ["r8snorm", 1], ["r8uint", 1], ["r8sint", 1], ["stencil8", 1],
    ["r16uint", 2], ["r16sint", 2], ["r16float", 2], ["rg8unorm", 2], ["rg8snorm", 2],
    ["rg8uint", 2], ["rg8sint", 2], ["depth16unorm", 2],
    ["r32uint", 4], ["r32sint", 4], ["r32float", 4], ["rg16uint", 4], ["rg16sint", 4],
    ["rg16float", 4], ["rgba8unorm", 4], ["rgba8unorm-srgb", 4], ["rgba8snorm", 4],
    ["rgba8uint", 4], ["rgba8sint", 4], ["bgra8unorm", 4], ["bgra8unorm-srgb", 4],
    ["rgb10a2uint", 4], ["rgb10a2unorm", 4], ["rg11b10ufloat", 4], ["rgb9e5ufloat", 4],
    ["depth24plus", 4], ["depth24plus-stencil8", 4], ["depth32float", 4],
    ["rg32uint", 8], ["rg32sint", 8], ["rg32float", 8], ["rgba16uint", 8],
    ["rgba16sint", 8], ["rgba16float", 8], ["depth32float-stencil8", 8],
    ["rgba32uint", 16], ["rgba32sint", 16], ["rgba32float", 16]
  ]);
  return {
    blockHeight: 1,
    blockWidth: 1,
    bytesPerBlock: byteSizes.get(normalized) || 4
  };
}

function webGLTexImageDescriptor(args) {
  const [target, level, internalFormat] = args;
  if (args.length >= 9) {
    const [, , , width, height, border, format, type, source] = args;
    return {
      border,
      bytes: estimateWebGLTextureBytes(width, height, internalFormat, type, 1, format),
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
    bytes: estimateWebGLTextureBytes(width, height, internalFormat, type, 1, format),
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

export function estimateWebGLTextureBytes(width, height, internalFormat, type, levels = 1, format = null) {
  const w = Number(width ?? 1), h = Number(height ?? 1);
  if (w === 0 || h === 0) return 0;
  const bytesPerPixel = webGLBytesPerPixel(internalFormat, type);
  let total = 0;
  for (let level = 0; level < Number(levels ?? 1); level++) {
    total += Math.max(1, Math.floor(w / 2 ** level)) * Math.max(1, Math.floor(h / 2 ** level)) * bytesPerPixel;
  }
  return total;
}

function webGLBytesPerPixel(internalFormat, type) {
  const sizedFormats = new Map([
    [0x8229, 1], [0x8f94, 1], [0x8f98, 1],
    [0x822b, 2], [0x8232, 2], [0x8238, 2], [0x822d, 2], [0x81a5, 2],
    [0x8051, 3],
    [0x8058, 4], [0x8c43, 4], [0x8f97, 4], [0x8f9b, 4], [0x881a, 8],
    [0x8814, 16], [0x822e, 4], [0x8230, 8], [0x823a, 8], [0x8cac, 4],
    [0x88f0, 4], [0x8cad, 8]
  ]);
  if (sizedFormats.has(Number(internalFormat))) {
    return sizedFormats.get(Number(internalFormat));
  }

  const components = new Map([
    [0x1903, 1], [0x1906, 1], [0x1909, 1], [0x190a, 2], [0x8227, 2],
    [0x1907, 3], [0x1908, 4], [0x84f9, 2]
  ]).get(Number(internalFormat)) || 4;
  const bytesPerComponent = new Map([
    [0x1400, 1], [0x1401, 1], [0x1402, 2], [0x1403, 2], [0x140b, 2],
    [0x1404, 4], [0x1405, 4], [0x1406, 4]
  ]).get(Number(type)) || 1;
  return components * bytesPerComponent;
}
