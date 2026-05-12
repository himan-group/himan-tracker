import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { collectAdapterEvent } from "../../src/collector/hookCollector.js";
import { resolveTrackerPaths, type TrackerPaths } from "../../src/config/paths.js";
import type { UserConfig } from "../../src/types/config.js";
import type { AdapterEvent } from "../../src/types/events.js";

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

describe("collectAdapterEvent", () => {
  it("writes normalized events without raw repo paths or shell args", async () => {
    const { homeDir, paths } = await createTempPaths();

    try {
      const result = await collectAdapterEvent(
        {
          event_type: "capability_usage",
          occurred_at: "2026-05-12T03:45:12.000Z",
          agent: "codex",
          source: "codex-hook",
          session_id: "s_001",
          turn_id: "t_001",
          repo_path: "/Users/example/private-project",
          capability_type: "shell_command",
          capability_name: "git status --short",
          status: "success",
        },
        { paths, config },
      );

      assert.equal(result.ok, true);
      assert.equal(result.accepted, true);

      const rawEvents = await readFile(paths.eventsPath, "utf8");
      assert.equal(rawEvents.includes("/Users/example/private-project"), false);
      assert.equal(rawEvents.includes("git status --short"), false);

      const [event] = rawEvents.trimEnd().split("\n").map((line) => JSON.parse(line));
      assert.equal(event.event_type, "capability_usage");
      assert.equal(event.capability_name, "git");
      assert.equal(typeof event.repo_hash, "string");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("fails open and writes sanitized errors when validation fails", async () => {
    const { homeDir, paths } = await createTempPaths();
    const eventWithSensitiveExtras = {
      event_type: "turn_summary",
      occurred_at: "2026-05-12T03:45:00.000Z",
      agent: "codex",
      source: "codex-hook",
      session_id: "s_001",
      repo_path: "/Users/example/private-project",
      status: "success",
      duration_ms: -1,
      prompt: "do not store this prompt",
      response: "do not store this response",
      code: "do not store this code",
    } as unknown as AdapterEvent;

    try {
      const result = await collectAdapterEvent(eventWithSensitiveExtras, {
        paths,
        config,
        now: () => new Date("2026-05-12T04:00:00.000Z"),
      });

      assert.equal(result.ok, true);
      assert.equal(result.accepted, false);
      assert.equal(result.error_logged, true);

      const rawErrors = await readFile(paths.errorsPath, "utf8");
      assert.equal(rawErrors.includes("/Users/example/private-project"), false);
      assert.equal(rawErrors.includes("do not store this prompt"), false);
      assert.equal(rawErrors.includes("do not store this response"), false);
      assert.equal(rawErrors.includes("do not store this code"), false);

      const [errorRecord] = rawErrors.trimEnd().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(errorRecord, {
        schema_version: "1.0",
        occurred_at: "2026-05-12T04:00:00.000Z",
        source: "collector",
        agent: "codex",
        message: "collector failed",
        details: {
          reason: result.accepted ? "" : result.error.details.reason,
          event_type: "turn_summary",
        },
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not throw when the event log cannot be written", async () => {
    const { homeDir, paths } = await createTempPaths();
    const unwritableEventsPath: TrackerPaths = {
      ...paths,
      eventsPath: homeDir,
    };

    try {
      const result = await collectAdapterEvent(
        {
          event_type: "turn_summary",
          occurred_at: "2026-05-12T03:45:00.000Z",
          agent: "claude-code",
          source: "claude-code-hook",
          session_id: "s_001",
          turn_id: "t_001",
          status: "success",
          model: "claude-sonnet-4",
          duration_ms: 42_000,
        },
        {
          paths: unwritableEventsPath,
          config,
          now: () => new Date("2026-05-12T04:05:00.000Z"),
        },
      );

      assert.equal(result.ok, true);
      assert.equal(result.accepted, false);
      assert.equal(result.error_logged, true);

      const rawErrors = await readFile(paths.errorsPath, "utf8");
      const [errorRecord] = rawErrors.trimEnd().split("\n").map((line) => JSON.parse(line));

      assert.equal(errorRecord.source, "collector");
      assert.equal(errorRecord.agent, "claude-code");
      assert.equal(errorRecord.details.event_type, "turn_summary");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function createTempPaths(): Promise<{ homeDir: string; paths: TrackerPaths }> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "himan-hook-collector-test-"));
  return {
    homeDir,
    paths: resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir }),
  };
}
