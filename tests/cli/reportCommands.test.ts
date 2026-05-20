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
import { runTokens } from "../../src/cli/commands/tokens.js";
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
      const summaryOutput = summary.lines.join("\n");
      assert.equal(summary.ok, true);
      assert.match(summaryOutput, /Total runtime tokens\s+\|\s+3\.56M/);
      assert.match(summaryOutput, /Top 5 agents/);
      assert.match(summaryOutput, /Top 10 capabilities/);
      assert.match(summaryOutput, /github\.create_pull_request/);
      assert.match(summaryOutput, /github\.create_pull_request[^\n]*\|\s+400ms/);

      const limitedSummary = await runSummary({
        paths,
        since: "7d",
        limit: 1,
        now: () => now,
      });
      const limitedSummaryOutput = limitedSummary.lines.join("\n");
      assert.equal(limitedSummary.ok, true);
      assert.match(limitedSummaryOutput, /Top 1 capabilities/);
      assert.match(limitedSummaryOutput, /github\.create_pull_request/);
      assert.equal(limitedSummaryOutput.includes("common-git-commit"), false);

      const userCapabilitySummary = await runSummary({
        paths,
        since: "7d",
        excludeSystem: true,
        now: () => now,
      });
      const userCapabilitySummaryOutput = userCapabilitySummary.lines.join("\n");
      assert.equal(userCapabilitySummary.ok, true);
      assert.match(userCapabilitySummaryOutput, /github\.create_pull_request/);
      assert.equal(userCapabilitySummaryOutput.includes("apply_patch"), false);
      assert.equal(userCapabilitySummaryOutput.includes("Bash"), false);

      const invalidSummary = await runSummary({
        paths,
        since: "7d",
        limit: 0,
        now: () => now,
      });
      assert.equal(invalidSummary.ok, false);
      assert.match(invalidSummary.lines.join("\n"), /Expected --limit/);

      const tokens = await runTokens({ paths, since: "7d", period: "day", now: () => now });
      assert.equal(tokens.ok, true);
      assert.match(tokens.lines.join("\n"), /Runtime token usage by day/);
      assert.match(tokens.lines.join("\n"), /2026-05-12/);
      assert.match(tokens.lines.join("\n"), /3\.56M/);

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
      assert.match(capabilities.lines.join("\n"), /400ms\s+\|\s+200ms\s+\|\s+600ms/);
      assert.match(capabilities.lines.join("\n"), /0\.0%/);
      assert.match(capabilities.lines.join("\n"), /Observed/);

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
      assert.match(skills.lines.join("\n"), /2s\s+\|\s+1s\s+\|\s+3s/);
      assert.match(skills.lines.join("\n"), /Explicit/);

      const userCapabilities = await runCapabilities({
        paths,
        since: "30d",
        sort: "invocations",
        agent: "codex",
        excludeSystem: true,
        now: () => now,
      });
      const userCapabilitiesOutput = userCapabilities.lines.join("\n");
      assert.equal(userCapabilities.ok, true);
      assert.match(userCapabilitiesOutput, /github\.create_pull_request/);
      assert.equal(userCapabilitiesOutput.includes("apply_patch"), false);
      assert.equal(userCapabilitiesOutput.includes("Bash"), false);

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
      assert.match(mcpEvents.lines.join("\n"), /observed/);

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
      assert.match(skillEvents.lines.join("\n"), /1s/);
      assert.match(skillEvents.lines.join("\n"), /turn/);
      assert.match(skillEvents.lines.join("\n"), /explicit/);

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
      assert.match(turns.lines.join("\n"), /1s/);

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
      const tokens = await runTokens({ paths, since: "7d", period: "week", now: () => now });

      assert.equal(summary.ok, true);
      assert.match(summary.lines.join("\n"), /No usage data found/);
      assert.equal(tokens.ok, true);
      assert.match(tokens.lines.join("\n"), /No runtime token usage found/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("renders token usage grouped by day, week, and month", async () => {
    const { homeDir, paths } = await createIngestedTokenFixture();

    try {
      const daily = await runTokens({ paths, since: "30d", period: "day", now: () => now });
      const dailyOutput = daily.lines.join("\n");
      assert.equal(daily.ok, true);
      assert.match(dailyOutput, /Runtime token usage by day/);
      assert.match(dailyOutput, /2026-04-28\s+\|\s+1\s+\|\s+1K\s+\|\s+500\s+\|\s+1\.5K/);
      assert.match(dailyOutput, /2026-05-01\s+\|\s+1\s+\|\s+2K\s+\|\s+500\s+\|\s+2\.5K/);
      assert.match(dailyOutput, /2026-05-12\s+\|\s+1\s+\|\s+2\.5K\s+\|\s+500\s+\|\s+3K/);
      assert.deepEqual(extractTokenReportPeriods(dailyOutput), [
        "2026-05-12",
        "2026-05-01",
        "2026-04-28",
      ]);

      const weekly = await runTokens({ paths, since: "30d", period: "week", now: () => now });
      const weeklyOutput = weekly.lines.join("\n");
      assert.equal(weekly.ok, true);
      assert.match(weeklyOutput, /2026 Week 18 \(04-27 ~ 05-03\)\s+\|\s+2\s+\|\s+3K\s+\|\s+1K\s+\|\s+4K\s+\|\s+2K/);
      assert.match(weeklyOutput, /2026 Week 20 \(05-11 ~ 05-17\)\s+\|\s+1\s+\|\s+2\.5K\s+\|\s+500\s+\|\s+3K\s+\|\s+3K/);
      assert.deepEqual(extractTokenReportPeriods(weeklyOutput), [
        "2026 Week 20 (05-11 ~ 05-17)",
        "2026 Week 18 (04-27 ~ 05-03)",
      ]);

      const monthly = await runTokens({ paths, since: "30d", period: "month", now: () => now });
      const monthlyOutput = monthly.lines.join("\n");
      assert.equal(monthly.ok, true);
      assert.match(monthlyOutput, /2026-04\s+\|\s+1\s+\|\s+1K\s+\|\s+500\s+\|\s+1\.5K/);
      assert.match(monthlyOutput, /2026-05\s+\|\s+2\s+\|\s+4\.5K\s+\|\s+1K\s+\|\s+5\.5K/);
      assert.deepEqual(extractTokenReportPeriods(monthlyOutput), ["2026-05", "2026-04"]);

      const invalidPeriod = await runTokens({
        paths,
        since: "30d",
        period: "quarter",
        now: () => now,
      });
      assert.equal(invalidPeriod.ok, false);
      assert.match(invalidPeriod.lines.join("\n"), /Expected --period/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function extractTokenReportPeriods(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /^(?:\d{4}-\d{2}|\d{4} Week \d+)/.test(line))
    .map((line) => line.split("|")[0]?.trim() ?? "");
}

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

async function createIngestedTokenFixture(): Promise<{
  homeDir: string;
  paths: TrackerPaths;
}> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "himan-token-report-test-"));
  const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
  const events = createTokenFixtureEvents();

  await ensureTrackerDirectories(paths);

  for (const event of events) {
    await appendJsonlRecord(resolveDailyEventsPath(paths, event.occurred_at), event);
  }

  await ingestEvents({
    sqlitePath: paths.sqlitePath,
    eventsDir: paths.eventsDir,
    now: () => now,
  });

  return { homeDir, paths };
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
      event_id: "evt_turn_002",
      event_type: "turn_summary",
      occurred_at: "2026-05-12T12:00:05.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_002",
      repo_hash: "repo_hash_001",
      status: "success",
      model: "gpt-5.1-codex",
      duration_ms: 3_000,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
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
      invocation_origin: "explicit",
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_004",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:06.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_002",
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
      invocation_origin: "explicit",
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
      invocation_origin: "observed",
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_003",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:07.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "failure",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      duration_ms: 600,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      adopted: "unknown",
      attribution_confidence: "estimated",
      invocation_origin: "observed",
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_005",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:08.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "failure",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      adopted: "unknown",
      attribution_confidence: "estimated",
      invocation_origin: "observed",
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_builtin_001",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:03.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "success",
      capability_type: "builtin_tool",
      capability_name: "apply_patch",
      duration_ms: 100,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      adopted: "unknown",
      attribution_confidence: "exact",
      invocation_origin: "observed",
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_builtin_legacy_001",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:04.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "success",
      capability_type: "unknown",
      capability_name: "Bash",
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      adopted: "unknown",
      attribution_confidence: "unknown",
      invocation_origin: "observed",
    },
  ];
}

