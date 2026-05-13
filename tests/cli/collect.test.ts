import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runCollect } from "../../src/cli/commands/collect.js";
import { resolveDailyEventsPath, resolveTrackerPaths } from "../../src/config/paths.js";
import { writeUserConfig } from "../../src/config/userConfig.js";
import type { UserConfig } from "../../src/types/config.js";

describe("collect codex command", () => {
  it("queues and drains Codex payloads into daily JSONL shards", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const rawPayload = await readFile("tests/fixtures/codex/raw/session.json", "utf8");

    try {
      await writeUserConfig(paths, createTestConfig());

      const result = await runCollect({
        paths,
        input: rawPayload,
        sync: true,
        startWorker: false,
        now: () => new Date("2026-05-12T13:00:00.000Z"),
      });

      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.match(result.lines.join("\n"), /Parsed events: 4/);
      assert.match(result.lines.join("\n"), /Queued events: 4/);
      assert.match(result.lines.join("\n"), /Written events: 4/);

      const rawEvents = await readFile(
        resolveDailyEventsPath(paths, "2026-05-12T12:00:00.000Z"),
        "utf8",
      );
      const lines = rawEvents.trimEnd().split("\n");

      assert.equal(lines.length, 4);
      assert.equal(rawEvents.includes("/Users/example/project"), false);
      assert.equal(JSON.parse(lines[0] ?? "{}").agent, "codex");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("queues normalized events without plaintext repo paths", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const rawPayload = await readFile("tests/fixtures/codex/raw/session.json", "utf8");

    try {
      await writeUserConfig(paths, createTestConfig());

      const result = await runCollect({
        paths,
        input: rawPayload,
        startWorker: false,
        now: () => new Date("2026-05-12T13:00:00.000Z"),
      });
      const queuePath = result.lines
        .find((line) => line.startsWith("Queue file: "))
        ?.replace("Queue file: ", "");

      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.ok(queuePath);

      const queuedPayload = await readFile(queuePath, "utf8");
      assert.equal(queuedPayload.includes("/Users/example/project"), false);
      assert.equal(queuedPayload.includes("repo_path"), false);
      assert.equal(queuedPayload.includes("repo_hash"), true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("enriches Codex stop events from transcript token snapshots during drain", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const transcriptPath = path.join(homeDir, "codex-rollout.jsonl");
    const rawPayload = JSON.stringify({
      events: [
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "session_123",
          turn_id: "turn_123",
          cwd: "/Users/example/project",
          prompt: "请使用 $common-git-commit，不要保存这段 prompt",
        },
        {
          hook_event_name: "Stop",
          session_id: "session_123",
          turn_id: "turn_123",
          cwd: "/Users/example/project",
          model: "gpt-5.5",
          transcript_path: transcriptPath,
        },
        {
          hook_event_name: "PostToolUse",
          session_id: "session_123",
          turn_id: "turn_123",
          cwd: "/Users/example/project",
          tool_name: "mcp__openaiDeveloperDocs__search_openai_docs",
          tool_use_id: "call_mcp_123",
          transcript_path: transcriptPath,
        },
      ],
    });

    try {
      await writeUserConfig(paths, createTestConfig());
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-12T11:59:59.000Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  total_tokens: 120,
                },
              },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-12T12:00:00.000Z",
            payload: {
              type: "task_started",
            },
          }),
          JSON.stringify({
            type: "turn_context",
            timestamp: "2026-05-12T12:00:01.000Z",
            payload: {
              turn_id: "turn_123",
              model: "gpt-5.5",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-12T12:00:02.000Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  total_tokens: 120,
                },
              },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-12T12:00:08.000Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 250,
                  output_tokens: 70,
                  total_tokens: 320,
                },
              },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-12T12:00:09.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn_123",
              duration_ms: 9_000,
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-12T12:00:09.500Z",
            payload: {
              type: "mcp_tool_call_end",
              call_id: "call_mcp_123",
              duration: {
                secs: 1,
                nanos: 250_000_000,
              },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const result = await runCollect({
        paths,
        input: rawPayload,
        sync: true,
        startWorker: false,
        now: () => new Date("2026-05-12T12:00:10.000Z"),
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Queued enrichments: 2/);
      assert.match(result.lines.join("\n"), /Written events: 3/);

      const rawEvents = await readFile(
        resolveDailyEventsPath(paths, "2026-05-12T12:00:10.000Z"),
        "utf8",
      );
      const events = rawEvents
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turn = events.find((event) => event.event_type === "turn_summary");
      const skill = events.find((event) => event.capability_type === "skill");
      const mcpTool = events.find(
        (event) => event.capability_name === "openaiDeveloperDocs.search_openai_docs",
      );

      assert.equal(turn?.input_tokens, 150);
      assert.equal(turn?.output_tokens, 50);
      assert.equal(turn?.total_tokens, 200);
      assert.equal(turn?.duration_ms, 9_000);
      assert.equal(skill?.capability_name, "common-git-commit");
      assert.equal(mcpTool?.duration_ms, 1_250);
      assert.equal(rawEvents.includes("不要保存这段 prompt"), false);
      assert.equal(rawEvents.includes("/Users/example/project"), false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON input without blocking by default", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const result = await runCollect({ paths, input: "{not json", startWorker: false });

      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 0);
      assert.match(result.lines.join("\n"), /Invalid JSON payload/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("can use strict mode for manual validation failures", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const result = await runCollect({
        paths,
        input: "{not json",
        strict: true,
        startWorker: false,
      });

      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.match(result.lines.join("\n"), /use --strict for manual validation failures/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function createTestConfig(): UserConfig {
  return {
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
}
