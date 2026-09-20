export function analyzeReport(report) {
  const warnings = [];
  const highlights = [];
  const recommendations = [];

  function addRecommendation({ id, category, severity, title, action, evidence, value = null, threshold = null, unit = null, warningText = null, codeHint = null, agentPrompt = null }) {
    recommendations.push({
      id,
      category,
      severity,
      title,
      action,
      evidence,
      value,
      threshold,
      unit,
      codeHint,
      agentPrompt
    });
    if (warningText) {
      warnings.push(warningText);
    } else {
      warnings.push(`${title}: ${evidence}. ${action}`);
    }
  }

  const summary = report.inPage?.summary || {};
  const fps = summary.fps?.mean;
  const frameTime = summary.frameTimeMsMean?.mean;
  const jsHeapDelta = summary.jsHeapDeltaBytes?.mean;

  // 0. Visual Validation
  if (report.screenshotError != null) {
    addRecommendation({
      id: "visual-validation-error",
      category: "rendering",
      severity: "critical",
      title: "Visual Validation Error",
      evidence: String(report.screenshotError),
      action: "Check page console logs or WebGPU canvas configuration.",
      warningText: `Visual Validation Error: ${report.screenshotError}`,
      agentPrompt: "Verify that the WebGPU canvas element exists and webgpu context is successfully created without device loss."
    });
  } else if (report.screenshotSize != null) {
    if (report.screenshotSize === 0) {
      addRecommendation({
        id: "visual-validation-empty",
        category: "rendering",
        severity: "critical",
        title: "Visual Validation Failed",
        evidence: "Captured screenshot is completely empty/0 bytes",
        action: "Ensure canvas is rendering before screenshot capture.",
        warningText: "Visual Validation Failed: Captured screenshot is completely empty/0 bytes.",
        agentPrompt: "Ensure requestAnimationFrame is running and at least one render pass submits before benchmarking."
      });
    } else if (report.screenshotSize < 5000) {
      addRecommendation({
        id: "visual-validation-blank",
        category: "rendering",
        severity: "warning",
        title: "Visual Validation Warning",
        evidence: `Captured screenshot is extremely small (${report.screenshotSize} bytes)`,
        action: "The canvas might be rendering a blank/clear-color screen. Verify scene assets and draw calls.",
        warningText: `Visual Validation Failed: Captured screenshot is extremely small (${report.screenshotSize} bytes). The canvas might be rendering a blank/clear-color screen.`,
        agentPrompt: "Check if geometry or camera positions are properly set so meshes are within the frustum."
      });
    } else {
      highlights.push(`Visual Validation Passed: Canvas/page rendered content successfully (${(report.screenshotSize / 1024).toFixed(1)} KiB screenshot).`);
    }
  }

  // 1. Frame Rate & Cadence
  if (fps != null) {
    if (fps >= 58) {
      highlights.push(`Excellent frame rate: average ${fps.toFixed(1)} FPS.`);
    } else if (fps >= 45) {
      addRecommendation({
        id: "moderate-frame-rate",
        category: "rendering",
        severity: "warning",
        title: "Moderate Frame Rate",
        evidence: `Average ${fps.toFixed(1)} FPS`,
        action: "Check for potential CPU/GPU bottlenecks to maintain 60 FPS.",
        value: fps,
        threshold: 58,
        unit: "FPS",
        warningText: `Moderate frame rate: average ${fps.toFixed(1)} FPS. Check for potential CPU/GPU bottlenecks to maintain 60 FPS.`,
        agentPrompt: "Profile CPU frame time vs GPU pass duration to identify if bottleneck is CPU draw submission or GPU fragment/compute work."
      });
    } else {
      addRecommendation({
        id: "low-frame-rate",
        category: "rendering",
        severity: "critical",
        title: "Low Frame Rate",
        evidence: `Average ${fps.toFixed(1)} FPS`,
        action: "Rendering is significantly bottlenecked. Profile GPU execution time and CPU draw submission.",
        value: fps,
        threshold: 45,
        unit: "FPS",
        warningText: `Low frame rate: average ${fps.toFixed(1)} FPS. Rendering is significantly bottlenecked.`,
        agentPrompt: "Severe bottleneck detected. Check for synchronous pipeline compilation, excessive draw calls (>500), or heavy shaders."
      });
    }
  }

  // Cadence stability
  const cadence = summary.cadence;
  if (cadence && cadence.hitRate != null && cadence.hitRate < 0.85) {
    addRecommendation({
      id: "unstable-cadence",
      category: "rendering",
      severity: "warning",
      title: "Unstable Display Cadence",
      evidence: `Only ${(cadence.hitRate * 100).toFixed(1)}% of frames hit the target ${cadence.hz} Hz interval (${cadence.intervalMs}ms)`,
      action: "Even out per-frame CPU/GPU workload to prevent frame pacing stutter.",
      value: cadence.hitRate * 100,
      threshold: 85,
      unit: "%",
      agentPrompt: "Inspect frame-to-frame delta variances: eliminate periodic garbage collection pauses or time-slice heavy background tasks."
    });
  }

  // Frame time variance (stuttering)
  const elapsedMs = summary.elapsedMs;
  if (elapsedMs && elapsedMs.p95 && elapsedMs.mean) {
    const variance = elapsedMs.p95 - elapsedMs.mean;
    if (variance > 8) {
      addRecommendation({
        id: "frame-time-variance",
        category: "rendering",
        severity: "warning",
        title: "High Frame Time Variance",
        evidence: `p95: ${elapsedMs.p95.toFixed(1)}ms vs mean: ${elapsedMs.mean.toFixed(1)}ms (variance ${variance.toFixed(1)}ms)`,
        action: "Investigate micro-stuttering, sporadic GC pauses, or periodic shader/compute dispatch spikes.",
        value: variance,
        threshold: 8,
        unit: "ms",
        warningText: `High frame time variance (p95: ${elapsedMs.p95.toFixed(1)}ms vs mean: ${elapsedMs.mean.toFixed(1)}ms). This indicates micro-stuttering or garbage collection pauses.`,
        agentPrompt: "Investigate frame spikes: look for synchronous pipeline compilation, large texture uploads, or JS memory garbage collection during rendering."
      });
    }
  }

  // 2. JS Heap Memory
  if (jsHeapDelta != null) {
    const elapsedMsVal = summary.elapsedMs?.mean || report.inPage?.config?.durationMs || 1000;
    const sampleDurationSec = elapsedMsVal / 1000;
    const heapGrowthMBPerSec = (jsHeapDelta / 1024 / 1024) / sampleDurationSec;
    if (heapGrowthMBPerSec > 5) {
      addRecommendation({
        id: "high-js-heap-churn",
        category: "memory",
        severity: "critical",
        title: "High JS Heap Churn",
        evidence: `Growing by ${heapGrowthMBPerSec.toFixed(2)} MB/s`,
        action: "Eliminate object and closure allocations inside the render/animation loop.",
        value: heapGrowthMBPerSec,
        threshold: 5,
        unit: "MB/s",
        warningText: `High JS Heap churn: growing by ${heapGrowthMBPerSec.toFixed(2)} MB/s. Check for object allocation/creation in the render loop.`,
        codeHint: "// Pre-allocate math objects outside the loop:\nconst tempVector = new Vector3();\nfunction animate() {\n  tempVector.set(x, y, z);\n}",
        agentPrompt: "Find allocations (new Vector, new Matrix, closures, object literals) inside requestAnimationFrame loop and hoist them to module/class scope."
      });
    } else if (heapGrowthMBPerSec > 0.5) {
      addRecommendation({
        id: "moderate-js-heap-growth",
        category: "memory",
        severity: "warning",
        title: "Moderate JS Heap Growth",
        evidence: `Growing by ${heapGrowthMBPerSec.toFixed(2)} MB/s`,
        action: "Ensure math objects (vectors, matrices, colors) and temporary descriptors are pooled.",
        value: heapGrowthMBPerSec,
        threshold: 0.5,
        unit: "MB/s",
        warningText: `Moderate JS Heap growth: growing by ${heapGrowthMBPerSec.toFixed(2)} MB/s. Ensure objects, vectors, or matrices are pooled.`,
        codeHint: "// Pool vectors/matrices:\nconst _tempMat = new Matrix4();",
        agentPrompt: "Ensure temporary objects and matrix transformations reuse pooled instances in the hot animation loop."
      });
    } else if (heapGrowthMBPerSec <= 0.01) {
      highlights.push(`Stable CPU memory: JS Heap growth is negligible.`);
    }
  }

  // 3. GPU VRAM Memory & Resources
  const lastSample = report.inPage?.samples?.[report.inPage.samples.length - 1];
  const trackedGpuMemory = lastSample?.measurement?.trackedGpuMemory ||
                           lastSample?.trackedGpuMemory ||
                           report.inPage?.memory?.after?.trackedGpuMemory ||
                           report.inPage?.trackedGpuMemory;

  let bufferBytes = 0;
  let bufferCount = 0;
  let textureBytes = 0;
  let textureCount = 0;

  if (trackedGpuMemory) {
    if (trackedGpuMemory.byKind) {
      if (trackedGpuMemory.byKind.buffer) {
        bufferBytes = trackedGpuMemory.byKind.buffer.bytes || 0;
        bufferCount = trackedGpuMemory.byKind.buffer.count || 0;
      }
      if (trackedGpuMemory.byKind.texture) {
        textureBytes = trackedGpuMemory.byKind.texture.bytes || 0;
        textureCount = trackedGpuMemory.byKind.texture.count || 0;
      }
    } else {
      if (Array.isArray(trackedGpuMemory.buffers)) {
        bufferCount = trackedGpuMemory.buffers.length;
        bufferBytes = trackedGpuMemory.buffers.reduce((sum, b) => sum + (b.size || 0), 0);
      }
      if (Array.isArray(trackedGpuMemory.textures)) {
        textureCount = trackedGpuMemory.textures.length;
        textureBytes = trackedGpuMemory.textures.reduce((sum, t) => sum + (t.size || 0), 0);
      }
    }
  }

  const totalBytes = bufferBytes + textureBytes;
  const totalVramMB = totalBytes / 1024 / 1024;

  if (totalVramMB > 0) {
    highlights.push(`GPU Memory tracked: ${(totalVramMB).toFixed(2)} MiB allocated.`);
  }

  if (totalVramMB > 500) {
    addRecommendation({
      id: "high-vram-footprint",
      category: "memory",
      severity: "critical",
      title: "High VRAM Footprint",
      evidence: `${(totalVramMB).toFixed(1)} MiB of GPU resources allocated`,
      action: "Optimize textures (mipmaps, compression) and release unused buffers to prevent OOM on mobile/low-end devices.",
      value: totalVramMB,
      threshold: 500,
      unit: "MiB",
      warningText: `High VRAM footprint: ${(totalVramMB).toFixed(1)} MiB of GPU resources allocated. This may cause page crashes on mobile or low-end devices.`,
      agentPrompt: "Compress large textures, generate mipmaps, downscale over-resolution maps, and destroy inactive buffers."
    });
  }

  if (textureBytes > 0) {
    const texMB = textureBytes / 1024 / 1024;
    if (texMB > 100) {
      addRecommendation({
        id: "high-texture-memory",
        category: "memory",
        severity: "warning",
        title: "High Texture Memory",
        evidence: `${texMB.toFixed(1)} MiB across ${textureCount} textures`,
        action: "Recommend using compressed textures (KTX2, Basis Universal) and ensuring unused textures are disposed.",
        value: texMB,
        threshold: 100,
        unit: "MiB",
        warningText: `Texture memory is high: ${texMB.toFixed(1)} MiB across ${textureCount} textures. Recommend using compressed textures (KTX2, Basis Universal) and ensuring unused textures are disposed.`,
        codeHint: "// Use KTX2 compressed textures:\nimport { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\n// Or 'mini3/loaders/ktx2'",
        agentPrompt: "Convert uncompressed PNG/JPEG textures to GPU-compressed KTX2/Basis format to cut VRAM by 70-80%."
      });
    }
  }

  if (bufferCount > 200) {
    addRecommendation({
      id: "large-buffer-count",
      category: "memory",
      severity: "warning",
      title: "Large Buffer Count",
      evidence: `${bufferCount} buffers allocated`,
      action: "High draw call count or missing vertex/index buffer consolidation. Suggest merging geometries or using InstancedMesh.",
      value: bufferCount,
      threshold: 200,
      unit: "buffers",
      warningText: `Large buffer count: ${bufferCount} buffers allocated. High draw call count or missing vertex/index buffer consolidation. Suggest merging geometries or using InstancedMesh.`,
      codeHint: "// Consolidate geometry buffers:\nimport { InstancedMesh } from 'three'; // or 'mini3/instancing'",
      agentPrompt: "Combine geometries into an InstancedMesh or BatchedMesh to consolidate buffer allocations."
    });
  }

  // Leaks
  const leakCount = summary.leakCount?.max || 0;
  if (leakCount > 0) {
    addRecommendation({
      id: "gpu-resource-leak",
      category: "memory",
      severity: "critical",
      title: "GPU Resource Leak Detected",
      evidence: `${leakCount} GPU resource(s) allocated during sampling were not destroyed`,
      action: "Explicitly call buffer.destroy() and texture.destroy() when freeing objects.",
      value: leakCount,
      threshold: 0,
      unit: "resources",
      codeHint: "buffer.destroy();\ntexture.destroy();",
      agentPrompt: "Ensure dispose() methods properly call buffer.destroy() and texture.destroy() when removing scene objects."
    });
  }

  // 4. GPU Timing / Execution Duration
  const gpuTimes = report.inPage?.samples?.map((s) => s.measurement?.gpuTimeNs || s.gpuTimeNs).filter((t) => t != null && t > 0) || [];
  if (gpuTimes.length > 0) {
    const sumGpuTime = gpuTimes.reduce((a, b) => a + b, 0);
    const meanGpuMs = (sumGpuTime / gpuTimes.length) / 1000000;
    if (meanGpuMs > 13) {
      addRecommendation({
        id: "high-gpu-time",
        category: "gpu-execution",
        severity: "warning",
        title: "High GPU Execution Time",
        evidence: `Average ${meanGpuMs.toFixed(2)} ms per frame`,
        action: "The GPU is heavily loaded. Optimize shaders, simplify geometry, or reduce lights/shadows.",
        value: meanGpuMs,
        threshold: 13,
        unit: "ms",
        warningText: `High GPU execution time: average ${meanGpuMs.toFixed(2)} ms per frame. The GPU is heavily loaded. Optimize shaders, simplify geometry, or reduce lights/shadows.`,
        agentPrompt: "GPU time exceeds 13ms. Profile fragment shader complexity, lower shadow map resolutions, or implement LOD/culling."
      });
    } else {
      highlights.push(`GPU frame execution time is healthy: average ${meanGpuMs.toFixed(2)} ms.`);
    }
  }

  // Compute vs Render pass balance
  const computeTimes = report.inPage?.samples?.map(s => s.measurement?.computeTimeNs).filter(t => t != null && t > 0) || [];
  const renderTimes = report.inPage?.samples?.map(s => s.measurement?.renderTimeNs).filter(t => t != null && t > 0) || [];
  if (computeTimes.length > 0 && renderTimes.length > 0) {
    const meanComputeMs = (computeTimes.reduce((a, b) => a + b, 0) / computeTimes.length) / 1e6;
    const meanRenderMs = (renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length) / 1e6;
    if (meanComputeMs > 10 && meanComputeMs > meanRenderMs * 1.5) {
      addRecommendation({
        id: "compute-bound",
        category: "gpu-execution",
        severity: "warning",
        title: "Compute Bound Execution",
        evidence: `Compute passes take ${meanComputeMs.toFixed(2)} ms vs render passes ${meanRenderMs.toFixed(2)} ms`,
        action: "Tune compute workgroup sizes, optimize memory access patterns, or reduce dispatch grid dimensions.",
        value: meanComputeMs,
        threshold: 10,
        unit: "ms",
        codeHint: "@workgroup_size(64, 1, 1)\nvar<workgroup> sharedTile: array<f32, 64>;",
        agentPrompt: "Optimize compute kernels: leverage workgroup shared memory to avoid global storage buffer lookups, and align workgroups to 32 or 64 threads."
      });
    }
  }

  // 5. Pipelines & Bind Groups
  const syncPipelines = trackedGpuMemory?.pipelines?.syncCount ||
                        report.inPage?.samples?.reduce((max, s) => Math.max(max, s.measurement?.trackedGpuMemory?.pipelines?.syncCount || 0), 0) ||
                        0;
  if (syncPipelines > 0) {
    addRecommendation({
      id: "pipeline-sync-stall",
      category: "pipeline",
      severity: "critical",
      title: "Synchronous Pipeline Compilation",
      evidence: `${syncPipelines} synchronous pipeline compilation(s) detected`,
      action: "Switch to device.createRenderPipelineAsync() or device.createComputePipelineAsync() to avoid main thread jank.",
      value: syncPipelines,
      threshold: 0,
      unit: "pipelines",
      warningText: `Synchronous pipeline creation detected (${syncPipelines} sync pipeline${syncPipelines > 1 ? "s" : ""}). Switch to createRenderPipelineAsync() to avoid main thread jank.`,
      codeHint: "// Use async pipeline creation:\nconst pipeline = await device.createRenderPipelineAsync(descriptor);",
      agentPrompt: "Search codebase for device.createRenderPipeline or device.createComputePipeline and replace with createRenderPipelineAsync or pre-compile during warmup."
    });
  }

  const bindGroupsCreated = trackedGpuMemory?.bindGroups?.createdCount ||
                           report.inPage?.samples?.reduce((max, s) => Math.max(max, s.measurement?.trackedGpuMemory?.bindGroups?.createdCount || 0), 0) ||
                           0;
  if (bindGroupsCreated > 20) {
    addRecommendation({
      id: "bind-group-churn",
      category: "bindgroup",
      severity: "warning",
      title: "High Bind Group Churn",
      evidence: `${bindGroupsCreated} bind groups created during profiling`,
      action: "Pool and reuse GPUBindGroup instances across frames rather than allocating them each frame.",
      value: bindGroupsCreated,
      threshold: 20,
      unit: "bind groups",
      warningText: `High bind group churn (${bindGroupsCreated} bind groups created). Pool and reuse GPUBindGroup instances across frames.`,
      codeHint: "// Cache and reuse bind groups across frames:\nconst bg = bindGroupPool.get(device, layout, entries);",
      agentPrompt: "Find where device.createBindGroup is called inside the render loop and implement a BindGroupPool or cache."
    });
  }

  // 6. Draw Calls & Compute Dispatches
  const drawCalls = summary.drawCalls?.mean;
  if (drawCalls != null && drawCalls > 300) {
    addRecommendation({
      id: "draw-call-pressure",
      category: "draw-calls",
      severity: "warning",
      title: "High Draw Call Count",
      evidence: `Average ${Math.round(drawCalls)} draw calls per frame`,
      action: "Batch geometries or use InstancedMesh/MultiDrawIndirect to consolidate draw calls.",
      value: Math.round(drawCalls),
      threshold: 300,
      unit: "draws",
      warningText: `High draw call count: average ${Math.round(drawCalls)} draws per frame. Batch geometries or use InstancedMesh/MultiDrawIndirect.`,
      codeHint: "// Use InstancedMesh:\nconst mesh = new InstancedMesh(geometry, material, count);",
      agentPrompt: "Consolidate individual Mesh instances sharing geometry and material into InstancedMesh or BatchedMesh."
    });
  }

  const dispatchCalls = summary.dispatchCalls?.mean;
  if (dispatchCalls != null && dispatchCalls > 100) {
    addRecommendation({
      id: "dispatch-pressure",
      category: "gpu-execution",
      severity: "warning",
      title: "High Compute Dispatch Count",
      evidence: `Average ${Math.round(dispatchCalls)} compute dispatches per frame`,
      action: "Consolidate compute passes or increase workgroup dimensions to reduce kernel launch overhead.",
      value: Math.round(dispatchCalls),
      threshold: 100,
      unit: "dispatches",
      warningText: `High compute dispatch count: average ${Math.round(dispatchCalls)} dispatches per frame. Consolidate compute passes.`,
      agentPrompt: "Merge smaller compute dispatches into unified multi-element passes or increase workgroup size."
    });
  }

  // 7. CDP Chrome Trace analysis
  const traceGpuMean = report.trace?.summary?.gpu?.completeDurationMs?.mean;
  if (traceGpuMean != null) {
    if (traceGpuMean > 13) {
      addRecommendation({
        id: "chrome-trace-gpu-task",
        category: "gpu-execution",
        severity: "warning",
        title: "Long Chrome GPU Thread Tasks",
        evidence: `Chrome GPU thread trace shows long tasks: average ${traceGpuMean.toFixed(2)} ms`,
        action: "Look for heavy GPU pipeline compiles, large buffer transfers, or complex fragment shaders.",
        value: traceGpuMean,
        threshold: 13,
        unit: "ms",
        warningText: `Chrome GPU thread trace shows long tasks: average ${traceGpuMean.toFixed(2)} ms. Look for heavy GPU pipeline compiles or draw calls.`,
        agentPrompt: "Chrome GPU thread is stalled. Look for shader compilation stalls, excessive GPU readbacks (mapAsync), or large staging buffer copies."
      });
    }
  }

  return {
    warnings,
    highlights,
    recommendations,
    resources: {
      bufferBytes,
      bufferCount,
      textureBytes,
      textureCount,
      totalBytes
    }
  };
}

