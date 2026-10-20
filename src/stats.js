export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function numericStats(values) {
  const numbers = values.filter(finiteNumber).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return null;
  }

  const sum = numbers.reduce((total, value) => total + value, 0);
  const mean = sum / numbers.length;
  const variance = numbers.reduce((total, value) => total + ((value - mean) ** 2), 0) / numbers.length;
  const stddev = Math.sqrt(variance);
  const median = percentile(numbers, 0.5);
  return {
    coefficientOfVariation: mean === 0 ? null : stddev / Math.abs(mean),
    count: numbers.length,
    mad: medianAbsoluteDeviation(numbers, median),
    min: numbers[0],
    max: numbers[numbers.length - 1],
    mean,
    p50: median,
    p90: percentile(numbers, 0.9),
    p95: percentile(numbers, 0.95),
    p99: percentile(numbers, 0.99),
    stddev,
    variance
  };
}

function medianAbsoluteDeviation(numbers, median) {
  // Typed-array map operations can round or truncate deviations; retain that behavior.
  if (!Array.isArray(numbers)) {
    return percentile(numbers.map(value => Math.abs(value - median)).sort((a, b) => a - b), 0.5);
  }

  // Distances increase in both directions away from the median. Merge only as far
  // as their middle values instead of allocating and sorting every deviation.
  // Search by value: interpolating subnormal numbers can round outside the two
  // central values, so their indices alone do not always locate this split.
  let start = 0;
  let end = numbers.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (numbers[middle] < median) start = middle + 1;
    else end = middle;
  }
  let left = start - 1;
  let right = start;
  let leftDistance = left >= 0 ? Math.abs(numbers[left] - median) : Infinity;
  let rightDistance = right < numbers.length ? Math.abs(numbers[right] - median) : Infinity;
  let previous = 0;
  let current = 0;
  const middle = Math.floor(numbers.length / 2);
  for (let index = 0; index <= middle; index += 1) {
    previous = current;
    if (left >= 0 && (right >= numbers.length || leftDistance <= rightDistance)) {
      current = leftDistance;
      left -= 1;
      leftDistance = left >= 0 ? Math.abs(numbers[left] - median) : Infinity;
    } else {
      current = rightDistance;
      right += 1;
      rightDistance = right < numbers.length ? Math.abs(numbers[right] - median) : Infinity;
    }
  }
  return numbers.length % 2 ? current : previous * 0.5 + current * 0.5;
}

/** Median of the finite values, or null. */
export function median(values) {
  const numbers = values.filter(finiteNumber).sort((a, b) => a - b);
  return percentile(numbers, 0.5);
}

/** Robust standard error of the mean: 1.4826·MAD/√n (§4.2). */
export function robustStandardError(stats) {
  if (!stats || !(stats.count > 0) || !finiteNumber(stats.mad)) return null;
  return 1.4826 * stats.mad / Math.sqrt(stats.count);
}

export function confidenceInterval95(values) {
  return confidenceInterval95FromStats(numericStats(values));
}

function confidenceInterval95FromStats(stats) {
  if (!stats) {
    return null;
  }
  if (stats.count < 2) {
    return {
      high: stats.mean,
      low: stats.mean,
      margin: 0,
      method: "single-sample"
    };
  }

  const critical = studentTCritical95(stats.count - 1);
  // numericStats reports population variance; Student-t needs sample variance.
  const margin = critical * stats.stddev / Math.sqrt(stats.count - 1);
  return {
    high: stats.mean + margin,
    low: stats.mean - margin,
    margin,
    method: "student-t"
  };
}

export function pairedDifferenceStats(baseValues, candidateValues) {
  const count = Math.min(baseValues.length, candidateValues.length);
  const differences = [];
  for (let index = 0; index < count; index += 1) {
    if (finiteNumber(baseValues[index]) && finiteNumber(candidateValues[index])) {
      differences.push(candidateValues[index] - baseValues[index]);
    }
  }
  if (differences.length === 0) {
    return null;
  }
  const stats = numericStats(differences);
  return {
    confidence95: confidenceInterval95FromStats(stats),
    differences,
    stats
  };
}

/** Independent captures have no natural pairing. Use unequal-variance Welch intervals. */
export function independentDifferenceStats(baseValues, candidateValues) {
  return independentDifferenceStatsFromStats(numericStats(baseValues), numericStats(candidateValues));
}

