export type AgentName = "codex" | "claude-code" | "copilot";

export type EventStatus = "success" | "failure" | "cancelled" | "unknown";

export type CapabilityType =
  | "skill"
  | "mcp_tool"
  | "plugin"
  | "builtin_tool"
  | "shell_command"
  | "unknown";

export type AttributionConfidence = "exact" | "estimated" | "unknown";

export type CapabilityInvocationOrigin = "explicit" | "inferred" | "observed" | "unknown";

export type CapabilityAttributionBasis =
  | "prompt_explicit_skill"
  | "transcript_mcp_tool_end"
  | "transcript_tool_name"
  | "transcript_shell_skill_path"
  | "himan_lock_match"
  | "himan_manifest_match"
  | "himan_dependency_match"
  | "classifier_builtin"
  | "classifier_shell"
  | "fallback_unknown"
  | "unknown";

export type CapabilityAttributionContextSource =
  | "himan_install_manifest"
  | "himan_lock"
  | "himan_metadata"
  | "transcript_only"
  | "none";

export type NormalizedEventBase = {
  schema_version: "1.0";
  event_id: string;
  event_type: "turn_summary" | "capability_usage" | "session_summary";
  occurred_at: string;
  agent: AgentName;
  source: string;
  session_id: string;
  turn_id?: string | null;
  repo_hash?: string | null;
  status: EventStatus;
};

export type TokenUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

export type TurnSummaryEvent = NormalizedEventBase &
  TokenUsage & {
    event_type: "turn_summary";
    model?: string | null;
    duration_ms: number | null;
  };

export type CapabilityUsageEvent = NormalizedEventBase &
  TokenUsage & {
    event_type: "capability_usage";
    capability_type: CapabilityType;
    capability_name: string;
    duration_ms: number | null;
    adopted: "yes" | "no" | "unknown";
    attribution_confidence: AttributionConfidence;
    invocation_origin: CapabilityInvocationOrigin;
    attribution_basis?: CapabilityAttributionBasis;
    attribution_score?: number | null;
    attribution_reason?: string | null;
    attribution_context_source?: CapabilityAttributionContextSource;
  };

export type SessionSummaryEvent = NormalizedEventBase & {
  event_type: "session_summary";
  turn_count: number | null;
  duration_ms: number | null;
};

export type NormalizedEvent =
  | TurnSummaryEvent
  | CapabilityUsageEvent
  | SessionSummaryEvent;

export type AdapterEventBase = {
  event_type: NormalizedEvent["event_type"];
  occurred_at: string;
  identity_key?: string | null;
  agent: AgentName;
  source: string;
  session_id: string;
  turn_id?: string | null;
  repo_path?: string | null;
  repo_hash?: string | null;
  status?: EventStatus;
};

export type AdapterTurnSummaryEvent = AdapterEventBase &
  Partial<TokenUsage> & {
    event_type: "turn_summary";
    model?: string | null;
    duration_ms?: number | null;
  };

export type AdapterCapabilityUsageEvent = AdapterEventBase &
  Partial<TokenUsage> & {
    event_type: "capability_usage";
    capability_type?: CapabilityType | null;
    capability_name: string;
    duration_ms?: number | null;
    adopted?: "yes" | "no" | "unknown";
    attribution_confidence?: AttributionConfidence;
    invocation_origin?: CapabilityInvocationOrigin;
    attribution_basis?: CapabilityAttributionBasis;
    attribution_score?: number | null;
    attribution_reason?: string | null;
    attribution_context_source?: CapabilityAttributionContextSource;
  };

export type AdapterSessionSummaryEvent = AdapterEventBase & {
  event_type: "session_summary";
  turn_count?: number | null;
  duration_ms?: number | null;
};

export type AdapterEvent =
  | AdapterTurnSummaryEvent
  | AdapterCapabilityUsageEvent
  | AdapterSessionSummaryEvent;
