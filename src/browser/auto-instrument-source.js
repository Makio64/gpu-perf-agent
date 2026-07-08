(function () {
  const activeTrackers = [];
  globalThis.__gpuSlowFrames = [];

  let currentFrameStats = {
    renderPasses: 0,
    computePasses: 0,
    drawCalls: 0,
    dispatchCalls: 0,
    setPipelineCalls: 0,
    setBindGroupCalls: 0,
    copyBufferCalls: 0
  };

  let lastFrameTime = performance.now();
  const slowFrameThresholdMs = 20;

  function frameLoop() {
    const now = performance.now();
    const frameDuration = now - lastFrameTime;

    const threshold = globalThis.__gpuSlowFrameThreshold || slowFrameThresholdMs;
    if (frameDuration > threshold) {
      const slowFrameRecord = {
        frameDurationMs: frameDuration,
        timestamp: now,
        stats: { ...currentFrameStats }
      };
      globalThis.__gpuSlowFrames.push(slowFrameRecord);

      if (globalThis.__gpuSlowFrames.length > 100) {
        globalThis.__gpuSlowFrames.shift();
      }

      console.warn(
        `[WebGPU Optimizer] Slow frame detected: ${frameDuration.toFixed(2)}ms (Threshold: ${threshold}ms). ` +
        `WebGPU Ops: renderPasses=${currentFrameStats.renderPasses}, computePasses=${currentFrameStats.computePasses}, ` +
        `draws=${currentFrameStats.drawCalls}, dispatches=${currentFrameStats.dispatchCalls}, ` +
        `pipelines=${currentFrameStats.setPipelineCalls}, bindGroups=${currentFrameStats.setBindGroupCalls}, ` +
        `copies=${currentFrameStats.copyBufferCalls}`
      );
    }

    currentFrameStats = {
      renderPasses: 0,
      computePasses: 0,
      drawCalls: 0,
      dispatchCalls: 0,
      setPipelineCalls: 0,
      setBindGroupCalls: 0,
      copyBufferCalls: 0
    };

    lastFrameTime = now;
    requestAnimationFrame(frameLoop);
  }

  requestAnimationFrame(() => {
    lastFrameTime = performance.now();
    requestAnimationFrame(frameLoop);
  });

  globalThis.__gpuMemoryTracker = {
    snapshot() {
      const combined = {
        api: "none",
        byKind: {},
        liveResources: [],
        totalBytes: 0,
        totalResources: 0
      };
      let hasWebGPU = false;
      let hasWebGL2 = false;
      for (const tracker of activeTrackers) {
        const snap = tracker.snapshot();
        if (snap.api === "webgpu") hasWebGPU = true;
        if (snap.api === "webgl2") hasWebGL2 = true;
        combined.totalBytes += snap.totalBytes || 0;
        combined.totalResources += snap.totalResources || 0;
        for (const kind in snap.byKind) {
          if (!combined.byKind[kind]) {
            combined.byKind[kind] = { bytes: 0, count: 0 };
          }
          combined.byKind[kind].bytes += snap.byKind[kind].bytes || 0;
          combined.byKind[kind].count += snap.byKind[kind].count || 0;
        }
        if (snap.liveResources) {
          combined.liveResources.push(...snap.liveResources);
        }
      }
      if (hasWebGPU) {
        combined.api = "webgpu";
      } else if (hasWebGL2) {
        combined.api = "webgl2";
      }
      return combined;
    }
  };

  // Setup automatic WebGPU timing
  function setupAutoWebGPUTiming(device) {
    if (!device?.features?.has?.("timestamp-query")) {
      return;
    }

    try {
      const timer = createWebGPURingTimer(device, 8);
      if (!timer) return;

      globalThis.__gpuTimer = timer;

      const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
      const originalSubmit = device.queue.submit.bind(device.queue);

      device.queue.submit = function (commandBuffers) {
        const idx = timer.getNextSlot();
        if (idx === -1) {
          // If all slots are busy, fallback to submitting without timing to prevent GPU/CPU stalls
          originalSubmit(commandBuffers);
          return;
        }

        try {
          const startEncoder = originalCreateCommandEncoder();
          startEncoder.writeTimestamp(timer.querySets[idx], 0);
          const startCB = startEncoder.finish();

          const endEncoder = originalCreateCommandEncoder();
          endEncoder.writeTimestamp(timer.querySets[idx], 1);
          timer.resolve(endEncoder, idx);
          const endCB = endEncoder.finish();

          const cbArray = Array.from(commandBuffers);
          const timedCommandBuffers = [startCB, ...cbArray, endCB];

          originalSubmit(timedCommandBuffers);

          timer.readNanoseconds(idx).then((durationNs) => {
            if (durationNs > 0) {
              globalThis.__lastWebGPUDurationNs = durationNs;
            }
          }).catch(() => {});
        } catch (e) {
          originalSubmit(commandBuffers);
        }
      };
    } catch (e) {
      console.warn("Failed to setup auto WebGPU timing:", e);
    }
  }

  // Setup automatic WebGL2 timing
  function setupAutoWebGL2Timing(gl) {
    try {
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (!ext) return;

      const timer = createWebGL2Timer(gl);
      if (!timer) return;

      globalThis.__webglTimer = timer;

      const originalRAF = globalThis.requestAnimationFrame;
      let activeQuery = null;
      let queryInProgress = false;

      globalThis.requestAnimationFrame = function (callback) {
        return originalRAF.call(globalThis, function (timestamp) {
          if (!queryInProgress) {
            try {
              activeQuery = gl.createQuery();
              gl.beginQuery(ext.TIME_ELAPSED_EXT, activeQuery);
              queryInProgress = true;
            } catch (e) {
              activeQuery = null;
            }
          }

          try {
            callback(timestamp);
          } finally {
            if (activeQuery && queryInProgress) {
              try {
                gl.endQuery(ext.TIME_ELAPSED_EXT);
                const currentQuery = activeQuery;
                activeQuery = null;
                queryInProgress = false;

                const poll = () => {
                  try {
                    const available = gl.getQueryParameter(currentQuery, gl.QUERY_RESULT_AVAILABLE);
                    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);

                    if (available && !disjoint) {
                      globalThis.__lastWebGL2DurationNs = Number(gl.getQueryParameter(currentQuery, gl.QUERY_RESULT));
                      gl.deleteQuery(currentQuery);
                    } else if (disjoint || available) {
                      gl.deleteQuery(currentQuery);
                    } else {
                      originalRAF.call(globalThis, poll);
                    }
                  } catch (e) {}
                };
                originalRAF.call(globalThis, poll);
              } catch (e) {
                activeQuery = null;
                queryInProgress = false;
              }
            }
          }
        });
      };
    } catch (e) {
      console.warn("Failed to setup auto WebGL2 timing:", e);
    }
  }

  // Hook WebGPU adapter and device creation
  try {
    const webgpuResources = new WeakMap();

    if (globalThis.GPUCommandEncoder) {
      const originalCreateCommandEncoder = GPUDevice.prototype.createCommandEncoder;
      GPUDevice.prototype.createCommandEncoder = function (descriptor) {
        const encoder = originalCreateCommandEncoder.call(this, descriptor);
        encoder.__stats = {
          renderPasses: 0,
          computePasses: 0,
          drawCalls: 0,
          dispatchCalls: 0,
          setPipelineCalls: 0,
          setBindGroupCalls: 0,
          copyBufferCalls: 0
        };
        return encoder;
      };

      const originalBeginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
      GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
        const pass = originalBeginRenderPass.call(this, descriptor);
        if (this.__stats) {
          this.__stats.renderPasses++;
          pass.__stats = this.__stats;
        }
        return pass;
      };

      const originalBeginComputePass = GPUCommandEncoder.prototype.beginComputePass;
      GPUCommandEncoder.prototype.beginComputePass = function (descriptor) {
        const pass = originalBeginComputePass.call(this, descriptor);
        if (this.__stats) {
          this.__stats.computePasses++;
          pass.__stats = this.__stats;
        }
        return pass;
      };

      const originalCopyBufferToBuffer = GPUCommandEncoder.prototype.copyBufferToBuffer;
      GPUCommandEncoder.prototype.copyBufferToBuffer = function (...args) {
        if (this.__stats) {
          this.__stats.copyBufferCalls++;
        }
        return originalCopyBufferToBuffer.apply(this, args);
      };

      const originalFinish = GPUCommandEncoder.prototype.finish;
      GPUCommandEncoder.prototype.finish = function (descriptor) {
        const cb = originalFinish.call(this, descriptor);
        if (this.__stats) {
          cb.__stats = this.__stats;
        }
        return cb;
      };
    }

    if (globalThis.GPURenderPassEncoder) {
      const proto = GPURenderPassEncoder.prototype;

      const originalDraw = proto.draw;
      proto.draw = function (...args) {
        if (this.__stats) this.__stats.drawCalls++;
        return originalDraw.apply(this, args);
      };

      const originalDrawIndexed = proto.drawIndexed;
      proto.drawIndexed = function (...args) {
        if (this.__stats) this.__stats.drawCalls++;
        return originalDrawIndexed.apply(this, args);
      };

      const originalDrawIndirect = proto.drawIndirect;
      proto.drawIndirect = function (...args) {
        if (this.__stats) this.__stats.drawCalls++;
        return originalDrawIndirect.apply(this, args);
      };

      const originalDrawIndexedIndirect = proto.drawIndexedIndirect;
      proto.drawIndexedIndirect = function (...args) {
        if (this.__stats) this.__stats.drawCalls++;
        return originalDrawIndexedIndirect.apply(this, args);
      };

      const originalSetPipeline = proto.setPipeline;
      proto.setPipeline = function (...args) {
        if (this.__stats) this.__stats.setPipelineCalls++;
        return originalSetPipeline.apply(this, args);
      };

      const originalSetBindGroup = proto.setBindGroup;
      proto.setBindGroup = function (...args) {
        if (this.__stats) this.__stats.setBindGroupCalls++;
        return originalSetBindGroup.apply(this, args);
      };
    }

    if (globalThis.GPUComputePassEncoder) {
      const proto = GPUComputePassEncoder.prototype;

      const originalDispatch = proto.dispatchWorkgroups;
      proto.dispatchWorkgroups = function (...args) {
        if (this.__stats) this.__stats.dispatchCalls++;
        return originalDispatch.apply(this, args);
      };

      const originalDispatchIndirect = proto.dispatchWorkgroupsIndirect;
      proto.dispatchWorkgroupsIndirect = function (...args) {
        if (this.__stats) this.__stats.dispatchCalls++;
        return originalDispatchIndirect.apply(this, args);
      };

      const originalSetPipeline = proto.setPipeline;
      proto.setPipeline = function (...args) {
        if (this.__stats) this.__stats.setPipelineCalls++;
        return originalSetPipeline.apply(this, args);
      };

      const originalSetBindGroup = proto.setBindGroup;
      proto.setBindGroup = function (...args) {
        if (this.__stats) this.__stats.setBindGroupCalls++;
        return originalSetBindGroup.apply(this, args);
      };
    }

    if (globalThis.GPUQueue) {
      const originalQueueSubmit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function (commandBuffers) {
        const cbs = Array.from(commandBuffers);
        for (const cb of cbs) {
          if (cb.__stats) {
            currentFrameStats.renderPasses += cb.__stats.renderPasses;
            currentFrameStats.computePasses += cb.__stats.computePasses;
            currentFrameStats.drawCalls += cb.__stats.drawCalls;
            currentFrameStats.dispatchCalls += cb.__stats.dispatchCalls;
            currentFrameStats.setPipelineCalls += cb.__stats.setPipelineCalls;
            currentFrameStats.setBindGroupCalls += cb.__stats.setBindGroupCalls;
            currentFrameStats.copyBufferCalls += cb.__stats.copyBufferCalls;
          }
        }
        return originalQueueSubmit.call(this, commandBuffers);
      };
    }

    if (globalThis.GPUDevice) {
      const originalCreateBuffer = GPUDevice.prototype.createBuffer;
      GPUDevice.prototype.createBuffer = function (descriptor) {
        const buffer = originalCreateBuffer.call(this, descriptor);
        if (this.__tracker) {
          const bytes = Number(descriptor?.size || 0);
          const id = this.__tracker.track({
            api: "webgpu",
            bytes,
            descriptor: cloneDescriptor(descriptor),
            kind: "buffer",
            label: descriptor?.label || null
          });
          webgpuResources.set(buffer, { tracker: this.__tracker, id });
        }
        return buffer;
      };

      const originalCreateTexture = GPUDevice.prototype.createTexture;
      GPUDevice.prototype.createTexture = function (descriptor) {
        const texture = originalCreateTexture.call(this, descriptor);
        if (this.__tracker) {
          const bytes = estimateWebGPUTextureBytes(descriptor);
          const id = this.__tracker.track({
            api: "webgpu",
            bytes,
            descriptor: cloneDescriptor(descriptor),
            kind: "texture",
            label: descriptor?.label || null
          });
          webgpuResources.set(texture, { tracker: this.__tracker, id });
        }
        return texture;
      };
    }

    if (globalThis.GPUBuffer) {
      const originalDestroy = GPUBuffer.prototype.destroy;
      GPUBuffer.prototype.destroy = function () {
        const meta = webgpuResources.get(this);
        if (meta) {
          meta.tracker.release(meta.id);
          webgpuResources.delete(this);
        }
        return originalDestroy.call(this);
      };
    }

    if (globalThis.GPUTexture) {
      const originalDestroy = GPUTexture.prototype.destroy;
      GPUTexture.prototype.destroy = function () {
        const meta = webgpuResources.get(this);
        if (meta) {
          meta.tracker.release(meta.id);
          webgpuResources.delete(this);
        }
        return originalDestroy.call(this);
      };
    }

    if (globalThis.GPU && globalThis.GPUAdapter) {
      const originalRequestAdapter = GPU.prototype.requestAdapter;
      GPU.prototype.requestAdapter = async function (options) {
        return await originalRequestAdapter.call(this, options);
      };

      const originalRequestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (deviceDescriptor) {
        const descriptorCopy = deviceDescriptor ? { ...deviceDescriptor } : {};
        const requiredFeatures = new Set(descriptorCopy.requiredFeatures || []);
        const timestampQueryAvailable = this.features?.has?.("timestamp-query");
        if (timestampQueryAvailable) {
          requiredFeatures.add("timestamp-query");
        }
        descriptorCopy.requiredFeatures = Array.from(requiredFeatures);

        const device = await originalRequestDevice.call(this, descriptorCopy);
        if (!device) return null;

        // Auto-instrument allocations via prototype tracker assignment
        const tracker = createTracker("webgpu");
        device.__tracker = tracker;
        activeTrackers.push(tracker);

        // Auto-instrument timing
        setupAutoWebGPUTiming(device);

        return device;
      };
    } else if (globalThis.navigator?.gpu) {
      // Fallback to instance hook if prototype hooking is not supported
      const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = async function (options) {
        const adapter = await originalRequestAdapter(options);
        if (!adapter) return null;

        const originalRequestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async function (deviceDescriptor) {
          const descriptorCopy = deviceDescriptor ? { ...deviceDescriptor } : {};
          const requiredFeatures = new Set(descriptorCopy.requiredFeatures || []);
          const timestampQueryAvailable = adapter.features.has("timestamp-query");
          if (timestampQueryAvailable) {
            requiredFeatures.add("timestamp-query");
          }
          descriptorCopy.requiredFeatures = Array.from(requiredFeatures);

          const device = await originalRequestDevice(descriptorCopy);
          if (!device) return null;

          // Auto-instrument allocations
          const tracker = trackWebGPUDevice(device);
          activeTrackers.push(tracker);

          // Auto-instrument timing
          setupAutoWebGPUTiming(device);

          return device;
        };

        return adapter;
      };
    }
  } catch (e) {
    console.warn("Failed to hook WebGPU:", e);
  }

  // Hook WebGL2 context creation
  try {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attributes) {
      const context = originalGetContext.call(this, type, attributes);
      if (context && (type === "webgl2" || type === "experimental-webgl2")) {
        // Auto-instrument allocations
        const tracker = trackWebGL2Context(context);
        activeTrackers.push(tracker);

        // Auto-instrument timing
        setupAutoWebGL2Timing(context);
      }
      return context;
    };
  } catch (e) {
    console.warn("Failed to hook HTMLCanvasElement.prototype.getContext:", e);
  }

  // Define default benchmark hook if not exists
  if (!globalThis.__gpuReportBench) {
    globalThis.__gpuReportBench = async function ({ durationMs, phase }) {
      const started = performance.now();
      const frames = [];

      function nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(resolve));
      }

      await nextFrame();
      await nextFrame();

      while (performance.now() - started < durationMs) {
        const time = await nextFrame();
        frames.push(time);
      }

      const deltas = [];
      for (let index = 1; index < frames.length; index += 1) {
        deltas.push(frames[index] - frames[index - 1]);
      }

      const elapsedMs = Math.max(0.001, frames[frames.length - 1] - frames[0]);
      const fps = (frames.length - 1) / (elapsedMs / 1000);

      const sum = deltas.reduce((a, b) => a + b, 0);
      const mean = sum / Math.max(1, deltas.length);
      const sorted = deltas.slice().sort((a, b) => a - b);

      const frameTimeMs = {
        count: deltas.length,
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0,
        mean: mean
      };

      // Get GPU time if available
      let gpuTimeNs = null;
      if (globalThis.__lastWebGPUDurationNs != null) {
        gpuTimeNs = globalThis.__lastWebGPUDurationNs;
      } else if (globalThis.__lastWebGL2DurationNs != null) {
        gpuTimeNs = globalThis.__lastWebGL2DurationNs;
      }

      return {
        fps,
        frameCount: frames.length,
        frameTimeMs,
        gpuTimeNs,
        phase,
        trackedGpuMemory: globalThis.__gpuMemoryTracker ? globalThis.__gpuMemoryTracker.snapshot() : null
      };
    };
  }
})();
