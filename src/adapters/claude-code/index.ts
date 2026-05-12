import type { AdapterEvent, CapabilityType, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export function parseClaudeCodeHookPayload(payload: unknown): AdapterEvent[] {
  return getRawEvents(payload).flatMap(parseClaudeCodeEvent);
}

function parseClaudeCodeEvent(event: RawRecord): AdapterEvent[] {
  const type = getString(event.type) ?? getString(event.hook);

  switch (type) {
    case "tool_result":
    case "tool_use":
      return parseToolEvent(event);
    case "message_stop":
      return parseMessageStop(event);
    case "session_end":
      return parseSessionEnd(event);
    default:
      return [];
  }
}

function parseToolEvent(event: RawRecord): AdapterEvent[] {
  const base = createBaseEvent(event);
  const tool = getRecord(event.tool);
  const capabilityName = getString(event.tool_name) ?? getString(tool?.name);

  if (!base || !capabilityName) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "capability_usage",
      capability_type: getCapabilityType(event.capability_type) ?? getCapabilityType(tool?.capability_type),
      capability_name: capabilityName,
      duration_ms: getNumber(event.duration_ms),
      input_tokens: getNumber(event.input_tokens),
      output_tokens: getNumber(event.output_tokens),
      total_tokens: getNumber(event.total_tokens),
      status: getStatus(event.status),
      adopted: getAdopted(event.adopted),
      attribution_confidence: getString(event.attribution_confidence) === "exact" ? "exact" : "unknown",
    },
  ];
}

function parseMessageStop(event: RawRecord): AdapterEvent[] {
  const base = createBaseEvent(event);
  const usage = getRecord(event.usage);

  if (!base) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "turn_summary",
      model: getString(event.model),
      duration_ms: getNumber(event.duration_ms),
      input_tokens: getNumber(usage?.input_tokens),
      output_tokens: getNumber(usage?.output_tokens),
      total_tokens: getNumber(usage?.total_tokens),
      status: getStatus(event.status),
    },
  ];
}

function parseSessionEnd(event: RawRecord): AdapterEvent[] {
  const base = createBaseEvent(event);
  if (!base) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "session_summary",
      turn_id: null,
      turn_count: getNumber(event.turn_count),
      duration_ms: getNumber(event.duration_ms),
      status: getStatus(event.status),
    },
  ];
}

function createBaseEvent(event: RawRecord): Omit<AdapterEvent, "event_type"> | null {
  const occurredAt = getString(event.occurred_at);
  const sessionId = getString(event.session_id);

  if (!occurredAt || !sessionId) {
    return null;
  }

  return {
    occurred_at: occurredAt,
    agent: "claude-code",
    source: "claude-code-hook",
    session_id: sessionId,
    turn_id: getString(event.turn_id),
    repo_path: getString(event.repo_path),
    status: getStatus(event.status),
  };
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

function getStatus(value: unknown): EventStatus | undefined {
  return value === "success" || value === "failure" || value === "cancelled" || value === "unknown"
    ? value
    : undefined;
}

function getCapabilityType(value: unknown): CapabilityType | undefined {
  return value === "skill" ||
    value === "mcp_tool" ||
    value === "plugin" ||
    value === "builtin_tool" ||
    value === "shell_command" ||
    value === "unknown"
    ? value
    : undefined;
}

function getAdopted(value: unknown): "yes" | "no" | "unknown" | undefined {
  return value === "yes" || value === "no" || value === "unknown" ? value : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
