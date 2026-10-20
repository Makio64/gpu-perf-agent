// §4.7 acceptance on saved audit captures (test/fixtures/saved, trimmed v2 reports).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { compareReports } from "../src/compare.js";
import { classifyBottleneck } from "../src/analysis.js";
import { comparisonExitCode } from "../src/output.js";
import { convertWarm } from "./fixtures/v3/convert-warm.mjs";

const captures = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/saved/audit-captures.json.gz", import.meta.url))));
const group = prefix => Object.keys(captures).filter(name => new RegExp(`^${prefix}-\\d+$`).test(name)).sort().map(name => captures[name]);
const orderedPairs = list => list.flatMap((a, i) => list.filter((_, j) => j !== i).map(b => [a, b]));
const crossPairs = (left, right) => left.flatMap(a => right.map(b => [a, b]));
const GPU_ROW = /^health\.(autoGpuFrameMs|gpuFrameMs)|^gpu\./;

function tally(pairs, options = {}) {
  const result = { pairs: 0, exit: { 0: 0, 1: 0, 2: 0 }, status: {}, screen: {}, gpuDecisions: 0, failures: {} };
  for (const [base, candidate] of pairs) {
    const comparison = compareReports(base, candidate, options);
    result.pairs++;
    result.exit[comparisonExitCode(comparison)]++;
    result.status[comparison.status] = (result.status[comparison.status] || 0) + 1;
    const screen = comparison.primary?.row?.screen;
    if (screen) result.screen[screen] = (result.screen[screen] || 0) + 1;
    result.gpuDecisions += comparison.rows.filter(row => GPU_ROW.test(row.key) && ["improved", "regression"].includes(row.status)).length;
    for (const row of comparison.failures) result.failures[row.key] = (result.failures[row.key] || 0) + 1;
  }
  return result;
}

const pages = { draw: group("draw"), clear: group("clear"), mid: group("mid"), cube: group("cube"), heavy: group("heavy") };

test("gating A/A: 122 ordered same-page pairs give no exit 1 and no separate-capture GPU decision", () => {
  const pairs = Object.values(pages).flatMap(orderedPairs);
  assert.equal(pairs.length, 122);
  const result = tally(pairs);
  assert.equal(result.exit[1], 0, JSON.stringify(result.failures));
  assert.equal(result.gpuDecisions, 0);
  assert.deepEqual(result.status, { unverified: 122 });
});

test("draw → mid and draw → heavy (separate) are unverified with screen worse; heavy → draw screens better", () => {
  for (const [label, pairs, screen] of [["draw→mid", crossPairs(pages.draw, pages.mid), "worse"], ["draw→heavy", crossPairs(pages.draw, pages.heavy), "worse"],
    ["heavy→draw", crossPairs(pages.heavy, pages.draw), "better"]]) {
    const result = tally(pairs);
    assert.deepEqual(result.status, { unverified: pairs.length }, label);
    assert.deepEqual(result.screen, { [screen]: pairs.length }, label);
    assert.equal(result.exit[0], pairs.length, label);
  }
  const comparison = compareReports(pages.draw[0], pages.heavy[0]);
  assert.equal(comparison.primary.selection, "fallback");
  assert.deepEqual(comparison.primary.row.reasons, ["unverified-between-run"]);
});

test("gl-cpu-20 → gl-cpu-24 regresses frame time in 25/25 pairs; the reverse never regresses", () => {
  const cpu20 = group("gl-cpu-20"), cpu24 = group("gl-cpu-24");
  const forward = tally(crossPairs(cpu20, cpu24));
  assert.deepEqual(forward.status, { regression: 25 });
  assert.deepEqual(forward.failures, { "frame.frameTimeMs.mean": 25 });
  const reverse = tally(crossPairs(cpu24, cpu20));
  assert.equal(reverse.status.regression ?? 0, 0);
  assert.equal(reverse.exit[1], 0);
  const comparison = compareReports(cpu20[0], cpu24[0]);
  assert.equal(comparison.primary.key, "frame.frameTimeMs.mean");
  assert.equal(comparison.primary.row.evidence, "independent-samples");
  for (const report of [...cpu20, ...cpu24]) assert.equal(classifyBottleneck(report).class, "cpu-bound");
});

test("slowFrameRate never fails between separate captures (gpu-loop-300 and ovh-autoinst A/A)", () => {
  const pairs = [...orderedPairs(group("gpu-loop-300")), ...orderedPairs(group("ovh-autoinst"))];
  assert.equal(pairs.length, 26);
  for (const [base, candidate] of pairs) {
    const comparison = compareReports(base, candidate);
    const row = comparison.rows.find(item => item.key === "health.slowFrameRate");
    assert.equal(row.status, "unverified");
    assert.deepEqual(row.reasons, ["episodic-slow-frames"]);
    assert.ok(!comparison.failures.some(item => item.key === "health.slowFrameRate"));
  }
});

test("warm hook timing: 200 → 240 regresses in at least 6/9 separate pairs", () => {
  const w200 = group("warm-200").map(report => convertWarm(report)), w240 = group("warm-240").map(report => convertWarm(report));
  const result = tally(crossPairs(w200, w240));
  assert.ok(result.status.regression >= 6, JSON.stringify(result));
  assert.equal(result.exit[2], 0);
  assert.deepEqual(Object.keys(result.failures), ["health.gpuFrameMs.mean"]);
  // Without the warm method the same captures are vsync-paced and never gate.
  const paced = tally(crossPairs(group("warm-200"), group("warm-240")));
  assert.equal(paced.status.regression ?? 0, 0);
});

test("a broken candidate is invalid (exit 2), never a -100% improvement", () => {
  const base = convertWarm(group("warm-240")[0]);
  const comparison = compareReports(base, captures["broken-240-1"]);
  assert.equal(comparison.status, "invalid");
  assert.equal(comparison.exitCode, 2);
  assert.equal(comparisonExitCode(comparison), 2);
  assert.ok(comparison.validity.issues.some(issue => issue.code === "invalid-candidate"));
});

test("a capture that observed no GPU work never makes the other side's work counts regress", () => {
  const comparison = compareReports(captures["three-failed-1"], captures["three-ok-1"]);
  const draws = comparison.rows.find(row => row.key === "health.drawCallsPerFrame");
  assert.equal(draws.status, "unverified");
  assert.deepEqual(draws.reasons, ["gpu-work-unobserved"]);
  assert.notEqual(comparison.exitCode, 1);
});

test("§5.2 classes on saved captures", () => {
  assert.equal(classifyBottleneck(group("gpu-loop-300")[0]).class, "vsync-capped");
  for (const report of pages.cube) assert.equal(classifyBottleneck(report).class, "vsync-capped");
});
