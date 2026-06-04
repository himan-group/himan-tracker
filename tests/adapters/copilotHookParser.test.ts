import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parseCopilotHookPayload } from "../../src/adapters/copilot/hookParser.js";
import { normalizeEvent } from "../../src/normalizer/normalizeEvent.js";
import type { UserConfig } from "../../src/types/config.js";
import type { NormalizedEvent } from "../../src/types/events.js";

const config: UserConfig = {
    schema_version: "1.0",
    privacy: {
        capture_content: false,
        hash_repo_path: true,
        capture_shell_args: false,
    },
    agents: {
        codex: {
            enabled: true,
        },
        "claude-code": {
            enabled: true,
        },
        copilot: {
            enabled: true,
        },
    },
    known_capabilities: [],
    local_salt: "fixture-salt",
};

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await readFile(filePath, "utf8"));
}

describe("parseCopilotHookPayload", () => {
    it("parses the Copilot hook fixture into stable normalized events (VS Code compatible / PascalCase format)", async () => {
        const rawPayload = await readJson("tests/fixtures/copilot/hook-raw/session.json");
        const expectedEvents = (await readJson(
            "tests/fixtures/copilot/hook-normalized/events.json",
        )) as NormalizedEvent[];

        const adapterEvents = await parseCopilotHookPayload(rawPayload);
        const normalizedEvents = adapterEvents.map((event) =>
            normalizeEvent(event, config),
        );

        assert.deepEqual(normalizedEvents, expectedEvents);
    });

    it("returns empty array for non-object input", async () => {
        assert.deepEqual(await parseCopilotHookPayload("not json"), []);
        assert.deepEqual(await parseCopilotHookPayload(null), []);
        assert.deepEqual(await parseCopilotHookPayload(42), []);
    });

    it("returns empty array for empty object", async () => {
        assert.deepEqual(await parseCopilotHookPayload({}), []);
    });

    it("returns empty array for object without recognized hook event", async () => {
        assert.deepEqual(
            await parseCopilotHookPayload({
                hook_event_name: "UnknownEvent",
                session_id: "s1",
                timestamp: "2026-05-30T12:00:00.000Z",
                cwd: "/tmp",
            }),
            [],
        );
    });

    it("returns empty array when session_id is missing", async () => {
        assert.deepEqual(
            await parseCopilotHookPayload({
                hook_event_name: "SessionStart",
                timestamp: "2026-05-30T12:00:00.000Z",
                cwd: "/tmp",
            }),
            [],
        );
    });

    it("returns empty array when timestamp is missing and no observedAt fallback", async () => {
        assert.deepEqual(
            await parseCopilotHookPayload({
                hook_event_name: "SessionStart",
                session_id: "s1",
                cwd: "/tmp",
            }),
            [],
        );
    });

    it("uses observedAt fallback when timestamp is missing", async () => {
        const events = await parseCopilotHookPayload(
            {
                hook_event_name: "SessionStart",
                session_id: "s1",
                cwd: "/tmp",
            },
            { observedAt: "2026-05-30T12:00:00.000Z" },
        );

        assert.equal(events.length, 1);
        assert.equal(events[0].occurred_at, "2026-05-30T12:00:00.000Z");
        assert.equal(events[0].event_type, "session_summary");
    });

    it("supports camelCase event names and fields", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "sessionStart",
            sessionId: "s2",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/tmp",
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "session_summary");
        assert.equal(events[0].session_id, "s2");
    });

    it("parses PostToolUse with camelCase fields", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "postToolUse",
            sessionId: "s3",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/tmp",
            toolName: "bash",
            toolResult: { resultType: "success", textResultForLlm: "done" },
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "capability_usage");
        assert.equal(events[0].capability_name, "bash");
        assert.equal(events[0].status, "success");
    });

    it("parses PostToolUseFailure with camelCase fields", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "postToolUseFailure",
            sessionId: "s4",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/tmp",
            toolName: "bash",
            error: "command not found",
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "capability_usage");
        assert.equal(events[0].capability_name, "bash");
        assert.equal(events[0].status, "failure");
    });

    it("parses agentStop with embedded session data", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "agentStop",
            sessionId: "s5",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/tmp",
            turn_id: "turn-1",
            transcriptPath: "/tmp/transcript.jsonl",
            stopReason: "end_turn",
            durationMs: 5000,
            model: "claude-sonnet-4.5",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            session: {
                turnCount: 2,
                durationMs: 20000,
                status: "success",
            },
        });

        // Should produce turn_summary + session_summary
        assert.equal(events.length, 2, "agentStop should produce turn_summary and session_summary");

        const turnEvent = events.find((e) => e.event_type === "turn_summary");
        assert.ok(turnEvent, "should have turn_summary event");
        assert.equal(turnEvent?.model, "claude-sonnet-4.5");
        assert.equal(turnEvent?.duration_ms, 5000);
        assert.equal(turnEvent?.input_tokens, 100);
        assert.equal(turnEvent?.output_tokens, 50);
        assert.equal(turnEvent?.total_tokens, 150);

        const sessionEvent = events.find((e) => e.event_type === "session_summary");
        assert.ok(sessionEvent, "should have session_summary event");
        assert.equal(sessionEvent?.turn_count, 2);
        assert.equal(sessionEvent?.duration_ms, 20000);
    });

    it("parses SessionEnd with reason mapping", async () => {
        const tests: Array<{ reason: string; expectedStatus: string }> = [
            { reason: "complete", expectedStatus: "success" },
            { reason: "error", expectedStatus: "failure" },
            { reason: "timeout", expectedStatus: "failure" },
            { reason: "abort", expectedStatus: "cancelled" },
            { reason: "user_exit", expectedStatus: "cancelled" },
        ];

        for (const { reason, expectedStatus } of tests) {
            const events = await parseCopilotHookPayload({
                hook_event_name: "SessionEnd",
                session_id: "s6",
                timestamp: "2026-05-30T12:00:00.000Z",
                cwd: "/tmp",
                reason,
            });

            assert.equal(events.length, 1);
            assert.equal(events[0].event_type, "session_summary");
            assert.equal(events[0].status, expectedStatus, `reason="${reason}" should map to status="${expectedStatus}"`);
        }
    });

    it("handles direct event (non-wrapper) payload", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "PostToolUse",
            session_id: "s7",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/tmp",
            tool_name: "edit",
            tool_result: { result_type: "success" },
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "capability_usage");
        assert.equal(events[0].capability_name, "edit");
    });

    it("extracts repo_path from cwd field", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "SessionStart",
            session_id: "s8",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/home/user/my-project",
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].repo_path, "/home/user/my-project");
    });

    it("prefers explicit repo_path over cwd", async () => {
        const events = await parseCopilotHookPayload({
            hook_event_name: "SessionStart",
            session_id: "s9",
            timestamp: "2026-05-30T12:00:00.000Z",
            cwd: "/home/user/my-project",
            repo_path: "/explicit/path",
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].repo_path, "/explicit/path");
    });

    it("filters out unknown hook event types", async () => {
        const events = await parseCopilotHookPayload([
            {
                hook_event_name: "SessionStart",
                session_id: "s10",
                timestamp: "2026-05-30T12:00:00.000Z",
                cwd: "/tmp",
            },
            {
                hook_event_name: "preToolUse",
                session_id: "s10",
                timestamp: "2026-05-30T12:00:01.000Z",
                cwd: "/tmp",
                tool_name: "bash",
            },
            {
                hook_event_name: "UnknownEvent",
                session_id: "s10",
                timestamp: "2026-05-30T12:00:02.000Z",
                cwd: "/tmp",
            },
            {
                hook_event_name: "PostToolUse",
                session_id: "s10",
                timestamp: "2026-05-30T12:00:03.000Z",
                cwd: "/tmp",
                tool_name: "view",
                tool_result: { result_type: "success" },
            },
        ]);

        // Should only include SessionStart and PostToolUse; preToolUse and UnknownEvent are filtered
        assert.equal(events.length, 2);
        assert.equal(events[0].event_type, "session_summary");
        assert.equal(events[1].event_type, "capability_usage");
        assert.equal(events[1].capability_name, "view");
    });
});
