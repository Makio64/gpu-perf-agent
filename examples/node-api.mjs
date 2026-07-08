import { runReport } from "../src/index.js";

const report = await runReport({
  file: new URL("./webgl2-draw.html", import.meta.url).pathname,
  durationMs: 500,
  samples: 3,
  trace: false,
  warmup: 1
});

console.log(JSON.stringify({
  fps: report.inPage.summary.fps,
  trackedGpuBytes: report.inPage.summary.trackedGpuTotalBytes,
  webgl2: report.inPage.apiSupport.webgl2.available,
  webgpu: report.inPage.apiSupport.webgpu.available
}, null, 2));
