// About 80 ms of main-thread work per frame in a named rAF callback (a long animation frame).
const gl = document.getElementById("c").getContext("webgl2");
function simulate(ms) {
  const start = performance.now();
  let x = 0;
  while (performance.now() - start < ms) x += Math.sqrt(x + 1);
  return x;
}
function frame() {
  simulate(80);
  gl.clearColor(0.1, 0.2, 0.3, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
