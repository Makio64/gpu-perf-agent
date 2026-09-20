export async function requestTimedWebGPUDevice(adapter, descriptor = {}) {
  const requiredFeatures = new Set(descriptor.requiredFeatures || []);
  const timestampQueryAvailable = Boolean(adapter?.features?.has?.("timestamp-query"));

  if (timestampQueryAvailable) {
    requiredFeatures.add("timestamp-query");
  }

  const device = await adapter.requestDevice({
    ...descriptor,
    requiredFeatures: Array.from(requiredFeatures)
  });

  return {
    device,
    timer: timestampQueryAvailable ? createWebGPUTimer(device) : null,
    timestampQueryAvailable
  };
}

export function createWebGPUTimer(device) {
  if (!device?.features?.has?.("timestamp-query")) {
    return null;
  }

  const querySet = device.createQuerySet({
    count: 2,
    type: "timestamp"
  });
  const resolveBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.QUERY_RESOLVE
  });
  const resultBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  function timestampWrites(extra = {}) {
    return {
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
      querySet,
      ...extra
    };
  }

  function beginRenderPass(encoder, descriptor) {
    return encoder.beginRenderPass({
      ...descriptor,
      timestampWrites: descriptor.timestampWrites || timestampWrites()
    });
  }

  function beginComputePass(encoder, descriptor = {}) {
    return encoder.beginComputePass({
      ...descriptor,
      timestampWrites: descriptor.timestampWrites || timestampWrites()
    });
  }

  function resolve(encoder) {
    encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, resultBuffer, 0, 16);
  }

  async function readNanoseconds() {
    await resultBuffer.mapAsync(GPUMapMode.READ);
    const copy = resultBuffer.getMappedRange().slice(0);
    resultBuffer.unmap();
    const values = new BigUint64Array(copy);
    return Number(values[1] - values[0]);
  }

  async function measure(recordCommands) {
    const encoder = device.createCommandEncoder();
    await recordCommands(encoder, {
      beginComputePass,
      beginRenderPass,
      querySet,
      timestampWrites
    });
    resolve(encoder);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return readNanoseconds();
  }

  return {
    beginComputePass,
    beginRenderPass,
    measure,
    querySet,
    readNanoseconds,
    resolve,
    timestampWrites
  };
}

export function createWebGPURingTimer(device, poolSize = 8, maxPassesPerFrame = 15) {
  if (!device?.features?.has?.("timestamp-query")) {
    return null;
  }

  const maxQueries = (maxPassesPerFrame + 1) * 2;
  const bufferByteSize = maxQueries * 8;
  const querySets = [];
  const resolveBuffers = [];
  const resultBuffers = [];
  const states = new Array(poolSize).fill("free"); // "free", "pending", "reading"
  const passMeta = new Array(poolSize).fill(null).map(() => []);

  for (let i = 0; i < poolSize; i++) {
    querySets.push(device.createQuerySet({ count: maxQueries, type: "timestamp" }));
    resolveBuffers.push(device.createBuffer({
      size: bufferByteSize,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.QUERY_RESOLVE
    }));
    resultBuffers.push(device.createBuffer({
      size: bufferByteSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    }));
  }

  let activeIndex = 0;

  function getNextSlot() {
    for (let i = 0; i < poolSize; i++) {
      const idx = (activeIndex + i) % poolSize;
      if (states[idx] === "free") {
        activeIndex = idx;
        passMeta[idx].length = 0;
        return idx;
      }
    }
    return -1;
  }

  function allocatePassTimestamp(idx, type, label) {
    if (idx < 0 || idx >= poolSize || states[idx] !== "free") return null;
    const metaList = passMeta[idx];
    if (metaList.length >= maxPassesPerFrame) return null;

    const pairIndex = metaList.length + 1;
    const startIndex = pairIndex * 2;
    const endIndex = pairIndex * 2 + 1;
    metaList.push({ type, label: label || type, startIndex, endIndex });

    return {
      querySet: querySets[idx],
      beginningOfPassWriteIndex: startIndex,
      endOfPassWriteIndex: endIndex
    };
  }

  return {
    querySets,
    resolveBuffers,
    resultBuffers,
    states,
    getNextSlot,
    allocatePassTimestamp,
    resolve(encoder, idx) {
      const queryCount = Math.max(2, (passMeta[idx].length + 1) * 2);
      encoder.resolveQuerySet(querySets[idx], 0, queryCount, resolveBuffers[idx], 0);
      encoder.copyBufferToBuffer(resolveBuffers[idx], 0, resultBuffers[idx], 0, queryCount * 8);
      states[idx] = "pending";
    },
    async readNanoseconds(idx) {
      if (states[idx] !== "pending") return 0;
      states[idx] = "reading";
      const buffer = resultBuffers[idx];
      try {
        await buffer.mapAsync(GPUMapMode.READ);
        const copy = buffer.getMappedRange().slice(0);
        buffer.unmap();
        states[idx] = "free";

        const values = new BigUint64Array(copy);
        const meta = passMeta[idx] || [];
        let computeDurationNs = 0;
        let renderDurationNs = 0;
        const passes = [];

        for (const p of meta) {
          const start = values[p.startIndex];
          const end = values[p.endIndex];
          if (end > start) {
            const diff = Number(end - start);
            if (p.type === "compute") computeDurationNs += diff;
            else renderDurationNs += diff;
            passes.push({ type: p.type, label: p.label, durationNs: diff });
          }
        }

        let durationNs = 0;
        if (values[1] > values[0]) {
          durationNs = Number(values[1] - values[0]);
        } else if (computeDurationNs + renderDurationNs > 0) {
          durationNs = computeDurationNs + renderDurationNs;
        }

        passMeta[idx].length = 0;

        return {
          durationNs,
          computeDurationNs,
          renderDurationNs,
          passes,
          valueOf() { return this.durationNs; },
          [Symbol.toPrimitive](hint) { return hint === "string" ? String(this.durationNs) : this.durationNs; }
        };
      } catch (e) {
        states[idx] = "free";
        passMeta[idx].length = 0;
        return 0;
      }
    }
  };
}

export function createWebGL2Timer(gl) {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) {
    return null;
  }

  async function measure(draw) {
    const query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    draw();
    gl.endQuery(ext.TIME_ELAPSED_EXT);

    const nanoseconds = await waitForQuery(gl, ext, query);
    gl.deleteQuery(query);
    return nanoseconds;
  }

  return {
    extension: ext,
    measure
  };
}

function waitForQuery(gl, ext, query) {
  return new Promise((resolve, reject) => {
    function poll() {
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);

      if (available && !disjoint) {
        resolve(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)));
        return;
      }

      if (disjoint) {
        reject(new Error("WebGL2 timer query became disjoint; discard this sample."));
        return;
      }

      requestAnimationFrame(poll);
    }

    poll();
  });
}
