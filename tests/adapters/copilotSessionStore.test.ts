import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { parseCopilotSessionStore } from "../../src/adapters/copilot/sessionStoreBackfill.js";
import { normalizeEvent } from "../../src/normalizer/normalizeEvent.js";
import type { UserConfig } from "../../src/types/config.js";

const config: UserConfig = {
    schema_version: "1.0",
    privacy: {
        capture_content: false,
        hash_repo_path: true,
        capture_shell_args: false,
    },
    agents: {
        codex: { enabled: true },
        "claude-code": { enabled: true },
        copilot: { enabled: true },
    },
    known_capabilities: [],
    local_salt: "fixture-salt",
};

function createTestDb(): { dbPath: string; cleanup: () => void } {
    const dbPath = path.join(
        tmpdir(),
        `himan-copilot-session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const db = new Database(dbPath);

    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            repository TEXT,
            branch TEXT,
            summary TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE forge_trajectory_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            tool_call_id TEXT,
            turn_index INTEGER,
            event_type TEXT NOT NULL,
            command TEXT,
            output TEXT,
            exit_code INTEGER,
            event_key TEXT,
            event_value TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_forge_trajectory_events_tool_call
            ON forge_trajectory_events(tool_call_id);
    `);

    db.close();

    return {
        dbPath,
        cleanup: () => {
            try {
                unlinkSync(dbPath);
            } catch {
                // best effort
            }
        },
    };
}

const cleanupFns: Array<() => void> = [];
function registerCleanup(fn: () => void) {
    cleanupFns.push(fn);
}

// Clean up all temp DBs after all tests
process.on("exit", () => {
    for (const fn of cleanupFns) {
        try { fn(); } catch { /* ignore */ }
    }
});

