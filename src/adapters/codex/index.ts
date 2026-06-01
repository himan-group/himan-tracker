import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type ParseCodexHookPayloadOptions = {
  observedAt?: string;
};

export function parseCodexHookPayload(
  payload: unknown,
  options: ParseCodexHookPayloadOptions = {},
): AdapterEvent[] {
  return getRawEvents(payload).flatMap((event) => parseCodexEvent(event, options));
}

function parseCodexEvent(event: RawRecord, options: ParseCodexHookPayloadOptions): AdapterEvent[] {
  const hook =
    getString(event.hook) ?? getString(event.hook_event_name) ?? getString(event.type);

  switch (hook) {
    case "UserPromptSubmit":
      return parsePromptSubmit(event, options);
    case "PostToolUse":
      return parsePostToolUse(event, options);
    case "Stop":
      return parseStop(event, options);
    default:
      return [];
  }
}

function parsePromptSubmit(
  event: RawRecord,
  options: ParseCodexHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  if (!base) {
    return [];
  }

  const skills = new Set([
    ...getStringArray(event.skills),
    ...extractExplicitSkillNames(getString(event.prompt)),
  ]);

  return [...skills].map((skill) => {
    const identityKey = createObservedHookIdentity(event, "UserPromptSubmit", `skill:${skill}`);
    return {
      ...base,
      ...(identityKey ? { identity_key: identityKey } : {}),
      event_type: "capability_usage",
      capability_type: "skill",
      capability_name: skill,
      attribution_confidence: "exact",
      invocation_origin: "explicit",
      attribution_basis: "prompt_explicit_skill",
      attribution_score: 100,
      attribution_reason: "Skill name explicitly referenced in prompt.",
      attribution_context_source: "transcript_only",
    };
  });
}

function parsePostToolUse(
  event: RawRecord,
  options: ParseCodexHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  const capabilityName =
    getString(event.tool_name) ?? getString(getRecord(event.tool)?.name) ?? getString(event.name);

  if (!base || !capabilityName) {
    return [];
  }

  const toolUseId = getToolUseId(event);

  const identityKey = toolUseId
    ? createObservedHookIdentity(event, "PostToolUse", `tool:${toolUseId}:${capabilityName}`)
    : null;

  return [
    {
      ...base,
      ...(identityKey ? { identity_key: identityKey } : {}),
      event_type: "capability_usage",
      capability_name: capabilityName,
      duration_ms: getNumber(event.duration_ms),
      status: getStatus(event.status),
      attribution_confidence: "unknown",
      invocation_origin: "observed",
      attribution_basis: "transcript_tool_name",
      attribution_score: 40,
      attribution_reason: "Tool call name observed from hook event.",
      attribution_context_source: "none",
    },
  ];
}

function parseStop(event: RawRecord, options: ParseCodexHookPayloadOptions): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  if (!base) {
    return [];
  }

  const turnIdentityKey = createObservedHookIdentity(event, "Stop", `turn:${base.turn_id ?? ""}`);
  const events: AdapterEvent[] = [
    {
      ...base,
      ...(turnIdentityKey ? { identity_key: turnIdentityKey } : {}),
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
    const sessionIdentityKey = createObservedHookIdentity(
      event,
      "Stop",
      `session:${base.turn_id ?? ""}`,
    );
    events.push({
      ...base,
      ...(sessionIdentityKey ? { identity_key: sessionIdentityKey } : {}),
      event_type: "session_summary",
      turn_id: null,
      turn_count: getNumber(session.turn_count),
      duration_ms: getNumber(session.duration_ms),
      status: getStatus(session.status),
    });
  }

  return events;
}

function createBaseEvent(
  event: RawRecord,
  options: ParseCodexHookPayloadOptions,
): Omit<AdapterEvent, "event_type"> | null {
  const occurredAt = getString(event.occurred_at) ?? options.observedAt;
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
    repo_path: getString(event.repo_path) ?? getString(event.cwd),
    status: getStatus(event.status),
  };
}

function createObservedHookIdentity(
  event: RawRecord,
  hook: string,
  detail: string,
): string | null {
  if (getString(event.occurred_at)) {
    return null;
  }

  return `codex:${hook}:${getString(event.turn_id) ?? ""}:${detail}`;
}

function getToolUseId(event: RawRecord): string | undefined {
  return (
    getString(event.tool_use_id) ??
    getString(event.tool_call_id) ??
    getString(event.call_id) ??
    getString(event.id)
  );
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

function extractExplicitSkillNames(prompt: string | undefined): string[] {
  if (!prompt) {
    return [];
  }

  const skills = new Set<string>();
  const skillPattern = /(?:^|[\s([`"'，。！？；：])\$([a-z][a-z0-9]*(?:[-:][a-z0-9]+)+)\b/g;
  let match: RegExpExecArray | null;

  while ((match = skillPattern.exec(prompt)) !== null) {
    const skillName = match[1];
    if (skillName) {
      skills.add(skillName);
    }
  }

  return [...skills];
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
