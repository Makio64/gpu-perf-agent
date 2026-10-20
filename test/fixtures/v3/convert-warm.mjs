// Marks saved warm-timing captures (gpu-warm-200/240 audit runs, recorded before
// hooks reported their method) as warm hook evidence (§4.7):
//   node test/fixtures/v3/convert-warm.mjs --out DIR report.json [...]
// or import { convertWarm } and convert in memory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A copy whose measured samples carry `measurement.gpuTiming.method: "warm"`. */
export function convertWarm(report, { passes = 24, warmupMs = 20 } = {}) {
  const copy = structuredClone(report);
  for (const sample of copy?.inPage?.samples || []) {
    if (!sample || sample.error || !sample.measurement || typeof sample.measurement !== "object") continue;
    sample.measurement.gpuTiming = { method: "warm", passes, warmupMs, ...sample.measurement.gpuTiming };
  }
  // Saved evidence predates provenance; drop it so readers recompute from samples.
  if (copy?.diagnostics?.signal?.gpuTiming) delete copy.diagnostics.signal.gpuTiming;
  return copy;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex < 0 || !args[outIndex + 1]) {
    console.error("usage: node convert-warm.mjs --out DIR report.json [...]");
    process.exit(3);
  }
  const outDir = args[outIndex + 1];
  const files = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(outDir, basename(file)), `${JSON.stringify(convertWarm(JSON.parse(readFileSync(file, "utf8"))))}\n`);
  }
}
