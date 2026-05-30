import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type CopilotTranscriptResult = {
    transcriptFiles: string[];
    events: AdapterEvent[];
};

export async function parseCopilotTranscriptBackfill(options: {
    transcriptDir: string;
}): Promise<CopilotTranscriptResult> {
    const transcriptFiles = await listTranscriptFiles(options.transcriptDir);
    const events = (
        await Promise.all(
            transcriptFiles.map(async (transcriptPath) => {
                const raw = await readFile(transcriptPath, "utf8");
                return parseCopilotTranscriptLines(raw.split(/\r?\n/));
            }),
        )
    ).flat();

    return {
        transcriptFiles,
        events,
    };
}

async function listTranscriptFiles(transcriptDir: string): Promise<string[]> {
    try {
        const entries = await readdir(transcriptDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => path.join(transcriptDir, entry.name))
            .sort();
    } catch (error) {
        if (isMissingFileError(error)) {
            return [];
        }

        throw error;
    }
}

export function parseCopilotTranscriptLines(lines: string[]): AdapterEvent[] {
    const rawEvents: RawRecord[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }

        const record = parseJsonRecord(trimmed);
        if (record) {
            rawEvents.push(record);
        }
    }

    return buildAdapterEvents(rawEvents);
}

function buildAdapterEvents(rawEvents: RawRecord[]): AdapterEvent[] {
    const sessionId = findSessionId(rawEvents);
    if (!sessionId) {
        return [];
    }

    const events: AdapterEvent[] = [];

    // Collect session start info
    const sessionStart = rawEvents.find((e) => e.type === "session.start");
    if (sessionStart) {
        const data = getRecord(sessionStart.data);
        const startTime = getString(data?.startTime) ?? getString(sessionStart.timestamp);
        if (startTime) {
            events.push({
                event_type: "session_summary",
                occurred_at: startTime,
                agent: "copilot",
                source: "copilot-transcript",
                session_id: sessionId,
                turn_id: null,
                turn_count: null,
                duration_ms: null,
                status: "success",
            });
        }
    }

    // Track turn boundaries for turn_summary events
    const turnStarts = new Map<string, string>(); // turnId → timestamp
    for (const event of rawEvents) {
        if (event.type === "assistant.turn_start") {
            const data = getRecord(event.data);
            const turnId = getString(data?.turnId);
            const ts = getString(event.timestamp);
            if (turnId && ts) {
                turnStarts.set(turnId, ts);
            }
        }
    }

    for (const event of rawEvents) {
        if (event.type === "assistant.turn_end") {
            const data = getRecord(event.data);
            const turnId = getString(data?.turnId);
            const endTs = getString(event.timestamp);
            if (!turnId || !endTs) {
                continue;
            }

            const startTs = turnStarts.get(turnId);
            const durationMs = startTs ? computeDurationMs(startTs, endTs) : null;

            events.push({
                event_type: "turn_summary",
                occurred_at: startTs ?? endTs,
                agent: "copilot",
                source: "copilot-transcript",
                session_id: sessionId,
                turn_id: turnId,
                model: null,
                duration_ms: durationMs,
                input_tokens: null,
                output_tokens: null,
                total_tokens: null,
                status: "success",
            });
        }
    }

    // Track tool executions for capability_usage events
    const toolStarts = new Map<string, { toolName: string; startTs: string; turnId: string | null }>();

    for (const event of rawEvents) {
        if (event.type === "tool.execution_start") {
            const data = getRecord(event.data);
            const toolCallId = getString(data?.toolCallId);
            const toolName = getString(data?.toolName);
            const startTs = getString(event.timestamp);
            if (toolCallId && toolName && startTs) {
                toolStarts.set(toolCallId, { toolName, startTs, turnId: null });
            }
        }
    }

    // Assign turn context: find which turn each tool call belongs to
    // A tool call belongs to the most recent turn that started before it
    const sortedTurnStarts = [...turnStarts.entries()]
        .map(([turnId, ts]) => ({ turnId, ts: new Date(ts).getTime() }))
        .sort((a, b) => a.ts - b.ts);

    for (const [toolCallId, toolInfo] of toolStarts) {
        const toolTime = new Date(toolInfo.startTs).getTime();
        let assignedTurn: string | null = null;

        for (const turn of sortedTurnStarts) {
            if (turn.ts <= toolTime) {
                assignedTurn = turn.turnId;
            } else {
                break;
            }
        }

        toolInfo.turnId = assignedTurn;
    }

    for (const event of rawEvents) {
        if (event.type === "tool.execution_complete") {
            const data = getRecord(event.data);
            const toolCallId = getString(data?.toolCallId);
            const success = data?.success;
            const endTs = getString(event.timestamp);
            if (!toolCallId) {
                continue;
            }

            const toolInfo = toolStarts.get(toolCallId);
            const toolName = toolInfo?.toolName ?? "unknown";
            const startTs = toolInfo?.startTs;
            const durationMs = startTs && endTs ? computeDurationMs(startTs, endTs) : null;
            const status: EventStatus = typeof success === "boolean" ? (success ? "success" : "failure") : "unknown";

            events.push({
                event_type: "capability_usage",
                occurred_at: startTs ?? endTs ?? "",
                agent: "copilot",
                source: "copilot-transcript",
                session_id: sessionId,
                turn_id: toolInfo?.turnId ?? null,
                capability_type: "builtin_tool",
                capability_name: toolName,
                duration_ms: durationMs,
                adopted: "unknown",
                attribution_confidence: "exact",
                invocation_origin: "observed",
                input_tokens: null,
                output_tokens: null,
                total_tokens: null,
                status,
            });
        }
    }

    return events;
}

function findSessionId(rawEvents: RawRecord[]): string | null {
    for (const event of rawEvents) {
        if (event.type === "session.start") {
            const data = getRecord(event.data);
            const id = getString(data?.sessionId);
            if (id) {
                return id;
            }
        }
    }

    // Fallback: try sid field from top-level
    for (const event of rawEvents) {
        const sid = getString(event.sid);
        if (sid) {
            return sid;
        }
    }

    return null;
}

function computeDurationMs(startTs: string, endTs: string): number {
    const start = new Date(startTs).getTime();
    const end = new Date(endTs).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) {
        return 0;
    }

    return Math.max(0, end - start);
}

function parseJsonRecord(line: string): RawRecord | null {
    try {
        const parsed = JSON.parse(line);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function getRecord(value: unknown): RawRecord | null {
    return isRecord(value) ? value : null;
}

function getString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is RawRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
