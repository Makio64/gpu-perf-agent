import assert from "node:assert/strict";
import test from "node:test";
import {
  confidenceInterval95,
  flattenNumbers,
  numericStats,
  pairedDifferenceStats,
  percentile
} from "../src/stats.js";

test("numericStats returns robust distribution metrics", () => {
  const result = numericStats([4, 1, Number.NaN, 3, 2]);
  assert.equal(result.count, 4);
  assert.equal(result.mean, 2.5);
  assert.equal(result.p50, 2.5);
  assert.equal(result.p90, 3.7);
  assert.equal(result.p95, 3.8499999999999996);
  assert.equal(result.p99, 3.9699999999999998);
  assert.equal(result.variance, 1.25);
  assert.equal(result.mad, 1);
});

test("numericStats handles empty and zero-mean inputs", () => {
  assert.equal(numericStats([]), null);
  assert.equal(numericStats([-1, 1]).coefficientOfVariation, null);
});

function sortedDeviationMedian(values) {
  const numbers = values.filter(value => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const median = percentile(numbers, 0.5);
  return percentile(numbers.map(value => Math.abs(value - median)).sort((a, b) => a - b), 0.5);
}

test("MAD preserves subnormal rounding, overflowing deviations, signed zero and typed-array behavior", () => {
  const fixtures = [
    [], [NaN, Infinity, -Infinity, null, "1"], [7], [-0], [-0, 0], [0, -0, 0, -0],
    [Number.MIN_VALUE, Number.MIN_VALUE], [-Number.MIN_VALUE, -Number.MIN_VALUE],
    [3 * Number.MIN_VALUE, 3 * Number.MIN_VALUE], [-3 * Number.MIN_VALUE, -3 * Number.MIN_VALUE],
    [-Number.MIN_VALUE, Number.MIN_VALUE], [Number.MIN_VALUE, Number.MIN_VALUE * 2],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [-Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [1, 1, 1, 1, 100], [1, 2, 3, 4, 1e100], [NaN, 1, null, 2, Infinity, 9],
    new Int32Array([0, 1]), new Float32Array([0.1, 0.2, 0.3, 0.8]),
    new Float64Array([Number.MIN_VALUE, Number.MIN_VALUE])
  ];
  for (const values of fixtures) {
    const before = values.slice();
    assert.deepEqual(numericStats(values)?.mad ?? null, sortedDeviationMedian(values));
    assert.deepEqual(values, before, "statistics must not mutate their input");
  }
});

test("MAD matches the sorted-deviation oracle across varied finite IEEE-754 values", () => {
  let state = 0x71c89e2d;
  const randomWord = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const bits = new DataView(new ArrayBuffer(8));
  for (let fixture = 0; fixture < 400; fixture += 1) {
    const values = Array.from({ length: fixture % 131 + 1 }, () => {
      bits.setUint32(0, randomWord());
      bits.setUint32(4, randomWord());
      return bits.getFloat64(0);
    });
    assert.deepEqual(numericStats(values)?.mad ?? null, sortedDeviationMedian(values), `fixture ${fixture}`);
  }
});

test("percentile interpolates and handles boundaries", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
});

test("confidenceInterval95 uses a Student-t interval", () => {
  const interval = confidenceInterval95([9, 10, 11, 10, 10]);
  assert.equal(interval.method, "student-t");
  assert.ok(interval.low < 10);
  assert.ok(interval.high > 10);
  assert.ok(interval.margin > 0);
});

test("pairedDifferenceStats retains pairing", () => {
  const result = pairedDifferenceStats([10, 20, 30], [8, 18, 28]);
  assert.deepEqual(result.differences, [-2, -2, -2]);
  assert.equal(result.stats.mean, -2);
  assert.deepEqual(result.confidence95, {
    high: -2,
    low: -2,
    margin: 0,
    method: "student-t"
  });
});

test("flattenNumbers preserves paths and ignores non-numbers", () => {
  assert.deepEqual(flattenNumbers({ a: { b: 3 }, c: [4, "x"] }), {
    "a.b": 3,
    "c.0": 4
  });
});

test('Student-t uses unbiased sample variance for small sample counts', () => {
  const result = confidenceInterval95([1, 2, 3]);
  const expected = 4.303 / Math.sqrt(3); // sample standard deviation = 1
  assert.ok(Math.abs(result.margin - expected) < 1e-12);
});

test('Welch intervals use unequal sample variances and conservative fractional degrees of freedom', async () => {
  const { independentDifferenceStats } = await import('../src/stats.js');
  const equal = independentDifferenceStats([1, 2, 3], [2, 3, 4]);
  assert.equal(equal.mean, 1);
  assert.equal(equal.degreesOfFreedom, 4);
  assert.ok(Math.abs(equal.confidence95.margin - 2.776 * Math.sqrt(2 / 3)) < 1e-12);
  const unequal = independentDifferenceStats([1, 2, 3, null], [2, 4, 6, 8]);
  assert.ok(unequal.degreesOfFreedom > 4 && unequal.degreesOfFreedom < 5);
  assert.ok(Math.abs(unequal.confidence95.margin - 2.776 * Math.sqrt(2)) < 1e-12);
  assert.equal(independentDifferenceStats([1], [2, 3]).confidence95, null);
  assert.equal(independentDifferenceStats([], [2]), null);
});
