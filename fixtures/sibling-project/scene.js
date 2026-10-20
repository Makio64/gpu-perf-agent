const canvas = document.querySelector("#scene");
const gl = canvas.getContext("webgl2", { antialias: false });

if (!gl) {
  throw new Error("WebGL2 unavailable in sibling fixture");
}

const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(1024), gl.STATIC_DRAW);

const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

const vs = gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs, "#version 300 es\nvoid main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }");
gl.compileShader(vs);
const fs = gl.createShader(gl.FRAGMENT_SHADER);
gl.shaderSource(fs, "#version 300 es\nprecision mediump float;\nout vec4 outColor;\nvoid main() { outColor = vec4(0.2, 0.4, 0.8, 1.0); }");
gl.compileShader(fs);
const program = gl.createProgram();
gl.attachShader(program, vs);
gl.attachShader(program, fs);
gl.linkProgram(program);
gl.useProgram(program);

globalThis.__gpuReportBench = async ({ durationMs }) => {
  const started = performance.now();
  let frames = 0;
  while (performance.now() - started < durationMs) {
    gl.clearColor((frames % 8) / 8, 0.1, 0.2, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frames += 1;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const elapsed = performance.now() - started;
  return {
    api: "webgl2",
    fps: frames / (elapsed / 1000),
    renderedFrames: frames
  };
};