function createTokenFixtureEvents(): NormalizedEvent[] {
  return [
    createTokenTurnEvent({
      eventId: "evt_token_001",
      occurredAt: "2026-04-28T12:00:00.000Z",
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
    }),
    createTokenTurnEvent({
      eventId: "evt_token_002",
      occurredAt: "2026-05-01T12:00:00.000Z",
      inputTokens: 2_000,
      outputTokens: 500,
      totalTokens: 2_500,
    }),
    createTokenTurnEvent({
      eventId: "evt_token_003",
      occurredAt: "2026-05-12T12:00:00.000Z",
      inputTokens: 2_500,
      outputTokens: 500,
      totalTokens: 3_000,
    }),
  ];
}

function createTokenTurnEvent(options: {
  eventId: string;
  occurredAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): NormalizedEvent {
  return {
    schema_version: "1.0",
    event_id: options.eventId,
    event_type: "turn_summary",
    occurred_at: options.occurredAt,
    agent: "codex",
    source: "fixture",
    session_id: "s_tokens",
    turn_id: options.eventId.replace("evt_", "turn_"),
    repo_hash: "repo_hash_tokens",
    status: "success",
    model: "gpt-5.1-codex",
    duration_ms: 1_000,
    input_tokens: options.inputTokens,
    output_tokens: options.outputTokens,
    total_tokens: options.totalTokens,
  };
}
