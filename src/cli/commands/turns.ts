import { parseSinceRange } from "../../reports/dateRange.js";
import { parseTurnLimit, renderTurnReport } from "../../reports/turnReport.js";
import type { AgentName } from "../../types/events.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type TurnsCommandOptions = ReportCommandBaseOptions & {
  since?: string;
  agent?: string;
  limit?: string | number;
  now?: () => Date;
};

export async function runTurns(options: TurnsCommandOptions = {}): Promise<ReportCommandResult> {
  try {
    const range = parseSinceRange(options.since ?? "7d", (options.now ?? (() => new Date()))());
    const agent = parseAgent(options.agent);
    const limit = parseTurnLimit(options.limit);
    const lines = await withReportContext(options.paths, ({ db }) =>
      renderTurnReport(db, range, { agent, limit }),
    );

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("turns", error);
  }
}

function parseAgent(agent: string | undefined): AgentName | undefined {
  if (agent === undefined) {
    return undefined;
  }

  if (agent === "codex" || agent === "claude-code") {
    return agent;
  }

  throw new Error("Expected --agent to be codex or claude-code");
}
