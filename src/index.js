export {
  compareReports,
  comparisonStatus,
  DECISION_METRICS,
  formatCompareTable,
  loadReport,
  reportMetrics,
  rowScreen,
  selectPrimaryMetric,
  validateBudget,
  workEquivalence
} from "./compare.js";
export { reportValidity } from "./validity.js";
export {
  analyzeReport,
  classifyBottleneck,
  finalizeReport,
  heapSummary
} from "./analysis.js";
export { aggregateReports, alternatingOrder, runABComparison } from "./ab-runner.js";
export {
  closeAllHarnesses,
  FastCDPHarness,
  runFastReport,
  runFastReports,
  runFastReport as runReport,
  TOOL
} from "./fast-cdp-runner.js";
export { acquireMeasurementLock, measurementLockPath } from "./measure-lock.js";
export { startCpuProfile, stopCpuProfile, summarizeCpuProfile } from "./cpu-profile.js";
export {
  connectOrStartDaemon,
  daemonDisabled,
  daemonKey,
  pruneDirectory,
  runViaDaemon
} from "./daemon.js";
export { runReport as runPlaywrightReport } from "./runner.js";
export { startReportServer } from "./report-server.js";
export { macOSProfilerStatus, recordMacOSXctrace } from "./native/macos-xctrace.js";
export { autoInstrumentationSource, installAutoInstrumentation } from "./browser/auto-instrument.js";
export {
  applyOptionPrecedence,
  BASE_INHERITED_OPTION_KEYS,
  normalizeOptions,
  PROFILING_PRESETS
} from "./options.js";
export {
  compactComparison,
  compactReport,
  comparisonExitCode,
  formatAgentComparison,
  formatAgentReport,
  formatCaptureAndCompare,
  formatCliError
} from "./output.js";
export { inspectReport, validateInspectOptions } from "./inspect.js";

export { buildFindings, summarizeReport, formatDiagnostics, verdictFromFindings } from "./diagnostics.js";
export { generateHtmlReport } from "./html-report.js";
export { generateAgentDigest, generateAgentCompareDigest, getMcpToolDefinitions, runMcpServer } from "./agent.js";
