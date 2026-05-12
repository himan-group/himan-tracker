import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export function parseCodexHookPayload(payload: unknown): AdapterEvent[] {
  return getRawEvents(payload).flatMap(parseCodexEvent);
}

function parseCodexEvent(event: RawRecord): AdapterEvent[] {
  const hook = getString(event.hook) ?? getString(event.type);

  switch (hook) {
    case "UserPromptSubmit":
      return parsePromptSubmit(event);
    case "PostToolUse":
      return parsePostToolUse(event);
    case "Stop":
      return parseStop(event);
    default:
      return [];
  }
}

function parsePromptSubmit(event: RawRecord): AdapterEvent[] {
  const base = createBaseEvent(event);
  if (!base) {
    return [];
  }

  return getStringArray(event.skills).map((skill) => ({
    ...base,
    event_type: "capability_usage",
    capability_type: "skill",
    capability_name: skill,
    attribution_confidence: "unknown",
  }));
}

function parsePostToolUse(event: RawRecord): AdapterEvent[] {
  const base = createBaseEvent(event);
  const capabilityName =
    getString(event.tool_name) ?? getString(getRecord(event.tool)?.name) ?? getString(event.name);

  if (!base || !capabilityName) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "capability_usage",
      capability_name: capabilityName,
      duration_ms: getNumber(event.duration_ms),
      status: getStatus(event.status),
      attribution_confidence: "unknown",
    },
  ];
}

function parseStop(event: RawRecord): AdapterEvent[] {
  const base = createBaseEvent(event);
  if (!base) {
    return [];
  }

  const events: AdapterEvent[] = [
    {
      ...base,
      event_type: "turn_summary",
      model: getString(event.model),
      duration_ms: getNumber(event.duration_ms),
      input_tokens: getNumber(event.input_tokens),
      output_tokens: getNumber(event.output_tokens),
      total_tokens: getNumber(event.total_tokens),
      status: getStatus(event.status),
    },
  ];
  const session = getRecord(event.session);

  if (session) {
    events.push({
      ...base,
      event_type: "session_summary",
      turn_id: null,
      turn_count: getNumber(session.turn_count),
      duration_ms: getNumber(session.duration_ms),
      status: getStatus(session.status),
    });
  }

  return events;
}

function createBaseEvent(event: RawRecord): Omit<AdapterEvent, "event_type"> | null {
  const occurredAt = getString(event.occurred_at);
  const sessionId = getString(event.session_id);

  if (!occurredAt || !sessionId) {
    return null;
  }

  return {
    occurred_at: occurredAt,
    agent: "codex",
    source: "codex-hook",
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

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStatus(value: unknown): EventStatus | undefined {
  return value === "success" || value === "failure" || value === "cancelled" || value === "unknown"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
