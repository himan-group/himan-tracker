import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";

import { validateNormalizedEvent } from "../../src/normalizer/eventSchema.js";

describe("validateNormalizedEvent", () => {
  it("accepts valid normalized capability usage events", () => {
    const event = validateNormalizedEvent({
      schema_version: "1.0",
      event_id: "evt_001",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:00.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "success",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      duration_ms: 200,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
        adopted: "unknown",
        attribution_confidence: "unknown",
      });

      assert.equal(event.event_type, "capability_usage");
      assert.equal(event.invocation_origin, "unknown");
    });

  it("rejects unsupported schema versions", () => {
    assert.throws(
      () =>
        validateNormalizedEvent({
          schema_version: "2.0",
          event_id: "evt_001",
          event_type: "turn_summary",
          occurred_at: "2026-05-12T12:00:00.000Z",
          agent: "codex",
          source: "fixture",
          session_id: "s_001",
          status: "success",
          duration_ms: null,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
        }),
      ZodError,
    );
  });
});
