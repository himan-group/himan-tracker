import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
