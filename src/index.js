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
export {
  exportMacOSXctraceXpath,
  macOSProfilerStatus,
  parseXctraceTocXml,
  recordMacOSXctrace,
  summarizeMacOSXctrace
} from "./native/macos-xctrace.js";
export {
  formatAgxDigest,
  parseIoregAccelerator,
  sampleMacOSAgx,
  snapshotMacOSAgx,
  summarizeAgxSamples
} from "./native/macos-agx.js";
export {
  analyzeShader,
  analyzeShaderStatic,
  compareShaderAnalyses,
  detectShaderLanguage,
  extractAndAnalyzePageShaders,
  formatShaderComparisonDigest,
  formatShaderDigest,
  normalizeNagaMslBindings,
  parseMetalAirDisassembly
} from "./shader-analyzer.js";
export {
  analyzeAuditSnapshot,
  auditWebGPUPage,
  deepAuditInitSource,
  estimateTextureBytes,
  formatAuditDigest
} from "./deep-audit.js";
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
