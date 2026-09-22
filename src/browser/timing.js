export async function requestTimedWebGPUDevice(adapter, descriptor = {}) {
  if (!adapter?.requestDevice) throw new TypeError('A WebGPU adapter is required.');
  const requiredFeatures = new Set(descriptor.requiredFeatures || []);
  const timestampQueryAvailable = Boolean(adapter.features?.has('timestamp-query'));
  if (timestampQueryAvailable) requiredFeatures.add('timestamp-query');
  const device = await adapter.requestDevice({ ...descriptor, requiredFeatures: [...requiredFeatures] });
  return { device, timer: timestampQueryAvailable ? createWebGPUTimer(device) : null, timestampQueryAvailable };
}

/** One timed pass per measurement. Use createBatch() for multiple passes. */
export function createWebGPUTimer(device, options = {}) {
  const batch = createBatchedWebGPUTimer(device, { ...options, capacity: 1 });
  if (!batch) return null;
  let measuring = false;
  const assertManual = () => {
    if (measuring) throw new Error('WebGPU timer is measuring; use a separate timer for overlapping work.');
  };
  const readNanoseconds = async () => {
    const measurements = await batch.read();
    if (!measurements.length) throw new Error('Resolve and submit a timed pass before reading it.');
    return measurements[0].durationNs;
  };
  const helpers = {
    beginComputePass: batch.beginComputePass,
    beginRenderPass: batch.beginRenderPass,
    querySet: batch.querySet,
    timestampWrites: (extra) => batch.timestampWrites(null, extra)
  };
  return {
    querySet: batch.querySet,
    get state() { return batch.state; },
    beginComputePass(...args) { assertManual(); return batch.beginComputePass(...args); },
    beginRenderPass(...args) { assertManual(); return batch.beginRenderPass(...args); },
    timestampWrites(extra) { assertManual(); return helpers.timestampWrites(extra); },
    resolve(encoder) { assertManual(); return batch.resolve(encoder); },
    async readNanoseconds() { assertManual(); return readNanoseconds(); },
    reset() { assertManual(); return batch.reset(); },
    destroy: batch.destroy,
    createBatch: (batchOptions) => {
      if (batch.state === 'destroyed') throw new Error('WebGPU timer is destroyed.');
      return createBatchedWebGPUTimer(device, batchOptions);
    },
    async measure(recordCommands) {
      assertManual();
      if (typeof recordCommands !== 'function') throw new TypeError('recordCommands must be a function.');
      if (batch.state !== 'idle') throw new Error(`WebGPU timer is ${batch.state}; finish or reset the previous measurement.`);
      measuring = true;
      try {
        const encoder = device.createCommandEncoder();
        await recordCommands(encoder, helpers);
        if (batch.resolve(encoder) !== 1) throw new Error('Record one timed pass using the supplied timer helpers.');
        device.queue.submit([encoder.finish()]);
        // mapAsync waits for this result buffer. A queue-wide fence adds unnecessary synchronization.
        return await readNanoseconds();
      } catch (error) {
        if (batch.state === 'recording' || batch.state === 'idle') batch.reset();
        // Submission failures leave uncertain GPU state; destroy instead of reusing those queries.
        else if (batch.state === 'resolved') batch.destroy();
        throw error;
      } finally { measuring = false; }
    }
  };
}