/**
 * Builds a compact, agent-friendly digest of a report: single scalars plus a
 * verdict, so callers never need to walk the nested sample structure.
 */
export function summarizeReport(report, diagnostics = null) {
  const analysis = diagnostics || analyzeReport(report);
  const s = report.inPage?.summary || {};
  const resources = analysis.resources || {};

  const fps = finite(s.fps?.mean);
  const frameTimeMsMean = finite(s.frameTimeMsMean?.mean);
  const frameTimeMsP95 = finite(s.frameTimeMsP95?.mean);
  const frameTimeMsMax = finite(s.frameTimeMsMax?.max);
  const maxJitterMs = finite(s.maxJitter?.mean);

  const jsHeapDelta = finite(s.jsHeapDeltaBytes?.mean);
  const elapsedMsVal = finite(s.elapsedMs?.mean) || report.inPage?.config?.durationMs || 1000;
  const jsHeapGrowthMBPerSec = jsHeapDelta == null
    ? null
    : (jsHeapDelta / 1024 / 1024) / (elapsedMsVal / 1000);

  const gpuTimes = report.inPage?.samples
    ?.map((sample) => sample.measurement?.gpuTimeNs || sample.gpuTimeNs)
    .filter((t) => Number.isFinite(t) && t > 0) || [];
  const gpuFrameMsMean = gpuTimes.length > 0
    ? (gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length) / 1e6
    : null;

  const totalBytes = resources.totalBytes || finite(s.trackedGpuTotalBytes?.max) || 0;

  const lastSample = report.inPage?.samples?.[report.inPage.samples.length - 1];
  const trackedGpuMemory = lastSample?.measurement?.trackedGpuMemory ||
                           lastSample?.trackedGpuMemory ||
                           report.inPage?.memory?.after?.trackedGpuMemory ||
                           report.inPage?.trackedGpuMemory;

  const summary = {
    verdict: null,
    fps,
    frameTimeMsMean,
    frameTimeMsP95,
    frameTimeMsMax,
    maxJitterMs,
    gpuFrameMsMean,
    jsHeapGrowthMBPerSec,
    cadence: s.cadence || null,
    warmup: report.inPage?.warmup || null,
    trackedVram: {
      totalMiB: round2(totalBytes / 1024 / 1024),
      textureMiB: round2((resources.textureBytes || 0) / 1024 / 1024),
      bufferMiB: round2((resources.bufferBytes || 0) / 1024 / 1024),
      textureCount: resources.textureCount || 0,
      bufferCount: resources.bufferCount || 0,
      leakedResources: finite(s.leakCount?.max) || 0
    },
    pipelines: trackedGpuMemory?.pipelines || null,
    bindGroups: trackedGpuMemory?.bindGroups || null,
    webgpuOps: {
      drawCalls: finite(s.drawCalls?.mean),
      dispatchCalls: finite(s.dispatchCalls?.mean),
      renderPasses: finite(s.renderPasses?.mean),
      computePasses: finite(s.computePasses?.mean),
      setPipelineCalls: finite(s.setPipelineCalls?.mean),
      setBindGroupCalls: finite(s.setBindGroupCalls?.mean)
    },
    slowFrameCount: report.inPage?.slowFrames?.length || 0,
    sampleCount: finite(s.sampleCount) || report.inPage?.samples?.length || 0,
    warningCount: analysis.warnings.length,
    warnings: analysis.warnings,
    highlights: analysis.highlights,
    recommendations: analysis.recommendations || []
  };

  summary.verdict = computeVerdict(summary, analysis);
  return summary;
}

