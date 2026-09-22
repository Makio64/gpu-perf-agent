export { compareReports, formatCompareTable, loadReport, reportMetrics, validateBudget } from "./compare.js";
export { reportValidity } from "./validity.js";
export { analyzeReport, finalizeReport } from "./analysis.js";
export { aggregateReports, alternatingOrder, runABComparison } from "./ab-runner.js";
export { FastCDPHarness, runFastReport, runFastReports, runFastReport as runReport } from "./fast-cdp-runner.js";
export { runReport as runPlaywrightReport } from "./runner.js";
export { startReportServer } from "./report-server.js";
export { macOSProfilerStatus, recordMacOSXctrace } from "./native/macos-xctrace.js";
export { autoInstrumentationSource, installAutoInstrumentation } from "./browser/auto-instrument.js";
export { normalizeOptions, PROFILING_PRESETS } from "./options.js";
export { compactReport, comparisonExitCode, formatAgentReport, formatAgentComparison } from "./output.js";

export { summarizeReport, formatDiagnostics } from "./diagnostics.js";
export { generateHtmlReport } from "./html-report.js";
export { generateAgentDigest, generateAgentCompareDigest, getMcpToolDefinitions, runMcpServer } from "./agent.js";
