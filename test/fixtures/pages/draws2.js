// Draw-call-bound WebGL2: N tiny draws per frame, each with a uniform update. No heavy JS math.
const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2");
const N = (globalThis.N_DRAWS || Number(new URLSearchParams(location.search).get("n") || 20000));
const vs = `#version 300 es
uniform vec4 u; void main(){ vec2 p = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 0.01 + u.xy; gl_Position = vec4(p,0.,1.); }`;
const fs = `#version 300 es
precision mediump float; uniform vec4 u; out vec4 o; void main(){ o = vec4(u.zw, .5, 1.); }`;
function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
const uLoc = gl.getUniformLocation(prog, "u");
canvas.width = 1280; canvas.height = 720;
function submitDraws(t) {
  for (let i = 0; i < N; i++) {
    gl.uniform4f(uLoc, ((i * 37) % 200) / 100 - 1, ((i * 91) % 200) / 100 - 1, (i % 7) / 7, (t % 1000) / 1000);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
function frame(now) {
  gl.viewport(0, 0, 1280, 720);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  submitDraws(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