/**
 * Attaches `summary` and `diagnostics` to a report in place and returns it.
 * Called by every runner so CLI, serve, and Node API output are consistent.
 */
export function finalizeReport(report) {
  const diagnostics = analyzeReport(report);
  report.diagnostics = diagnostics;
  report.summary = summarizeReport(report, diagnostics);
  return report;
}

function computeVerdict(summary, analysis = null) {
  const fps = summary.fps;
  const vramMiB = summary.trackedVram?.totalMiB || 0;
  const heapGrowth = summary.jsHeapGrowthMBPerSec;

  const hasCritical = analysis?.recommendations?.some(r => r.severity === "critical");
  if (hasCritical || (fps != null && fps < 45) || vramMiB > 500 || (heapGrowth != null && heapGrowth > 5)) {
    return "poor";
  }

  const hasWarning = (analysis?.recommendations?.some(r => r.severity === "warning")) || (summary.warningCount > 0);
  if (hasWarning || (fps != null && fps < 58)) {
    return "needs-work";
  }

  if (fps != null && fps >= 58) {
    return "excellent";
  }
  return "good";
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function formatDiagnostics(analysis) {
  const lines = [];
  
  if (analysis.highlights?.length > 0) {
    lines.push("🟩 Performance Highlights:");
    for (const highlight of analysis.highlights) {
      lines.push(`  - ${highlight}`);
    }
  }
  
  if (analysis.recommendations?.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("⚠️ Bottlenecks & Optimization Recommendations:");
    for (const rec of analysis.recommendations) {
      const icon = rec.severity === "critical" ? "🔴" : rec.severity === "warning" ? "🟡" : "ℹ️";
      lines.push(`  ${icon} [${rec.category.toUpperCase()}] ${rec.title}`);
      lines.push(`     Evidence: ${rec.evidence}`);
      lines.push(`     Action:   ${rec.action}`);
    }
  } else if (analysis.warnings?.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("⚠️ Bottlenecks & Optimization Recommendations:");
    for (const warning of analysis.warnings) {
      lines.push(`  - ${warning}`);
    }
  } else {
    if (lines.length > 0) lines.push("");
    lines.push("✨ No significant bottlenecks or memory leaks detected.");
  }
  
  return lines.join("\n");
}
