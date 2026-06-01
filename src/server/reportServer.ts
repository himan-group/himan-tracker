import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import { ingestEvents } from "../aggregator/aggregateEvents.js";
import { runBackfill } from "../backfill/runBackfill.js";
import { createKnownProjectDisplayNameMap } from "../config/knownProjects.js";
import { ensureTrackerDirectories, type TrackerPaths } from "../config/paths.js";
import { readOrCreateUserConfig } from "../config/userConfig.js";
import { formatDateRange, parseSinceRange, todayLocalDate } from "../reports/dateRange.js";
import {
  formatAverageDurationMs,
  formatDurationMs,
  formatNullableText,
  formatSuccessRate,
  formatTable,
  formatTokenCount,
} from "../reports/formatTable.js";
import {
  readMetricsInsightData,
  type CapabilityMetricsRow,
  type DateRange,
  type MetricsInsightAlert,
  type MetricsInsightData,
  type MetricsPeriod,
  type MetricsPeriodInsight,
  type ProjectMetricsRow,
} from "../reports/metricsInsights.js";
import {
  addDays,
  formatLocalDate,
  formatNaturalWeekRangeLabel,
  formatShortDateRange,
  parseLocalDate,
  startOfLocalWeek,
} from "../reports/periodFormatter.js";
import { renderSummaryReport } from "../reports/summaryReport.js";
import { createExcludeSystemCapabilityCondition } from "../reports/systemCapabilityFilter.js";
import { initializeTrackerDatabase } from "../storage/sqlite.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 5127;
export const DEFAULT_SERVER_INTERVAL_SECONDS = 300;
export const DEFAULT_SERVER_SINCE = "7d";
const DASHBOARD_CAPABILITY_CALL_LIMIT = 50;

export type ReportServerIngestSnapshot =
  | {
    ok: true;
    at: string;
    events_read: number;
    events_inserted: number;
    events_skipped: number;
    event_files: number;
  }
  | {
    ok: false;
    at: string;
    error: string;
  };

export type ReportServerBackfillSnapshot =
  | { ok: true; at: string; parsed: number; written: number; skipped: number }
  | { ok: false; at: string; error: string }
  | null;

export type ReportServerState = {
  pid: number;
  host: string;
  port: number;
  url: string;
  started_at: string;
  interval_seconds: number;
  since: string;
  display: DashboardDisplayMode;
  last_backfill: ReportServerBackfillSnapshot;
  last_ingest: ReportServerIngestSnapshot | null;
};

export type StartupBackfillMode = "none" | "copilot" | "codex" | "all";

export type StartReportHttpServerOptions = {
  paths: TrackerPaths;
  host?: string;
  port?: number;
  intervalSeconds?: number;
  since?: string;
  display?: DashboardDisplayMode;
  now?: () => Date;
  startupBackfill?: StartupBackfillMode;
  // Deprecated: kept for compatibility with older internal callers.
  autoBackfill?: boolean;
};

export type ReportHttpServerInstance = {
  server: Server;
  url: string;
  state: ReportServerState;
  close: () => Promise<void>;
  runSyncNow: () => Promise<void>;
};

type DashboardTab = {
  id: string;
  label: string;
  table: DashboardTable;
};

type DashboardSection = {
  title: string;
  table: DashboardTable;
  cliLines?: string[];
  cliBlocks?: DashboardCliBlock[];
  tableBlocks?: DashboardTableBlock[];
};

type DashboardTable = {
  columns: string[];
  rows: string[][];
  emptyText: string;
  note?: string;
  width?: "full" | "compact";
};

type DashboardCliBlock = {
  title: string;
  lines: string[];
};

type DashboardTableBlock = {
  title: string;
  table: DashboardTable;
};

type DashboardData = {
  generatedAt: string;
  lastIngest: ReportServerIngestSnapshot | null;
  summary: DashboardSummary;
  summarySection: DashboardSection;
  tokenTabs: DashboardTab[];
  sections: DashboardSection[];
  capabilityCallTabs: DashboardTab[];
  recentTurnsSection: DashboardSection;
};

type MetricsDashboardData = MetricsInsightData & {
  lastIngest: ReportServerIngestSnapshot | null;
  summary: MetricsDashboardSummary;
  overallTabs: DashboardTab[];
  projectTabs: DashboardTab[];
  capabilityTabs: DashboardTab[];
  alertsSection: DashboardSection;
};

type MetricsDashboardSummary = {
  totalTokens: number | null;
  durationMs: number | null;
  tokenGrowthRate: number | null;
  durationGrowthRate: number | null;
  alertCount: number;
};

type DashboardCapabilityCallType = "skill" | "mcp_tool";

type DashboardSummary = {
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  success_count: number;
  failure_count: number;
};

type DashboardCapabilityCallRow = {
  occurred_at: string;
  agent: string;
  source: string;
  capability_name: string;
  duration_ms: number | null;
  duration_basis: string;
  total_tokens: number | null;
  status: string;
  invocation_origin: string;
};

type DashboardAgentRow = {
  agent: string;
  model: string;
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  success_count: number;
  failure_count: number;
};

type DashboardSummaryAgentRow = {
  agent: string;
  model: string;
  turn_count: number;
  total_tokens: number | null;
};

type DashboardCapabilityRow = {
  agent: string;
  capability_type: string;
  capability_name: string;
  invocation_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  duration_count: number;
  min_duration_ms: number | null;
  max_duration_ms: number | null;
  success_count: number;
  failure_count: number;
  explicit_invocation_count: number;
  inferred_invocation_count: number;
  observed_invocation_count: number;
  unknown_origin_count: number;
};

type DashboardSummaryCapabilityRow = {
  agent: string;
  capability_type: string;
  capability_name: string;
  invocation_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  duration_count: number;
};

