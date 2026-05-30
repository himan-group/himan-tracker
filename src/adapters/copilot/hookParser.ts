import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type ParseCopilotHookPayloadOptions = {
    observedAt?: string;
};

/**
 * Parse a Copilot hook JSON payload (single event or array) into AdapterEvents.
 *
 * Supports two payload formats:
 * - camelCase: event names like "sessionStart", fields like "sessionId"
 * - PascalCase / VS Code compatible: event names like "SessionStart", fields like "session_id"
 */
export function parseCopilotHookPayload(
    payload: unknown,
    options: ParseCopilotHookPayloadOptions = {},
): AdapterEvent[] {
    const rawEvents = getRawEvents(payload);
    if (rawEvents.length === 0) {
        return [];
    }

    return rawEvents.flatMap((event) => parseCopilotHookEvent(event, options));
}

function getRawEvents(payload: unknown): RawRecord[] {
    if (Array.isArray(payload)) {
        return payload.filter(isRecord);
    }

    // Single event: the hook payload itself is the event
    if (isRecord(payload)) {
        // Check if it's a wrapper with an "events" array (like the codex fixture format)
        if (Array.isArray(payload.events)) {
            return (payload.events as unknown[]).filter(isRecord);
        }
        return [payload];
    }

    return [];
}

function parseCopilotHookEvent(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const hook =
        getString(event.hook) ??
        getString(event.hook_event_name) ??
        getString(event.type);

    switch (hook) {
        case "SessionStart":
        case "sessionStart":
            return parseSessionStart(event, options);
        case "UserPromptSubmit":
        case "userPromptSubmitted":
            return parseUserPromptSubmit(event, options);
        case "PostToolUse":
        case "postToolUse":
            return parsePostToolUse(event, options);
        case "PostToolUseFailure":
        case "postToolUseFailure":
            return parsePostToolUseFailure(event, options);
        case "Stop":
        case "agentStop":
            return parseAgentStop(event, options);
        case "SessionEnd":
        case "sessionEnd":
            return parseSessionEnd(event, options);
        default:
            return [];
    }
}

// ── SessionStart → session_summary ──

function parseSessionStart(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    return [
        {
            ...base,
            event_type: "session_summary",
            turn_count: null,
            duration_ms: null,
            status: "success" as EventStatus,
        },
    ];
}

// ── UserPromptSubmit → turn context (capability_usage for prompt) ──

function parseUserPromptSubmit(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    // User prompt submission does not directly map to a capability usage,
    // but we record it as a lightweight observation for turn tracking.
    // The main turn data comes from agentStop.
    return [];
}

// ── PostToolUse → capability_usage ──

function parsePostToolUse(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    const toolName = getString(event.tool_name) ?? getString(event.toolName);
    if (!toolName) {
        return [];
    }

    const toolResult = getRecord(event.tool_result) ?? getRecord(event.toolResult);
    const resultType = getString(toolResult?.result_type) ?? getString(toolResult?.resultType);
    const status: EventStatus = resultType === "success" ? "success" : "unknown";

    const durationMs = getNumber(event.duration_ms) ?? getNumber(event.durationMs) ?? null;

    return [
        {
            ...base,
            event_type: "capability_usage",
            capability_type: "builtin_tool",
            capability_name: toolName,
            duration_ms: durationMs,
            adopted: "unknown",
            attribution_confidence: "exact",
            invocation_origin: "observed",
            status,
        },
    ];
}

// ── PostToolUseFailure → capability_usage (failure) ──

function parsePostToolUseFailure(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    const toolName = getString(event.tool_name) ?? getString(event.toolName);
    if (!toolName) {
        return [];
    }

    return [
        {
            ...base,
            event_type: "capability_usage",
            capability_type: "builtin_tool",
            capability_name: toolName,
            duration_ms: null,
            adopted: "unknown",
            attribution_confidence: "exact",
            invocation_origin: "observed",
            status: "failure" as EventStatus,
        },
    ];
}

