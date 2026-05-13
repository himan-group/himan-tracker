import type { CapabilityType } from "../types/events.js";

export type ClassificationConfidence = "exact" | "estimated" | "unknown";

export type CapabilityClassificationInput = {
  capability_type?: CapabilityType | null;
  capability_name: string;
  source?: string | null;
};

export type ClassifiedCapability = {
  type: CapabilityType;
  name: string;
  confidence: ClassificationConfidence;
};

export const BUILTIN_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "LS",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
  "apply_patch",
  "image_gen.imagegen",
  "web.run",
  "functions.apply_patch",
  "functions.exec_command",
  "functions.update_plan",
] as const;

const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);

const SHELL_SOURCE_PATTERN = /\b(shell|exec|command|terminal)\b/i;

export function classifyCapability(input: CapabilityClassificationInput): ClassifiedCapability {
  const name = input.capability_name.trim();

  if (input.capability_type && input.capability_type !== "unknown") {
    return {
      type: input.capability_type,
      name,
      confidence: "exact",
    };
  }

  const mcpName = classifyMcpToolName(name);
  if (mcpName) {
    return {
      type: "mcp_tool",
      name: mcpName,
      confidence: "estimated",
    };
  }

  if (isShellCapability(input)) {
    return {
      type: "shell_command",
      name,
      confidence: "estimated",
    };
  }

  if (BUILTIN_TOOL_NAME_SET.has(name)) {
    return {
      type: "builtin_tool",
      name,
      confidence: "estimated",
    };
  }

  return {
    type: "unknown",
    name,
    confidence: "unknown",
  };
}

function classifyMcpToolName(name: string): string | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/.exec(name);
  if (!match) {
    return null;
  }

  const [, server, tool] = match;
  if (!server || !tool) {
    return null;
  }

  return `${server.replaceAll("_", "-")}.${tool}`;
}

function isShellCapability(input: CapabilityClassificationInput): boolean {
  if (SHELL_SOURCE_PATTERN.test(input.source ?? "")) {
    return true;
  }

  return input.capability_name === "shell_command";
}
