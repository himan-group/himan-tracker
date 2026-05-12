import { parseDate, todayLocalDate } from "../../reports/dateRange.js";
import { renderAgentReport } from "../../reports/agentReport.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type AgentsCommandOptions = ReportCommandBaseOptions & {
  date?: string;
  now?: () => Date;
};

export async function runAgents(options: AgentsCommandOptions = {}): Promise<ReportCommandResult> {
  try {
    const date = options.date
      ? parseDate(options.date)
      : todayLocalDate((options.now ?? (() => new Date()))());
    const lines = await withReportContext(options.paths, ({ db }) => renderAgentReport(db, date));

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("agents", error);
  }
}
