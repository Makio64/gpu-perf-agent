export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function numericStats(values) {
  const numbers = values.filter(finiteNumber).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return null;
  }

  const sum = numbers.reduce((total, value) => total + value, 0);
  return {
    count: numbers.length,
    min: numbers[0],
    max: numbers[numbers.length - 1],
    mean: sum / numbers.length,
    p50: percentile(numbers, 0.5),
    p95: percentile(numbers, 0.95)
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
