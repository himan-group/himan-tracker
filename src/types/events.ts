export type AgentName = "codex" | "claude-code";

export type EventStatus = "success" | "failure" | "cancelled" | "unknown";

export type CapabilityType =
  | "skill"
  | "mcp_tool"
  | "plugin"
  | "builtin_tool"
  | "shell_command"
  | "unknown";

export type AttributionConfidence = "exact" | "estimated" | "unknown";

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
