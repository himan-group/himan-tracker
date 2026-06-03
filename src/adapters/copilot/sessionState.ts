import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import type { TrackerPaths } from "../../config/paths.js";

/**
 * Lightweight session state tracker for computing session and turn duration.
 *
 * Copilot hooks arrive as independent invocations — SessionStart, Stop,
 * and SessionEnd are separate processes.  This tracker stores the
 * SessionStart timestamp and last turn end time in a short-lived JSON file
 * keyed by session_id so duration can be computed across invocations.
 *
 * Turn duration approximation (most → least accurate):
 *   1. Stop.timestamp - last UserPromptSubmit.timestamp (user-driven)
 *   2. Stop.timestamp - SessionStart.timestamp (first turn)
 *   3. Stop.timestamp - previous Stop.timestamp (fallback)
 */
export type SessionState = {
    startedAt: string;
    /** Timestamp of the most recent UserPromptSubmit (best turn-start reference). */
    lastPromptSubmittedAt?: string;
    /** Timestamp of the most recent Stop event (fallback turn-start reference). */
    lastTurnEndedAt?: string;
};

function sessionStateDir(paths: TrackerPaths): string {
    return path.join(paths.homeDir, "sessions");
}

function sessionStateFile(paths: TrackerPaths, sessionId: string): string {
    return path.join(sessionStateDir(paths), `${sanitizeSessionId(sessionId)}.json`);
}

function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function recordSessionStart(
    paths: TrackerPaths,
    sessionId: string,
    startedAt: string,
): Promise<void> {
    const dir = sessionStateDir(paths);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
        sessionStateFile(paths, sessionId),
        JSON.stringify({ startedAt }),
        { encoding: "utf8", mode: 0o600 },
    );
}

export async function getSessionStartTime(
    paths: TrackerPaths,
    sessionId: string,
): Promise<string | null> {
    try {
        const raw = await readFile(sessionStateFile(paths, sessionId), "utf8");
        const state = JSON.parse(raw) as SessionState;
        return state.startedAt ?? null;
    } catch {
        return null;
    }
}

/**
 * Record a UserPromptSubmit timestamp for accurate turn duration calculation.
 */
export async function recordPromptSubmitted(
    paths: TrackerPaths,
    sessionId: string,
    submittedAt: string,
): Promise<void> {
    const file = sessionStateFile(paths, sessionId);
    let state: SessionState;

    try {
        const raw = await readFile(file, "utf8");
        state = JSON.parse(raw) as SessionState;
    } catch {
        // SessionStart hasn't been recorded yet — create a minimal state.
        state = { startedAt: submittedAt };
    }

    state.lastPromptSubmittedAt = submittedAt;
    await writeFile(file, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
}

/**
 * Record the end time of a turn and return the approximate turn duration (ms).
 *
 * Duration is computed using the best available reference point:
 *   1. UserPromptSubmit timestamp (most accurate — user-driven)
 *   2. Session start time (first turn)
 *   3. Previous Stop timestamp (fallback)
 *
 * Returns null when no reference point can be found.
 */
export async function recordTurnEndAndGetDuration(
    paths: TrackerPaths,
    sessionId: string,
    endedAt: string,
): Promise<number | null> {
    const file = sessionStateFile(paths, sessionId);
    let state: SessionState;

    try {
        const raw = await readFile(file, "utf8");
        state = JSON.parse(raw) as SessionState;
    } catch {
        return null;
    }

    // Best reference: user prompt submission time
    // Fallback chain: promptSubmitted → startedAt (first turn) → lastTurnEndedAt
    const referencePoint =
        state.lastPromptSubmittedAt ?? state.startedAt ?? state.lastTurnEndedAt;
    const durationMs = computeDurationMs(referencePoint, endedAt);

    // Update last turn end time and clear the prompt reference for next turn.
    state.lastTurnEndedAt = endedAt;
    // Don't clear lastPromptSubmittedAt — the next UserPromptSubmit will overwrite it.
    await writeFile(file, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });

    return durationMs;
}

export async function clearSessionState(
    paths: TrackerPaths,
    sessionId: string,
): Promise<void> {
    try {
        await unlink(sessionStateFile(paths, sessionId));
    } catch {
        // Best-effort cleanup
    }
}

export function computeDurationMs(startIso: string, endIso: string): number | null {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return null;
    }
    return end - start;
}
