import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseClaudeCodeTranscriptBackfill } from "../../src/adapters/claude-code/transcriptBackfill.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "claude-code",
  "raw",
);

describe("parseClaudeCodeTranscriptBackfill", () => {
  it("parses a Claude Code transcript JSONL into backfill events", async () => {
    const result = await parseClaudeCodeTranscriptBackfill({
      transcriptDir: fixtureDir,
    });

    assert.ok(result.transcriptFiles.length > 0, "should find transcript files");
    assert.ok(result.events.length > 0, "should produce events");

    // Should have turn_summary events (one per assistant message with usage)
    const turnSummaries = result.events.filter((e) => e.event_type === "turn_summary");
    assert.ok(turnSummaries.length >= 2, "should have at least 2 turn summaries");

    // Should have capability_usage events (one per tool_use)
    const capabilityEvents = result.events.filter((e) => e.event_type === "capability_usage");
    assert.ok(capabilityEvents.length >= 2, "should have at least 2 capability events");

    // Should have one session_summary
    const sessionSummaries = result.events.filter((e) => e.event_type === "session_summary");
    assert.equal(sessionSummaries.length, 1, "should have 1 session summary");

    // All events should have claude-code agent
    for (const event of result.events) {
      assert.equal(event.agent, "claude-code");
    }

    // Check turn with usage has token data
    const turnsWithTokens = turnSummaries.filter((t) => t.input_tokens !== null);
    assert.ok(turnsWithTokens.length >= 2, "turns with usage should have token data");

    // Check capability events have tool names
    const writeEvent = capabilityEvents.find((e) => e.capability_name === "Write");
    assert.ok(writeEvent, "should have Write capability event");

    const bashEvent = capabilityEvents.find((e) => e.capability_name === "Bash");
    assert.ok(bashEvent, "should have Bash capability event");
  });
});
