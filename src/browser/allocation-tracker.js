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
  // Texture bindings are per texture unit and target; cube faces resolve to TEXTURE_CUBE_MAP.
  const textureBindings = new Map();
  const textureLevels = new WeakMap();
  let activeUnit = 0;
  const original = {};

  for (const name of [
    "activeTexture",
    "bindBuffer",
    "bufferData",
    "compressedTexImage2D",
    "compressedTexImage3D",
    "compressedTexSubImage2D",
    "compressedTexSubImage3D",
    "copyTexImage2D",
    "createBuffer",
    "createTexture",
    "deleteBuffer",
    "deleteTexture",
    "bindTexture",
    "texImage2D",
    "texImage3D",
    "texStorage2D",
    "texStorage3D"
  ]) {
    original[name] = gl[name]?.bind(gl);
  }

  const boundTexture = target => textureBindings.get(activeUnit * 0x10000 + textureBindingTarget(target));
  // `replace` (texStorage*) redefines every level; uploads define one face and level each.
  const setLevels = (target, entries, replace, descriptor) => {
    const texture = boundTexture(target);
    if (!texture) return;
    let levels = textureLevels.get(texture);
    if (!levels || replace) {
      levels = new Map();
      textureLevels.set(texture, levels);
    }
    for (const [face, level, bytes] of entries) levels.set(face * 64 + level, Number(bytes) || 0);
    let bytes = 0;
    for (const value of levels.values()) bytes += value;
    tracker.updateAttached(texture, { bytes, descriptor, kind: "texture" });
  };
  const wrap = (name, replacement) => {
    if (typeof original[name] === "function") gl[name] = replacement;
  };

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

  wrap("activeTexture", (unit) => {
    activeUnit = Math.max(0, Number(unit) - 0x84c0) || 0;
    return original.activeTexture(unit);
  });

  gl.bindTexture = (target, texture) => {
    textureBindings.set(activeUnit * 0x10000 + textureBindingTarget(target), texture);
    return original.bindTexture(target, texture);
  };

  gl.texImage2D = (...args) => {
    const result = original.texImage2D(...args);
    const descriptor = webGLTexImageDescriptor(args);
    setLevels(args[0], [[textureFace(args[0]), Number(args[1]) || 0, descriptor.bytes]], false, descriptor);
    return result;
  };

  wrap("texImage3D", (...args) => {
    const result = original.texImage3D(...args);
    const [target, level, internalFormat, width, height, depth, , format, type] = args;
    const bytes = estimateWebGLTextureBytes(width, height, internalFormat, type, 1, format) * Math.max(1, Number(depth ?? 1));
    setLevels(target, [[0, Number(level) || 0, bytes]], false, { depth, height, internalFormat, level, target, type, width });
    return result;
  });

  wrap("copyTexImage2D", (...args) => {
    const result = original.copyTexImage2D(...args);
    const [target, level, internalFormat, , , width, height] = args;
    setLevels(target, [[textureFace(target), Number(level) || 0, estimateWebGLTextureBytes(width, height, internalFormat, null, 1)]], false,
      { height, internalFormat, level, target, width });
    return result;
  });

  wrap("compressedTexImage2D", (...args) => {
    const result = original.compressedTexImage2D(...args);
    const [target, level, internalFormat, width, height] = args;
    setLevels(target, [[textureFace(target), Number(level) || 0, compressedBytes(internalFormat, width, height, 1, args[6])]], false,
      { height, internalFormat, level, target, width });
    return result;
  });

  wrap("compressedTexImage3D", (...args) => {
    const result = original.compressedTexImage3D(...args);
    const [target, level, internalFormat, width, height, depth] = args;
    setLevels(target, [[0, Number(level) || 0, compressedBytes(internalFormat, width, height, depth, args[7])]], false,
      { depth, height, internalFormat, level, target, width });
    return result;
  });

  // Sub-image uploads never change an allocation; they only define a level that was not seen yet.
  for (const [name, dims] of [["compressedTexSubImage2D", 2], ["compressedTexSubImage3D", 3]]) {
    wrap(name, (...args) => {
      const result = original[name](...args);
      const [target, level] = args;
      const texture = boundTexture(target);
      const face = textureFace(target);
      if (texture && !textureLevels.get(texture)?.has(face * 64 + (Number(level) || 0))) {
        const [width, height, depth, format, data] = dims === 2
          ? [Number(args[2]) + Number(args[4]), Number(args[3]) + Number(args[5]), 1, args[6], args[7]]
          : [Number(args[2]) + Number(args[5]), Number(args[3]) + Number(args[6]), Number(args[4]) + Number(args[7]), args[8], args[9]];
        setLevels(target, [[face, Number(level) || 0, compressedBytes(format, width, height, depth, data)]], false,
          { height, internalFormat: format, level, target, width });
      }
      return result;
    });
  }

  gl.texStorage2D = (...args) => {
    const result = original.texStorage2D(...args);
    const [target, levels, internalFormat, width, height] = args;
    const faces = textureBindingTarget(target) === 0x8513 ? 6 : 1;
    const entries = [];
    for (let face = 0; face < faces; face += 1) {
      for (let level = 0; level < Number(levels ?? 1); level += 1) {
        entries.push([face, level, estimateWebGLTextureBytes(Math.max(1, Math.floor(Number(width ?? 1) / 2 ** level)),
          Math.max(1, Math.floor(Number(height ?? 1) / 2 ** level)), internalFormat, null, 1)]);
      }
    }
    setLevels(target, entries, true, { height, internalFormat, levels, target, width });
    return result;
  };

  wrap("texStorage3D", (...args) => {
    const result = original.texStorage3D(...args);
    const [target, levels, internalFormat, width, height, depth] = args;
    // Only a 3D texture halves its depth per level; array layers stay.
    const halveDepth = Number(target) === 0x806f;
    const entries = [];
    for (let level = 0; level < Number(levels ?? 1); level += 1) {
      const layers = halveDepth ? Math.max(1, Math.floor(Number(depth ?? 1) / 2 ** level)) : Math.max(1, Number(depth ?? 1));
      entries.push([0, level, layers * estimateWebGLTextureBytes(Math.max(1, Math.floor(Number(width ?? 1) / 2 ** level)),
        Math.max(1, Math.floor(Number(height ?? 1) / 2 ** level)), internalFormat, null, 1)]);
    }
    setLevels(target, entries, true, { depth, height, internalFormat, levels, target, width });
    return result;
  });

  gl.deleteTexture = (texture) => {
    tracker.releaseAttached(texture);
    return original.deleteTexture(texture);
  };

  return tracker;
}

