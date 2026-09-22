/** Measurement validity is separate from the workload's performance verdict. */
export function reportValidity(report) {
  const issues = [];
  const add = (code, message, details = {}) => issues.push({ code, message, ...details });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    add("invalid-report", "Expected a profiling report object.");
    return { valid: false, issues };
  }
  // Aggregates preserve each round's validity; their empty samples are intentional.
  if (Array.isArray(report.roundValidity)) {
    report.roundValidity.forEach((validity, round) => {
      if (!validity.valid) add("invalid-round", `Round ${round + 1} has invalid measurements.`, { round, issues: validity.issues });
    });
    if (!report.roundValidity.length) add("no-samples", "No profiling rounds were captured.");
    return { valid: issues.length === 0, issues };
  }

  const inPage = report.inPage || {};
  const samples = inPage.samples || [];
  const diagnostics = report.diagnostics || {};
  const sampleErrors = samples.filter(sample => sample.error).length || diagnostics.sampleErrors?.length || 0;
  if (sampleErrors) add("sample-errors", `${sampleErrors} benchmark sample(s) failed.`, { count: sampleErrors });
  const pageErrors = (report.pageEvents || diagnostics.pageErrors || []).filter(event => event.type === "pageerror").length;
  if (pageErrors) add("runtime-errors", `${pageErrors} uncaught page error(s) occurred.`, { count: pageErrors });
  // Network errors remain warnings: optional telemetry requests need not invalidate rendering.
  const adaptiveComplete = report.options?.adaptive === true && inPage.sampling?.stoppedEarly === true
    && inPage.sampling.reason === "fps-converged" && samples.length >= 3 && samples.length < report.options.samples
    && Number.isFinite(inPage.sampling.coefficientOfVariation) && inPage.sampling.coefficientOfVariation >= 0
    && inPage.sampling.coefficientOfVariation < 0.015;
  if (Number.isInteger(report.options?.samples) && samples.length !== report.options.samples && !adaptiveComplete) {
    add("incomplete-samples", `Expected ${report.options.samples} samples; captured ${samples.length}.`);
  }
  const hasSignal = samples.some(sample => !sample.error && hasNumericMeasurement(sample.measurement))
    || Number.isFinite(inPage.summary?.fps?.mean)
    || Number.isFinite(inPage.summary?.frameTimeMsMean?.mean)
    || Object.values(report.aggregateMetrics || {}).some(Number.isFinite);
  if (!hasSignal) add("no-measurements", "No numeric workload or frame measurements were captured.");
  if (report.options?.waitForHook && inPage.hook?.found === false) add("missing-hook", "The requested benchmark hook was not found.");

  const api = report.options?.api === "webgl" && !inPage.apiSupport?.webgl ? "webgl2" : report.options?.api;
  const support = inPage.apiSupport?.[api];
  if (support?.available === false || support?.error) add("api-unavailable", `The requested ${api} API is unavailable.`);
  if (report.options?.autoInstrument && (inPage.instrumentation?.after === null || diagnostics.instrumentation?.enabled === false)) {
    add("missing-instrumentation", "Requested allocation and draw instrumentation is unavailable.");
  }
  const instrumentationErrors = inPage.instrumentation?.after?.errors || diagnostics.instrumentation?.errors || [];
  if (instrumentationErrors.length) add("instrumentation-errors", `${instrumentationErrors.length} instrumentation error(s) occurred.`);
  if (report.options?.trace && (report.trace?.captured === false || report.trace?.error)) add("trace-failed", "Requested Chrome trace was not captured successfully.");
  return { valid: issues.length === 0, issues };
}

function hasNumericMeasurement(value, depth = 0) {
  if (Number.isFinite(value)) return true;
  if (!value || typeof value !== "object" || depth > 8) return false;
  // A zero-frame observer still contains numeric metadata, but no performance evidence.
  if (value.type === "raf") return value.frameCount >= 2;
  return Object.entries(value).some(([key, item]) => !["observedFrames", "frameCount", "slowFrameCount", "durationMs"].includes(key)
    ? hasNumericMeasurement(item, depth + 1)
    : key === "observedFrames" && item?.frameCount >= 2);
}
