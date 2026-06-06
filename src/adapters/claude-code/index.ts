import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type ParseClaudeCodeHookPayloadOptions = {
  observedAt?: string;
};

export function parseClaudeCodeHookPayload(
  payload: unknown,
  options: ParseClaudeCodeHookPayloadOptions = {},
): AdapterEvent[] {
  return getRawEvents(payload).flatMap((event) => parseClaudeCodeEvent(event, options));
}

function parseClaudeCodeEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const hookEventName = getString(event.hook_event_name);

  switch (hookEventName) {
    case "PreToolUse":
      return parseToolEvent(event, options);
    case "PostToolUse":
      return parseToolEvent(event, options);
    case "PostToolUseFailure":
      return parseToolFailureEvent(event, options);
    case "Stop":
      return parseStop(event, options);
    case "SessionEnd":
      return parseSessionEnd(event, options);
    default:
      return [];
  }
}

function parseToolEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  const toolName = getToolName(event);

  if (!base || !toolName) {
    return [];
  }

  const toolUseId = getString(event.tool_use_id);
  const toolResponse = getRecord(event.tool_response);
  const status = toolResponse ? resolveToolResponseStatus(toolResponse) : undefined;

  return [
    {
      ...base,
      event_type: "capability_usage",
      capability_name: toolName,
      duration_ms: getNumber(event.duration_ms),
      status,
      attribution_confidence: "unknown",
      invocation_origin: "observed",
      attribution_basis: "transcript_tool_name",
      attribution_score: 40,
      attribution_reason: "Tool call observed from Claude Code hook event.",
      attribution_context_source: "none",
      ...(toolUseId ? { turn_id: toolUseId } : {}),
    },
  ];
}

function parseToolFailureEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  const toolName = getToolName(event);

  if (!base || !toolName) {
    return [];
  }

  const toolUseId = getString(event.tool_use_id);

  return [
    {
      ...base,
      event_type: "capability_usage",
      capability_name: toolName,
      status: "failure",
      attribution_confidence: "unknown",
      invocation_origin: "observed",
      attribution_basis: "transcript_tool_name",
      attribution_score: 40,
      attribution_reason: "Failed tool call observed from Claude Code hook event.",
      attribution_context_source: "none",
      ...(toolUseId ? { turn_id: toolUseId } : {}),
    },
  ];
}

function parseStop(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  if (!base) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "turn_summary",
      model: getString(event.model),
      duration_ms: getNumber(event.duration_ms),
      // Claude Code hooks do not provide token usage in the Stop payload.
      // Token data must come from transcript backfill.
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      status: "success",
    },
  ];
}

function parseSessionEnd(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  if (!base) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "session_summary",
      turn_id: null,
      turn_count: null,
      duration_ms: getNumber(event.duration_ms),
      status: "success",
    },
  ];
}

function createBaseEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): Omit<AdapterEvent, "event_type"> | null {
  const occurredAt = options.observedAt;
  const sessionId = getString(event.session_id);

  if (!occurredAt || !sessionId) {
    return null;
  }

  return {
    occurred_at: occurredAt,
    agent: "claude-code",
    source: "claude-code-hook",
    session_id: sessionId,
    turn_id: getString(event.tool_use_id) ?? null,
    repo_path: getString(event.cwd),
    status: "unknown",
  };
}

function getToolName(event: RawRecord): string | undefined {
  return getString(event.tool_name) ?? getString(getRecord(event.tool)?.name);
}

function resolveToolResponseStatus(
  toolResponse: RawRecord,
): EventStatus | undefined {
  if ("success" in toolResponse) {
    return toolResponse.success === true
      ? "success"
      : toolResponse.success === false
        ? "failure"
        : undefined;
  }

  if (getString(toolResponse.status) === "failure") {
    return "failure";
  }

  return undefined;
}

function getRawEvents(payload: unknown): RawRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const events = payload.events;
  return Array.isArray(events) ? events.filter(isRecord) : [payload];
}

function getRecord(value: unknown): RawRecord | null {
  return isRecord(value) ? value : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