function textureBindingTarget(target) {
  const value = Number(target);
  return value >= 0x8515 && value <= 0x851a ? 0x8513 : value;
}

function textureFace(target) {
  const value = Number(target);
  return value >= 0x8515 && value <= 0x851a ? value - 0x8515 : 0;
}

function compressedBytes(internalFormat, width, height, depth, data) {
  if (webGLCompressedBlock(internalFormat)) {
    return estimateWebGLTextureBytes(width, height, internalFormat, null, 1) * Math.max(1, Number(depth ?? 1));
  }
  return typeof data === "number" ? data : Number(data?.byteLength || 0);
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
  const block = webGLCompressedBlock(internalFormat);
  const bytesPerPixel = block ? 0 : webGLBytesPerPixel(internalFormat, type);
  let total = 0;
  for (let level = 0; level < Number(levels ?? 1); level++) {
    const levelWidth = Math.max(1, Math.floor(w / 2 ** level));
    const levelHeight = Math.max(1, Math.floor(h / 2 ** level));
    total += block
      ? Math.ceil(levelWidth / block.blockWidth) * Math.ceil(levelHeight / block.blockHeight) * block.bytesPerBlock
      : levelWidth * levelHeight * bytesPerPixel;
  }
  return total;
}

const ASTC_BLOCKS = [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]];
const COMPRESSED_BLOCKS = new Map([
  // S3TC (DXT1/3/5) and sRGB variants
  [0x83f0, [4, 4, 8]], [0x83f1, [4, 4, 8]], [0x83f2, [4, 4, 16]], [0x83f3, [4, 4, 16]],
  [0x8c4c, [4, 4, 8]], [0x8c4d, [4, 4, 8]], [0x8c4e, [4, 4, 16]], [0x8c4f, [4, 4, 16]],
  // RGTC (BC4/BC5) and BPTC (BC6H/BC7)
  [0x8dbb, [4, 4, 8]], [0x8dbc, [4, 4, 8]], [0x8dbd, [4, 4, 16]], [0x8dbe, [4, 4, 16]],
  [0x8e8c, [4, 4, 16]], [0x8e8d, [4, 4, 16]], [0x8e8e, [4, 4, 16]], [0x8e8f, [4, 4, 16]],
  // ETC1, ETC2 and EAC
  [0x8d64, [4, 4, 8]], [0x9270, [4, 4, 8]], [0x9271, [4, 4, 8]], [0x9272, [4, 4, 16]], [0x9273, [4, 4, 16]],
  [0x9274, [4, 4, 8]], [0x9275, [4, 4, 8]], [0x9276, [4, 4, 8]], [0x9277, [4, 4, 8]], [0x9278, [4, 4, 16]], [0x9279, [4, 4, 16]],
  // PVRTC 4 bpp and 2 bpp
  [0x8c00, [4, 4, 8]], [0x8c02, [4, 4, 8]], [0x8c01, [8, 4, 8]], [0x8c03, [8, 4, 8]]
]);

/** Block layout of a WebGL compressed internal format (S3TC, RGTC, BPTC, ETC, ASTC, PVRTC), or null. */
export function webGLCompressedBlock(internalFormat) {
  const value = Number(internalFormat);
  const astc = value >= 0x93b0 && value <= 0x93bd ? ASTC_BLOCKS[value - 0x93b0]
    : value >= 0x93d0 && value <= 0x93dd ? ASTC_BLOCKS[value - 0x93d0] : null;
  const block = astc ? [astc[0], astc[1], 16] : COMPRESSED_BLOCKS.get(value);
  return block ? { blockHeight: block[1], blockWidth: block[0], bytesPerBlock: block[2] } : null;
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
