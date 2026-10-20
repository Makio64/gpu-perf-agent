// Deliberately CPU-bound WebGL2 scene with identifiable hot functions.
const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2");
const N = 20000;
const K = Number(new URLSearchParams(location.search).get("k") || 80);
const positions = new Float32Array(N * 2);
const velocities = new Float32Array(N * 2);
for (let i = 0; i < N * 2; i++) { positions[i] = Math.random() * 2 - 1; velocities[i] = (Math.random() - 0.5) * 0.01; }

const vs = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); gl_PointSize = 2.; }`;
const fs = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(1.,.6,.2,1.); }`;
function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
gl.linkProgram(prog);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, positions.byteLength, gl.DYNAMIC_DRAW);
const loc = gl.getAttribLocation(prog, "p");
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

// Hot spot 1: O(N * K) neighbor-ish physics.
function updateParticles(dt) {
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < N; i++) {
      const ix = i * 2;
      let vx = velocities[ix], vy = velocities[ix + 1];
      const x = positions[ix], y = positions[ix + 1];
      vx += -x * 0.0001 * Math.sin(k + x * 3.1);
      vy += -y * 0.0001 * Math.cos(k + y * 2.7);
      velocities[ix] = vx; velocities[ix + 1] = vy;
      positions[ix] = x + vx * dt * 0.03; positions[ix + 1] = y + vy * dt * 0.03;
    }
  }
}

// Hot spot 2: allocation churn building per-frame uniform-like objects.
function buildFrameState(t) {
  const out = [];
  for (let i = 0; i < 4000; i++) out.push({ id: i, m: [Math.sin(t + i), Math.cos(t + i), i * 0.5, 1] });
  return out.length;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(50, now - last); last = now;
  updateParticles(dt);
  buildFrameState(now * 0.001);
  const w = Math.floor(innerWidth * devicePixelRatio), h = Math.floor(innerHeight * devicePixelRatio);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.02, 0.02, 0.05, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
  gl.drawArrays(gl.POINTS, 0, N);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (new URLSearchParams(location.search).has("bench")) {
  globalThis.__gpuReportBench = async () => { const t = performance.now(); for (let j = 0; j < 5; j++) updateParticles(16); buildFrameState(1); return { cpuMs: performance.now() - t }; };
}