/** Reuse already calculated summaries when comparing many report metrics. */
export function independentDifferenceStatsFromStats(base, candidate) {
  if (!base || !candidate) return null;
  const mean = candidate.mean - base.mean;
  if (base.count < 2 || candidate.count < 2) return { confidence95: null, mean };
  // population variance / (n - 1) equals unbiased sample variance / n.
  const a = base.variance / (base.count - 1);
  const b = candidate.variance / (candidate.count - 1);
  const degreesOfFreedom = a + b === 0 ? Infinity
    : (a + b) ** 2 / (a ** 2 / (base.count - 1) + b ** 2 / (candidate.count - 1));
  const margin = studentTCritical95(degreesOfFreedom) * Math.sqrt(a + b);
  return {
    confidence95: { high: mean + margin, low: mean - margin, margin, method: "welch-t" },
    degreesOfFreedom,
    mean
  };
}

export function percentile(sortedNumbers, ratio) {
  if (sortedNumbers.length === 0) {
    return null;
  }
  if (sortedNumbers.length === 1) {
    return sortedNumbers[0];
  }

  const index = (sortedNumbers.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedNumbers[lower];
  }

  const weight = index - lower;
  return sortedNumbers[lower] * (1 - weight) + sortedNumbers[upper] * weight;
}

function studentTCritical95(degreesOfFreedom) {
  const table = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
  ];
  if (degreesOfFreedom <= 0) {
    return 0;
  }
  if (degreesOfFreedom <= table.length) {
    // Rounding down is conservative for fractional Welch degrees of freedom.
    return table[Math.max(1, Math.floor(degreesOfFreedom)) - 1];
  }
  if (degreesOfFreedom <= 40) {
    return 2.042;
  }
  if (degreesOfFreedom <= 60) {
    return 2.021;
  }
  if (degreesOfFreedom <= 120) {
    return 2.0;
  }
  return 1.98;
}

export function flattenNumbers(value, prefix = "", out = {}) {
  if (finiteNumber(value)) {
    out[prefix || "value"] = value;
    return out;
  }

  if (!value || typeof value !== "object") {
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const nextPrefix = prefix ? `${prefix}.${index}` : String(index);
      flattenNumbers(item, nextPrefix, out);
    });
    return out;
  }

  for (const [key, item] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    flattenNumbers(item, nextPrefix, out);
  }

  return out;
}

/**
 * Hook-returned measurement paths that are not workload metrics: observed-frame
 * histories, counts, and anything that mirrors profiler telemetry.
 */
export function isNoisyMeasurementPath(path) {
  return /(^|\.)(length|byteLength|count|fps|frameCount|frameTimeMs|observationWindowMs|observedFrames|samples|slowFrameCount|totalResources)(\.|$)/i.test(path)
    || /^\d+/.test(path);
}

/** Flatten a hook measurement to `{path: number}`, skipping noisy subtrees before visiting them. */
export function flattenMeasurementNumbers(value, prefix = "", out = {}, depth = 0) {
  // Once a path contains an excluded segment every descendant is excluded too.
  // Skip observed-frame histories before allocating their thousands of paths.
  // The depth bound also stops on cyclic objects passed in directly (never JSON).
  if ((prefix && isNoisyMeasurementPath(prefix)) || depth > 32) return out;
  if (finiteNumber(value)) {
    out[prefix || "value"] = value;
  } else if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => flattenMeasurementNumbers(item, prefix ? `${prefix}.${index}` : String(index), out, depth + 1));
    } else {
      for (const [key, item] of Object.entries(value)) {
        flattenMeasurementNumbers(item, prefix ? `${prefix}.${key}` : key, out, depth + 1);
      }
    }
  }
  return out;
}

export function summarizeNumericPaths(items) {
  const paths = new Map();
  for (const item of items) {
    const flat = flattenNumbers(item);
    for (const [path, value] of Object.entries(flat)) {
      if (!paths.has(path)) {
        paths.set(path, []);
      }
      paths.get(path).push(value);
    }
  }

  const summary = {};
  for (const [path, values] of paths) {
    const stats = numericStats(values);
    if (stats) {
      summary[path] = stats;
    }
  }
  return summary;
}

export function bytesToMiB(bytes) {
  return bytes / (1024 * 1024);
}

export function formatNumber(value, unit = "") {
  if (!finiteNumber(value)) {
    return "n/a";
  }
  if (unit === "bytes") {
    return `${bytesToMiB(value).toFixed(2)} MiB`;
  }
  if (Math.abs(value) >= 1000) {
    return value.toFixed(0);
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}
