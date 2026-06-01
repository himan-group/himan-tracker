import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";

import { validateNormalizedEvent } from "../../src/normalizer/eventSchema.js";
import { hashRepoPath } from "../../src/normalizer/privacy.js";
import {
  createEventId,
  normalizeEvent,
  normalizeTokenUsage,
} from "../../src/normalizer/normalizeEvent.js";
import type { AdapterEvent, NormalizedEvent } from "../../src/types/events.js";
import type { UserConfig } from "../../src/types/config.js";

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
  },
  known_capabilities: [],
  local_salt: "test-salt",
};

describe("normalizeTokenUsage", () => {
  it("calculates total tokens when input or output is present", () => {
    assert.deepEqual(normalizeTokenUsage({ input_tokens: 12, output_tokens: 3 }), {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
    });
  });

  it("preserves null token usage when no token fields are available", () => {
    assert.deepEqual(normalizeTokenUsage({}), {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    });
  });

  it("prefers source-provided total tokens", () => {
    assert.deepEqual(
      normalizeTokenUsage({
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 99,
      }),
      {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 99,
      },
    );
  });
});

describe("normalizeEvent", () => {
  it("normalizes turn summaries with stable event IDs and hashed repo paths", () => {
    const adapterEvent: AdapterEvent = {
      event_type: "turn_summary",
      occurred_at: "2026-05-12T03:45:00.000Z",
      agent: "codex",
      source: "codex-hook",
      session_id: "s_001",
      turn_id: "t_001",
      repo_path: "/Users/example/project",
      status: "success",
      model: "gpt-5.1-codex",
      duration_ms: 42_000,
      input_tokens: 12_000,
      output_tokens: 1_800,
    };

    const first = normalizeEvent(adapterEvent, config);
    const second = normalizeEvent(adapterEvent, config);

    assert.equal(first.event_id, second.event_id);
    assert.equal(first.total_tokens, 13_800);
    assert.equal(first.repo_hash, hashRepoPath("/Users/example/project", config.local_salt));
    assert.equal("repo_path" in first, false);
  });

  it("normalizes capability usage with default status and attribution fields", () => {
    const event = normalizeEvent(
      {
        event_type: "capability_usage",
        occurred_at: "2026-05-12T03:45:12.000Z",
        agent: "claude-code",
        source: "claude-code-hook",
        session_id: "s_001",
        turn_id: "t_001",
        capability_type: "mcp_tool",
        capability_name: "github.create_pull_request",
        duration_ms: 3_000,
      },
      config,
    );

    assert.equal(event.event_type, "capability_usage");
      assert.equal(event.status, "unknown");
      assert.equal(event.adopted, "unknown");
      assert.equal(event.attribution_confidence, "unknown");
      assert.equal(event.invocation_origin, "unknown");
      assert.equal(event.attribution_basis, undefined);
      assert.equal(event.attribution_score, undefined);
      assert.equal(event.total_tokens, null);
    });

  it("normalizes capability attribution detail fields when present", () => {
    const event = normalizeEvent(
      {
        event_type: "capability_usage",
        occurred_at: "2026-05-12T03:45:12.000Z",
        agent: "codex",
        source: "codex-hook",
        session_id: "s_001",
        turn_id: "t_001",
        capability_name: "Bash",
        attribution_confidence: "estimated",
        invocation_origin: "observed",
        attribution_basis: "classifier_shell",
        attribution_score: 120,
        attribution_reason: "  shell  name   inferred from tool   ",
        attribution_context_source: "none",
      },
      config,
    );

    assert.equal(event.event_type, "capability_usage");
    assert.equal(event.capability_type, "builtin_tool");
    assert.equal(event.attribution_basis, "classifier_shell");
    assert.equal(event.attribution_score, 50);
    assert.equal(event.attribution_reason, "shell name inferred from tool");
    assert.equal(event.attribution_context_source, "none");
  });

  it("uses adapter identity keys to dedupe observed duplicate events", () => {
    const first = normalizeEvent(
      {
        event_type: "capability_usage",
        occurred_at: "2026-05-12T03:45:12.000Z",
        identity_key: "codex:PostToolUse:turn_001:tool:call_001:Bash",
        agent: "codex",
        source: "codex-hook",
        session_id: "s_001",
        turn_id: "turn_001",
        capability_name: "Bash",
      },
      config,
    );
    const second = normalizeEvent(
      {
        event_type: "capability_usage",
        occurred_at: "2026-05-12T03:45:12.050Z",
        identity_key: "codex:PostToolUse:turn_001:tool:call_001:Bash",
        agent: "codex",
        source: "codex-hook",
        session_id: "s_001",
        turn_id: "turn_001",
        capability_name: "Bash",
      },
      config,
    );

    assert.equal(first.event_id, second.event_id);
    assert.equal("identity_key" in first, false);
  });

  it("strips shell command arguments by default", () => {
    const event = normalizeEvent(
      {
        event_type: "capability_usage",
        occurred_at: "2026-05-12T03:45:12.000Z",
        agent: "codex",
        source: "codex-hook",
        session_id: "s_001",
        capability_type: "shell_command",
        capability_name: "git status --short",
        status: "success",
      },
      config,
    );

    assert.equal(event.capability_name, "git");
  });

  it("normalizes session summaries", () => {
    const event = normalizeEvent(
      {
        event_type: "session_summary",
        occurred_at: "2026-05-12T04:10:00.000Z",
        agent: "codex",
        source: "codex-hook",
        session_id: "s_001",
        turn_count: 8,
        duration_ms: 1_500_000,
        status: "success",
      },
      config,
    );

    assert.equal(event.event_type, "session_summary");
    assert.equal(event.turn_count, 8);
    assert.equal(event.duration_ms, 1_500_000);
  });
});

describe("validateNormalizedEvent", () => {
  it("rejects invalid normalized event payloads", () => {
    assert.throws(
      () =>
        validateNormalizedEvent({
          schema_version: "1.0",
          event_id: "evt_001",
          event_type: "turn_summary",
          occurred_at: "not-a-date",
          agent: "codex",
          source: "codex-hook",
          session_id: "s_001",
          status: "success",
          duration_ms: 1,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
        }),
      ZodError,
    );
  });
});

describe("createEventId", () => {
  it("uses stable identity fields", () => {
    const event: Omit<NormalizedEvent, "event_id"> = {
      schema_version: "1.0",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T03:45:12.000Z",
      agent: "codex",
      source: "source-a",
      session_id: "s_001",
      turn_id: "t_001",
      status: "success",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
        total_tokens: null,
        adopted: "unknown",
        attribution_confidence: "unknown",
        invocation_origin: "observed",
      };

    const sameIdentityDifferentSource = {
      ...event,
      source: "source-b",
      duration_ms: 100,
    };

    assert.equal(createEventId(event), createEventId(sameIdentityDifferentSource));
  });
});
