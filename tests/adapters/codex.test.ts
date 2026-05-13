import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parseCodexHookPayload } from "../../src/adapters/codex/index.js";
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
  },
  known_capabilities: [],
  local_salt: "fixture-salt",
};

describe("parseCodexHookPayload", () => {
  it("parses the Codex raw fixture into stable normalized events", async () => {
    const rawPayload = await readJson("tests/fixtures/codex/raw/session.json");
    const expectedEvents = (await readJson(
      "tests/fixtures/codex/normalized/events.json",
    )) as NormalizedEvent[];

    const normalizedEvents = parseCodexHookPayload(rawPayload).map((event) =>
      normalizeEvent(event, config),
    );

    assert.deepEqual(normalizedEvents, expectedEvents);
    assert.equal(JSON.stringify(normalizedEvents).includes("/Users/example/project"), false);
  });

  it("ignores unrecognized hooks without throwing", () => {
    assert.deepEqual(
      parseCodexHookPayload({
        events: [
          {
            hook: "FutureHook",
            prompt: "do not store this prompt",
          },
        ],
      }),
      [],
    );
  });

  it("parses current Codex hook payload fields without storing prompt content", () => {
    const adapterEvents = parseCodexHookPayload(
      {
        hook_event_name: "PostToolUse",
        session_id: "session_123",
        turn_id: "turn_123",
        cwd: "/Users/example/project",
        model: "gpt-5.1-codex",
        tool_name: "Bash",
        tool_input: {
          command: "pnpm test",
        },
        tool_response: {
          output: "do not store output",
        },
        prompt: "do not store this prompt",
      },
      { observedAt: "2026-05-12T12:00:00.000Z" },
    );

    assert.equal(adapterEvents.length, 1);
    assert.deepEqual(adapterEvents[0], {
      occurred_at: "2026-05-12T12:00:00.000Z",
      agent: "codex",
      source: "codex-hook",
      session_id: "session_123",
      turn_id: "turn_123",
      repo_path: "/Users/example/project",
      status: undefined,
      event_type: "capability_usage",
        capability_name: "Bash",
        duration_ms: undefined,
        attribution_confidence: "unknown",
        invocation_origin: "observed",
      });
    assert.equal(JSON.stringify(adapterEvents).includes("do not store"), false);
  });

  it("extracts explicit skill mentions from UserPromptSubmit without storing prompt content", () => {
    const adapterEvents = parseCodexHookPayload(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session_123",
        turn_id: "turn_123",
        cwd: "/Users/example/project",
        prompt: "请使用 $common-git-commit，并忽略 $HOME 和 $py",
      },
      { observedAt: "2026-05-12T12:00:00.000Z" },
    );

    assert.deepEqual(adapterEvents, [
      {
        occurred_at: "2026-05-12T12:00:00.000Z",
        agent: "codex",
        source: "codex-hook",
        session_id: "session_123",
        turn_id: "turn_123",
        identity_key: "codex:UserPromptSubmit:turn_123:skill:common-git-commit",
        repo_path: "/Users/example/project",
        status: undefined,
        event_type: "capability_usage",
        capability_type: "skill",
        capability_name: "common-git-commit",
        attribution_confidence: "exact",
        invocation_origin: "explicit",
      },
    ]);
    assert.equal(JSON.stringify(adapterEvents).includes("请使用"), false);
    assert.equal(JSON.stringify(adapterEvents).includes("HOME"), false);
  });

  it("dedupes duplicate observed PostToolUse hooks by stable tool use ID", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "session_123",
      turn_id: "turn_123",
      cwd: "/Users/example/project",
      tool_name: "Bash",
      tool_use_id: "call_123",
    };

    const first = parseCodexHookPayload(payload, {
      observedAt: "2026-05-12T12:00:00.000Z",
    }).map((event) => normalizeEvent(event, config));
    const second = parseCodexHookPayload(payload, {
      observedAt: "2026-05-12T12:00:00.050Z",
    }).map((event) => normalizeEvent(event, config));

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0]?.event_id, second[0]?.event_id);
    assert.equal(first[0]?.occurred_at, "2026-05-12T12:00:00.000Z");
    assert.equal(second[0]?.occurred_at, "2026-05-12T12:00:00.050Z");
  });
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
