import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type ParseCopilotHookPayloadOptions = {
    observedAt?: string;
    /** Callback to look up a previously-recorded session start time (ISO string). */
    getSessionStartTime?: (sessionId: string) => string | null | Promise<string | null>;
    /** Callback to record a session start time for later duration calculation. */
    recordSessionStart?: (sessionId: string, startedAt: string) => void | Promise<void>;
    /** Callback to record a UserPromptSubmit time for accurate turn duration. */
    recordPromptSubmitted?: (sessionId: string, submittedAt: string) => void | Promise<void>;
    /**
     * Callback to record a turn end and get the approximate turn duration (ms).
     * Uses UserPromptSubmit timestamp when available, falls back to session/previous Stop.
     */
    recordTurnEndAndGetDuration?: (sessionId: string, endedAt: string) => number | null | Promise<number | null>;
};

/**
 * Parse a Copilot hook JSON payload (single event or array) into AdapterEvents.
 *
 * Supports two payload formats:
 * - camelCase: event names like "sessionStart", fields like "sessionId"
 * - PascalCase / VS Code compatible: event names like "SessionStart", fields like "session_id"
 */
export async function parseCopilotHookPayload(
    payload: unknown,
    options: ParseCopilotHookPayloadOptions = {},
): Promise<AdapterEvent[]> {
    const rawEvents = getRawEvents(payload);
    if (rawEvents.length === 0) {
        return [];
    }

    const nested = await Promise.all(
        rawEvents.map((event) => parseCopilotHookEvent(event, options)),
    );
    return nested.flat();
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

async function parseCopilotHookEvent(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): Promise<AdapterEvent[]> {
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

    // Record session start time so Stop / SessionEnd can compute duration.
    if (options.recordSessionStart && base.session_id && base.occurred_at) {
        void options.recordSessionStart(base.session_id, base.occurred_at);
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

    // Record the prompt submission time so Stop can compute accurate turn duration.
    if (options.recordPromptSubmitted && base.session_id && base.occurred_at) {
        void options.recordPromptSubmitted(base.session_id, base.occurred_at);
    }

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

async function parseAgentStop(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): Promise<AdapterEvent[]> {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    const stopReason = getString(event.stop_reason) ?? getString(event.stopReason);
    const status: EventStatus =
        stopReason === "end_turn" ? "success" : "unknown";

    // Prefer explicit duration_ms from the hook payload.
    const explicitDurationMs =
        getNumber(event.duration_ms) ?? getNumber(event.durationMs) ?? null;

    // Fall back: compute turn duration from the session state tracker
    // (SessionStart → first Stop, or previous Stop → current Stop).
    let durationMs = explicitDurationMs;
    if (durationMs === null && options.recordTurnEndAndGetDuration && base.session_id && base.occurred_at) {
        durationMs = await options.recordTurnEndAndGetDuration(base.session_id, base.occurred_at);
    }

    const model = getString(event.model) ?? null;

    // Check for embedded session data (similar to Codex Stop hook).
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

async function parseSessionEnd(
    event: RawRecord,
    options: ParseCopilotHookPayloadOptions,
): Promise<AdapterEvent[]> {
    const base = createBaseEvent(event, options);
    if (!base) {
        return [];
    }

    const reason = getString(event.reason);
    const status = mapSessionEndReason(reason);

    // SessionEnd may carry aggregate data
    const turnCount = getNumber(event.turn_count) ?? getNumber(event.turnCount) ?? null;
    const explicitDurationMs =
        getNumber(event.duration_ms) ?? getNumber(event.durationMs) ?? null;

    // Fall back: compute session duration from recorded SessionStart timestamp.
    let durationMs = explicitDurationMs;
    if (durationMs === null && options.getSessionStartTime && base.session_id && base.occurred_at) {
        const startTime = await options.getSessionStartTime(base.session_id);
        if (startTime) {
            durationMs = computeDurationFromTimestamps(startTime, base.occurred_at);
        }
    }

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

// ── Duration helpers ──

function computeDurationFromTimestamps(startIso: string, endIso: string): number | null {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return null;
    }
    return end - start;
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