type DashboardTokenDayRow = {
  date: string;
  turn_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

const RUNTIME_TOKEN_NOTE =
  "Runtime tokens use observed input/output/total token fields only; himan.yaml static token estimates are excluded.";

type DashboardTokenBucket = {
  key: string;
  label: string;
  turn_count: number;
  input_tokens: number;
  input_count: number;
  output_tokens: number;
  output_count: number;
  total_tokens: number;
  total_count: number;
};

type DashboardTokenPeriod = "day" | "week" | "month";
export type DashboardDisplayMode = "table" | "text";

type DashboardTurnRow = {
  occurred_at: string;
  agent: string;
  model: string;
  id: string;
  duration_ms: number | null;
  total_tokens: number | null;
  status: string;
};

type AlertSeverityName = "warning" | "major" | "critical";
type IconName = "alert" | "arrow-down" | "arrow-up" | "check" | "minus" | "warning";
type VisualTone = "positive" | "negative" | "neutral" | "warning";

export async function startReportHttpServer(
  options: StartReportHttpServerOptions,
): Promise<ReportHttpServerInstance> {
  const paths = options.paths;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_SERVER_INTERVAL_SECONDS;
  const since = options.since ?? DEFAULT_SERVER_SINCE;
  const display = options.display ?? "table";
  const startupBackfill = resolveStartupBackfillMode(options.startupBackfill, options.autoBackfill);
  const now = options.now ?? (() => new Date());
  let lastIngest: ReportServerIngestSnapshot | null = null;
  let lastBackfill: ReportServerBackfillSnapshot = null;
  let currentState: ReportServerState | null = null;
  let ingestInFlight: Promise<void> | null = null;

  await ensureTrackerDirectories(paths);

  if (startupBackfill !== "none") {
    lastBackfill = await runStartupBackfill(startupBackfill, paths, now);
  }

  const runSyncNow = async (): Promise<void> => {
    if (ingestInFlight) {
      return ingestInFlight;
    }

    ingestInFlight = runIngest(paths, now)
      .then((snapshot) => {
        lastIngest = snapshot;
      })
      .catch((error: unknown) => {
        lastIngest = {
          ok: false,
          at: now().toISOString(),
          error: getErrorMessage(error),
        };
      })
      .finally(async () => {
        ingestInFlight = null;
        if (currentState) {
          currentState = { ...currentState, last_backfill: lastBackfill, last_ingest: lastIngest };
          await writeReportServerState(paths, currentState);
        }
      });

    return ingestInFlight;
  };

  await runSyncNow();

  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      paths,
      since,
      display,
      now,
      getLastBackfill: () => lastBackfill,
      getLastIngest: () => lastIngest,
      runSyncNow,
    }).catch((error: unknown) => {
      writeResponse(response, 500, "text/plain; charset=utf-8", getErrorMessage(error));
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  await listen(server, port, host);
  const address = server.address();
  const resolvedPort = resolveListeningPort(address);
  const url = `http://${host}:${resolvedPort}`;
  const timer = setInterval(() => {
    void runSyncNow();
  }, intervalSeconds * 1_000);

  currentState = {
    pid: process.pid,
    host,
    port: resolvedPort,
    url,
    started_at: now().toISOString(),
    interval_seconds: intervalSeconds,
    since,
    display,
    last_backfill: lastBackfill,
    last_ingest: lastIngest,
  };
  await writeReportServerState(paths, currentState);

  return {
    server,
    url,
    state: currentState,
    close: async () => {
      clearInterval(timer);
      await closeServer(server, sockets);
      await removeReportServerState(paths, process.pid);
    },
    runSyncNow,
  };
}

export function resolveReportServerStatePath(paths: TrackerPaths): string {
  return path.join(paths.homeDir, "server-state.json");
}

function resolveStartupBackfillMode(
  startupBackfill: StartupBackfillMode | undefined,
  autoBackfill: boolean | undefined,
): StartupBackfillMode {
  if (startupBackfill) {
    return startupBackfill;
  }

  if (autoBackfill === true) {
    return "copilot";
  }

  return "none";
}

async function runStartupBackfill(
  mode: Exclude<StartupBackfillMode, "none">,
  paths: TrackerPaths,
  now: () => Date,
): Promise<ReportServerBackfillSnapshot> {
  const agents = mode === "all" ? ["copilot", "codex"] : [mode];
  let parsed = 0;
  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const agent of agents) {
    try {
      const result = await runBackfill({ agent, paths, now });
      if (result.ok) {
        parsed += result.stats.parsedEvents;
        written += result.stats.writtenEvents;
        skipped += result.stats.skippedDuplicates;
        continue;
      }

      errors.push(`${agent}: ${result.lines.join(" | ")}`);
    } catch (error) {
      errors.push(`${agent}: ${getErrorMessage(error)}`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      at: now().toISOString(),
      error: `startup backfill failed (${mode}): ${errors.join(" ; ")}`,
    };
  }

  return {
    ok: true,
    at: now().toISOString(),
    parsed,
    written,
    skipped,
  };
}

export function resolveReportServerLogPath(paths: TrackerPaths): string {
  return path.join(paths.homeDir, "server.log");
}

export async function readReportServerState(
  paths: TrackerPaths,
): Promise<ReportServerState | null> {
  const statePath = resolveReportServerStatePath(paths);

  try {
    return parseReportServerState(JSON.parse(await readFile(statePath, "utf8")), statePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

export async function writeReportServerState(
  paths: TrackerPaths,
  state: ReportServerState,
): Promise<void> {
  await ensureTrackerDirectories(paths);
  await writeFile(resolveReportServerStatePath(paths), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function removeReportServerState(paths: TrackerPaths, pid?: number): Promise<void> {
  if (pid !== undefined) {
    const state = await readReportServerState(paths);
    if (state && state.pid !== pid) {
      return;
    }
  }

  await rm(resolveReportServerStatePath(paths), { force: true });
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, "EPERM");
  }
}

async function runIngest(
  paths: TrackerPaths,
  now: () => Date,
): Promise<ReportServerIngestSnapshot> {
  const result = await ingestEvents({
    sqlitePath: paths.sqlitePath,
    eventsDir: paths.eventsDir,
    skillMetadataRoots: [process.cwd(), homedir()],
    now,
  });

  return {
    ok: true,
    at: now().toISOString(),
    events_read: result.events_read,
    events_inserted: result.events_inserted,
    events_skipped: result.events_skipped,
    event_files: result.event_files.length,
  };
}

async function handleRequest(options: {
  request: IncomingMessage;
  response: ServerResponse;
  paths: TrackerPaths;
  since: string;
  display: DashboardDisplayMode;
  now: () => Date;
  getLastBackfill: () => ReportServerBackfillSnapshot;
  getLastIngest: () => ReportServerIngestSnapshot | null;
  runSyncNow: () => Promise<void>;
}): Promise<void> {
  const method = options.request.method ?? "GET";
  const url = new URL(options.request.url ?? "/", "http://localhost");

  if (method !== "GET") {
    writeResponse(options.response, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }

  if (url.pathname === "/healthz") {
    writeResponse(
      options.response,
      200,
      "application/json; charset=utf-8",
      JSON.stringify({
        ok: true,
        last_backfill: options.getLastBackfill(),
        last_ingest: options.getLastIngest(),
      }),
    );
    return;
  }

  if (url.pathname === "/dashboard.json") {
    await options.runSyncNow();
    const data = readDashboardData({
      paths: options.paths,
      since: options.since,
      now: options.now,
      lastIngest: options.getLastIngest(),
    });
    writeResponse(
      options.response,
      200,
      "application/json; charset=utf-8",
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return;
  }

  if (url.pathname === "/metrics.json") {
    await options.runSyncNow();
    const data = await readMetricsDashboardData({
      paths: options.paths,
      now: options.now,
      lastIngest: options.getLastIngest(),
    });
    writeResponse(
      options.response,
      200,
      "application/json; charset=utf-8",
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return;
  }

  if (url.pathname === "/metrics") {
    await options.runSyncNow();
    const html = await renderMetricsPage({
      paths: options.paths,
      display: options.display,
      now: options.now,
      lastIngest: options.getLastIngest(),
    });
    writeResponse(options.response, 200, "text/html; charset=utf-8", html);
    return;
  }

  if (url.pathname !== "/") {
    writeResponse(options.response, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }

  await options.runSyncNow();
  const html = renderDashboardPage({
    paths: options.paths,
    since: options.since,
    display: options.display,
    now: options.now,
    lastIngest: options.getLastIngest(),
  });
  writeResponse(options.response, 200, "text/html; charset=utf-8", html);
}

function renderDashboardPage(options: {
  paths: TrackerPaths;
  since: string;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): string {
  return renderDashboardHtml(readDashboardData(options), options.display);
}

async function renderMetricsPage(options: {
  paths: TrackerPaths;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): Promise<string> {
  return renderMetricsHtml(await readMetricsDashboardData(options), options.display);
}

function readDashboardData(options: {
  paths: TrackerPaths;
  since: string;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): DashboardData {
  const generatedAt = options.now();
  const range = parseSinceRange(options.since, generatedAt);
  const agentDate = todayLocalDate(generatedAt);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const summary = readDashboardSummary(db, range);
    const summaryLines = renderSummaryReport(db, range, {
      capabilityLimit: 15,
      excludeSystem: true,
    });

    return {
      generatedAt: generatedAt.toISOString(),
      lastIngest: options.lastIngest,
      summary,
      summarySection: {
        title: "Summary",
        cliLines: summaryLines,
        cliBlocks: splitCliOutputBlocks(summaryLines),
        tableBlocks: readDashboardSummaryBlocks(db, range, summary),
        table: readDashboardCapabilities(db, range, {
          excludeSystem: true,
          limit: 15,
          sort: "tokens",
          noteLabel: "top non-system capabilities",
        }),
      },
      tokenTabs: [
        {
          id: "day",
          label: "Daily",
          table: readDashboardTokenUsage(db, range, "day"),
        },
        {
          id: "week",
          label: "Weekly",
          table: readDashboardTokenUsage(db, range, "week"),
        },
        {
          id: "month",
          label: "Monthly",
          table: readDashboardTokenUsage(db, range, "month"),
        },
      ],
      sections: [
        {
          title: "Agents",
          table: readDashboardAgents(db, agentDate),
        },
        {
          title: "Capabilities",
          table: readDashboardCapabilities(db, range, {
            excludeSystem: false,
            limit: 25,
            sort: "tokens",
            noteLabel: "capabilities",
          }),
        },
      ],
      capabilityCallTabs: [
        {
          id: "skills",
          label: "Skills",
          table: readDashboardCapabilityCalls(db, range, "skill"),
        },
        {
          id: "mcp-tools",
          label: "MCP tools",
          table: readDashboardCapabilityCalls(db, range, "mcp_tool"),
        },
      ],
      recentTurnsSection: {
        title: "Recent turns",
        table: readDashboardTurns(db, range, 20),
      },
    };
  } finally {
    db.close();
  }
}

async function readMetricsDashboardData(options: {
  paths: TrackerPaths;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): Promise<MetricsDashboardData> {
  const generatedAt = options.now();
  const config = await readOrCreateUserConfig(options.paths);
  const projectDisplayNames = createKnownProjectDisplayNameMap(config);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const insights = readMetricsInsightData(db, { now: generatedAt });
    const day = findMetricsPeriod(insights.periods, "day");

    return {
      ...insights,
      lastIngest: options.lastIngest,
      summary: {
        totalTokens: day.overall.totalTokens,
        durationMs: day.overall.durationMs,
        tokenGrowthRate: day.overall.tokenGrowthRate,
        durationGrowthRate: day.overall.durationGrowthRate,
        alertCount: insights.alerts.length,
      },
      overallTabs: insights.periods.map((period) => ({
        id: period.period,
        label: formatMetricsPeriodTabLabel(period),
        table: createMetricsOverallTable(period),
      })),
      projectTabs: insights.periods.map((period) => ({
        id: period.period,
        label: formatMetricsPeriodTabLabel(period),
        table: createMetricsProjectTable(period, projectDisplayNames),
      })),
      capabilityTabs: insights.periods.map((period) => ({
        id: period.period,
        label: formatMetricsPeriodTabLabel(period),
        table: createMetricsCapabilityTable(period),
      })),
      alertsSection: {
        title: "Alerts",
        table: createMetricsAlertsTable(insights.alerts),
      },
    };
  } finally {
    db.close();
  }
}

function renderDashboardHtml(data: DashboardData, display: DashboardDisplayMode): string {
  const generatedAt = new Date(data.generatedAt);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>himan-tracker</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(DASHBOARD_ICON_DATA_URL)}">
  <meta name="theme-color" content="#117a65">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #607080;
      --line: #d9e1e8;
      --accent: #117a65;
      --danger: #b42318;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    main,
    .header-inner {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
    }

    .header-inner {
      padding: 22px 0 18px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 720;
    }

    .status {
      margin-top: 10px;
      color: var(--muted);
      font-size: 14px;
    }

    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    .nav a {
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
      padding: 7px 10px;
      text-decoration: none;
    }

    .nav a[aria-current="page"] {
      background: #eef8f5;
      border-color: rgba(17, 122, 101, 0.35);
      color: var(--accent);
    }

    .status strong {
      color: ${data.lastIngest?.ok === false ? "var(--danger)" : "var(--accent)"};
    }

    main {
      padding: 22px 0 40px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }

    .metric,
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .metric {
      padding: 14px;
      min-width: 0;
    }

    .metric-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 8px;
      font-size: 24px;
      line-height: 1.1;
      font-weight: 720;
      overflow-wrap: anywhere;
    }

    .metric.is-positive .metric-value,
    .cell-trend.is-positive {
      color: #0f766e;
    }

    .metric.is-negative .metric-value,
    .cell-trend.is-negative,
    .severity-badge.is-critical {
      color: #b42318;
    }

    .metric.is-warning .metric-value,
    .severity-badge.is-warning {
      color: #a15c07;
    }

    .severity-badge.is-major {
      color: #c2410c;
    }

    .severity-badge,
    .cell-trend {
      font-weight: 700;
    }

    .severity-badge {
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 2px 8px;
    }

    section {
      margin-top: 14px;
      overflow: hidden;
    }

    section > h2 {
      margin: 0;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 16px;
      line-height: 1.25;
    }

    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .section-heading h2 {
      margin: 0;
      font-size: 16px;
      line-height: 1.25;
    }

    .tabs {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f4f6f8;
    }

    .tab {
      appearance: none;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
      padding: 7px 10px;
    }

    .tab:hover,
    .tab:focus-visible {
      color: var(--text);
      outline: 2px solid rgba(17, 122, 101, 0.22);
      outline-offset: 1px;
    }

    .tab.is-active {
      background: var(--panel);
      color: var(--text);
      box-shadow: 0 1px 2px rgba(23, 32, 42, 0.08);
    }

    [hidden] {
      display: none;
    }

    .table-note,
    .empty-state {
      margin: 0;
      padding: 12px 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }

    .table-note {
      border-bottom: 1px solid var(--line);
    }

    .table-scroll {
      overflow: auto;
    }

    .table-scroll.is-compact {
      display: inline-block;
      max-width: 100%;
      min-width: 0;
      vertical-align: top;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .table-scroll.is-compact table {
      width: auto;
    }

    th,
    td {
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }

    th {
      background: #f8fafb;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    td {
      color: #24313d;
      font-variant-numeric: tabular-nums;
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    .cli-output {
      margin: 0;
      padding: 14px;
      overflow: auto;
      color: #24313d;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      white-space: pre;
    }

    @media (max-width: 820px) {
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .section-heading {
        align-items: flex-start;
        flex-direction: column;
      }
    }

    @media (max-width: 520px) {
      main,
      .header-inner {
        width: min(100vw - 20px, 1180px);
      }

      .metrics {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>himan-tracker</h1>
      <div class="status">${renderIngestStatus(data.lastIngest)} · Generated ${escapeHtml(
    formatLocalDateTime(generatedAt),
  )}</div>
      <nav class="nav" aria-label="Dashboard navigation">
        <a href="/" aria-current="page">Overview</a>
        <a href="/metrics">Metrics</a>
      </nav>
    </div>
  </header>
  <main>
    <div class="metrics">
      ${renderMetric("Sessions", String(data.summary.session_count))}
      ${renderMetric("Turns", String(data.summary.turn_count))}
      ${renderMetric("Runtime tokens", formatTokenCount(data.summary.total_tokens))}
      ${renderMetric("Avg latency", formatAverageDurationMs(data.summary.duration_ms, data.summary.turn_count))}
    </div>
    ${renderSection(data.summarySection, display)}
    ${renderTabbedSection("Runtime token usage", "token", data.tokenTabs, display)}
    ${data.sections.map((section) => renderSection(section, display)).join("\n")}
    ${renderTabbedSection("Capability calls", "capability-calls", data.capabilityCallTabs, display)}
    ${renderSection(data.recentTurnsSection, display)}
  </main>
  <script>
    document.querySelectorAll("[data-tabs]").forEach((root) => {
      const tabs = [...root.querySelectorAll("[role='tab']")];
      const panels = [...root.querySelectorAll("[role='tabpanel']")];

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const selectedPanel = tab.getAttribute("aria-controls");

          tabs.forEach((candidate) => {
            const active = candidate === tab;
            candidate.classList.toggle("is-active", active);
            candidate.setAttribute("aria-selected", String(active));
            candidate.setAttribute("tabindex", active ? "0" : "-1");
          });

          panels.forEach((panel) => {
            panel.hidden = panel.id !== selectedPanel;
          });
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderMetricsHtml(data: MetricsDashboardData, display: DashboardDisplayMode): string {
  const generatedAt = new Date(data.generatedAt);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>himan-tracker Metrics</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(DASHBOARD_ICON_DATA_URL)}">
  <meta name="theme-color" content="#117a65">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #607080;
      --line: #d9e1e8;
      --accent: #117a65;
      --danger: #b42318;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    main,
    .header-inner {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
    }

    .header-inner {
      padding: 22px 0 18px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 720;
    }

    .status {
      margin-top: 10px;
      color: var(--muted);
      font-size: 14px;
    }

    .status strong {
      color: ${data.lastIngest?.ok === false ? "var(--danger)" : "var(--accent)"};
    }

    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    .nav a {
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
      padding: 7px 10px;
      text-decoration: none;
    }

    .nav a[aria-current="page"] {
      background: #eef8f5;
      border-color: rgba(17, 122, 101, 0.35);
      color: var(--accent);
    }

    main {
      padding: 22px 0 40px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }

    .metric,
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .metric {
      padding: 14px;
      min-width: 0;
    }

    .metric-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 8px;
      font-size: 24px;
      line-height: 1.1;
      font-weight: 720;
      overflow-wrap: anywhere;
    }

    .metric.is-positive .metric-value,
    .cell-trend.is-positive {
      color: #0f766e;
    }

    .metric.is-negative .metric-value,
    .cell-trend.is-negative,
    .severity-badge.is-critical {
      color: #b42318;
    }

    .metric.is-warning .metric-value,
    .severity-badge.is-warning {
      color: #a15c07;
    }

    .severity-badge.is-major {
      color: #c2410c;
    }

    .severity-badge,
    .cell-trend {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
    }

    .severity-badge {
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 2px 8px;
    }

    section {
      margin-top: 14px;
      overflow: hidden;
    }

    section > h2 {
      margin: 0;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 16px;
      line-height: 1.25;
    }

    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .section-heading h2 {
      margin: 0;
      font-size: 16px;
      line-height: 1.25;
    }

    .tabs {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f4f6f8;
    }

    .tab {
      appearance: none;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
      padding: 7px 10px;
    }

    .tab:hover,
    .tab:focus-visible {
      color: var(--text);
      outline: 2px solid rgba(17, 122, 101, 0.22);
      outline-offset: 1px;
    }

    .tab.is-active {
      background: var(--panel);
      color: var(--text);
      box-shadow: 0 1px 2px rgba(23, 32, 42, 0.08);
    }

    [hidden] {
      display: none;
    }

    .table-note,
    .empty-state {
      margin: 0;
      padding: 12px 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }

    .table-note {
      border-bottom: 1px solid var(--line);
    }

    .table-scroll {
      overflow: auto;
    }

    .table-scroll.is-compact {
      display: inline-block;
      max-width: 100%;
      min-width: 0;
      vertical-align: top;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .table-scroll.is-compact table {
      width: auto;
    }

    th,
    td {
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }

    th {
      background: #f8fafb;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    td {
      color: #24313d;
      font-variant-numeric: tabular-nums;
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    .cli-output {
      margin: 0;
      padding: 14px;
      overflow: auto;
      color: #24313d;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      white-space: pre;
    }

    @media (max-width: 980px) {
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .section-heading {
        align-items: flex-start;
        flex-direction: column;
      }
    }

    @media (max-width: 520px) {
      main,
      .header-inner {
        width: min(100vw - 20px, 1180px);
      }

      .metrics {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>Metrics</h1>
      <div class="status">${renderIngestStatus(data.lastIngest)} · Generated ${escapeHtml(
    formatLocalDateTime(generatedAt),
  )}</div>
      <nav class="nav" aria-label="Dashboard navigation">
        <a href="/">Overview</a>
        <a href="/metrics" aria-current="page">Metrics</a>
      </nav>
    </div>
  </header>
  <main>
    <div class="metrics">
      ${renderMetric("Day runtime tokens", formatTokenCount(data.summary.totalTokens))}
      ${renderMetric("Runtime token growth", formatSignedPercent(data.summary.tokenGrowthRate), {
    tone: getTrendTone(data.summary.tokenGrowthRate),
  })}
      ${renderMetric("Day duration", formatDurationMs(data.summary.durationMs))}
      ${renderMetric("Duration growth", formatSignedPercent(data.summary.durationGrowthRate), {
    tone: getTrendTone(data.summary.durationGrowthRate),
  })}
      ${renderMetric("Alerts", String(data.summary.alertCount), {
    tone: data.summary.alertCount > 0 ? "warning" : "positive",
  })}
    </div>
    ${renderTabbedSection("Overall metrics", "metrics-overall", data.overallTabs, display)}
    ${renderTabbedSection("Project metrics", "metrics-project", data.projectTabs, display)}
    ${renderTabbedSection("Capability metrics", "metrics-capability", data.capabilityTabs, display)}
    ${renderSection(data.alertsSection, display)}
  </main>
  <script>
    document.querySelectorAll("[data-tabs]").forEach((root) => {
      const tabs = [...root.querySelectorAll("[role='tab']")];
      const panels = [...root.querySelectorAll("[role='tabpanel']")];

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const selectedPanel = tab.getAttribute("aria-controls");

          tabs.forEach((candidate) => {
            const active = candidate === tab;
            candidate.classList.toggle("is-active", active);
            candidate.setAttribute("aria-selected", String(active));
            candidate.setAttribute("tabindex", active ? "0" : "-1");
          });

          panels.forEach((panel) => {
            panel.hidden = panel.id !== selectedPanel;
          });
        });
      });
    });
  </script>
</body>
</html>`;
}

function findMetricsPeriod(
  periods: MetricsPeriodInsight[],
  period: MetricsPeriod,
): MetricsPeriodInsight {
  const found = periods.find((candidate) => candidate.period === period);
  if (!found) {
    throw new Error(`Missing metrics period: ${period}`);
  }

  return found;
}

function createMetricsOverallTable(period: MetricsPeriodInsight): DashboardTable {
  return {
    columns: [
      "Period",
      "Range",
      "Sessions",
      "Turns",
      "Runtime tokens",
      "Runtime token growth",
      "Duration",
      "Duration growth",
      "Avg duration / turn",
      "Avg runtime tokens / turn",
    ],
    rows: period.overallRows.map((row) => [
      row.label,
      formatMetricsRangeForPeriod(period.period, row.range),
      String(row.sessionCount),
      String(row.turnCount),
      formatTokenCount(row.totalTokens),
      formatSignedPercent(row.tokenGrowthRate),
      formatDurationMs(row.durationMs),
      formatSignedPercent(row.durationGrowthRate),
      formatDurationMs(row.avgTurnDurationMs),
      formatTokenCount(roundNullable(row.avgTokensPerTurn)),
    ]),
    emptyText: "No overall metrics found for this period.",
    note: `Overall metrics by ${period.period} through ${formatMetricsPeriodCaption(period)}.`,
  };
}

function createMetricsProjectTable(
  period: MetricsPeriodInsight,
  projectDisplayNames: ReadonlyMap<string, string>,
): DashboardTable {
  return {
    columns: [
      "Project",
      "Turns",
      "Runtime tokens",
      "Runtime token share",
      "Runtime token growth",
      "Duration",
      "Duration share",
      "Duration growth",
      "Skill calls",
      "Skill runtime token share",
      "MCP calls",
      "MCP runtime token share",
    ],
    rows: period.projects.map((project) =>
      createMetricsProjectRow(project, projectDisplayNames),
    ),
    emptyText: `No project metrics found for ${formatMetricsPeriodCaption(period)}.`,
    note: `Project metrics by project label (repo hash fallback) for ${formatMetricsPeriodCaption(period)}. Token columns use runtime observed tokens only.`,
  };
}

function createMetricsProjectRow(
  project: ProjectMetricsRow,
  projectDisplayNames: ReadonlyMap<string, string>,
): string[] {
  const projectLabel = projectDisplayNames.get(project.repoHash) ?? project.repoHash;

  return [
    projectLabel,
    String(project.turnCount),
    formatTokenCount(project.totalTokens),
    formatPercentRatio(project.tokenShare),
    formatSignedPercent(project.tokenGrowthRate),
    formatDurationMs(project.durationMs),
    formatPercentRatio(project.durationShare),
    formatSignedPercent(project.durationGrowthRate),
    String(project.skillInvocationCount),
    formatPercentRatio(project.skillTokenShare),
    String(project.mcpInvocationCount),
    formatPercentRatio(project.mcpTokenShare),
  ];
}

function createMetricsCapabilityTable(period: MetricsPeriodInsight): DashboardTable {
  return {
    columns: [
      "Agent",
      "Type",
      "Capability",
      "Invocations",
      "Invocation growth",
      "Success rate",
      "Success delta",
      "Total duration",
      "Duration growth",
      "Duration basis",
      "Avg duration",
      "Min duration",
      "Max duration",
      "Duration stddev",
      "Total runtime tokens",
      "Runtime token growth",
      "Avg runtime tokens",
      "Min runtime tokens",
      "Max runtime tokens",
      "Runtime token stddev",
    ],
    rows: period.capabilities.map((capability) => createMetricsCapabilityRow(capability)),
    emptyText: `No capability metrics found for ${formatMetricsPeriodCaption(period)}.`,
    note: `Capability metrics for ${formatMetricsPeriodCaption(period)}. Runtime tokens exclude himan.yaml static token estimates; turn estimate duration is inferred from the parent turn.`,
  };
}

function createMetricsCapabilityRow(capability: CapabilityMetricsRow): string[] {
  return [
    capability.agent,
    capability.capabilityType,
    capability.capabilityName,
    String(capability.invocationCount),
    formatSignedPercent(capability.invocationGrowthRate),
    formatPercentRatio(capability.successRate),
    formatSignedPercent(capability.successRateDelta),
    formatDurationMs(capability.duration.total),
    formatSignedPercent(capability.duration.growthRate),
    formatDurationBasis(capability.durationBasis),
    formatDurationMs(capability.duration.avg),
    formatDurationMs(capability.duration.min),
    formatDurationMs(capability.duration.max),
    formatDurationMs(capability.duration.stddev),
    formatTokenCount(capability.tokens.total),
    formatSignedPercent(capability.tokens.growthRate),
    formatTokenCount(roundNullable(capability.tokens.avg)),
    formatTokenCount(capability.tokens.min),
    formatTokenCount(capability.tokens.max),
    formatTokenCount(roundNullable(capability.tokens.stddev)),
  ];
}

function createMetricsAlertsTable(alerts: MetricsInsightAlert[]): DashboardTable {
  const sortedAlerts = [...alerts].sort(compareMetricsAlerts);

  return {
    columns: ["Severity", "Period", "Scope", "Metric", "Subject", "Current", "Previous", "Change", "Message"],
    rows: sortedAlerts.map((alert) => [
      alert.severity,
      alert.period,
      alert.scope,
      alert.metric,
      alert.subject,
      formatAlertValue(alert.metric, alert.current),
      formatAlertValue(alert.metric, alert.previous),
      formatSignedPercent(alert.change),
      alert.message,
    ]),
    emptyText: "No metrics alerts found.",
    note: `Alerts use 20% / 40% / 60% change thresholds, runtime token changes, and capability CV thresholds.`,
  };
}

function formatDurationBasis(value: CapabilityMetricsRow["durationBasis"]): string {
  if (value === "turn_estimate") {
    return "turn estimate";
  }
  return value;
}

function compareMetricsAlerts(left: MetricsInsightAlert, right: MetricsInsightAlert): number {
  const severityDelta = getSeverityRank(right.severity) - getSeverityRank(left.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const leftMagnitude = Math.abs(left.change ?? left.current ?? 0);
  const rightMagnitude = Math.abs(right.change ?? right.current ?? 0);
  if (leftMagnitude !== rightMagnitude) {
    return rightMagnitude - leftMagnitude;
  }

  return `${left.period}\u001f${left.scope}\u001f${left.metric}\u001f${left.subject}`.localeCompare(
    `${right.period}\u001f${right.scope}\u001f${right.metric}\u001f${right.subject}`,
  );
}

function getSeverityRank(severity: AlertSeverityName): number {
  if (severity === "critical") {
    return 3;
  }
  if (severity === "major") {
    return 2;
  }

  return 1;
}

function formatMetricsPeriodTabLabel(period: MetricsPeriodInsight): string {
  if (period.period === "day") {
    return "Daily";
  }
  if (period.period === "week") {
    return "Weekly";
  }

  return "Monthly";
}

function formatMetricsPeriodCaption(period: MetricsPeriodInsight): string {
  return `${period.currentLabel} (${formatMetricsPeriodRange(period)})`;
}

function formatMetricsPeriodRange(period: MetricsPeriodInsight): string {
  return formatMetricsRangeForPeriod(period.period, period.currentRange);
}

function formatMetricsRangeForPeriod(period: MetricsPeriod, range: DateRange): string {
  if (period === "week") {
    return formatShortDateRange(range);
  }

  return formatDateRange(range);
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPercentRatio(value)}`;
}

function formatPercentRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatAlertValue(metric: MetricsInsightAlert["metric"], value: number | null): string {
  if (metric === "success_rate") {
    return formatPercentRatio(value);
  }

  if (metric === "unknown_origin_ratio") {
    return formatPercentRatio(value);
  }

  if (metric === "attribution_score_drop") {
    return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(1);
  }

  if (metric === "duration_cv" || metric === "tokens_cv") {
    return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(2);
  }

  if (metric === "duration") {
    return formatDurationMs(value);
  }

  if (metric === "tokens") {
    return value === null ? "n/a" : formatTokenCount(roundNullable(value));
  }

  return value === null || !Number.isFinite(value) ? "n/a" : String(Math.round(value));
}

function roundNullable(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value);
}

function getTrendTone(value: number | null): VisualTone {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return "neutral";
  }

  return value > 0 ? "positive" : "negative";
}

function getTrendIcon(value: number | null): IconName {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return "minus";
  }

  return value > 0 ? "arrow-up" : "arrow-down";
}

function parseTrendTone(value: string): VisualTone {
  if (value.startsWith("+")) {
    return "positive";
  }

  if (value.startsWith("-")) {
    return "negative";
  }

  return "neutral";
}

function getTrendIconFromText(value: string): IconName {
  if (value.startsWith("+")) {
    return "arrow-up";
  }

  if (value.startsWith("-")) {
    return "arrow-down";
  }

  return "minus";
}

function parseSeverity(value: string): AlertSeverityName | null {
  if (value === "warning" || value === "major" || value === "critical") {
    return value;
  }

  return null;
}

function readDashboardCapabilityCalls(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  type: DashboardCapabilityCallType,
): DashboardTable {
  const rows = db
    .prepare(
      `
      select
        c.occurred_at,
        c.agent,
        c.source,
        c.capability_name,
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
          as duration_ms,
        case
          when c.duration_ms is not null then 'event'
          when c.capability_type = 'skill' and t.duration_ms is not null then 'turn'
          else 'n/a'
        end as duration_basis,
        c.total_tokens,
        c.status,
        c.invocation_origin
      from capability_usages c
      left join turns t
        on t.id = c.turn_id
        and t.session_id = c.session_id
        and t.agent = c.agent
      where date(c.occurred_at, 'localtime') between ? and ?
        and c.capability_type = ?
      order by c.occurred_at desc
      limit ?
      `,
    )
    .all(
      range.startDate,
      range.endDate,
      type,
      DASHBOARD_CAPABILITY_CALL_LIMIT,
    ) as DashboardCapabilityCallRow[];
  const label = type === "skill" ? "skill" : "MCP tool";

  return {
    columns: ["Time", "Agent", "Source", "Capability", "Duration", "Basis", "Runtime tokens", "Status", "Origin"],
    rows: rows.map((row) => [
      formatLocalDateTime(row.occurred_at),
      row.agent,
      row.source,
      row.capability_name,
      formatDurationMs(row.duration_ms),
      row.duration_basis,
      formatTokenCount(row.total_tokens),
      row.status,
      formatNullableText(row.invocation_origin),
    ]),
    emptyText: `No ${label} calls found for ${formatDateRange(range)}.`,
    note: `Showing latest ${rows.length} ${label} calls (${formatDateRange(range)}).`,
  };
}

function readDashboardAgents(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  date: string,
): DashboardTable {
  const rows = db
    .prepare(
      `
      select
        agent,
        model,
        sum(session_count) as session_count,
        sum(turn_count) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
        sum(success_count) as success_count,
        sum(failure_count) as failure_count
      from daily_agent_stats
      where date = ?
      group by agent, model
      order by coalesce(total_tokens, -1) desc, turn_count desc
      `,
    )
    .all(date) as DashboardAgentRow[];

  return {
    columns: ["Agent", "Model", "Sessions", "Turns", "Runtime tokens", "Avg latency", "Success rate"],
    rows: rows.map((row) => [
      row.agent,
      formatNullableText(row.model),
      String(row.session_count),
      String(row.turn_count),
      formatTokenCount(row.total_tokens),
      formatAverageDurationMs(row.duration_ms, row.turn_count),
      formatSuccessRate(row.success_count, row.failure_count),
    ]),
    emptyText: "No agent usage found for this date.",
    note: `Agents (${date}).`,
  };
}

function readDashboardSummaryBlocks(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  summary: DashboardSummary,
): DashboardTableBlock[] {
  return [
    {
      title: `Summary (${formatDateRange(range)})`,
      table: createDashboardSummaryMetricTable(summary),
    },
    {
      title: "Top 5 agents",
      table: readDashboardSummaryAgents(db, range, 5),
    },
    {
      title: "Top 15 capabilities",
      table: readDashboardSummaryCapabilities(db, range, {
        excludeSystem: true,
        limit: 15,
      }),
    },
  ];
}

function createDashboardSummaryMetricTable(summary: DashboardSummary): DashboardTable {
  return {
    columns: ["Metric", "Value"],
    width: "compact",
    rows: [
      ["Sessions", String(summary.session_count)],
      ["Turns", String(summary.turn_count)],
      ["Total runtime tokens", formatTokenCount(summary.total_tokens)],
      ["Average latency", formatAverageDurationMs(summary.duration_ms, summary.turn_count)],
      ["Success rate", formatSuccessRate(summary.success_count, summary.failure_count)],
    ],
    emptyText: "No usage data found for this range.",
  };
}

function readDashboardSummaryAgents(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  limit: number,
): DashboardTable {
  const rows = db
    .prepare(
      `
      select
        agent,
        model,
        sum(turn_count) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from daily_agent_stats
      where date between ? and ?
      group by agent, model
      order by turn_count desc, coalesce(total_tokens, -1) desc, agent asc, model asc
      limit ?
      `,
    )
    .all(range.startDate, range.endDate, limit) as DashboardSummaryAgentRow[];

  return {
    columns: ["Agent", "Model", "Turns", "Runtime tokens"],
    width: "compact",
    rows: rows.map((row) => [
      row.agent,
      formatNullableText(row.model),
      String(row.turn_count),
      formatTokenCount(row.total_tokens),
    ]),
    emptyText: "No agent usage found.",
  };
}

function readDashboardSummaryCapabilities(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  filters: {
    excludeSystem: boolean;
    limit: number;
  },
): DashboardTable {
  const clauses = ["date(c.occurred_at, 'localtime') between ? and ?"];
  const params: Array<string | number> = [range.startDate, range.endDate];

  if (filters.excludeSystem) {
    const condition = createExcludeSystemCapabilityCondition("c");
    clauses.push(condition.sql);
    params.push(...condition.params);
  }

  params.push(filters.limit);

  const rows = db
    .prepare(
      `
      with capability_events as (
        select
          c.agent,
          c.capability_type,
          c.capability_name,
          c.total_tokens,
          coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
            as effective_duration_ms
        from capability_usages c
        left join turns t
          on t.id = c.turn_id
          and t.session_id = c.session_id
          and t.agent = c.agent
        where ${clauses.join(" and ")}
      )
      select
        agent,
        capability_type,
        capability_name,
        count(*) as invocation_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(effective_duration_ms) = 0 then null else sum(effective_duration_ms) end as duration_ms,
        count(effective_duration_ms) as duration_count
      from capability_events
      group by agent, capability_type, capability_name
      order by coalesce(total_tokens, -1) desc, invocation_count desc
      limit ?
      `,
    )
    .all(...params) as DashboardSummaryCapabilityRow[];

  return {
    columns: ["Agent", "Type", "Capability", "Invocations", "Runtime tokens", "Duration"],
    rows: rows.map((row) => [
      row.agent,
      row.capability_type,
      row.capability_name,
      String(row.invocation_count),
      formatTokenCount(row.total_tokens),
      formatAverageDurationMs(row.duration_ms, row.duration_count),
    ]),
    emptyText: "No capability usage found.",
  };
}

function readDashboardCapabilities(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  filters: {
    excludeSystem: boolean;
    limit: number;
    sort: "tokens" | "invocations" | "duration" | "failures";
    noteLabel: string;
  },
): DashboardTable {
  const clauses = ["date(c.occurred_at, 'localtime') between ? and ?"];
  const params: Array<string | number> = [range.startDate, range.endDate];

  if (filters.excludeSystem) {
    const condition = createExcludeSystemCapabilityCondition("c");
    clauses.push(condition.sql);
    params.push(...condition.params);
  }

  const sortSql = {
    invocations: "invocation_count",
    tokens: "coalesce(total_tokens, -1)",
    duration: "case when duration_count = 0 then -1 else duration_ms * 1.0 / duration_count end",
    failures: "failure_count",
  }[filters.sort];

  const rows = db
    .prepare(
      `
      with capability_events as (
        select
          c.agent,
          c.capability_type,
          c.capability_name,
          c.total_tokens,
          coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
            as effective_duration_ms,
          c.status,
          c.invocation_origin
        from capability_usages c
        left join turns t
          on t.id = c.turn_id
          and t.session_id = c.session_id
          and t.agent = c.agent
        where ${clauses.join(" and ")}
      ),
      capability_stats as (
        select
          agent,
          capability_type,
          capability_name,
          count(*) as invocation_count,
          case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
          count(effective_duration_ms) as duration_count,
          case
            when count(effective_duration_ms) = 0 then null
            else sum(effective_duration_ms)
          end as duration_ms,
          min(effective_duration_ms) as min_duration_ms,
          max(effective_duration_ms) as max_duration_ms,
          sum(case when status = 'success' then 1 else 0 end) as success_count,
          sum(case when status = 'failure' then 1 else 0 end) as failure_count,
          sum(case when invocation_origin = 'explicit' then 1 else 0 end) as explicit_invocation_count,
          sum(case when invocation_origin = 'inferred' then 1 else 0 end) as inferred_invocation_count,
          sum(case when invocation_origin = 'observed' then 1 else 0 end) as observed_invocation_count,
          sum(case when invocation_origin = 'unknown' then 1 else 0 end) as unknown_origin_count
        from capability_events
        group by agent, capability_type, capability_name
      )
      select *
      from capability_stats
      order by ${sortSql} desc, invocation_count desc, capability_name asc
      `,
    )
    .all(...params) as DashboardCapabilityRow[];
  const visibleRows = rows.slice(0, filters.limit);

  return {
    columns: [
      "Agent",
      "Type",
      "Capability",
      "Invocations",
      "Explicit",
      "Inferred",
      "Observed",
      "Unknown",
      "Runtime tokens",
      "Avg duration",
      "Min duration",
      "Max duration",
      "Success rate",
    ],
    rows: visibleRows.map((row) => [
      row.agent,
      row.capability_type,
      row.capability_name,
      String(row.invocation_count),
      String(row.explicit_invocation_count),
      String(row.inferred_invocation_count),
      String(row.observed_invocation_count),
      String(row.unknown_origin_count),
      formatTokenCount(row.total_tokens),
      formatAverageDurationMs(row.duration_ms, row.duration_count),
      formatDurationMs(row.min_duration_ms),
      formatDurationMs(row.max_duration_ms),
      formatSuccessRate(row.success_count, row.failure_count),
    ]),
    emptyText: "No capability usage found for this range.",
    note: `Showing ${visibleRows.length} of ${rows.length} ${filters.noteLabel} (${formatDateRange(
      range,
    )}).`,
  };
}

function readDashboardTokenUsage(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  period: DashboardTokenPeriod,
): DashboardTable {
  const rows = db
    .prepare(
      `
      select
        date,
        coalesce(sum(turn_count), 0) as turn_count,
        case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
        case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from daily_agent_stats
      where date between ? and ?
      group by date
      order by date asc
      `,
    )
    .all(range.startDate, range.endDate) as DashboardTokenDayRow[];
  const buckets = aggregateDashboardTokenRows(rows, period);

  return {
    columns: ["Period", "Turns", "Input", "Output", "Total", "Avg / turn"],
    rows: buckets.map((bucket) => {
      const totalTokens = bucket.total_count > 0 ? bucket.total_tokens : null;

      return [
        bucket.label,
        String(bucket.turn_count),
        formatNullableTokenCount(bucket.input_tokens, bucket.input_count),
        formatNullableTokenCount(bucket.output_tokens, bucket.output_count),
        formatTokenCount(totalTokens),
        formatAverageTokens(totalTokens, bucket.turn_count),
      ];
    }),
    emptyText: "No runtime token usage found for this range.",
    note: `Runtime token usage by ${period} (${formatDateRange(range)}). ${RUNTIME_TOKEN_NOTE}`,
  };
}

function readDashboardTurns(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  limit: number,
): DashboardTable {
  const rows = db
    .prepare(
      `
      select
        occurred_at,
        agent,
        model,
        id,
        duration_ms,
        total_tokens,
        status
      from turns
      where date(occurred_at, 'localtime') between ? and ?
      order by occurred_at desc
      limit ?
      `,
    )
    .all(range.startDate, range.endDate, limit) as DashboardTurnRow[];

  return {
    columns: ["Time", "Agent", "Model", "Turn", "Duration", "Runtime tokens", "Status"],
    rows: rows.map((row) => [
      formatLocalDateTime(row.occurred_at),
      row.agent,
      formatNullableText(row.model),
      shortenId(row.id),
      formatDurationMs(row.duration_ms),
      formatTokenCount(row.total_tokens),
      row.status,
    ]),
    emptyText: "No turn usage found for this range.",
    note: `Showing latest ${rows.length} turns (${formatDateRange(range)}).`,
  };
}

function readDashboardSummary(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
): DashboardSummary {
  const row = db
    .prepare(
      `
      select
        coalesce(sum(session_count), 0) as session_count,
        coalesce(sum(turn_count), 0) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
        coalesce(sum(success_count), 0) as success_count,
        coalesce(sum(failure_count), 0) as failure_count
      from daily_agent_stats
      where date between ? and ?
      `,
    )
    .get(range.startDate, range.endDate) as {
      session_count: number;
      turn_count: number;
      total_tokens: number | null;
      duration_ms: number | null;
      success_count: number;
      failure_count: number;
    };

  return {
    session_count: row.session_count,
    turn_count: row.turn_count,
    total_tokens: row.total_tokens,
    duration_ms: row.duration_ms,
    success_count: row.success_count,
    failure_count: row.failure_count,
  };
}

function aggregateDashboardTokenRows(
  rows: DashboardTokenDayRow[],
  period: DashboardTokenPeriod,
): DashboardTokenBucket[] {
  const buckets = new Map<string, DashboardTokenBucket>();

  for (const row of rows) {
    const descriptor = describeDashboardTokenPeriod(row.date, period);
    const bucket = buckets.get(descriptor.key) ?? {
      key: descriptor.key,
      label: descriptor.label,
      turn_count: 0,
      input_tokens: 0,
      input_count: 0,
      output_tokens: 0,
      output_count: 0,
      total_tokens: 0,
      total_count: 0,
    };

    bucket.turn_count += row.turn_count;
    if (row.input_tokens !== null) {
      bucket.input_tokens += row.input_tokens;
      bucket.input_count += 1;
    }
    if (row.output_tokens !== null) {
      bucket.output_tokens += row.output_tokens;
      bucket.output_count += 1;
    }
    if (row.total_tokens !== null) {
      bucket.total_tokens += row.total_tokens;
      bucket.total_count += 1;
    }

    buckets.set(descriptor.key, bucket);
  }

  return [...buckets.values()].sort((left, right) => right.key.localeCompare(left.key));
}

function describeDashboardTokenPeriod(
  dateText: string,
  period: DashboardTokenPeriod,
): { key: string; label: string } {
  if (period === "day") {
    return { key: dateText, label: dateText };
  }

  if (period === "month") {
    const month = dateText.slice(0, 7);
    return { key: month, label: month };
  }

  const weekStart = startOfLocalWeek(parseLocalDate(dateText));
  const weekEnd = addDays(weekStart, 6);

  return {
    key: formatLocalDate(weekStart),
    label: formatNaturalWeekRangeLabel({
      startDate: formatLocalDate(weekStart),
      endDate: formatLocalDate(weekEnd),
    }),
  };
}

function formatNullableTokenCount(value: number, count: number): string {
  return count > 0 ? formatTokenCount(value) : "n/a";
}

function formatAverageTokens(totalTokens: number | null, turnCount: number): string {
  if (totalTokens === null || turnCount <= 0) {
    return "n/a";
  }

  return formatTokenCount(Math.round(totalTokens / turnCount));
}

function shortenId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function renderMetric(
  label: string,
  value: string,
  options: {
    tone?: VisualTone;
  } = {},
): string {
  const toneClass = options.tone ? ` is-${options.tone}` : "";

  return `<div class="metric${toneClass}"><div class="metric-label">${escapeHtml(
    label,
  )}</div><div class="metric-value">${escapeHtml(value)}</div></div>`;
}

function renderSection(section: DashboardSection, display: DashboardDisplayMode): string {
  if (display === "text" && section.cliBlocks) {
    return `<section><h2>${escapeHtml(section.title)}</h2>${renderCliBlocks(
      section.cliBlocks,
    )}</section>`;
  }

  if (section.tableBlocks) {
    return `<section><h2>${escapeHtml(section.title)}</h2>${renderTableBlocks(
      section.tableBlocks,
      display,
    )}</section>`;
  }

  return `<section><h2>${escapeHtml(section.title)}</h2>${renderDashboardContent(
    section.table,
    display,
  )}</section>`;
}

function renderTabbedSection(
  title: string,
  idPrefix: string,
  tabs: DashboardTab[],
  display: DashboardDisplayMode,
): string {
  const tabButtons = tabs
    .map((tab, index) => {
      const active = index === 0;
      return `<button class="tab${active ? " is-active" : ""}" id="${escapeHtml(
        idPrefix,
      )}-tab-${escapeHtml(
        tab.id,
      )}" role="tab" type="button" aria-selected="${String(
        active,
      )}" aria-controls="${escapeHtml(idPrefix)}-panel-${escapeHtml(tab.id)}" tabindex="${active ? "0" : "-1"
        }">${escapeHtml(tab.label)}</button>`;
    })
    .join("");
  const panels = tabs
    .map((tab, index) => {
      const hidden = index === 0 ? "" : " hidden";
      return `<div id="${escapeHtml(idPrefix)}-panel-${escapeHtml(
        tab.id,
      )}" role="tabpanel" aria-labelledby="${escapeHtml(idPrefix)}-tab-${escapeHtml(
        tab.id,
      )}"${hidden}>${renderDashboardContent(tab.table, display)}</div>`;
    })
    .join("");

  return `<section data-tabs><div class="section-heading"><h2>${escapeHtml(
    title,
  )}</h2><div class="tabs" role="tablist" aria-label="${escapeHtml(
    title,
  )}">${tabButtons}</div></div>${panels}</section>`;
}

function renderDashboardContent(table: DashboardTable, display: DashboardDisplayMode): string {
  const note = table.note
    ? `<p class="table-note">${escapeHtml(table.note)}</p>`
    : "";
  if (table.rows.length === 0) {
    return `${note}<p class="empty-state">${escapeHtml(table.emptyText)}</p>`;
  }

  if (display === "text") {
    return `${note}<pre class="cli-output">${escapeHtml(
      formatTable(table.columns, table.rows).join("\n"),
    )}</pre>`;
  }

  const header = table.columns
    .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
    .join("");
  const rows = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, index) => renderDashboardCell(table.columns[index] ?? "", cell))
          .join("")}</tr>`,
    )
    .join("");

  const scrollClass = table.width === "compact" ? "table-scroll is-compact" : "table-scroll";

  return `${note}<div class="${scrollClass}"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDashboardCell(column: string, value: string): string {
  const className = getDashboardCellClass(column, value);
  const content = renderDashboardCellContent(column, value);

  return `<td${className ? ` class="${className}"` : ""}>${content}</td>`;
}

function getDashboardCellClass(column: string, value: string): string {
  const columnName = column.toLowerCase();
  const classes: string[] = [];

  if (columnName === "severity") {
    classes.push("cell-severity");
  }

  if (isTrendColumn(columnName) && value !== "n/a") {
    classes.push("cell-trend-cell");
  }

  return classes.join(" ");
}

function renderDashboardCellContent(column: string, value: string): string {
  const columnName = column.toLowerCase();

  if (columnName === "severity") {
    const severity = parseSeverity(value);
    if (severity) {
      return `<span class="severity-badge is-${severity}">${escapeHtml(value)}</span>`;
    }
  }

  if (isTrendColumn(columnName) && value !== "n/a") {
    const tone = parseTrendTone(value);
    return `<span class="cell-trend is-${tone}"><span class="cell-icon">${renderIcon(
      getTrendIconFromText(value),
      13,
    )}</span>${escapeHtml(value)}</span>`;
  }

  return escapeHtml(value);
}

function isTrendColumn(columnName: string): boolean {
  return (
    columnName === "change" ||
    columnName.includes("growth") ||
    columnName.includes("delta")
  );
}

function renderCliOutput(lines: string[]): string {
  return `<pre class="cli-output">${escapeHtml(lines.join("\n"))}</pre>`;
}

function renderCliBlocks(blocks: DashboardCliBlock[]): string {
  return blocks
    .map((block) => {
      const body = block.lines.length > 0 ? renderCliOutput(block.lines) : "";
      return `<p class="table-note">${escapeHtml(block.title)}</p>${body}`;
    })
    .join("");
}

function renderTableBlocks(blocks: DashboardTableBlock[], display: DashboardDisplayMode): string {
  return blocks
    .map(
      (block) =>
        `<p class="table-note">${escapeHtml(block.title)}</p>${renderDashboardContent(
          block.table,
          display,
        )}`,
    )
    .join("");
}

function renderIcon(name: IconName, size: number): string {
  const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"`;

  if (name === "alert") {
    return `<svg ${common}><path d="M10.3 3.5 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
  }

  if (name === "warning") {
    return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`;
  }

  if (name === "arrow-up") {
    return `<svg ${common}><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
  }

  if (name === "arrow-down") {
    return `<svg ${common}><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`;
  }

  if (name === "check") {
    return `<svg ${common}><path d="M20 6 9 17l-5-5"/></svg>`;
  }

  return `<svg ${common}><path d="M5 12h14"/></svg>`;
}

function splitCliOutputBlocks(lines: string[]): DashboardCliBlock[] {
  const blocks: DashboardCliBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    while (lines[index] === "") {
      index += 1;
    }

    const title = lines[index];
    if (title === undefined) {
      break;
    }
    index += 1;

    if (lines[index] === "") {
      index += 1;
    }

    const blockLines: string[] = [];
    while (index < lines.length) {
      if (lines[index] === "" && lines[index + 1] !== undefined) {
        break;
      }

      blockLines.push(lines[index] ?? "");
      index += 1;
    }

    blocks.push({ title, lines: blockLines });
  }

  return blocks;
}

function renderIngestStatus(snapshot: ReportServerIngestSnapshot | null): string {
  if (!snapshot) {
    return "<strong>Ingest pending</strong>";
  }

  if (!snapshot.ok) {
    return `<strong>Ingest failed</strong> at ${escapeHtml(formatLocalDateTime(snapshot.at))}: ${escapeHtml(
      snapshot.error,
    )}`;
  }

  return `<strong>Ingested</strong> at ${escapeHtml(
    formatLocalDateTime(snapshot.at),
  )}: ${snapshot.events_inserted} inserted, ${snapshot.events_skipped} skipped`;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });

    server.closeIdleConnections();
    server.closeAllConnections();
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

function resolveListeningPort(address: string | AddressInfo | null): number {
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve report server port");
  }

  return address.port;
}

function writeResponse(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function parseReportServerState(value: unknown, statePath: string): ReportServerState {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReportServerState).pid === "number" &&
    typeof (value as ReportServerState).host === "string" &&
    typeof (value as ReportServerState).port === "number" &&
    typeof (value as ReportServerState).url === "string" &&
    typeof (value as ReportServerState).started_at === "string" &&
    typeof (value as ReportServerState).interval_seconds === "number" &&
    typeof (value as ReportServerState).since === "string"
  ) {
    const state = value as ReportServerState;
    return {
      ...state,
      display: isDashboardDisplayMode(state.display) ? state.display : "table",
    };
  }

  throw new Error(`Invalid server state file: ${statePath}`);
}

function isDashboardDisplayMode(value: unknown): value is DashboardDisplayMode {
  return value === "table" || value === "text";
}

function formatLocalDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DASHBOARD_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#117a65"/><path d="M18 16v32M46 16v32M18 32h28" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="46" cy="18" r="6" fill="#8ee6d6"/></svg>';
const DASHBOARD_ICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(DASHBOARD_ICON_SVG)}`;
