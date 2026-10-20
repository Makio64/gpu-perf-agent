/** Shared by CLI, HTTP service and both runners. Validate before launching Chrome. */
export const PROFILING_PRESETS = Object.freeze({
  default: Object.freeze({ durationMs: 1000, samples: 5, warmup: 1 }),
  quick: Object.freeze({ durationMs: 250, samples: 6, warmup: 2 }),
  confirm: Object.freeze({ durationMs: 500, samples: 15, warmup: 4 }),
  profile: Object.freeze({ durationMs: 750, samples: 8, warmup: 2, gc: true, trace: true })
});

/** Option errors carry `code: "invalid-options"`; they stay TypeErrors for existing callers. */
export function invalidOption(message) {
  return Object.assign(new TypeError(message), { code: "invalid-options" });
}

export const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Keys `agent --base` and MCP `baseReportPath` copy from the base report's options (§2). */
export const BASE_INHERITED_OPTION_KEYS = Object.freeze([
  "api", "samples", "durationMs", "warmup", "viewport", "deviceScaleFactor", "waitUntil", "waitCondition",
  "samplingMode", "autoInstrument", "gpuTiming", "hookName"
]);

/**
 * Precedence for every entry point: explicit > base-report option > preset > default.
 * A preset never overrides a value inherited from the base. `base` is a report's
 * `options` object (or the report itself); `preset` is a preset name or a values object.
 * Returns the merged, not yet normalized, options.
 */
