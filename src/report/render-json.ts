import { canonicalJson } from "../experiment/index.js";
import type { ExperimentReport } from "./schema.js";

export function serializeExperimentReportJson(report: ExperimentReport): string {
  return `${canonicalJson(report)}\n`;
}
