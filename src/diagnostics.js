export function analyzeReport(report) {
  const warnings = [];
  const highlights = [];

  const summary = report.inPage?.summary || {};
  const fps = summary.fps?.mean;
  const frameTime = summary.frameTimeMsMean?.mean;
  const jsHeapDelta = summary.jsHeapDeltaBytes?.mean;

  // 0. Visual Validation
  if (report.screenshotError != null) {
    warnings.push(`Visual Validation Error: ${report.screenshotError}`);
  } else if (report.screenshotSize != null) {
    if (report.screenshotSize === 0) {
      warnings.push("Visual Validation Failed: Captured screenshot is completely empty/0 bytes.");
    } else if (report.screenshotSize < 5000) {
      warnings.push(`Visual Validation Failed: Captured screenshot is extremely small (${report.screenshotSize} bytes). The canvas might be rendering a blank/clear-color screen.`);
    } else {
      highlights.push(`Visual Validation Passed: Canvas/page rendered content successfully (${(report.screenshotSize / 1024).toFixed(1)} KiB screenshot).`);
    }
  }

  // 1. Frame Rate & Stuttering
  if (fps != null) {
    if (fps >= 58) {
      highlights.push(`Excellent frame rate: average ${fps.toFixed(1)} FPS.`);
    } else if (fps >= 45) {
      warnings.push(`Moderate frame rate: average ${fps.toFixed(1)} FPS. Check for potential CPU/GPU bottlenecks to maintain 60 FPS.`);
    } else {
      warnings.push(`Low frame rate: average ${fps.toFixed(1)} FPS. Rendering is significantly bottlenecked.`);
    }
  }

  // Frame time variance (stuttering)
  const elapsedMs = summary.elapsedMs;
  if (elapsedMs && elapsedMs.p95 && elapsedMs.mean) {
    const variance = elapsedMs.p95 - elapsedMs.mean;
    if (variance > 8) {
      warnings.push(`High frame time variance (p95: ${elapsedMs.p95.toFixed(1)}ms vs mean: ${elapsedMs.mean.toFixed(1)}ms). This indicates micro-stuttering or garbage collection pauses.`);
    }
  }

  // 2. JS Heap Memory
  if (jsHeapDelta != null) {
    const elapsedMsVal = summary.elapsedMs?.mean || report.inPage?.config?.durationMs || 1000;
    const sampleDurationSec = elapsedMsVal / 1000;
    const heapGrowthMBPerSec = (jsHeapDelta / 1024 / 1024) / sampleDurationSec;
    if (heapGrowthMBPerSec > 5) {
      warnings.push(`High JS Heap churn: growing by ${heapGrowthMBPerSec.toFixed(2)} MB/s. Check for object allocation/creation in the render loop.`);
    } else if (heapGrowthMBPerSec > 0.5) {
      warnings.push(`Moderate JS Heap growth: growing by ${heapGrowthMBPerSec.toFixed(2)} MB/s. Ensure objects, vectors, or matrices are pooled.`);
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
      // Fallback if structured as arrays
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
    warnings.push(`High VRAM footprint: ${(totalVramMB).toFixed(1)} MiB of GPU resources allocated. This may cause page crashes on mobile or low-end devices.`);
  }

  if (textureBytes > 0) {
    const texMB = textureBytes / 1024 / 1024;
    if (texMB > 100) {
      warnings.push(`Texture memory is high: ${texMB.toFixed(1)} MiB across ${textureCount} textures. Recommend using compressed textures (KTX2, Basis Universal) and ensuring unused textures are disposed.`);
    }
  }

  if (bufferCount > 200) {
    warnings.push(`Large buffer count: ${bufferCount} buffers allocated. High draw call count or missing vertex/index buffer consolidation. Suggest merging geometries or using InstancedMesh.`);
  }

  // 4. GPU Timing / Execution Duration
  const gpuTimes = report.inPage?.samples?.map((s) => s.gpuTimeNs).filter((t) => t != null && t > 0) || [];
  if (gpuTimes.length > 0) {
    const sumGpuTime = gpuTimes.reduce((a, b) => a + b, 0);
    const meanGpuMs = (sumGpuTime / gpuTimes.length) / 1000000;
    if (meanGpuMs > 13) {
      warnings.push(`High GPU execution time: average ${meanGpuMs.toFixed(2)} ms per frame. The GPU is heavily loaded. Optimize shaders, simplify geometry, or reduce lights/shadows.`);
    } else {
      highlights.push(`GPU frame execution time is healthy: average ${meanGpuMs.toFixed(2)} ms.`);
    }
  }

  // 5. CDP Chrome Trace analysis
  const traceGpuMean = report.trace?.summary?.gpu?.completeDurationMs?.mean;
  if (traceGpuMean != null) {
    if (traceGpuMean > 13) {
      warnings.push(`Chrome GPU thread trace shows long tasks: average ${traceGpuMean.toFixed(2)} ms. Look for heavy GPU pipeline compiles or draw calls.`);
    }
  }

  return {
    warnings,
    highlights,
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
    ?.map((sample) => sample.gpuTimeNs)
    .filter((t) => Number.isFinite(t) && t > 0) || [];
  const gpuFrameMsMean = gpuTimes.length > 0
    ? (gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length) / 1e6
    : null;

  const totalBytes = resources.totalBytes || finite(s.trackedGpuTotalBytes?.max) || 0;

  const summary = {
    verdict: null,
    fps,
    frameTimeMsMean,
    frameTimeMsP95,
    frameTimeMsMax,
    maxJitterMs,
    gpuFrameMsMean,
    jsHeapGrowthMBPerSec,
    trackedVram: {
      totalMiB: round2(totalBytes / 1024 / 1024),
      textureMiB: round2((resources.textureBytes || 0) / 1024 / 1024),
      bufferMiB: round2((resources.bufferBytes || 0) / 1024 / 1024),
      textureCount: resources.textureCount || 0,
      bufferCount: resources.bufferCount || 0,
      leakedResources: finite(s.leakCount?.max) || 0
    },
    slowFrameCount: report.inPage?.slowFrames?.length || 0,
    sampleCount: finite(s.sampleCount) || report.inPage?.samples?.length || 0,
    warningCount: analysis.warnings.length,
    warnings: analysis.warnings,
    highlights: analysis.highlights
  };

  summary.verdict = computeVerdict(summary);
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

function computeVerdict(summary) {
  const fps = summary.fps;
  const vramMiB = summary.trackedVram.totalMiB;
  const heapGrowth = summary.jsHeapGrowthMBPerSec;

  if ((fps != null && fps < 45) || vramMiB > 500 || (heapGrowth != null && heapGrowth > 5)) {
    return "poor";
  }
  if ((fps != null && fps < 58) || summary.warningCount > 0) {
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
  
  if (analysis.highlights.length > 0) {
    lines.push("🟩 Performance Highlights:");
    for (const highlight of analysis.highlights) {
      lines.push(`  - ${highlight}`);
    }
  }
  
  if (analysis.warnings.length > 0) {
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
