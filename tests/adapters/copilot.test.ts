import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parseCopilotTranscriptLines } from "../../src/adapters/copilot/index.js";
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

describe("parseCopilotTranscriptLines", () => {
    it("parses the Copilot raw transcript fixture into stable normalized events", async () => {
        const rawLines = (await readFile("tests/fixtures/copilot/raw/session.jsonl", "utf8")).split(
            /\r?\n/,
        );
        const expectedEvents = (await readJson(
            "tests/fixtures/copilot/normalized/events.json",
        )) as NormalizedEvent[];

        const normalizedEvents = parseCopilotTranscriptLines(rawLines).map((event) =>
            normalizeEvent(event, config),
        );

        assert.deepEqual(normalizedEvents, expectedEvents);
    });

    it("returns empty array for empty input", () => {
        assert.deepEqual(parseCopilotTranscriptLines([]), []);
    });

    it("returns empty array for invalid JSON lines", () => {
        assert.deepEqual(parseCopilotTranscriptLines(["not valid json", "{]"]), []);
    });

    it("ignores lines without session.start when no session id is available", () => {
        const events = parseCopilotTranscriptLines([
            JSON.stringify({
                type: "tool.execution_start",
                data: { toolCallId: "abc", toolName: "test" },
                timestamp: "2026-05-12T12:00:00.000Z",
            }),
            JSON.stringify({
                type: "tool.execution_complete",
                data: { toolCallId: "abc", success: true },
                timestamp: "2026-05-12T12:00:05.000Z",
            }),
        ]);

        assert.deepEqual(events, []);
    });

    it("produces capability_usage events with correct status mapping", () => {
        const events = parseCopilotTranscriptLines([
            JSON.stringify({
                type: "session.start",
                data: { sessionId: "s1", startTime: "2026-05-12T12:00:00.000Z" },
                timestamp: "2026-05-12T12:00:00.000Z",
            }),
            JSON.stringify({
                type: "tool.execution_start",
                data: { toolCallId: "t1", toolName: "success_tool" },
                timestamp: "2026-05-12T12:00:05.000Z",
            }),
            JSON.stringify({
                type: "tool.execution_complete",
                data: { toolCallId: "t1", success: true },
                timestamp: "2026-05-12T12:00:06.000Z",
            }),
            JSON.stringify({
                type: "tool.execution_start",
                data: { toolCallId: "t2", toolName: "failure_tool" },
                timestamp: "2026-05-12T12:00:07.000Z",
            }),
            JSON.stringify({
                type: "tool.execution_complete",
                data: { toolCallId: "t2", success: false },
                timestamp: "2026-05-12T12:00:08.000Z",
            }),
        ]);

        const capabilityEvents = events.filter((e) => e.event_type === "capability_usage");
        assert.equal(capabilityEvents.length, 2);

        const successEvent = capabilityEvents.find((e) => e.capability_name === "success_tool");
        assert.ok(successEvent);
        assert.equal(successEvent.status, "success");
        assert.equal(successEvent.duration_ms, 1000);

        const failureEvent = capabilityEvents.find((e) => e.capability_name === "failure_tool");
        assert.ok(failureEvent);
        assert.equal(failureEvent.status, "failure");
        assert.equal(failureEvent.duration_ms, 1000);
    });

    it("computes turn duration from turn_start and turn_end timestamps", () => {
        const events = parseCopilotTranscriptLines([
            JSON.stringify({
                type: "session.start",
                data: { sessionId: "s1", startTime: "2026-05-12T12:00:00.000Z" },
                timestamp: "2026-05-12T12:00:00.000Z",
            }),
            JSON.stringify({
                type: "assistant.turn_start",
                data: { turnId: "0" },
                timestamp: "2026-05-12T12:00:05.000Z",
            }),
            JSON.stringify({
                type: "assistant.turn_end",
                data: { turnId: "0" },
                timestamp: "2026-05-12T12:00:12.000Z",
            }),
        ]);

        const turnEvents = events.filter((e) => e.event_type === "turn_summary");
        assert.equal(turnEvents.length, 1);
        assert.equal(turnEvents[0].turn_id, "0");
        assert.equal(turnEvents[0].duration_ms, 7000);
    });
});

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await readFile(filePath, "utf8"));
}
