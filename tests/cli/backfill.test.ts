import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runBackfill } from "../../src/cli/commands/backfill.js";
import { resolveDailyEventsPath, resolveTrackerPaths } from "../../src/config/paths.js";
import type { UserConfig } from "../../src/types/config.js";

describe("backfill command", () => {
  it("backfills Codex transcripts and skips duplicate event IDs on repeated runs", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-backfill-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const transcriptDir = path.join(homeDir, "codex-transcripts");
    const transcriptPath = path.join(transcriptDir, "rollout-2026-05-15T10-00-00-session_123.jsonl");

    try {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-05-15T02:00:00.000Z",
            payload: {
              id: "session_123",
              timestamp: "2026-05-15T02:00:00.000Z",
              cwd: "/Users/example/private-project",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T02:00:00.000Z",
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
            timestamp: "2026-05-15T02:00:01.000Z",
            payload: {
              type: "task_started",
              turn_id: "turn_123",
            },
          }),
          JSON.stringify({
            type: "turn_context",
            timestamp: "2026-05-15T02:00:01.500Z",
            payload: {
              turn_id: "turn_123",
              cwd: "/Users/example/private-project",
              model: "gpt-5.5",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T02:00:01.750Z",
            payload: {
              type: "user_message",
              message: "Please use $common-dev-pattern for this change; $skill-name is only documentation syntax.",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-15T02:00:02.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call_shell_123",
              arguments: JSON.stringify({
                cmd: "printf should-not-be-stored && sed -n '1,80p' /Users/example/private-project/.agents/skills/common-project-tech-design/SKILL.md",
                workdir: "/Users/example/private-project",
              }),
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-15T02:00:03.250Z",
            payload: {
              type: "function_call_output",
              call_id: "call_shell_123",
              output: "secret output should not be stored",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-15T02:00:04.000Z",
            payload: {
              type: "function_call",
              name: "search_openai_docs",
              call_id: "call_mcp_123",
              arguments: JSON.stringify({ query: "should not persist" }),
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T02:00:04.900Z",
            payload: {
              type: "mcp_tool_call_end",
              call_id: "call_mcp_123",
              invocation: {
                server: "openaiDeveloperDocs",
                tool: "search_openai_docs",
                arguments: {
                  query: "should not persist",
                },
              },
              duration: {
                secs: 0,
                nanos: 900_000_000,
              },
              result: {
                Ok: [],
              },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T02:00:05.000Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 250,
                  output_tokens: 80,
                  total_tokens: 330,
                },
              },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T02:00:06.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn_123",
              duration_ms: 5_000,
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const first = await runBackfill({
        paths,
        config: createTestConfig(),
        date: "2026-05-15",
        from: transcriptDir,
      });

      assert.equal(first.ok, true);
      assert.match(first.lines.join("\n"), /Transcript files: 1/);
      assert.match(first.lines.join("\n"), /Written events: 6/);
      assert.match(first.lines.join("\n"), /Skipped duplicates: 0/);

      const eventPath = resolveDailyEventsPath(paths, "2026-05-15T02:00:06.000Z");
      const rawEvents = await readFile(eventPath, "utf8");
      const events = rawEvents
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turn = events.find((event) => event.event_type === "turn_summary");
      const shellTool = events.find((event) => event.capability_name === "functions.exec_command");
      const mcpTool = events.find(
        (event) => event.capability_name === "openaiDeveloperDocs.search_openai_docs",
      );
      const explicitSkill = events.find(
        (event) => event.capability_name === "common-dev-pattern",
      );
      const inferredSkill = events.find(
        (event) => event.capability_name === "common-project-tech-design",
      );

      assert.equal(events.length, 6);
      assert.equal(turn?.input_tokens, 150);
      assert.equal(turn?.output_tokens, 60);
      assert.equal(turn?.total_tokens, 210);
      assert.equal(turn?.duration_ms, 5_000);
      assert.equal(shellTool?.duration_ms, 1_250);
      assert.equal(mcpTool?.duration_ms, 900);
      assert.equal(mcpTool?.status, "success");
      assert.equal(explicitSkill?.invocation_origin, "explicit");
      assert.equal(explicitSkill?.attribution_confidence, "exact");
      assert.equal(inferredSkill?.invocation_origin, "inferred");
      assert.equal(inferredSkill?.attribution_confidence, "estimated");
      assert.equal(rawEvents.includes("should-not-be-stored"), false);
      assert.equal(rawEvents.includes("secret output"), false);
      assert.equal(rawEvents.includes("/Users/example/private-project"), false);

      const second = await runBackfill({
        paths,
        config: createTestConfig(),
        date: "2026-05-15",
        from: transcriptDir,
      });
      const repeatedRawEvents = await readFile(eventPath, "utf8");

      assert.equal(second.ok, true);
      assert.match(second.lines.join("\n"), /Parsed events: 0/);
      assert.match(second.lines.join("\n"), /Written events: 0/);
      assert.match(second.lines.join("\n"), /Skipped duplicates: 0/);
      assert.match(second.lines.join("\n"), /Sources skipped by cursor: 1/);
      assert.equal(repeatedRawEvents.trimEnd().split("\n").length, 6);

      const forced = await runBackfill({
        paths,
        config: createTestConfig(),
        date: "2026-05-15",
        from: transcriptDir,
        ignoreCursor: true,
      });
      const forcedRawEvents = await readFile(eventPath, "utf8");

      assert.equal(forced.ok, true);
      assert.match(forced.lines.join("\n"), /Parsed events: 6/);
      assert.match(forced.lines.join("\n"), /Written events: 0/);
      assert.match(forced.lines.join("\n"), /Skipped duplicates: 6/);
      assert.match(forced.lines.join("\n"), /Sources skipped by cursor: 0/);
      assert.equal(forcedRawEvents.trimEnd().split("\n").length, 6);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("skips similar existing hook events when event IDs differ", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-backfill-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const transcriptDir = path.join(homeDir, "codex-transcripts");
    const transcriptPath = path.join(transcriptDir, "rollout-2026-05-15T11-00-00-session_456.jsonl");
    const eventPath = resolveDailyEventsPath(paths, "2026-05-15T03:00:06.000Z");

    try {
      await mkdir(transcriptDir, { recursive: true });
      await mkdir(path.dirname(eventPath), { recursive: true });
      await writeFile(
        eventPath,
        `${JSON.stringify({
          schema_version: "1.0",
          event_id: "existing-hook-turn-event",
          event_type: "turn_summary",
          occurred_at: "2026-05-15T03:00:06.000Z",
          agent: "codex",
          source: "codex-hook",
          session_id: "session_456",
          turn_id: "turn_456",
          repo_hash: "existing",
          status: "success",
          model: "gpt-5.5",
          duration_ms: 5_000,
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        })}\n`,
        "utf8",
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-05-15T03:00:00.000Z",
            payload: {
              id: "session_456",
              timestamp: "2026-05-15T03:00:00.000Z",
              cwd: "/Users/example/private-project",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T03:00:01.000Z",
            payload: {
              type: "task_started",
              turn_id: "turn_456",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T03:00:06.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn_456",
              duration_ms: 5_000,
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const result = await runBackfill({
        paths,
        config: createTestConfig(),
        date: "2026-05-15",
        from: transcriptDir,
      });
      const rawEvents = await readFile(eventPath, "utf8");

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Parsed events: 2/);
      assert.match(result.lines.join("\n"), /Written events: 1/);
      assert.match(result.lines.join("\n"), /Skipped duplicates: 1/);
      assert.equal(rawEvents.trimEnd().split("\n").length, 2);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not infer skills from transcript prompt context alone", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-backfill-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const transcriptDir = path.join(homeDir, "codex-transcripts");
    const transcriptPath = path.join(transcriptDir, "rollout-2026-05-15T12-00-00-session_789.jsonl");

    try {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-05-15T04:00:00.000Z",
            payload: {
              id: "session_789",
              timestamp: "2026-05-15T04:00:00.000Z",
              cwd: "/Users/example/private-project",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T04:00:01.000Z",
            payload: {
              type: "task_started",
              turn_id: "turn_789",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-15T04:00:02.000Z",
            payload: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Available skills include $common-dev-pattern and /Users/example/private-project/.agents/skills/common-project-tech-design/SKILL.md",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-15T04:00:06.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn_789",
              duration_ms: 5_000,
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const result = await runBackfill({
        paths,
        config: createTestConfig(),
        date: "2026-05-15",
        from: transcriptDir,
      });

      const eventPath = resolveDailyEventsPath(paths, "2026-05-15T04:00:06.000Z");
      const rawEvents = await readFile(eventPath, "utf8");
      const events = rawEvents
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Written events: 2/);
      assert.equal(events.length, 2);
      assert.equal(events.some((event) => event.capability_type === "skill"), false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("processes copilot --since source once instead of repeating full scans per day", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-backfill-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const transcriptDir = path.join(homeDir, "copilot-transcripts");
    const fixturePath = path.resolve("tests/fixtures/copilot/raw/session.jsonl");
    const transcriptPath = path.join(transcriptDir, "session.jsonl");

    try {
      await mkdir(transcriptDir, { recursive: true });
      await copyFile(fixturePath, transcriptPath);

      const result = await runBackfill({
        paths,
        config: createTestConfig(),
        agent: "copilot",
        since: "2026-05-29",
        from: transcriptDir,
        now: () => new Date("2026-05-31T12:00:00.000Z"),
      });

      const output = result.lines.join("\n");
      assert.equal(result.ok, true);
      assert.match(output, /Range: 2026-05-29 → 2026-05-31 \(3 days\)/);
      assert.match(output, /Transcript files: 1/);
      assert.match(output, /Skipped duplicates: 0/);

      const second = await runBackfill({
        paths,
        config: createTestConfig(),
        agent: "copilot",
        since: "2026-05-29",
        from: transcriptDir,
        now: () => new Date("2026-05-31T12:00:00.000Z"),
      });
      const secondOutput = second.lines.join("\n");
      assert.equal(second.ok, true);
      assert.match(secondOutput, /Parsed events: 0/);
      assert.match(secondOutput, /Written events: 0/);
      assert.match(secondOutput, /Sources skipped by cursor: 1/);

      const forced = await runBackfill({
        paths,
        config: createTestConfig(),
        agent: "copilot",
        since: "2026-05-29",
        from: transcriptDir,
        ignoreCursor: true,
        now: () => new Date("2026-05-31T12:00:00.000Z"),
      });
      const forcedOutput = forced.lines.join("\n");
      assert.equal(forced.ok, true);
      assert.match(forcedOutput, /Parsed events: 6/);
      assert.match(forcedOutput, /Written events: 0/);
      assert.match(forcedOutput, /Skipped duplicates: 6/);
      assert.match(forcedOutput, /Sources skipped by cursor: 0/);
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
