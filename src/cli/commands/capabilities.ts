import { parseSinceRange } from "../../reports/dateRange.js";
import {
  parseCapabilitySort,
  renderCapabilityReport,
  type CapabilitySort,
} from "../../reports/capabilityReport.js";
import type { AgentName, CapabilityType } from "../../types/events.js";
import {
  formatCommandError,
  withReportContext,
  type ReportCommandBaseOptions,
  type ReportCommandResult,
} from "./reportContext.js";

export type CapabilitiesCommandOptions = ReportCommandBaseOptions & {
  since?: string;
  sort?: string;
  type?: string;
  agent?: string;
  excludeSystem?: boolean;
  now?: () => Date;
};

export async function runCapabilities(
  options: CapabilitiesCommandOptions = {},
): Promise<ReportCommandResult> {
  try {
    const range = parseSinceRange(options.since ?? "30d", (options.now ?? (() => new Date()))());
    const sort = parseCapabilitySort(options.sort ?? "tokens");
    const agent = parseAgent(options.agent);
    const type = parseCapabilityType(options.type);
    const lines = await withReportContext(options.paths, ({ db }) =>
      renderCapabilityReport(db, range, {
        sort: sort as CapabilitySort,
        agent,
        type,
        excludeSystem: options.excludeSystem ?? false,
      }),
    );

    return { ok: true, lines };
  } catch (error) {
    return formatCommandError("capabilities", error);
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

function parseCapabilityType(type: string | undefined): CapabilityType | undefined {
  if (type === undefined) {
    return undefined;
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
