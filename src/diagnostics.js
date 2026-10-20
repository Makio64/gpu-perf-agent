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

  // 0. Screenshot capture is an artifact, not a visual correctness test.
  if (report.screenshotError != null) {
    addRecommendation({
      id: "visual-validation-error",
      category: "rendering",
      severity: "warning",
      title: "Screenshot Capture Error",
      evidence: String(report.screenshotError),
      action: "Resolve the capture error, then inspect the image against the expected scene.",
      warningText: `Screenshot capture failed: ${report.screenshotError}. Visual correctness remains unchecked.`,
      agentPrompt: "Inspect the screenshot capture error and page diagnostics; retry capture and compare the image with the expected rendering."
    });
  } else if (report.screenshotSize != null) {
    if (report.screenshotSize === 0) {
      addRecommendation({
        id: "visual-validation-empty",
        category: "rendering",
        severity: "warning",
        title: "Empty Screenshot Artifact",
        evidence: "Screenshot capture returned a zero-byte artifact",
        action: "Inspect capture diagnostics and retry; an empty artifact cannot establish what the page rendered.",
        warningText: "Screenshot capture returned 0 bytes. Visual correctness remains unchecked.",
        agentPrompt: "Resolve the empty screenshot artifact, then inspect a decodable image against the expected rendering."
      });
    } else if (Number.isFinite(report.screenshotSize) && report.screenshotSize > 0) {
      highlights.push(`Screenshot captured (${(report.screenshotSize / 1024).toFixed(1)} KiB); visual correctness has not been checked.`);
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
  const frameP95 = summary.frameTimeMsP95?.mean;
  if (Number.isFinite(frameP95) && Number.isFinite(frameTime)) {
    const tailGap = frameP95 - frameTime;
    if (tailGap > 8) {
      addRecommendation({
        id: "frame-time-variance",
        category: "rendering",
        severity: "warning",
        title: "Wide Frame Time Tail",
        evidence: `Mean per-sample frame p95: ${frameP95.toFixed(1)}ms vs mean frame time: ${frameTime.toFixed(1)}ms (gap ${tailGap.toFixed(1)}ms)`,
        action: "Correlate the slow frames with CPU tasks, GC events and GPU timings to identify the cause.",
        value: tailGap,
        threshold: 8,
        unit: "ms",
        warningText: `Wide frame time tail (mean per-sample p95: ${frameP95.toFixed(1)}ms vs mean frame time: ${frameTime.toFixed(1)}ms). Investigate the corresponding slow frames.`,
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
      action: "Identify unused or duplicated allocations and release resources whose lifetime has ended; measure memory against the target device budget.",
      value: totalVramMB,
      threshold: 500,
      unit: "MiB",
      warningText: `High VRAM footprint: ${(totalVramMB).toFixed(1)} MiB of GPU resources allocated. This may cause page crashes on mobile or low-end devices.`,
      agentPrompt: "Inspect live GPU allocations and resource lifetimes. Remove unused or duplicated resources, then verify identical rendering and measure the memory change."
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
        action: "Dispose unused textures; evaluate supported compressed formats against the required image quality and measured allocation savings.",
        value: texMB,
        threshold: 100,
        unit: "MiB",
        warningText: `Texture memory is high: ${texMB.toFixed(1)} MiB across ${textureCount} textures. Inspect resource lifetimes and evaluate compression with visual verification.`,
        codeHint: "// Use KTX2 compressed textures:\nimport { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\n// Or 'mini3/loaders/ktx2'",
        agentPrompt: "Measure texture allocations, identify unused or duplicated textures, and compare candidate compression formats for byte savings and visual fidelity."
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
      action: "Check buffer lifetimes and draw submission measurements; consolidate compatible buffers only where repeated allocation or submission overhead is measured.",
      value: bufferCount,
      threshold: 200,
      unit: "buffers",
      warningText: `Large buffer count: ${bufferCount} buffers allocated. The count alone does not establish draw-call pressure or a resource leak.`,
      codeHint: "// Consolidate geometry buffers:\nimport { InstancedMesh } from 'three'; // or 'mini3/instancing'",
      agentPrompt: "Inspect buffer lifetimes and CPU submission timings. If consolidation addresses measured overhead, batch compatible geometries while preserving materials, draw order and rendered output."
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
  const gpuTimes = reportedTimings(report, "gpuTimeNs", true);
  if (gpuTimes.length > 0) {
    const sumGpuTime = gpuTimes.reduce((a, b) => a + b, 0);
    const meanGpuMs = (sumGpuTime / gpuTimes.length) / 1000000;
    if (meanGpuMs > 13) {
      addRecommendation({
        id: "high-gpu-time",
        category: "gpu-execution",
        severity: "warning",
        title: "High GPU Execution Time",
        evidence: `Average reported GPU duration: ${meanGpuMs.toFixed(2)} ms; timing scope is defined by the workload`,
        action: "Identify the expensive timed passes and optimize redundant work or memory access while preserving the workload and rendered output.",
        value: meanGpuMs,
        threshold: 13,
        unit: "ms",
        warningText: `High reported GPU duration: average ${meanGpuMs.toFixed(2)} ms. Confirm the timing scope and investigate the expensive passes.`,
        agentPrompt: "Inspect GPU timestamps for the reported scope. Benchmark optimizations that preserve scene complexity, resolution, lighting, and output; verify the result visually."
      });
    } else {
      highlights.push(`Reported GPU execution duration: average ${meanGpuMs.toFixed(2)} ms.`);
    }
  }

  // Compute vs Render pass balance
  const computeTimes = reportedTimings(report, "computeTimeNs");
  const renderTimes = reportedTimings(report, "renderTimeNs");
  if (computeTimes.length > 0 && renderTimes.length > 0) {
    const meanComputeMs = (computeTimes.reduce((a, b) => a + b, 0) / computeTimes.length) / 1e6;
    const meanRenderMs = (renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length) / 1e6;
    if (meanComputeMs > 10 && meanComputeMs > meanRenderMs * 1.5) {
      addRecommendation({
        id: "compute-bound",
        category: "gpu-execution",
        severity: "warning",
        title: "Compute Timing Exceeds Render Timing",
        evidence: `Compute passes take ${meanComputeMs.toFixed(2)} ms vs render passes ${meanRenderMs.toFixed(2)} ms`,
        action: "Confirm these timings cover comparable work, then benchmark workgroup sizes and memory access changes while preserving the dispatch workload and results.",
        value: meanComputeMs,
        threshold: 10,
        unit: "ms",
        agentPrompt: "Profile the dominant compute passes. Benchmark workgroup and memory-access variants on the target GPU, retaining the same dispatch coverage and checking numerical correctness."
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
      severity: "warning",
      title: "Synchronous Pipeline Creation",
      evidence: `${syncPipelines} synchronous pipeline creation call(s) recorded; call duration and frame impact were not measured`,
      action: "Locate these calls and measure their timing. Cache repeated pipelines or create them asynchronously during warmup if they affect the critical path.",
      value: syncPipelines,
      threshold: 0,
      unit: "pipelines",
      warningText: `Synchronous pipeline creation detected (${syncPipelines} sync pipeline${syncPipelines > 1 ? "s" : ""}). Measure call duration and placement before attributing frame stalls.`,
      codeHint: "// Use async pipeline creation:\nconst pipeline = await device.createRenderPipelineAsync(descriptor);",
      agentPrompt: "Locate device.createRenderPipeline/createComputePipeline calls and correlate their execution with frame or startup timings. Cache repeated pipelines or evaluate async creation in warmup while preserving readiness and rendering."
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
      title: "High Recorded Bind Group Count",
      evidence: `${bindGroupsCreated} creations recorded in the tracked snapshot; the total can include setup and warmup`,
      action: "Check per-sample creation deltas; cache compatible bind groups if repeated render-loop allocation is confirmed.",
      value: bindGroupsCreated,
      threshold: 20,
      unit: "bind groups",
      warningText: `High recorded bind group count (${bindGroupsCreated} creations). Check per-sample deltas before attributing this to render-loop churn.`,
      codeHint: "// Cache and reuse bind groups across frames:\nconst bg = bindGroupPool.get(device, layout, entries);",
      agentPrompt: "Inspect device.createBindGroup call sites and per-sample deltas. If repeated creation is measured, cache groups whose device, layout, resources and offsets are unchanged."
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
      action: "Measure CPU dispatch overhead; evaluate pass fusion only where resource dependencies and numerical results can be preserved.",
      value: Math.round(dispatchCalls),
      threshold: 100,
      unit: "dispatches",
      warningText: `High compute dispatch count: average ${Math.round(dispatchCalls)} dispatches per frame. Measure dispatch overhead before changing pass structure.`,
      agentPrompt: "Inspect CPU dispatch overhead and inter-pass dependencies. Benchmark fusion of compatible passes with identical dispatch coverage and verified numerical results."
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
        action: "Inspect the named trace events and correlate them with GPU timestamps; GPU-thread task duration can include CPU work or waiting.",
        value: traceGpuMean,
        threshold: 13,
        unit: "ms",
        warningText: `Chrome GPU thread trace shows long tasks: average ${traceGpuMean.toFixed(2)} ms. Look for heavy GPU pipeline compiles or draw calls.`,
        agentPrompt: "Inspect the long Chrome GPU-thread events and correlate them with pipeline creation, uploads, readbacks and GPU timestamp scopes before identifying the bottleneck."
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

  const gpuTimes = reportedTimings(report, "gpuTimeNs", true);
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

function reportedTimings(report, key, legacy = false) {
  return (report.inPage?.samples || [])
    .map(sample => sample.measurement?.[key] ?? (legacy ? sample[key] : undefined))
    .filter(value => Number.isFinite(value) && value >= 0);
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
