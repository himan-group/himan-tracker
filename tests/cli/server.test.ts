import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { appendJsonlRecord } from "../../src/collector/jsonlWriter.js";
import {
  runServerStart,
  runServerStatus,
  runServerStop,
} from "../../src/cli/commands/server.js";
import {
  ensureTrackerDirectories,
  resolveDailyEventsPath,
  resolveTrackerPaths,
} from "../../src/config/paths.js";
import {
  readReportServerState,
  resolveReportServerStatePath,
  startReportHttpServer,
} from "../../src/server/reportServer.js";
import type { NormalizedEvent } from "../../src/types/events.js";

const now = new Date("2026-05-12T13:00:00.000Z");

describe("server command", () => {
  it("serves a dashboard page and ingests events before rendering", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const events = [createTurnEvent(), ...createServerCapabilityEvents()];

    await ensureTrackerDirectories(paths);
    for (const event of events) {
      await appendJsonlRecord(resolveDailyEventsPath(paths, event.occurred_at), event);
    }

    const instance = await startReportHttpServer({
      paths,
      host: "127.0.0.1",
      port: 0,
      intervalSeconds: 60,
      since: "7d",
      display: "table",
      now: () => now,
    });

    try {
      const response = await fetch(instance.url);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /himan-tracker/);
      assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
      assert.match(html, /<table>/);
      assert.match(html, /href="\/" aria-current="page">Overview<\/a>/);
      assert.match(html, /href="\/metrics">Metrics<\/a>/);
      assert.match(html, /Summary/);
      const summaryHtml = html.slice(
        html.indexOf("<h2>Summary</h2>"),
        html.indexOf("<h2>Token usage</h2>"),
      );
      assert.match(
        summaryHtml,
        /<p class="table-note">Summary \(2026-05-06 to 2026-05-12\)<\/p>/,
      );
      assert.match(summaryHtml, /Total tokens/);
      assert.match(summaryHtml, /Success rate/);
      assert.match(summaryHtml, /<p class="table-note">Top 5 agents<\/p>/);
      assert.match(summaryHtml, /<p class="table-note">Top 15 capabilities<\/p>/);
      assert.match(summaryHtml, /<table>/);
      assert.match(summaryHtml, /<div class="table-scroll is-compact">/);
      assert.equal(summaryHtml.includes('<pre class="cli-output">'), false);
      assert.match(summaryHtml, /server-capability-15/);
      assert.equal(summaryHtml.includes("server-capability-16"), false);
      assert.equal(summaryHtml.includes("apply_patch"), false);
      assert.equal(summaryHtml.includes("Bash"), false);
      assert.match(html, /Token usage/);
      assert.ok(html.indexOf("<h2>Summary</h2>") < html.indexOf("<h2>Token usage</h2>"));
      assert.match(html, /role="tablist"/);
      assert.match(html, /role="tab"[^>]*>Daily<\/button>/);
      assert.match(html, /role="tab"[^>]*>Weekly<\/button>/);
      assert.match(html, /role="tab"[^>]*>Monthly<\/button>/);
      assert.equal(html.includes("Daily tokens"), false);
      assert.equal(html.includes("Weekly tokens"), false);
      assert.equal(html.includes("Monthly tokens"), false);
      assert.match(html, /Capability calls/);
      const capabilitiesHtml = html.slice(
        html.indexOf("<h2>Capabilities</h2>"),
        html.indexOf("<h2>Capability calls</h2>"),
      );
      assert.match(capabilitiesHtml, /Showing 25 of 33 capabilities/);
      assert.match(capabilitiesHtml, /server-capability-23/);
      assert.equal(capabilitiesHtml.includes("server-capability-24"), false);
      assert.match(html, /role="tab"[^>]*>Skills<\/button>/);
      assert.match(html, /role="tab"[^>]*>MCP tools<\/button>/);
      assert.match(html, /Showing latest 30 skill calls/);
      assert.match(html, /server-capability-24/);
      assert.match(html, /github\.create_pull_request/);
      assert.match(html, /Recent turns/);
      assert.match(html, /1\.23K/);

      const dashboardJsonResponse = await fetch(`${instance.url}/dashboard.json`);
      const dashboard = (await dashboardJsonResponse.json()) as {
        summary: { turn_count: number };
        summarySection: {
          cliLines: string[];
          cliBlocks: Array<{ title: string; lines: string[] }>;
          tableBlocks: Array<{ title: string; table: { rows: string[][]; width?: string } }>;
          table: { rows: string[][] };
        };
        capabilityCallTabs: Array<{ id: string; table: { rows: string[][] } }>;
      };
      assert.equal(dashboardJsonResponse.status, 200);
      assert.equal(dashboard.summary.turn_count, 1);
      assert.equal(dashboard.summarySection.cliLines.includes("Top 5 agents"), true);
      assert.equal(dashboard.summarySection.cliLines.includes("Top 15 capabilities"), true);
      assert.deepEqual(
        dashboard.summarySection.cliBlocks.map((block) => block.title),
        ["Summary (2026-05-06 to 2026-05-12)", "Top 5 agents", "Top 15 capabilities"],
      );
      assert.deepEqual(
        dashboard.summarySection.tableBlocks.map((block) => block.title),
        ["Summary (2026-05-06 to 2026-05-12)", "Top 5 agents", "Top 15 capabilities"],
      );
      assert.deepEqual(
        dashboard.summarySection.tableBlocks.map((block) => block.table.rows.length),
        [5, 1, 15],
      );
      assert.deepEqual(
        dashboard.summarySection.tableBlocks.map((block) => block.table.width ?? "full"),
        ["compact", "compact", "full"],
      );
      assert.equal(dashboard.summarySection.table.rows.length, 15);
      assert.equal(
        dashboard.capabilityCallTabs
          .find((tab) => tab.id === "mcp-tools")
          ?.table.rows.some((row) => row.includes("github.create_pull_request")),
        true,
      );

      const metricsResponse = await fetch(`${instance.url}/metrics`);
      const metricsHtml = await metricsResponse.text();
      assert.equal(metricsResponse.status, 200);
      assert.match(metricsHtml, /<h1>Metrics<\/h1>/);
      assert.match(metricsHtml, /href="\/">Overview<\/a>/);
      assert.match(metricsHtml, /href="\/metrics" aria-current="page">Metrics<\/a>/);
      assert.match(metricsHtml, /Overall metrics/);
      assert.match(metricsHtml, /Project metrics/);
      assert.match(metricsHtml, /Capability metrics/);
      assert.match(metricsHtml, /Alerts/);
      assert.match(metricsHtml, /role="tab"[^>]*>Day<\/button>/);
      assert.match(metricsHtml, /role="tab"[^>]*>Week<\/button>/);
      assert.match(metricsHtml, /role="tab"[^>]*>Month<\/button>/);
      assert.match(metricsHtml, /repo_hash_server_001/);
      assert.match(metricsHtml, /server-capability-01/);

      const metricsJsonResponse = await fetch(`${instance.url}/metrics.json`);
      const metrics = (await metricsJsonResponse.json()) as {
        periods: Array<{
          period: string;
          overall: { turnCount: number; totalTokens: number | null };
          projects: Array<{ repoHash: string; skillInvocationCount: number; mcpInvocationCount: number }>;
          capabilities: Array<{ capabilityName: string; invocationCount: number }>;
        }>;
      };
      assert.equal(metricsJsonResponse.status, 200);
      assert.deepEqual(
        metrics.periods.map((period) => period.period),
        ["day", "week", "month"],
      );
      const dayMetrics = metrics.periods.find((period) => period.period === "day");
      assert.equal(dayMetrics?.overall.turnCount, 1);
      assert.equal(dayMetrics?.overall.totalTokens, 1_234);
      assert.equal(dayMetrics?.projects[0]?.repoHash, "repo_hash_server_001");
      assert.equal(dayMetrics?.projects[0]?.skillInvocationCount, 30);
      assert.equal(dayMetrics?.projects[0]?.mcpInvocationCount, 1);
      assert.equal(
        dayMetrics?.capabilities.some((capability) => capability.capabilityName === "server-capability-01"),
        true,
      );

      const healthResponse = await fetch(`${instance.url}/healthz`);
      const health = (await healthResponse.json()) as {
        ok: boolean;
        last_ingest: { ok: boolean; events_read: number; events_skipped: number };
      };
      assert.equal(health.ok, true);
      assert.equal(health.last_ingest.ok, true);
      assert.equal(health.last_ingest.events_read, events.length);
      assert.equal(health.last_ingest.events_skipped, events.length);

      const status = await runServerStatus({ paths });
      assert.equal(status.ok, true);
      assert.match(status.lines.join("\n"), /running/);
      assert.match(status.lines.join("\n"), new RegExp(String(instance.state.port)));

      const openedUrls: string[] = [];
      const alreadyRunning = await runServerStart({
        paths,
        open: true,
        openBrowser: async (url) => {
          openedUrls.push(url);
        },
        spawnServer: () => {
          throw new Error("should not spawn when state is already active");
        },
      });
      assert.equal(alreadyRunning.ok, true);
      assert.match(alreadyRunning.lines.join("\n"), /Already running/);
      assert.match(alreadyRunning.lines.join("\n"), /Opened browser/);
      assert.deepEqual(openedUrls, [instance.url]);
    } finally {
      await instance.close();
      assert.equal(await readReportServerState(paths), null);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("renders metrics empty states when no usage data exists", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    await ensureTrackerDirectories(paths);

    const instance = await startReportHttpServer({
      paths,
      host: "127.0.0.1",
      port: 0,
      intervalSeconds: 60,
      since: "7d",
      display: "table",
      now: () => now,
    });

    try {
      const response = await fetch(`${instance.url}/metrics`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /No project metrics found/);
      assert.match(html, /No capability metrics found/);
      assert.match(html, /No metrics alerts found/);

      const metricsJsonResponse = await fetch(`${instance.url}/metrics.json`);
      const metrics = (await metricsJsonResponse.json()) as {
        periods: Array<{ period: string; overall: { turnCount: number } }>;
      };
      assert.equal(metricsJsonResponse.status, 200);
      assert.equal(metrics.periods.find((period) => period.period === "day")?.overall.turnCount, 0);
    } finally {
      await instance.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("renders the dashboard as CLI-style text when requested", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const events = [createTurnEvent(), ...createServerCapabilityEvents()];

    await ensureTrackerDirectories(paths);
    for (const event of events) {
      await appendJsonlRecord(resolveDailyEventsPath(paths, event.occurred_at), event);
    }

    const instance = await startReportHttpServer({
      paths,
      host: "127.0.0.1",
      port: 0,
      intervalSeconds: 60,
      since: "7d",
      display: "text",
      now: () => now,
    });

    try {
      const response = await fetch(instance.url);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /<pre class="cli-output">/);
      assert.match(html, /Metric\s+\| Value/);
      assert.match(html, /Total tokens\s+\| 1\.23K/);
      assert.match(html, /Capability\s+\| Invocations/);
      assert.equal(html.includes("<table>"), false);
    } finally {
      await instance.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("orders token usage from newest period to oldest period", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const events = [
      createTokenTurnEvent({
        eventId: "evt_server_token_old",
        occurredAt: "2026-05-10T12:00:00.000Z",
        totalTokens: 100,
      }),
      createTokenTurnEvent({
        eventId: "evt_server_token_new",
        occurredAt: "2026-05-12T12:00:00.000Z",
        totalTokens: 200,
      }),
    ];

    await ensureTrackerDirectories(paths);
    for (const event of events) {
      await appendJsonlRecord(resolveDailyEventsPath(paths, event.occurred_at), event);
    }

    const instance = await startReportHttpServer({
      paths,
      host: "127.0.0.1",
      port: 0,
      intervalSeconds: 60,
      since: "7d",
      display: "table",
      now: () => now,
    });

    try {
      const response = await fetch(`${instance.url}/dashboard.json`);
      const dashboard = (await response.json()) as {
        tokenTabs: Array<{ id: string; table: { rows: string[][] } }>;
      };
      const dailyRows = dashboard.tokenTabs.find((tab) => tab.id === "day")?.table.rows;

      assert.equal(response.status, 200);
      assert.deepEqual(
        dailyRows?.map((row) => row[0]),
        ["2026-05-12", "2026-05-10"],
      );
    } finally {
      await instance.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("passes display mode from server start to the background server", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const result = await runServerStart({
        paths,
        display: "text",
        waitMs: 500,
        spawnServer: (input) => {
          writeFileSync(
            resolveReportServerStatePath(paths),
            `${JSON.stringify(
              {
                pid: process.pid,
                host: input.host,
                port: 5127,
                url: "http://127.0.0.1:5127",
                started_at: now.toISOString(),
                interval_seconds: input.intervalSeconds,
                since: input.since,
                display: input.display,
                last_ingest: null,
              },
              null,
              2,
            )}\n`,
          );
          return { pid: process.pid };
        },
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Display: text/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("reports no-op status and stop when the server is not running", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const status = await runServerStatus({ paths });
      assert.equal(status.ok, true);
      assert.match(status.lines.join("\n"), /not running/);

      const stop = await runServerStop({ paths });
      assert.equal(stop.ok, true);
      assert.match(stop.lines.join("\n"), /not running/);

      const invalidStart = await runServerStart({ paths, interval: "0" });
      assert.equal(invalidStart.ok, false);
      assert.match(invalidStart.lines.join("\n"), /Expected --interval/);

      const invalidDisplay = await runServerStart({ paths, display: "grid" });
      assert.equal(invalidDisplay.ok, false);
      assert.match(invalidDisplay.lines.join("\n"), /Expected --display/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function createTurnEvent(): NormalizedEvent {
  return {
    schema_version: "1.0",
    event_id: "evt_server_turn_001",
    event_type: "turn_summary",
    occurred_at: "2026-05-12T12:00:00.000Z",
    agent: "codex",
    source: "fixture",
    session_id: "s_server_001",
    turn_id: "t_server_001",
    repo_hash: "repo_hash_server_001",
    status: "success",
    model: "gpt-5.1-codex",
    duration_ms: 1_500,
    input_tokens: 1_000,
    output_tokens: 234,
    total_tokens: 1_234,
  };
}

function createTokenTurnEvent(options: {
  eventId: string;
  occurredAt: string;
  totalTokens: number;
}): NormalizedEvent {
  return {
    schema_version: "1.0",
    event_id: options.eventId,
    event_type: "turn_summary",
    occurred_at: options.occurredAt,
    agent: "codex",
    source: "fixture",
    session_id: "s_server_tokens",
    turn_id: options.eventId.replace("evt_", "turn_"),
    repo_hash: "repo_hash_server_tokens",
    status: "success",
    model: "gpt-5.1-codex",
    duration_ms: 1_000,
    input_tokens: null,
    output_tokens: null,
    total_tokens: options.totalTokens,
  };
}

function createServerCapabilityEvents(): NormalizedEvent[] {
  const userCapabilities = Array.from({ length: 30 }, (_, index) =>
    createCapabilityEvent({
      eventId: `evt_server_capability_${index + 1}`,
      occurredAt: `2026-05-12T12:01:${String(index).padStart(2, "0")}.000Z`,
      type: "skill",
      name: `server-capability-${String(index + 1).padStart(2, "0")}`,
      totalTokens: 30_000 - index,
    }),
  );

  return [
    createCapabilityEvent({
      eventId: "evt_server_builtin_apply_patch",
      occurredAt: "2026-05-12T12:02:00.000Z",
      type: "builtin_tool",
      name: "apply_patch",
      totalTokens: 100_000,
    }),
    createCapabilityEvent({
      eventId: "evt_server_builtin_bash",
      occurredAt: "2026-05-12T12:02:01.000Z",
      type: "unknown",
      name: "Bash",
      totalTokens: 90_000,
    }),
    createCapabilityEvent({
      eventId: "evt_server_mcp_tool",
      occurredAt: "2026-05-12T12:03:00.000Z",
      type: "mcp_tool",
      name: "github.create_pull_request",
      totalTokens: 10,
    }),
    ...userCapabilities,
  ];
}

function createCapabilityEvent(options: {
  eventId: string;
  occurredAt: string;
  type: "skill" | "mcp_tool" | "builtin_tool" | "unknown";
  name: string;
  totalTokens: number;
}): NormalizedEvent {
  return {
    schema_version: "1.0",
    event_id: options.eventId,
    event_type: "capability_usage",
    occurred_at: options.occurredAt,
    agent: "codex",
    source: "fixture",
    session_id: "s_server_001",
    turn_id: "t_server_001",
    repo_hash: "repo_hash_server_001",
    status: "success",
    capability_type: options.type,
    capability_name: options.name,
    duration_ms: 500,
    input_tokens: null,
    output_tokens: null,
    total_tokens: options.totalTokens,
    adopted: "unknown",
    attribution_confidence: "exact",
    invocation_origin: "observed",
  };
}