describe("parseCopilotSessionStore", () => {
    it("parses sessions and trajectory events into normalized events", () => {
        const { dbPath, cleanup } = createTestDb();
        registerCleanup(cleanup);

        const db = new Database(dbPath);

        // Insert test sessions
        db.exec(`
            INSERT INTO sessions (id, cwd, repository, branch, created_at, updated_at)
            VALUES
                ('s1', '/Users/test/project', 'test-owner/test-repo', 'main',
                 '2026-05-30T12:00:00.000Z', '2026-05-30T12:05:00.000Z'),
                ('s2', '/Users/test/other', 'test-owner/other-repo', 'dev',
                 '2026-05-30T13:00:00.000Z', '2026-05-30T13:02:00.000Z')
        `);

        // Insert trajectory events for s1
        db.exec(`
            INSERT INTO forge_trajectory_events
                (session_id, tool_call_id, turn_index, event_type, command, output, exit_code, created_at)
            VALUES
                ('s1', 'call_01', 0, 'tool_start', 'read_file', NULL, NULL,
                 '2026-05-30T12:00:10.000Z'),
                ('s1', 'call_01', 0, 'tool_end', 'read_file', 'content here', 0,
                 '2026-05-30T12:00:10.250Z'),
                ('s1', 'call_02', 0, 'tool_start', 'bash', NULL, NULL,
                 '2026-05-30T12:00:15.000Z'),
                ('s1', 'call_02', 0, 'tool_end', 'bash', 'command output', 0,
                 '2026-05-30T12:00:16.500Z'),
                ('s1', 'call_04', 1, 'tool_start', 'bash -lc "cat ~/.ssh/config"', NULL, NULL,
                 '2026-05-30T12:01:10.000Z'),
                ('s1', 'call_04', 1, 'tool_end', 'bash -lc "cat ~/.ssh/config"', 'sensitive output', 0,
                 '2026-05-30T12:01:11.000Z'),
                ('s1', 'call_03', 1, 'tool_start', 'grep_search', NULL, NULL,
                 '2026-05-30T12:01:00.000Z'),
                ('s1', 'call_03', 1, 'tool_end', 'grep_search', 'no matches', 1,
                 '2026-05-30T12:01:00.300Z')
        `);

        db.close();

        const result = parseCopilotSessionStore(dbPath);
        const normalizedEvents = result.events.map((e) => normalizeEvent(e, config));

        // Should have: 2 sessions + 4 capability usages = 6 events
        assert.equal(
            normalizedEvents.length,
            6,
            `expected 6 events, got ${normalizedEvents.length}`,
        );

        // Verify session events
        const sessionEvents = normalizedEvents.filter(
            (e) => e.event_type === "session_summary",
        );
        assert.equal(sessionEvents.length, 2);

        const s1 = sessionEvents.find((e) => e.session_id === "s1");
        assert.ok(s1);
        assert.equal(s1?.agent, "copilot");
        assert.equal(s1?.source, "copilot-session-store");
        assert.equal(s1?.repo_hash, "a64c0f4e93766ac0a0881fd930a92769c1583306afd20d02c93e219c07cc328d");
        assert.equal(s1?.turn_count, 2); // turns 0 and 1
        assert.equal(s1?.duration_ms, 300000); // 5 minutes
        assert.equal(s1?.status, "success");

        const s2 = sessionEvents.find((e) => e.session_id === "s2");
        assert.ok(s2);
        assert.equal(s2?.turn_count, null); // no trajectory events
        assert.equal(s2?.duration_ms, 120000); // 2 minutes

        // Verify capability events
        const capabilityEvents = normalizedEvents.filter(
            (e) => e.event_type === "capability_usage",
        );
        assert.equal(capabilityEvents.length, 4);

        // read_file (success)
        const readFileEvent = capabilityEvents.find(
            (e) => e.capability_name === "read_file",
        );
        assert.ok(readFileEvent);
        assert.equal(readFileEvent?.status, "success");
        assert.equal(readFileEvent?.duration_ms, 250);
        assert.equal(readFileEvent?.capability_type, "builtin_tool");
        assert.equal(readFileEvent?.turn_id, "0");

        // bash (success)
        const bashEvent = capabilityEvents.find(
            (e) => e.capability_name === "bash",
        );
        assert.ok(bashEvent);
        assert.equal(bashEvent?.status, "success");
        assert.equal(bashEvent?.duration_ms, 1500);
        assert.equal(bashEvent?.capability_type, "shell_command");

        // bash with args should only keep command name and not leak args
        const bashWithArgsEvent = capabilityEvents.find(
            (e) => e.duration_ms === 1000 && e.turn_id === "1",
        );
        assert.ok(bashWithArgsEvent);
        assert.equal(bashWithArgsEvent?.capability_name, "bash");
        assert.equal(bashWithArgsEvent?.capability_type, "shell_command");

        // grep_search (failure)
        const grepEvent = capabilityEvents.find(
            (e) => e.capability_name === "grep_search",
        );
        assert.ok(grepEvent);
        assert.equal(grepEvent?.status, "failure");
        assert.equal(grepEvent?.duration_ms, 300);
        assert.equal(grepEvent?.turn_id, "1");
    });

    it("returns empty events for a DB with no sessions", () => {
        const { dbPath, cleanup } = createTestDb();
        registerCleanup(cleanup);

        const result = parseCopilotSessionStore(dbPath);
        assert.deepEqual(result.events, []);
        assert.deepEqual(result.transcriptFiles, []);
    });

    it("handles sessions with no trajectory events", () => {
        const { dbPath, cleanup } = createTestDb();
        registerCleanup(cleanup);

        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO sessions (id, cwd, created_at, updated_at)
            VALUES ('empty-session', '/tmp', '2026-05-30T12:00:00.000Z', '2026-05-30T12:00:00.000Z')
        `);
        db.close();

        const result = parseCopilotSessionStore(dbPath);
        const normalizedEvents = result.events.map((e) => normalizeEvent(e, config));

        assert.equal(normalizedEvents.length, 1);
        assert.equal(normalizedEvents[0].event_type, "session_summary");
        assert.equal(normalizedEvents[0].session_id, "empty-session");
        assert.equal(normalizedEvents[0].turn_count, null);
    });

    it("throws for a non-existent DB path", () => {
        assert.throws(
            () => parseCopilotSessionStore("/nonexistent/path/session-store.db"),
            /Could not open Copilot session store/,
        );
    });

    it("skips trajectory events without matching tool pairs gracefully", () => {
        const { dbPath, cleanup } = createTestDb();
        registerCleanup(cleanup);

        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO sessions (id, cwd, created_at, updated_at)
            VALUES ('s_orphan', '/tmp', '2026-05-30T12:00:00.000Z', '2026-05-30T12:01:00.000Z')
        `);
        // Insert events that are not tool start/end pairs
        db.exec(`
            INSERT INTO forge_trajectory_events
                (session_id, tool_call_id, turn_index, event_type, command, created_at)
            VALUES
                ('s_orphan', NULL, 0, 'model_request', NULL, '2026-05-30T12:00:05.000Z'),
                ('s_orphan', NULL, 0, 'model_response', NULL, '2026-05-30T12:00:06.000Z')
        `);
        db.close();

        const result = parseCopilotSessionStore(dbPath);
        const normalizedEvents = result.events.map((e) => normalizeEvent(e, config));

        // Should only have the session event, no capability events
        assert.equal(normalizedEvents.length, 1);
        assert.equal(normalizedEvents[0].event_type, "session_summary");
    });
});
