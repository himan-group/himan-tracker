import { parseSinceRange } from "../../reports/dateRange.js";
import { parseTokenPeriod, renderTokenReport } from "../../reports/tokenReport.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type TokensCommandOptions = ReportCommandBaseOptions & {
  since?: string;
  period?: string;
  now?: () => Date;
};

export async function runTokens(options: TokensCommandOptions = {}): Promise<ReportCommandResult> {
  try {
    const range = parseSinceRange(options.since ?? "30d", (options.now ?? (() => new Date()))());
    const period = parseTokenPeriod(options.period);
    const lines = await withReportContext(options.paths, ({ db }) =>
      renderTokenReport(db, range, period),
    );

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("tokens", error);
  }
}
