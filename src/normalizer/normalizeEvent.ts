import { createHash } from "node:crypto";

import type {
  AdapterCapabilityUsageEvent,
  AdapterEvent,
  CapabilityAttributionBasis,
  CapabilityAttributionContextSource,
  CapabilityUsageEvent,
  NormalizedEvent,
  TokenUsage,
} from "../types/events.js";
import type { UserConfig } from "../types/config.js";
import { classifyCapability } from "./capabilityClassifier.js";
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
      const classifiedCapability = classifyCapability(event);
      const attribution = resolveCapabilityAttribution(event, classifiedCapability.type);
      normalizedEvent = {
        ...base,
        event_type: "capability_usage",
        capability_type: classifiedCapability.type,
        capability_name: normalizeCapabilityName(
          classifiedCapability.name,
          classifiedCapability.type,
          config,
        ),
        duration_ms: event.duration_ms ?? null,
        adopted: event.adopted ?? "unknown",
        attribution_confidence: event.attribution_confidence ?? "unknown",
        invocation_origin: event.invocation_origin ?? "unknown",
        ...attribution,
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

  normalizedEvent.event_id = createEventId(normalizedEvent, event.identity_key ?? undefined);
  return validateNormalizedEvent(normalizedEvent);
}

export function normalizeTokenUsage(tokenUsage: Partial<TokenUsage>): TokenUsage {
  const inputTokens = tokenUsage.input_tokens ?? null;
  const cachedInputTokens = tokenUsage.cached_input_tokens ?? null;
  const outputTokens = tokenUsage.output_tokens ?? null;
  const totalTokens =
    tokenUsage.total_tokens ??
    (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

export function createEventId(
  event: Omit<NormalizedEvent, "event_id">,
  identityKey?: string,
): string {
  const parts = identityKey
    ? [event.schema_version, event.event_type, event.agent, event.session_id, identityKey]
    : [
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

function normalizeCapabilityName(
  capabilityName: string,
  capabilityType: AdapterCapabilityUsageEvent["capability_type"],
  config: UserConfig,
): string {
  if (capabilityType !== "shell_command") {
    return capabilityName;
  }

  const trimmedName = capabilityName.trim();
  if (trimmedName.length === 0 || config.privacy.capture_shell_args) {
    return trimmedName;
  }

  return trimmedName.split(/\s+/, 1)[0] ?? trimmedName;
}

type NormalizedCapabilityAttribution = {
  basis: CapabilityAttributionBasis;
  score: number | null;
  reason: string | null;
  contextSource: CapabilityAttributionContextSource;
};

type ResolvedCapabilityAttribution = {
  attribution_basis?: CapabilityAttributionBasis;
  attribution_score?: number | null;
  attribution_reason?: string | null;
  attribution_context_source?: CapabilityAttributionContextSource;
};

function resolveCapabilityAttribution(
  event: AdapterCapabilityUsageEvent,
  classifiedType: CapabilityUsageEvent["capability_type"],
): ResolvedCapabilityAttribution {
  if (
    event.attribution_basis === undefined &&
    event.attribution_score === undefined &&
    event.attribution_reason === undefined &&
    event.attribution_context_source === undefined
  ) {
    return {};
  }

  const normalized = normalizeCapabilityAttribution(event, classifiedType);
  return {
    attribution_basis: normalized.basis,
    attribution_score: normalized.score,
    attribution_reason: normalized.reason,
    attribution_context_source: normalized.contextSource,
  };
}

function normalizeCapabilityAttribution(
  event: AdapterCapabilityUsageEvent,
  classifiedType: CapabilityUsageEvent["capability_type"],
): NormalizedCapabilityAttribution {
  const basis = normalizeAttributionBasis(event.attribution_basis, classifiedType);
  const score = normalizeAttributionScore(event.attribution_score, event, basis);
  const reason = normalizeAttributionReason(event.attribution_reason);
  const contextSource = normalizeAttributionContextSource(event.attribution_context_source);

  return { basis, score, reason, contextSource };
}

function normalizeAttributionBasis(
  basis: AdapterCapabilityUsageEvent["attribution_basis"],
  classifiedType: CapabilityUsageEvent["capability_type"],
): CapabilityAttributionBasis {
  if (basis) {
    return basis;
  }

  if (classifiedType === "builtin_tool") {
    return "classifier_builtin";
  }
  if (classifiedType === "shell_command") {
    return "classifier_shell";
  }
  return "fallback_unknown";
}

function normalizeAttributionScore(
  score: AdapterCapabilityUsageEvent["attribution_score"],
  event: AdapterCapabilityUsageEvent,
  basis: CapabilityAttributionBasis,
): number | null {
  if (typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100) {
    return score;
  }

  if (event.attribution_confidence === "exact") {
    return 100;
  }
  if (basis === "classifier_builtin") {
    return 55;
  }
  if (basis === "classifier_shell") {
    return 50;
  }
  if (event.attribution_confidence === "estimated") {
    return 60;
  }
  if (event.attribution_confidence === "unknown") {
    return 0;
  }

  return null;
}

function normalizeAttributionReason(
  reason: AdapterCapabilityUsageEvent["attribution_reason"],
): string | null {
  if (!reason) {
    return null;
  }

  const sanitized = reason.replace(/\s+/g, " ").trim();
  if (sanitized.length === 0) {
    return null;
  }

  return sanitized.slice(0, 240);
}

function normalizeAttributionContextSource(
  source: AdapterCapabilityUsageEvent["attribution_context_source"],
): CapabilityAttributionContextSource {
  return source ?? "none";
}
