import { parseSinceRange } from "../../reports/dateRange.js";
import { renderSummaryReport } from "../../reports/summaryReport.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type SummaryCommandOptions = ReportCommandBaseOptions & {
  since?: string;
  now?: () => Date;
};

export async function runSummary(
  options: SummaryCommandOptions = {},
): Promise<ReportCommandResult> {
  try {
    const range = parseSinceRange(options.since ?? "7d", (options.now ?? (() => new Date()))());
    const lines = await withReportContext(options.paths, ({ db }) => renderSummaryReport(db, range));

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("summary", error);
  }
}
