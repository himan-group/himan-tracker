import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parseClaudeCodeHookPayload } from "../../src/adapters/claude-code/index.js";
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

describe("parseClaudeCodeHookPayload", () => {
  it("parses the Claude Code raw fixture into stable normalized events", async () => {
    const rawPayload = await readJson("tests/fixtures/claude-code/raw/session.json");
    const expectedEvents = (await readJson(
      "tests/fixtures/claude-code/normalized/events.json",
    )) as NormalizedEvent[];

    const normalizedEvents = parseClaudeCodeHookPayload(rawPayload).map((event) =>
      normalizeEvent(event, config),
    );

    assert.deepEqual(normalizedEvents, expectedEvents);
    assert.equal(JSON.stringify(normalizedEvents).includes("/Users/example/project"), false);
  });

  it("ignores unrecognized hooks without throwing", () => {
    assert.deepEqual(
      parseClaudeCodeHookPayload({
        events: [
          {
            type: "future_event",
            response: "do not store this response",
          },
        ],
      }),
      [],
    );
  });
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}
