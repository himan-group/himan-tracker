import { createHash } from "node:crypto";

import type {
  AdapterCapabilityUsageEvent,
  AdapterEvent,
  NormalizedEvent,
  TokenUsage,
} from "../types/events.js";
import type { UserConfig } from "../types/config.js";
import { validateNormalizedEvent } from "./eventSchema.js";
import { hashRepoPath } from "./privacy.js";

export function normalizeEvent(event: AdapterEvent, config: UserConfig): NormalizedEvent {
  const repoHash = resolveRepoHash(event, config);
  const base = {
    schema_version: "1.0" as const,
    event_id: "",
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    agent: event.agent,
    source: event.source,
    session_id: event.session_id,
    turn_id: event.turn_id ?? null,
    repo_hash: repoHash,
    status: event.status ?? "unknown",
  };

  let normalizedEvent: NormalizedEvent;

  switch (event.event_type) {
    case "turn_summary":
      normalizedEvent = {
        ...base,
        event_type: "turn_summary",
        model: event.model ?? null,
        duration_ms: event.duration_ms ?? null,
        ...normalizeTokenUsage(event),
      };
      break;
    case "capability_usage":
      normalizedEvent = {
        ...base,
        event_type: "capability_usage",
        capability_type: event.capability_type,
        capability_name: normalizeCapabilityName(event, config),
        duration_ms: event.duration_ms ?? null,
        adopted: event.adopted ?? "unknown",
        attribution_confidence: event.attribution_confidence ?? "unknown",
        ...normalizeTokenUsage(event),
      };
      break;
    case "session_summary":
      normalizedEvent = {
        ...base,
        event_type: "session_summary",
        turn_count: event.turn_count ?? null,
        duration_ms: event.duration_ms ?? null,
      };
      break;
  }

  normalizedEvent.event_id = createEventId(normalizedEvent);
  return validateNormalizedEvent(normalizedEvent);
}

export function normalizeTokenUsage(tokenUsage: Partial<TokenUsage>): TokenUsage {
  const inputTokens = tokenUsage.input_tokens ?? null;
  const outputTokens = tokenUsage.output_tokens ?? null;
  const totalTokens =
    tokenUsage.total_tokens ??
    (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

export function createEventId(event: Omit<NormalizedEvent, "event_id">): string {
  const parts = [
    event.schema_version,
    event.event_type,
    event.agent,
    event.session_id,
    event.turn_id ?? "",
    event.occurred_at,
    "capability_type" in event ? event.capability_type : "",
    "capability_name" in event ? event.capability_name : "",
  ];

  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function resolveRepoHash(event: AdapterEvent, config: UserConfig): string | null {
  if (event.repo_hash) {
    return event.repo_hash;
  }

  if (!event.repo_path || !config.privacy.hash_repo_path) {
    return null;
  }

  return hashRepoPath(event.repo_path, config.local_salt);
}

function normalizeCapabilityName(event: AdapterCapabilityUsageEvent, config: UserConfig): string {
  if (event.capability_type !== "shell_command") {
    return event.capability_name;
  }

  const trimmedName = event.capability_name.trim();
  if (trimmedName.length === 0 || config.privacy.capture_shell_args) {
    return trimmedName;
  }

  return trimmedName.split(/\s+/, 1)[0] ?? trimmedName;
}
