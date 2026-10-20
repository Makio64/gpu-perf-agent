// Multi-pass WebGPU workload: fixed-resolution vertex-heavy "shadow" pass, resolution-dependent
// fragment pass (unlabelled), labelled compute "blur", cheap unlabelled overlay pass.
const q = new URLSearchParams(location.search);
const LOAD = Number(q.get("load") || 64);       // fragment loop iterations
const TRIS = Number(q.get("tris") || 300000);   // shadow pass triangles
const CHURN = Number(q.get("churn") || 0);      // bind groups created per frame

const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
const device = await adapter.requestDevice();
const canvas = document.getElementById("c");
const ctx = canvas.getContext("webgpu");
const format = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format, alphaMode: "opaque" });

const shadowModule = device.createShaderModule({ label: "shadow.wgsl", code: `
@group(0) @binding(0) var<uniform> t: vec4f;
@vertex fn vsShadow(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let f = f32(i); let a = f * 0.618 + t.x;
  var p = vec2f(sin(a * 1.3) * cos(f * 0.001), cos(a * 0.7));
  for (var k = 0; k < 8; k++) { p = p * 0.99 + vec2f(sin(p.y * 3.0 + f32(k)), cos(p.x * 2.0)) * 0.01; }
  return vec4f(p * 0.9, fract(f * 0.0001), 1);
}` });
const mainModule = device.createShaderModule({ label: "main.wgsl", code: `
@group(0) @binding(0) var<uniform> t: vec4f;
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); }
@fragment fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c = vec3f(0); var uv = pos.xy * 0.002;
  for (var i = 0; i < ${LOAD}; i++) { uv = vec2f(sin(uv.y * 1.7 + t.x), cos(uv.x * 1.3 - t.x)) + uv * 0.5; c += abs(vec3f(uv, uv.x * uv.y)) * 0.02; }
  return vec4f(c, 1);
}
@fragment fn fsOverlay(@builtin(position) pos: vec4f) -> @location(0) vec4f { return vec4f(0.1, 0.1, 0.1, 0.0); }` });
const blurModule = device.createShaderModule({ label: "blur.wgsl", code: `
@group(0) @binding(0) var<storage, read_write> data: array<vec4f>;
@compute @workgroup_size(64) fn csBlur(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= arrayLength(&data)) { return; }
  var v = data[i]; for (var k = 0u; k < 16u; k++) { v = v * 0.9 + data[(i + k * 97u) % arrayLength(&data)] * 0.1; } data[i] = v;
}` });

const shadowTex = device.createTexture({ label: "shadow-map", size: [2048, 2048], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
const ubo = device.createBuffer({ label: "time", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const storage = device.createBuffer({ label: "blur-data", size: 256 * 1024 * 16, usage: GPUBufferUsage.STORAGE });

function createPipelines() {
  const shadow = device.createRenderPipeline({ label: "shadow-pipeline", layout: "auto", vertex: { module: shadowModule, entryPoint: "vsShadow" },
    primitive: { topology: "triangle-list" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } });
  const main = device.createRenderPipeline({ layout: "auto", vertex: { module: mainModule, entryPoint: "vsFull" }, fragment: { module: mainModule, entryPoint: "fsMain", targets: [{ format }] } });
  const overlay = device.createRenderPipeline({ label: "overlay", layout: "auto", vertex: { module: mainModule, entryPoint: "vsFull" },
    fragment: { module: mainModule, entryPoint: "fsOverlay", targets: [{ format, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: {} } }] } });
  const blur = device.createComputePipeline({ label: "blur-pipeline", layout: "auto", compute: { module: blurModule, entryPoint: "csBlur" } });
  return { shadow, main, overlay, blur };
}
const P = createPipelines();
const bgShadow = device.createBindGroup({ layout: P.shadow.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });
const bgMain = device.createBindGroup({ layout: P.main.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });
const bgBlur = device.createBindGroup({ layout: P.blur.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });

function makeFrameBindGroups() {
  // Deliberate churn: identical bind groups recreated every frame.
  for (let i = 0; i < CHURN; i++) device.createBindGroup({ layout: P.main.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });
}

function resize() {
  const w = Math.max(1, Math.floor(innerWidth * devicePixelRatio)), h = Math.max(1, Math.floor(innerHeight * devicePixelRatio));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function renderShadow(encoder) {
  const pass = encoder.beginRenderPass({ label: "shadow", colorAttachments: [], depthStencilAttachment: { view: shadowTex.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
  pass.setPipeline(P.shadow); pass.setBindGroup(0, bgShadow); pass.draw(TRIS * 3); pass.end();
}
function renderMain(encoder, view) {
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(P.main); pass.setBindGroup(0, bgMain); pass.draw(3); pass.end();
}
function runBlur(encoder) {
  const pass = encoder.beginComputePass({ label: "blur" });
  pass.setPipeline(P.blur); pass.setBindGroup(0, bgBlur); pass.dispatchWorkgroups(256 * 1024 / 64); pass.end();
}
function renderOverlay(encoder, view) {
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
  pass.setPipeline(P.overlay); pass.setBindGroup(0, bgMain); pass.draw(3); pass.end();
}

function frame(t) {
  resize();
  makeFrameBindGroups();
  device.queue.writeBuffer(ubo, 0, new Float32Array([t * 0.001, 0, 0, 0]));
  const view = ctx.getCurrentTexture().createView();
  const encoder = device.createCommandEncoder();
  renderShadow(encoder);
  renderMain(encoder, view);
  runBlur(encoder);
  renderOverlay(encoder, view);
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
globalThis.__appReady = true;
