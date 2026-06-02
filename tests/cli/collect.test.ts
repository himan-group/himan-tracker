import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      assert.equal(skill?.invocation_origin, "explicit");
      assert.equal(mcpTool?.invocation_origin, "observed");
      assert.equal(mcpTool?.duration_ms, 1_250);
      assert.equal(rawEvents.includes("不要保存这段 prompt"), false);
      assert.equal(rawEvents.includes("/Users/example/project"), false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("adds transcript-derived Codex MCP tools and inferred skill usage", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const transcriptPath = path.join(homeDir, "codex-rollout.jsonl");
    const rawPayload = JSON.stringify({
      events: [
        {
          hook_event_name: "Stop",
          session_id: "session_456",
          turn_id: "turn_456",
          cwd: "/Users/example/project",
          model: "gpt-5.5",
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
            timestamp: "2026-05-13T12:00:00.000Z",
            payload: {
              type: "task_started",
              turn_id: "turn_456",
            },
          }),
          JSON.stringify({
            type: "turn_context",
            timestamp: "2026-05-13T12:00:01.000Z",
            payload: {
              turn_id: "turn_456",
              model: "gpt-5.5",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-13T12:00:02.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call_skill_456",
              arguments: JSON.stringify({
                cmd: "sed -n '1,220p' .agents/skills/common-dev-pattern/SKILL.md",
                workdir: "/Users/example/project",
              }),
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-13T12:00:03.000Z",
            payload: {
              type: "function_call",
              name: "search_openai_docs",
              call_id: "call_mcp_456",
              arguments: JSON.stringify({ query: "should not be stored" }),
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-13T12:00:03.900Z",
            payload: {
              type: "mcp_tool_call_end",
              call_id: "call_mcp_456",
              invocation: {
                server: "openaiDeveloperDocs",
                tool: "search_openai_docs",
                arguments: {
                  query: "should not be stored",
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
            timestamp: "2026-05-13T12:00:04.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn_456",
              duration_ms: 4_000,
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
        now: () => new Date("2026-05-13T12:00:05.000Z"),
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Queued enrichments: 1/);
      assert.match(result.lines.join("\n"), /Written events: 3/);

      const rawEvents = await readFile(
        resolveDailyEventsPath(paths, "2026-05-13T12:00:05.000Z"),
        "utf8",
      );
      const events = rawEvents
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const skill = events.find((event) => event.capability_type === "skill");
      const mcpTool = events.find(
        (event) => event.capability_name === "openaiDeveloperDocs.search_openai_docs",
      );

      assert.equal(skill?.capability_name, "common-dev-pattern");
      assert.equal(skill?.source, "codex-transcript");
      assert.equal(skill?.attribution_confidence, "estimated");
      assert.equal(skill?.invocation_origin, "inferred");
      assert.equal(skill?.attribution_basis, "transcript_shell_skill_path");
      assert.equal(skill?.attribution_context_source, "transcript_only");
      assert.equal(skill?.attribution_score, 50);
      assert.equal(mcpTool?.capability_type, "mcp_tool");
      assert.equal(mcpTool?.source, "codex-transcript");
      assert.equal(mcpTool?.invocation_origin, "observed");
      assert.equal(mcpTool?.attribution_basis, "transcript_mcp_tool_end");
      assert.equal(mcpTool?.attribution_score, 100);
      assert.equal(mcpTool?.status, "success");
      assert.equal(mcpTool?.duration_ms, 900);
      assert.equal(rawEvents.includes("should not be stored"), false);
      assert.equal(rawEvents.includes("SKILL.md"), false);
      assert.equal(rawEvents.includes("/Users/example/project"), false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("confirms transcript-derived Codex skill usage with himan.lock when available", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-collect-codex-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const projectDir = path.join(homeDir, "project");
    const transcriptPath = path.join(homeDir, "codex-rollout.jsonl");
    const rawPayload = JSON.stringify({
      events: [
        {
          hook_event_name: "Stop",
          session_id: "session_himan_lock",
          turn_id: "turn_himan_lock",
          cwd: projectDir,
          model: "gpt-5.5",
          transcript_path: transcriptPath,
        },
      ],
    });

    try {
      await writeUserConfig(paths, createTestConfig());
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, "himan.lock"),
        JSON.stringify({
          version: 1,
          resources: [
            {
              type: "skill",
              name: "managed-skill",
              version: "1.0.0",
              agents: ["codex"],
              mode: "copy",
            },
            {
              type: "skill",
              name: "claude-only",
              version: "1.0.0",
              agents: ["claude-code"],
              mode: "copy",
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-13T12:00:00.000Z",
            payload: {
              type: "task_started",
              turn_id: "turn_himan_lock",
            },
          }),
          JSON.stringify({
            type: "turn_context",
            timestamp: "2026-05-13T12:00:01.000Z",
            payload: {
              turn_id: "turn_himan_lock",
              model: "gpt-5.5",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-13T12:00:02.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call_skill_himan_lock",
              arguments: JSON.stringify({
                cmd: [
                  "sed -n '1,80p' .agents/skills/managed-skill/SKILL.md",
                  "sed -n '1,80p' .agents/skills/unmanaged-skill/SKILL.md",
                  "sed -n '1,80p' .agents/skills/claude-only/SKILL.md",
                ].join(" && "),
                workdir: projectDir,
              }),
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-05-13T12:00:04.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn_himan_lock",
              duration_ms: 4_000,
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
        now: () => new Date("2026-05-13T12:00:05.000Z"),
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Written events: 2/);

      const rawEvents = await readFile(
        resolveDailyEventsPath(paths, "2026-05-13T12:00:05.000Z"),
        "utf8",
      );
      const events = rawEvents
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const skills = events.filter((event) => event.capability_type === "skill");

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.capability_name, "managed-skill");
      assert.equal(skills[0]?.attribution_confidence, "estimated");
      assert.equal(skills[0]?.invocation_origin, "inferred");
      assert.equal(skills[0]?.attribution_basis, "transcript_shell_skill_path");
      assert.equal(skills[0]?.attribution_context_source, "himan_lock");
      assert.equal(skills[0]?.attribution_score, 80);
      assert.equal(rawEvents.includes(projectDir), false);
      assert.equal(rawEvents.includes("SKILL.md"), false);
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
