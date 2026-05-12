import { parseSinceRange } from "../../reports/dateRange.js";
import { renderUnusedReport } from "../../reports/unusedReport.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type UnusedCommandOptions = ReportCommandBaseOptions & {
  since?: string;
  now?: () => Date;
};

export async function runUnused(options: UnusedCommandOptions = {}): Promise<ReportCommandResult> {
  try {
    const range = parseSinceRange(options.since ?? "30d", (options.now ?? (() => new Date()))());
    const lines = await withReportContext(options.paths, ({ db, config }) =>
      renderUnusedReport(db, range, config.known_capabilities),
    );

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("unused", error);
  }
}
