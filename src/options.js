/** Shared by CLI, HTTP service and both runners. Validate before launching Chrome. */
export const PROFILING_PRESETS = Object.freeze({
  default: Object.freeze({ durationMs: 1000, samples: 5, warmup: 1 }),
  quick: Object.freeze({ durationMs: 250, samples: 6, warmup: 2 }),
  confirm: Object.freeze({ durationMs: 500, samples: 15, warmup: 4 }),
  profile: Object.freeze({ durationMs: 750, samples: 8, warmup: 2, gc: true, trace: true })
});

export function numberOption(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new TypeError(`${name} must be a number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new TypeError(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`);
  }
  return number;
}

export function parseViewport(viewport = '1280x720') {
  const match = typeof viewport === 'string' && /^(\d+)x(\d+)$/i.exec(viewport);
  if (!match) throw new TypeError(`Invalid viewport "${viewport}". Expected WIDTHxHEIGHT, for example 1280x720.`);
  return {
    width: numberOption(match[1], 'viewport width', { min: 1, max: 16384, integer: true }),
    height: numberOption(match[2], 'viewport height', { min: 1, max: 16384, integer: true })
  };
}

export function normalizeOptions(input = {}, { requireTarget = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Options must be a JSON object.');
  const preset = input.preset ?? 'default';
  if (!Object.hasOwn(PROFILING_PRESETS, preset)) throw new TypeError(`Unknown preset "${preset}". Expected quick, confirm, profile, or default.`);
  const options = { ...PROFILING_PRESETS[preset], ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  if (options.url && options.file) throw new TypeError('Choose exactly one target: url or file.');
  if (requireTarget && !options.url && !options.file) throw new TypeError('A target is required. Pass --url or --file.');
  if (options.url) {
    let url;
    try { url = new URL(options.url); } catch { throw new TypeError('url must be an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('url must use HTTP or HTTPS. Use file for local HTML.');
  }
  options.screenshotPath ??= options.screenshotOut;
  for (const key of ['file', 'fileRoot', 'hookName', 'executablePath', 'channel', 'screenshotPath', 'rawTracePath']) {
    if (options[key] != null && (typeof options[key] !== 'string' || !options[key].trim())) throw new TypeError(`${key} must be a non-empty string.`);
  }
  for (const key of ['autoInstrument', 'gc', 'headful', 'trace', 'deepMemory', 'waitForHook', 'adaptive', 'minimalTrace', 'screenshot', 'visualValidation']) {
    if (options[key] != null && typeof options[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
  }
  options.cdpUrl ??= options.cdp ?? options.webSocketUrl;
  if (options.cdpUrl != null && (typeof options.cdpUrl !== "string" || !options.cdpUrl.trim())) throw new TypeError("cdpUrl must be a port or browser HTTP/WebSocket URL.");
  if (options.cdpUrl && (options.angle || options.channel || options.executablePath || options.headful || options.chromiumArgs?.length)) throw new TypeError("Browser launch flags cannot be changed when attaching over CDP.");
  options.slowFrameThresholdMs ??= options.slowFrameThreshold;
  if (options.waitCondition != null && (typeof options.waitCondition !== "string" || !options.waitCondition.trim())) throw new TypeError("waitCondition must be a non-empty JavaScript expression.");
  options.waitConditionTimeoutMs = numberOption(options.waitConditionTimeoutMs ?? options.timeoutMs ?? 20000, "waitConditionTimeoutMs", {min:1, max:2147482647});
  options.samples = numberOption(options.samples, 'samples', { min: 1, max: 10000, integer: true });
  options.warmup = numberOption(options.warmup, 'warmup', { max: 10000, integer: true });
  options.durationMs = numberOption(options.durationMs, 'durationMs', { min: 1, max: 3600000 });
  options.timeoutMs = numberOption(options.timeoutMs ?? 60000, 'timeoutMs', { min: 1, max: 2147482647 });
  options.launchTimeoutMs = numberOption(options.launchTimeoutMs ?? 15000, 'launchTimeoutMs', { min: 1, max: 2147482647 });
  options.deviceScaleFactor = numberOption(options.deviceScaleFactor ?? 1, 'deviceScaleFactor', { min: 0.1, max: 8 });
  options.slowFrameThresholdMs = numberOption(options.slowFrameThresholdMs ?? 20, 'slowFrameThresholdMs', { min: 0.1 });
  options.viewport ??= '1280x720';
  parseViewport(options.viewport);
  options.api ??= 'auto';
  if (!['auto', 'webgpu', 'webgl', 'webgl2'].includes(options.api)) throw new TypeError('api must be auto, webgpu, webgl, or webgl2.');
  options.contextMode ??= 'isolated';
  if (!['isolated', 'shared'].includes(options.contextMode)) throw new TypeError('contextMode must be isolated or shared.');
  options.waitUntil ??= 'networkidle';
  if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(options.waitUntil)) throw new TypeError('waitUntil must be load, domcontentloaded, networkidle, or commit.');
  if (options.chromiumArgs != null && (!Array.isArray(options.chromiumArgs) || options.chromiumArgs.some(arg => typeof arg !== 'string'))) throw new TypeError('chromiumArgs must be an array of strings.');
  if (options.rawTracePath || options.minimalTrace) options.trace = true;
  return options;
}
