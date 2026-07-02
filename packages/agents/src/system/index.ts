/**
 * System agents — importing this module registers every system agent into
 * the singleton registry as a side effect of import.
 *
 * apps/api/src/bootstrap.ts imports this once at boot.
 */

import "./test-agent";
import "./report-agent";

export {
  ReportAgent,
  extractHtmlDocument,
  substituteCharts,
  type ReportInput,
  type ReportOutput,
  type ReportChart,
} from "./report-agent";