export function applyOptionPrecedence({ explicit = {}, base = null, preset = null, defaults = {} } = {}) {
  let presetValues = {};
  if (typeof preset === "string") {
    if (!Object.hasOwn(PROFILING_PRESETS, preset)) throw invalidOption(`Unknown preset "${preset}". Expected quick, confirm, profile, or default.`);
    presetValues = PROFILING_PRESETS[preset];
  } else if (preset && typeof preset === "object") presetValues = preset;
  // A report has a plain `options` object (older reports lack schemaVersion); an options object never does.
  const isReport = base && typeof base === "object" && base.options && typeof base.options === "object" && !Array.isArray(base.options);
  const baseOptions = isReport ? base.options : base;
  const inherited = {};
  for (const key of BASE_INHERITED_OPTION_KEYS) {
    if (baseOptions?.[key] != null) inherited[key] = baseOptions[key];
  }
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(presetValues)) {
    if (!Object.hasOwn(inherited, key) && value !== undefined) merged[key] = value;
  }
  Object.assign(merged, inherited);
  for (const [key, value] of Object.entries(explicit || {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export function numberOption(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw invalidOption(`${name} must be a number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw invalidOption(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`);
  }
  return number;
}

export function parseViewport(viewport = '1280x720') {
  const match = typeof viewport === 'string' && /^(\d+)x(\d+)$/i.exec(viewport);
  if (!match) throw invalidOption(`Invalid viewport "${viewport}". Expected WIDTHxHEIGHT, for example 1280x720.`);
  return {
    width: numberOption(match[1], 'viewport width', { min: 1, max: 16384, integer: true }),
    height: numberOption(match[2], 'viewport height', { min: 1, max: 16384, integer: true })
  };
}

export function normalizeOptions(input = {}, { requireTarget = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidOption('Options must be a JSON object.');
  const preset = input.preset ?? 'default';
  if (!Object.hasOwn(PROFILING_PRESETS, preset)) throw invalidOption(`Unknown preset "${preset}". Expected quick, confirm, profile, or default.`);
  const options = { ...PROFILING_PRESETS[preset], ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  if (options.url && options.file) throw invalidOption('Choose exactly one target: url or file.');
  if (requireTarget && !options.url && !options.file) throw invalidOption('A target is required. Pass --url or --file.');
  if (options.url) {
    let url;
    try { url = new URL(options.url); } catch { throw invalidOption('url must be an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw invalidOption('url must use HTTP or HTTPS. Use file for local HTML.');
  }
  options.screenshotPath ??= options.screenshotOut;
  for (const key of ['file', 'fileRoot', 'hookName', 'executablePath', 'channel', 'screenshotPath', 'rawTracePath', 'screenshotJpegPath']) {
    if (options[key] != null && (typeof options[key] !== 'string' || !options[key].trim())) throw invalidOption(`${key} must be a non-empty string.`);
  }
  for (const key of ['autoInstrument', 'gc', 'headful', 'trace', 'deepMemory', 'waitForHook', 'adaptive', 'minimalTrace', 'screenshot', 'visualValidation', 'gpuTiming', 'allowIdle', 'measureLock']) {
    if (options[key] != null && typeof options[key] !== 'boolean') throw invalidOption(`${key} must be a boolean.`);
  }
  options.samplingMode ??= 'frames';
  if (!['frames', 'hook'].includes(options.samplingMode)) throw invalidOption('samplingMode must be frames or hook.');
  if (options.samplingMode === 'hook') {
    if (options.adaptive) throw invalidOption('adaptive requires frames samplingMode; hook mode does not observe frame pacing.');
    if (options.waitForHook === undefined) options.waitForHook = true;
  }
  options.cdpUrl ??= options.cdp ?? options.webSocketUrl;
  if (options.cdpUrl != null && (typeof options.cdpUrl !== "string" || !options.cdpUrl.trim())) throw invalidOption("cdpUrl must be a port or browser HTTP/WebSocket URL.");
  // Recorded only (relaxes zero-gpu-duration): attached browsers quantize timestamps.
  options.cdpAttached = Boolean(options.cdpUrl);
  if (options.cdpUrl && (options.angle || options.channel || options.executablePath || options.headful || options.chromiumArgs?.length)) throw invalidOption("Browser launch flags cannot be changed when attaching over CDP.");
  options.slowFrameThresholdMs ??= options.slowFrameThreshold;
  if (options.waitCondition != null && (typeof options.waitCondition !== "string" || !options.waitCondition.trim())) throw invalidOption("waitCondition must be a non-empty JavaScript expression.");
  options.waitConditionTimeoutMs = numberOption(options.waitConditionTimeoutMs ?? options.timeoutMs ?? 20000, "waitConditionTimeoutMs", {min:1, max:2147482647});
  options.samples = numberOption(options.samples, 'samples', { min: 1, max: 10000, integer: true });
  options.warmup = numberOption(options.warmup, 'warmup', { max: 10000, integer: true });
  options.durationMs = numberOption(options.durationMs, 'durationMs', { min: 1, max: 3600000 });
  options.timeoutMs = numberOption(options.timeoutMs ?? 60000, 'timeoutMs', { min: 1, max: 2147482647 });
  options.gpuTiming ??= true;
  options.allowIdle ??= false;
  options.readyTimeoutMs = Math.min(numberOption(options.readyTimeoutMs ?? 3000, 'readyTimeoutMs', { max: 2147482647 }), options.timeoutMs);
  // The network-idle budget is the only idle clock; it always expires before the hard timeout.
  options.networkIdleBudgetMs = Math.min(numberOption(options.networkIdleBudgetMs ?? 10000, 'networkIdleBudgetMs', { max: 2147482647 }), Math.max(0, options.timeoutMs - 1000));
  options.cpuProfile ??= 'auto';
  if (!['auto', true, false].includes(options.cpuProfile)) throw invalidOption('cpuProfile must be "auto", true, or false.');
  options.measureLock ??= process.env.GPU_PERF_AGENT_NO_LOCK !== '1';
  options.lockTimeoutMs = numberOption(options.lockTimeoutMs ?? 30000, 'lockTimeoutMs', { max: 2147482647 });
  options.label ??= null;
  if (options.label !== null && (typeof options.label !== 'string' || !LABEL_PATTERN.test(options.label) || options.label === '.' || options.label === '..')) {
    throw invalidOption('label must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" or "-" (not "." or "..").');
  }
  options.launchTimeoutMs = numberOption(options.launchTimeoutMs ?? 15000, 'launchTimeoutMs', { min: 1, max: 2147482647 });
  options.deviceScaleFactor = numberOption(options.deviceScaleFactor ?? 1, 'deviceScaleFactor', { min: 0.1, max: 8 });
  options.slowFrameThresholdMs = numberOption(options.slowFrameThresholdMs ?? 20, 'slowFrameThresholdMs', { min: 0.1 });
  options.viewport ??= '1280x720';
  parseViewport(options.viewport);
  options.api ??= 'auto';
  if (!['auto', 'webgpu', 'webgl', 'webgl2'].includes(options.api)) throw invalidOption('api must be auto, webgpu, webgl, or webgl2.');
  options.contextMode ??= 'isolated';
  if (!['isolated', 'shared'].includes(options.contextMode)) throw invalidOption('contextMode must be isolated or shared.');
  options.waitUntil ??= 'networkidle';
  if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(options.waitUntil)) throw invalidOption('waitUntil must be load, domcontentloaded, networkidle, or commit.');
  if (options.chromiumArgs != null && (!Array.isArray(options.chromiumArgs) || options.chromiumArgs.some(arg => typeof arg !== 'string'))) throw invalidOption('chromiumArgs must be an array of strings.');
  if (options.rawTracePath || options.minimalTrace) options.trace = true;
  return options;
}