// ── agentStop / Stop → turn_summary ──

function parseAgentStop(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    const stopReason = getString(event.stop_reason) ?? getString(event.stopReason);
    const status: EventStatus =
        stopReason === "end_turn" ? "success" : "unknown";

    const durationMs = getNumber(event.duration_ms) ?? getNumber(event.durationMs) ?? null;
    const model = getString(event.model) ?? null;

    // Check for embedded session data (similar to Codex Stop hook)
    const session = getRecord(event.session);
    const sessionEvents: AdapterEvent[] = [];
    if (session) {
        const turnCount = getNumber(session.turn_count) ?? getNumber(session.turnCount) ?? null;
        const sessionDurationMs =
            getNumber(session.duration_ms) ?? getNumber(session.durationMs) ?? null;
        const sessionStatus = mapSessionStatus(
            getString(session.status) ?? (sessionDurationMs !== null ? "success" : undefined),
        );

        sessionEvents.push({
            ...base,
            turn_id: null,
            event_type: "session_summary",
            turn_count: turnCount,
            duration_ms: sessionDurationMs,
            status: sessionStatus,
        });
    }

    return [
        {
            ...base,
            event_type: "turn_summary",
            model,
            duration_ms: durationMs,
            input_tokens: getNumber(event.input_tokens) ?? getNumber(event.inputTokens) ?? null,
            output_tokens: getNumber(event.output_tokens) ?? getNumber(event.outputTokens) ?? null,
            total_tokens: getNumber(event.total_tokens) ?? getNumber(event.totalTokens) ?? null,
            status,
        },
        ...sessionEvents,
    ];
}

// ── SessionEnd → session completion mark ──

function parseSessionEnd(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): AdapterEvent[] {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    const reason = getString(event.reason);
    const status = mapSessionEndReason(reason);

    // SessionEnd may carry aggregate data
    const turnCount = getNumber(event.turn_count) ?? getNumber(event.turnCount) ?? null;
    const durationMs =
        getNumber(event.duration_ms) ?? getNumber(event.durationMs) ?? null;

    return [
        {
            ...base,
            event_type: "session_summary",
            turn_count: turnCount,
            duration_ms: durationMs,
            status,
        },
    ];
}

// ── Helpers ──

function createBaseEvent(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): {
    occurred_at: string;
    agent: "copilot";
    source: string;
    session_id: string;
    turn_id: string | null;
    repo_path: string | null;
} | null {
    // Get timestamp: prefer occurred_at, then timestamp field
    const occurredAt =
        getString(event.occurred_at) ??
        getString(event.timestamp) ??
        options.observedAt;

    if (!occurredAt) {
        return null;
    }

    // Get session_id: snake_case or camelCase
    const sessionId = getString(event.session_id) ?? getString(event.sessionId);
    if (!sessionId) {
        return null;
    }

    // Get turn_id if present
    const turnId = getString(event.turn_id) ?? getString(event.turnId) ?? null;

    // Get repo path from cwd
    const cwd = getString(event.cwd);
    const repoPath = getString(event.repo_path) ?? getString(event.repoPath) ?? cwd ?? null;

    return {
        occurred_at: occurredAt,
        agent: "copilot",
        source: "copilot-hook",
        session_id: sessionId,
        turn_id: turnId,
        repo_path: repoPath,
    };
}

function mapSessionStatus(raw: string | undefined): EventStatus {
    if (raw === "success") return "success";
    if (raw === "failure" || raw === "error") return "failure";
    if (raw === "cancelled") return "cancelled";
    return "unknown";
}

function mapSessionEndReason(reason: string | undefined): EventStatus {
    switch (reason) {
        case "complete":
            return "success";
        case "error":
        case "timeout":
            return "failure";
        case "abort":
        case "user_exit":
            return "cancelled";
        default:
            return "unknown";
    }
}

// ── Low-level record helpers ──

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
