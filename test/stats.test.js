import assert from "node:assert/strict";
import test from "node:test";
import { compareReports } from "../src/compare.js";
import { estimateWebGPUTextureBytes } from "../src/browser/allocation-tracker.js";
import { numericStats } from "../src/stats.js";

test("numericStats returns useful percentiles", () => {
  assert.deepEqual(numericStats([1, 2, 3, 4]), {
    count: 4,
    max: 4,
    mean: 2.5,
    min: 1,
    p50: 2.5,
    p95: 3.8499999999999996
  });
});

test("compareReports flags lower fps as regression", () => {
  const base = {
    inPage: {
      summary: {
        fps: { mean: 60 },
        sampleCount: 1
      }
    }
  };
  const candidate = {
    inPage: {
      summary: {
        fps: { mean: 50 },
        sampleCount: 1
      }
    }
  };
  const result = compareReports(base, candidate, { thresholdPercent: 5 });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].key, "frame.fps.mean");
});

test("estimateWebGPUTextureBytes handles mip levels", () => {
  assert.equal(estimateWebGPUTextureBytes({
    format: "rgba8unorm",
    mipLevelCount: 2,
    size: [4, 4, 1]
  }), 80);
});
