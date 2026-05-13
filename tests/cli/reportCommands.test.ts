import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ingestEvents } from "../../src/aggregator/aggregateEvents.js";
import { toLocalDate } from "../../src/aggregator/dailyStats.js";
import { appendJsonlRecord } from "../../src/collector/jsonlWriter.js";
import { runAgents } from "../../src/cli/commands/agents.js";
import { runCapabilityEvents } from "../../src/cli/commands/capabilityEvents.js";
import { runCapabilities } from "../../src/cli/commands/capabilities.js";
import { runSummary } from "../../src/cli/commands/summary.js";
import { runTurns } from "../../src/cli/commands/turns.js";
import { runUnused } from "../../src/cli/commands/unused.js";
import {
  ensureTrackerDirectories,
  resolveDailyEventsPath,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../../src/config/paths.js";
import { writeUserConfig } from "../../src/config/userConfig.js";
import type { UserConfig } from "../../src/types/config.js";
import type { NormalizedEvent } from "../../src/types/events.js";

const now = new Date("2026-05-12T13:00:00.000Z");

describe("report commands", () => {
  it("renders summary, agents, capabilities, and unused reports", async () => {
    const { homeDir, paths, events } = await createIngestedFixture();

    try {
      const summary = await runSummary({ paths, since: "7d", now: () => now });
      assert.equal(summary.ok, true);
      assert.match(summary.lines.join("\n"), /Total tokens\s+\|\s+3\.56M/);
      assert.match(summary.lines.join("\n"), /github\.create_pull_request/);

      const agents = await runAgents({
        paths,
        date: toLocalDate(events[0].occurred_at),
        now: () => now,
      });
      assert.equal(agents.ok, true);
      assert.match(agents.lines.join("\n"), /gpt-5\.1-codex/);
      assert.match(agents.lines.join("\n"), /3\.56M/);
      assert.match(agents.lines.join("\n"), /100\.0%/);

      const capabilities = await runCapabilities({
        paths,
        since: "30d",
        sort: "failures",
        type: "mcp_tool",
        agent: "codex",
        now: () => now,
      });
      assert.equal(capabilities.ok, true);
      assert.match(capabilities.lines.join("\n"), /github\.create_pull_request/);
      assert.match(capabilities.lines.join("\n"), /1\.25K/);
      assert.match(capabilities.lines.join("\n"), /0\.0%/);

      const skills = await runCapabilities({
        paths,
        since: "30d",
        sort: "duration",
        type: "skill",
        agent: "codex",
        now: () => now,
      });
      assert.equal(skills.ok, true);
      assert.match(skills.lines.join("\n"), /common-git-commit/);
      assert.match(skills.lines.join("\n"), /1\.0s/);

      const mcpEvents = await runCapabilityEvents({
        paths,
        since: "30d",
        type: "mcp_tool",
        name: "github.create_pull_request",
        agent: "codex",
        now: () => now,
      });
      assert.equal(mcpEvents.ok, true);
      assert.match(mcpEvents.lines.join("\n"), /Capability events/);
      assert.match(mcpEvents.lines.join("\n"), /200ms/);
      assert.match(mcpEvents.lines.join("\n"), /event/);
      assert.match(mcpEvents.lines.join("\n"), /1\.25K/);
      assert.match(mcpEvents.lines.join("\n"), /failure/);

      const skillEvents = await runCapabilityEvents({
        paths,
        since: "30d",
        type: "skill",
        name: "common-git-commit",
        agent: "codex",
        now: () => now,
      });
      assert.equal(skillEvents.ok, true);
      assert.match(skillEvents.lines.join("\n"), /common-git-commit/);
      assert.match(skillEvents.lines.join("\n"), /1\.0s/);
      assert.match(skillEvents.lines.join("\n"), /turn/);

      const invalidEvents = await runCapabilityEvents({
        paths,
        since: "30d",
        type: "skill",
        now: () => now,
      });
      assert.equal(invalidEvents.ok, false);
      assert.match(invalidEvents.lines.join("\n"), /Expected --name/);

      const turns = await runTurns({
        paths,
        since: "30d",
        agent: "codex",
        now: () => now,
      });
      assert.equal(turns.ok, true);
      assert.match(turns.lines.join("\n"), /gpt-5\.1-codex/);
      assert.match(turns.lines.join("\n"), /1\.0s/);

      const unused = await runUnused({ paths, since: "30d", now: () => now });
      const unusedOutput = unused.lines.join("\n");
      assert.equal(unused.ok, true);
      assert.match(unusedOutput, /common-dev-pattern/);
      assert.equal(unusedOutput.includes("github.create_pull_request"), false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("renders an empty state for reports without ingested data", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-report-test-"));

    try {
      const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
      const summary = await runSummary({ paths, since: "7d", now: () => now });

      assert.equal(summary.ok, true);
      assert.match(summary.lines.join("\n"), /No usage data found/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function createIngestedFixture(): Promise<{
  homeDir: string;
  paths: TrackerPaths;
  events: NormalizedEvent[];
}> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "himan-report-test-"));
  const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
  const events = createFixtureEvents();

  await ensureTrackerDirectories(paths);
  await writeUserConfig(paths, createTestConfig());

  for (const event of events) {
    await appendJsonlRecord(resolveDailyEventsPath(paths, event.occurred_at), event);
  }

  await ingestEvents({
    sqlitePath: paths.sqlitePath,
    eventsDir: paths.eventsDir,
    now: () => now,
  });

  return { homeDir, paths, events };
}

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
    known_capabilities: [
      {
        type: "skill",
        name: "common-dev-pattern",
      },
    ],
    local_salt: "test-salt",
  };
}

function createFixtureEvents(): NormalizedEvent[] {
  return [
    {
      schema_version: "1.0",
      event_id: "evt_turn_001",
      event_type: "turn_summary",
      occurred_at: "2026-05-12T12:00:00.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "success",
      model: "gpt-5.1-codex",
      duration_ms: 1_000,
      input_tokens: 3_500_000,
      output_tokens: 57_933,
      total_tokens: 3_557_933,
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_002",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:01.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "success",
      capability_type: "skill",
      capability_name: "common-git-commit",
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      adopted: "unknown",
      attribution_confidence: "exact",
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_001",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:02.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "failure",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      duration_ms: 200,
      input_tokens: 1_000,
      output_tokens: 250,
      total_tokens: 1_250,
      adopted: "unknown",
      attribution_confidence: "estimated",
    },
  ];
}
