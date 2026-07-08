import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function getAutoInstrumentScript() {
  const allocationTrackerPath = path.join(__dirname, "allocation-tracker.js");
  const timingPath = path.join(__dirname, "timing.js");
  const autoInstrumentPath = path.join(__dirname, "auto-instrument-source.js");

  const [trackerRaw, timingRaw, autoRaw] = await Promise.all([
    readFile(allocationTrackerPath, "utf8"),
    readFile(timingPath, "utf8"),
    readFile(autoInstrumentPath, "utf8")
  ]);

  // Strip ESM export statements (e.g. "export function foo" -> "function foo")
  // and "export " prefix from variables.
  const trackerClean = trackerRaw.replace(/\bexport\s+/g, "");
  const timingClean = timingRaw.replace(/\bexport\s+/g, "");

  return `
    ${trackerClean}
    ${timingClean}
    ${autoRaw}
  `;
}