/** Resolve and map once for many passes; never reuse a batch while its read is pending. */
export function createBatchedWebGPUTimer(device, options = {}) {
  if (!device?.features?.has('timestamp-query')) return null;
  // WebGPU permits at most 4096 queries per query set, two per timed pass.
  const capacity = positiveNumber(options.capacity ?? 64, 'capacity', 2048, true);
  const timeoutMs = positiveNumber(options.timeoutMs ?? 10000, 'timeoutMs', 2147483647);
  const byteSize = capacity * 16;
  let querySet, resolveBuffer, resultBuffer;
  try {
    querySet = device.createQuerySet({ count: capacity * 2, label: `${options.label || 'gpu-perf-agent'}:queries`, type: 'timestamp' });
    resolveBuffer = device.createBuffer({ label: `${options.label || 'gpu-perf-agent'}:resolve`, size: byteSize, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.QUERY_RESOLVE });
    resultBuffer = device.createBuffer({ label: `${options.label || 'gpu-perf-agent'}:results`, size: byteSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  } catch (error) {
    querySet?.destroy(); resolveBuffer?.destroy(); resultBuffer?.destroy();
    throw error;
  }
  const labels = [];
  let count = 0;
  let state = 'idle';
  let cancelRead = null;

  function assertRecording() {
    if (state !== 'idle' && state !== 'recording') throw new Error(`WebGPU timer is ${state}; read the resolved batch before recording again.`);
  }

  function timestampWrites(label = null, extra = {}) {
    assertRecording();
    if (count >= capacity) throw new Error(`Batched WebGPU timer capacity exceeded (${capacity}).`);
    const writes = { beginningOfPassWriteIndex: count * 2, endOfPassWriteIndex: count * 2 + 1, querySet };
    for (const key of Object.keys(extra)) {
      if (!Object.hasOwn(writes, key) || extra[key] !== writes[key]) throw new Error('Timer querySet and query indices cannot be overridden.');
    }
    labels[count++] = label;
    state = 'recording';
    return writes;
  }

  function beginPass(encoder, method, descriptor, label) {
    assertRecording();
    const beforeCount = count;
    const writes = descriptor.timestampWrites || timestampWrites(label);
    if (writes.querySet !== querySet || !Number.isInteger(writes.beginningOfPassWriteIndex)
        || writes.beginningOfPassWriteIndex < 0 || writes.beginningOfPassWriteIndex % 2 !== 0
        || writes.endOfPassWriteIndex !== writes.beginningOfPassWriteIndex + 1
        || writes.endOfPassWriteIndex >= count * 2) {
      throw new Error('Pass timestampWrites must be reserved by this timer.');
    }
    try { return encoder[method]({ ...descriptor, timestampWrites: writes }); }
    catch (error) {
      count = beforeCount; labels.length = count; state = count ? 'recording' : 'idle';
      throw error;
    }
  }

  function resolve(encoder) {
    assertRecording();
    if (!count) return 0;
    encoder.resolveQuerySet(querySet, 0, count * 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, resultBuffer, 0, count * 16);
    state = 'resolved';
    return count;
  }

  function reset() {
    assertRecording();
    count = 0; labels.length = 0; state = 'idle';
  }

  async function read() {
    if (state === 'idle') return [];
    if (state !== 'resolved') throw new Error(`WebGPU timer is ${state}; resolve and submit before reading (only one read may be pending).`);
    state = 'reading';
    let deadline;
    try {
      const cancelled = new Promise((_, reject) => {
        cancelRead = reject;
        deadline = setTimeout(() => reject(new Error(`WebGPU timestamp read timed out after ${timeoutMs} ms.`)), timeoutMs);
      });
      await Promise.race([resultBuffer.mapAsync(GPUMapMode.READ, 0, count * 16), cancelled]);
      if (state === 'destroyed') throw new Error('WebGPU timer is destroyed.');
      // Read while mapped: no ArrayBuffer.slice() or copy of the entire result buffer.
      const values = new BigUint64Array(resultBuffer.getMappedRange(0, count * 16));
      const measurements = [];
      for (let index = 0; index < count; index++) {
        const startNs = values[index * 2], endNs = values[index * 2 + 1];
        if (endNs < startNs) throw new Error('Invalid WebGPU timestamps; discard this measurement.');
        const durationNs = Number(endNs - startNs);
        measurements.push({ durationMs: durationNs / 1e6, durationNs, endNs: endNs.toString(), index, label: labels[index] ?? null, startNs: startNs.toString() });
      }
      return measurements;
    } finally {
      clearTimeout(deadline);
      cancelRead = null;
      resultBuffer.unmap();
      count = 0; labels.length = 0;
      if (state !== 'destroyed') state = 'idle';
    }
  }

  function destroy() {
    if (state === 'destroyed') return;
    state = 'destroyed';
    cancelRead?.(new Error('WebGPU timer was destroyed during readback.'));
    querySet.destroy(); resolveBuffer.destroy(); resultBuffer.destroy();
  }

  return {
    beginComputePass: (encoder, descriptor = {}, label = descriptor.label ?? null) => beginPass(encoder, 'beginComputePass', descriptor, label),
    beginRenderPass: (encoder, descriptor = {}, label = descriptor.label ?? null) => beginPass(encoder, 'beginRenderPass', descriptor, label),
    capacity, destroy,
    get count() { return count; },
    get state() { return state; },
    querySet, read, reset, resolve, timestampWrites
  };
}

export function createWebGL2Timer(gl, options = {}) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const timeoutMs = positiveNumber(options.timeoutMs ?? 10000, 'timeoutMs', 2147483647);
  const pollIntervalMs = positiveNumber(options.pollIntervalMs ?? 4, 'pollIntervalMs', 1000);
  const maxPending = positiveNumber(options.maxPending ?? 64, 'maxPending', 4096, true);
  const pending = new Map();
  let destroyed = false;
  let drawing = false;

  async function measure(draw) {
    if (destroyed) return Promise.reject(new Error('WebGL2 timer is destroyed.'));
    if (drawing) return Promise.reject(new Error('Nested WebGL2 timer measurements are not supported.'));
    if (pending.size >= maxPending) return Promise.reject(new Error(`WebGL2 timer has ${maxPending} pending queries; await a measurement before submitting more.`));
    if (typeof draw !== 'function') return Promise.reject(new TypeError('draw must be a synchronous function.'));
    const query = gl.createQuery();
    if (!query) return Promise.reject(new Error('Could not allocate WebGL2 timer query.'));
    let began = false;
    try {
      if (gl.getQuery?.(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) throw new Error('Another elapsed-time query is already active on this WebGL context.');
      drawing = true;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      began = true;
      try {
        const result = draw();
        if (destroyed) throw new Error('WebGL2 timer was destroyed while recording.');
        if (result?.then) {
          Promise.resolve(result).catch(() => {});
          throw new TypeError('draw must be synchronous; asynchronous work cannot be enclosed by a WebGL timer query.');
        }
      } finally {
        if (began) gl.endQuery(ext.TIME_ELAPSED_EXT);
      }
    } catch (error) {
      gl.deleteQuery(query);
      return Promise.reject(error);
    } finally { drawing = false; }

    return new Promise((resolve, reject) => {
      let pollTimer, deadline;
      const finish = (error, value) => {
        if (!pending.delete(query)) return;
        clearTimeout(pollTimer); clearTimeout(deadline);
        gl.deleteQuery(query);
        if (error) reject(error); else resolve(value);
      };
      pending.set(query, finish);
      const poll = () => {
        try {
          if (gl.isContextLost?.()) throw new Error('WebGL2 context was lost; discard this sample.');
          if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            // Disjoint invalidates every outstanding timing query on this context.
            const error = new Error('WebGL2 timer query became disjoint; discard pending samples.');
            for (const done of [...pending.values()]) done(error);
            return;
          }
          if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            const value = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
            if (!Number.isFinite(value) || value < 0) throw new Error('Invalid WebGL2 timer result.');
            finish(null, value);
          } else pollTimer = setTimeout(poll, pollIntervalMs);
        } catch (error) { finish(error); }
      };
      deadline = setTimeout(() => finish(new Error(`WebGL2 timer query timed out after ${timeoutMs} ms.`)), timeoutMs);
      // Query availability cannot advance until control returns to the browser; this also works in workers and hidden tabs.
      pollTimer = setTimeout(poll, 0);
    });
  }

  return {
    extension: ext, measure,
    get pendingCount() { return pending.size; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const finish of [...pending.values()]) finish(new Error('WebGL2 timer was destroyed.'));
    }
  };
}

function positiveNumber(value, name, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be ${integer ? 'an integer' : 'a finite number'} greater than zero and at most ${max}.`);
  }
  return value;
}
