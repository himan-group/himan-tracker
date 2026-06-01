import { homedir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { AdapterEvent, CapabilityType, EventStatus } from "../../types/events.js";

type TrajectoryRow = {
    id: number;
    session_id: string;
    tool_call_id: string | null;
    turn_index: number | null;
    event_type: string;
    command: string | null;
    output: string | null;
    exit_code: number | null;
    event_key: string | null;
    event_value: string | null;
    created_at: string;
};

type SessionRow = {
    id: string;
    cwd: string | null;
    repository: string | null;
    branch: string | null;
    summary: string | null;
    created_at: string;
    updated_at: string;
};

/**
 * Default path for the Copilot CLI session store database.
 * Respects COPILOT_HOME if set, otherwise uses ~/.copilot.
 */
export function resolveCopilotSessionStorePath(): string {
    const copilotHome = process.env.COPILOT_HOME;
    const baseDir = copilotHome ?? path.join(homedir(), ".copilot");
    return path.join(baseDir, "session-store.db");
}

export type CopilotSessionStoreResult = {
    /** Always empty for DB source; kept for API compatibility with transcript backfill. */
    transcriptFiles: string[];
    events: AdapterEvent[];
};

/**
 * Parse a Copilot CLI session-store.db into AdapterEvents.
 *
 * Reads from the Copilot CLI's SQLite database which tracks sessions,
 * turns, and tool trajectory events across all Copilot CLI sessions.
 */
export function parseCopilotSessionStore(dbPath: string): CopilotSessionStoreResult {
    const db = openReadonly(dbPath);

    try {
        const sessions = querySessions(db);
        const trajectoryRows = queryTrajectoryEvents(db);

        const events = buildAdapterEvents(sessions, trajectoryRows);
        return { transcriptFiles: [], events };
    } finally {
        db.close();
    }
}

function openReadonly(dbPath: string): Database.Database {
    try {
        return new Database(dbPath, { readonly: true });
    } catch (error) {
        throw new Error(
            `Could not open Copilot session store at "${dbPath}": ${getErrorMessage(error)}`,
        );
    }
}

function querySessions(db: Database.Database): SessionRow[] {
    const rows = db
        .prepare(
            `SELECT id, cwd, repository, branch, summary, created_at, updated_at
             FROM sessions
             ORDER BY created_at ASC`,
        )
        .all() as SessionRow[];

    return rows;
}

function queryTrajectoryEvents(db: Database.Database): TrajectoryRow[] {
    const rows = db
        .prepare(
            `SELECT id, session_id, tool_call_id, turn_index,
                    event_type, command, output, exit_code,
                    event_key, event_value, created_at
             FROM forge_trajectory_events
             ORDER BY session_id, id ASC`,
        )
        .all() as TrajectoryRow[];

    return rows;
}

function buildAdapterEvents(
    sessions: SessionRow[],
    trajectoryRows: TrajectoryRow[],
): AdapterEvent[] {
    const events: AdapterEvent[] = [];

    // Emit session_summary for each session
    for (const session of sessions) {
        const turnCount = countDistinctTurns(trajectoryRows, session.id);
        events.push({
            event_type: "session_summary",
            occurred_at: session.created_at,
            agent: "copilot",
            source: "copilot-session-store",
            session_id: session.id,
            turn_id: null,
            repo_path: session.cwd ?? null,
            turn_count: turnCount > 0 ? turnCount : null,
            duration_ms: computeDurationMs(session.created_at, session.updated_at),
            status: "success",
        });
    }

    // Group trajectory events by tool_call_id and pair starts/ends
    const toolCallGroups = groupByToolCallId(trajectoryRows);

    for (const [toolCallId, rows] of toolCallGroups) {
        const capabilityEvent = buildCapabilityEvent(toolCallId, rows);
        if (capabilityEvent) {
            events.push(capabilityEvent);
        }
    }

    return events;
}

function countDistinctTurns(rows: TrajectoryRow[], sessionId: string): number {
    const turns = new Set<number>();
    for (const row of rows) {
        if (row.session_id === sessionId && row.turn_index != null) {
            turns.add(row.turn_index);
        }
    }
    return turns.size;
}

function groupByToolCallId(rows: TrajectoryRow[]): Map<string, TrajectoryRow[]> {
    const groups = new Map<string, TrajectoryRow[]>();
    for (const row of rows) {
        const key = row.tool_call_id ?? `_no_call_${row.id}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }
    return groups;
}

function buildCapabilityEvent(
    toolCallId: string,
    rows: TrajectoryRow[],
): AdapterEvent | null {
    // Find the start and end events
    const startRow = rows.find(
        (r) => isToolStartEvent(r.event_type),
    );
    const endRow = rows.find(
        (r) => isToolEndEvent(r.event_type),
    );

    if (!startRow && !endRow) {
        // Not a tool execution pair; skip unknown event types
        return null;
    }

    // Use start row for timing info, fallback to any row
    const primaryRow = startRow ?? endRow ?? rows[0];
    const occurredAt = primaryRow.created_at;

    const sessionId = primaryRow.session_id;
    if (!sessionId) {
        return null;
    }

    // Extract tool name from command field
    const toolName = extractToolName(primaryRow.command) ?? "unknown";

    // Determine status from end event's exit_code
    let status: EventStatus = "unknown";
    if (endRow) {
        if (endRow.exit_code === 0) {
            status = "success";
        } else if (endRow.exit_code != null && endRow.exit_code !== 0) {
            status = "failure";
        }
    }

    // Compute duration if we have both start and end
    const durationMs =
        startRow && endRow
            ? computeDurationMs(startRow.created_at, endRow.created_at)
            : null;

    return {
        event_type: "capability_usage",
        occurred_at: occurredAt,
        agent: "copilot",
        source: "copilot-session-store",
        session_id: sessionId,
        turn_id: primaryRow.turn_index != null ? String(primaryRow.turn_index) : null,
        capability_type: classifyToolType(toolName),
        capability_name: toolName,
        duration_ms: durationMs,
        adopted: "unknown",
        attribution_confidence: "exact",
        invocation_origin: "observed",
        status,
    };
}

/**
 * Classify a tool name into a capability type.
 * Copilot CLI tools are typically builtin tools or shell commands.
 */
function classifyToolType(toolName: string): CapabilityType {
    if (isShellCommand(toolName)) {
        return "shell_command";
    }
    // Most Copilot CLI tools (view, edit, grep, glob, etc.) are builtin
    return "builtin_tool";
}

/**
 * Check if an event_type indicates a tool execution start.
 * Handles known patterns; unknown patterns are treated conservatively.
 */
function isToolStartEvent(eventType: string): boolean {
    return (
        eventType === "tool_start" ||
        eventType === "tool_execution_start" ||
        eventType.endsWith("_start")
    );
}

/**
 * Check if an event_type indicates a tool execution end.
 */
function isToolEndEvent(eventType: string): boolean {
    return (
        eventType === "tool_end" ||
        eventType === "tool_execution_complete" ||
        eventType.endsWith("_end") ||
        eventType.endsWith("_complete")
    );
}

/**
 * Extract a tool name from the command field.
 * For shell commands, extract just the first word (the command name).
 */
function extractToolName(command: string | null): string | null {
    if (!command || command.trim().length === 0) {
        return null;
    }
    const firstToken = command.trim().split(/\s+/, 1)[0];
    return firstToken && firstToken.length > 0 ? firstToken : null;
}

function isShellCommand(toolName: string): boolean {
    return (
        toolName === "bash" ||
        toolName === "sh" ||
        toolName === "zsh" ||
        toolName === "fish" ||
        toolName === "powershell" ||
        toolName === "pwsh" ||
        toolName === "cmd" ||
        toolName === "cmd.exe"
    );
}

function computeDurationMs(start: string, end: string): number | null {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        return null;
    }
    return Math.max(0, endMs - startMs);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
