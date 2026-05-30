import { parseSinceRange } from "../../reports/dateRange.js";
import {
  parseCapabilityEventLimit,
  renderCapabilityEventReport,
} from "../../reports/capabilityEventReport.js";
import type { AgentName, CapabilityType } from "../../types/events.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type CapabilityEventsCommandOptions = ReportCommandBaseOptions & {
  since?: string;
  type?: string;
  name?: string;
  agent?: string;
  limit?: string | number;
  now?: () => Date;
};

export async function runCapabilityEvents(
  options: CapabilityEventsCommandOptions = {},
): Promise<ReportCommandResult> {
  try {
    const range = parseSinceRange(options.since ?? "30d", (options.now ?? (() => new Date()))());
    const type = parseRequiredCapabilityType(options.type);
    const name = parseRequiredCapabilityName(options.name);
    const agent = parseAgent(options.agent);
    const limit = parseCapabilityEventLimit(options.limit);
    const lines = await withReportContext(options.paths, ({ db }) =>
      renderCapabilityEventReport(db, range, { agent, type, name, limit }),
    );

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("capability-events", error);
  }
}

function parseAgent(agent: string | undefined): AgentName | undefined {
  if (agent === undefined) {
    return undefined;
  }

  if (agent === "codex" || agent === "claude-code" || agent === "copilot") {
    return agent;
  }

  throw new Error("Expected --agent to be codex, claude-code, or copilot");
}

function parseRequiredCapabilityType(type: string | undefined): CapabilityType {
  if (type === undefined) {
    throw new Error(
      "Expected --type to be skill, mcp_tool, plugin, builtin_tool, shell_command, or unknown",
    );
  }

  if (
    type === "skill" ||
    type === "mcp_tool" ||
    type === "plugin" ||
    type === "builtin_tool" ||
    type === "shell_command" ||
    type === "unknown"
  ) {
    return type;
  }

  throw new Error(
    "Expected --type to be skill, mcp_tool, plugin, builtin_tool, shell_command, or unknown",
  );
}

function parseRequiredCapabilityName(name: string | undefined): string {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    throw new Error("Expected --name to specify a capability name");
  }

  return trimmedName;
}
