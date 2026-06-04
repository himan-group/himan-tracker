import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import { ingestEvents } from "../aggregator/aggregateEvents.js";
import { runBackfill } from "../backfill/runBackfill.js";
import { createKnownProjectDisplayNameMap } from "../config/knownProjects.js";
import { ensureTrackerDirectories, type TrackerPaths } from "../config/paths.js";
import { readOrCreateUserConfig, writeUserConfig } from "../config/userConfig.js";
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
  formatShortDate,
  formatNaturalWeekRangeLabel,
  formatShortDateRange,
  parseLocalDate,
  startOfLocalWeek,
} from "../reports/periodFormatter.js";
import { renderSummaryReport } from "../reports/summaryReport.js";
import { createExcludeSystemCapabilityCondition } from "../reports/systemCapabilityFilter.js";
import {
  CODEX_WEEKLY_BUDGET_CREDITS,
  CODEX_WEEKLY_BUDGET_USD,
  creditsToUsd,
  estimateCodexCost,
  formatBillingCycleStartDay,
  getBillingCycleRange,
  listBillingCycleStartDays,
  parseBillingCycleStartDay,
  type CodexCostEstimate,
} from "../reports/usageCost.js";
import { initializeTrackerDatabase } from "../storage/sqlite.js";
import type { BillingCycleStartDay } from "../types/config.js";
import {
  buildNavLinks,
  escapeHtml,
  formatLocalDateTime,
  getSharedCss,
  renderIngestStatusHTML,
  renderPageShell,
  TAB_SCRIPT,
} from "./htmlLayout.js";

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
  moreHref?: string;
  pagination?: DashboardPagination;
};

type DashboardPagination = {
  page: number;
  pageSize: number;
  totalCount: number;
  previousHref?: string;
  nextHref?: string;
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
  capabilityViewTabs: DashboardTab[];
  capabilityCallTabs: DashboardTab[];
  overviewTabs: DashboardTab[];
};

type MetricsDashboardData = MetricsInsightData & {
  lastIngest: ReportServerIngestSnapshot | null;
  summary: MetricsDashboardSummary;
  overallTabs: DashboardTab[];
  projectTabs: DashboardTab[];
  capabilityTabs: DashboardTab[];
  alertsSection: DashboardSection;
};

type UsageDashboardData = {
  generatedAt: string;
  lastIngest: ReportServerIngestSnapshot | null;
  agent: "codex";
  billingCycleStartDay: BillingCycleStartDay;
  availableCycleStartDays: BillingCycleStartDay[];
  currentCycle: UsageCycleSummary;
  coverageSummary: UsageCoverageSummary;
  currentCycleSection: DashboardSection;
  dailySection: DashboardSection;
  weeklySection: DashboardSection;
};

type MetricsDashboardSummary = {
  totalTokens: number | null;
  durationMs: number | null;
  tokenGrowthRate: number | null;
  durationGrowthRate: number | null;
  alertCount: number;
};

type UsageCycleSummary = {
  startDate: string;
  endDate: string;
  usedCredits: number;
  usedUsd: number;
  expectedBaselineCredits: number;
  expectedBaselineUsd: number;
  expectedBaselineRatio: number;
  elapsedWorkdays: number;
  totalWorkdays: number;
  remainingCredits: number;
  remainingUsd: number;
  budgetUsedRatio: number;
  totalRuntimeTokens: number;
  pricedRuntimeTokens: number;
  modelCount: number;
  activeDays: number;
};

type UsageCoverageSummary = {
  pricedRuntimeTokens: number;
  totalRuntimeTokens: number;
  pricedTokenRatio: number | null;
  uncoveredRuntimeTokens: number;
  fullyPricedDayCount: number;
  partiallyPricedDayCount: number;
  unpricedDayCount: number;
};

type DashboardCapabilityCallType = "skill" | "mcp_tool";

type DashboardSummary = {
  project_count: number;
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
  static_package_tokens: number | null;
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
  static_package_tokens: number | null;
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

type UsageDailyAgentStatsRow = {
  date: string;
  model: string;
  turn_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

type UsageDailyRow = UsageDailyAgentStatsRow & {
  cycle_start_date: string;
  cycle_end_date: string;
  estimated_credits: number;
  estimated_usd: number;
  priced_runtime_tokens: number;
  coverage: CodexCostEstimate["coverage"];
  rate_card_model: string | null;
  rate_card_alias_of: string | null;
};

type UsageCycleRow = {
  cycle_start_date: string;
  cycle_end_date: string;
  model_count: number;
  active_days: number;
  total_runtime_tokens: number;
  priced_runtime_tokens: number;
  used_credits: number;
  used_usd: number;
  remaining_credits: number;
  remaining_usd: number;
  budget_used_ratio: number;
};

const RUNTIME_TOKEN_NOTE =
  "Runtime tokens use observed input/output/total token fields only; himan.yaml static token estimates are excluded.";

const DEFAULT_STRICT_SCORE_THRESHOLD = 80;
const EFFECTIVE_ATTRIBUTION_SCORE_SQL = `
coalesce(
  c.attribution_score,
  case
    when c.attribution_confidence = 'exact' then 100
    when c.capability_type = 'builtin_tool' then 55
    when c.capability_type = 'shell_command' then 50
    when c.attribution_confidence = 'estimated' then 60
    when c.attribution_confidence = 'unknown' then 0
    else 0
  end
)
`;

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
type DashboardCapabilityView = "raw" | "strict" | "weighted";

type DashboardTurnRow = {
  occurred_at: string;
  agent: string;
  model: string;
  id: string;
  duration_ms: number | null;
  total_tokens: number | null;
  status: string;
};

type DashboardProjectRow = {
  repo_hash: string;
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
};

type DashboardSessionRow = {
  id: string;
  agent: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  turn_count: number;
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
  const page = parseDashboardPageParam(url.searchParams.get("page"));
  const pageSize = parseDashboardPageSizeParam(url.searchParams.get("pageSize"));

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
    const data = await readDashboardData({
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

  if (url.pathname === "/usage.json") {
    await options.runSyncNow();
    const data = await readUsageDashboardData({
      paths: options.paths,
      now: options.now,
      lastIngest: options.getLastIngest(),
      cycleStartDayParam: url.searchParams.get("cycleStartDay"),
    });
    writeResponse(
      options.response,
      200,
      "application/json; charset=utf-8",
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return;
  }

  if (url.pathname === "/usage") {
    await options.runSyncNow();
    const cycleStartDayParam = url.searchParams.get("cycleStartDay");
    if (cycleStartDayParam) {
      const config = await readOrCreateUserConfig(options.paths);
      config.usage.billing_cycle_start_day = parseBillingCycleStartDay(cycleStartDayParam);
      await writeUserConfig(options.paths, config);
    }
    const html = await renderUsagePage({
      paths: options.paths,
      display: options.display,
      now: options.now,
      lastIngest: options.getLastIngest(),
      cycleStartDayParam,
    });
    writeResponse(options.response, 200, "text/html; charset=utf-8", html);
    return;
  }

  if (url.pathname === "/projects") {
    await options.runSyncNow();
    const html = await renderProjectsHtml({
      paths: options.paths,
      since: options.since,
      page,
      pageSize,
      display: options.display,
      now: options.now,
      lastIngest: options.getLastIngest(),
    });
    writeResponse(options.response, 200, "text/html; charset=utf-8", html);
    return;
  }

  if (url.pathname === "/sessions") {
    await options.runSyncNow();
    const html = renderSessionsHtml({
      paths: options.paths,
      since: options.since,
      page,
      pageSize,
      display: options.display,
      now: options.now,
      lastIngest: options.getLastIngest(),
    });
    writeResponse(options.response, 200, "text/html; charset=utf-8", html);
    return;
  }

  if (url.pathname === "/turns") {
    await options.runSyncNow();
    const html = renderTurnsHtml({
      paths: options.paths,
      since: options.since,
      page,
      pageSize,
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
  const html = await renderDashboardPage({
    paths: options.paths,
    since: options.since,
    display: options.display,
    now: options.now,
    lastIngest: options.getLastIngest(),
  });
  writeResponse(options.response, 200, "text/html; charset=utf-8", html);
}

async function renderDashboardPage(options: {
  paths: TrackerPaths;
  since: string;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): Promise<string> {
  return renderDashboardHtml(await readDashboardData(options), options.display);
}

async function renderMetricsPage(options: {
  paths: TrackerPaths;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): Promise<string> {
  return renderMetricsHtml(await readMetricsDashboardData(options), options.display);
}

async function renderUsagePage(options: {
  paths: TrackerPaths;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
  cycleStartDayParam: string | null;
}): Promise<string> {
  return renderUsageHtml(await readUsageDashboardData(options), options.display);
}

async function readDashboardData(options: {
  paths: TrackerPaths;
  since: string;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): Promise<DashboardData> {
  const generatedAt = options.now();
  const range = parseSinceRange(options.since, generatedAt);
  const agentDate = todayLocalDate(generatedAt);
  const config = await readOrCreateUserConfig(options.paths);
  const projectDisplayNames = createKnownProjectDisplayNameMap(config);
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
      capabilityViewTabs: [
        {
          id: "raw",
          label: "Raw",
          table: readDashboardCapabilities(db, range, {
            excludeSystem: false,
            limit: 25,
            sort: "tokens",
            noteLabel: "capabilities",
            view: "raw",
          }),
        },
        {
          id: "strict",
          label: "Strict (>=80)",
          table: readDashboardCapabilities(db, range, {
            excludeSystem: false,
            limit: 25,
            sort: "tokens",
            noteLabel: "capabilities",
            view: "strict",
            strictScoreThreshold: DEFAULT_STRICT_SCORE_THRESHOLD,
          }),
        },
        {
          id: "weighted",
          label: "Weighted",
          table: readDashboardCapabilities(db, range, {
            excludeSystem: false,
            limit: 25,
            sort: "tokens",
            noteLabel: "capabilities",
            view: "weighted",
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
      overviewTabs: [
        {
          id: "projects",
          label: "Projects",
          table: { ...readDashboardProjects(db, range, 10, projectDisplayNames), moreHref: "/projects" },
        },
        {
          id: "sessions",
          label: "Sessions",
          table: { ...readDashboardSessions(db, range, 10), moreHref: "/sessions" },
        },
        {
          id: "turns",
          label: "Turns",
          table: { ...readDashboardTurns(db, range, 10), moreHref: "/turns" },
        },
      ],
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

async function readUsageDashboardData(options: {
  paths: TrackerPaths;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
  cycleStartDayParam: string | null;
}): Promise<UsageDashboardData> {
  const generatedAt = options.now();
  const config = await readOrCreateUserConfig(options.paths);
  const billingCycleStartDay = parseBillingCycleStartDay(
    options.cycleStartDayParam,
    config.usage.billing_cycle_start_day,
  );
  const currentCycleRange = getBillingCycleRange(generatedAt, billingCycleStartDay);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const dailyRows = readUsageDailyRows(db, billingCycleStartDay);
    const cycleRows = aggregateUsageCycles(dailyRows);
    const currentCycle = cycleRows.find((row) =>
      row.cycle_start_date === currentCycleRange.startDate && row.cycle_end_date === currentCycleRange.endDate
    ) ?? createEmptyUsageCycle(currentCycleRange.startDate, currentCycleRange.endDate);
    const coverageSummary = summarizeUsageCoverage(dailyRows);
    const budgetProgress = summarizeUsageBudgetProgress(currentCycleRange, generatedAt);

    return {
      generatedAt: generatedAt.toISOString(),
      lastIngest: options.lastIngest,
      agent: "codex",
      billingCycleStartDay,
      availableCycleStartDays: listBillingCycleStartDays(),
      currentCycle: {
        startDate: currentCycle.cycle_start_date,
        endDate: currentCycle.cycle_end_date,
        usedCredits: currentCycle.used_credits,
        usedUsd: currentCycle.used_usd,
        expectedBaselineCredits: budgetProgress.expectedBaselineCredits,
        expectedBaselineUsd: budgetProgress.expectedBaselineUsd,
        expectedBaselineRatio: budgetProgress.expectedBaselineRatio,
        elapsedWorkdays: budgetProgress.elapsedWorkdays,
        totalWorkdays: budgetProgress.totalWorkdays,
        remainingCredits: currentCycle.remaining_credits,
        remainingUsd: currentCycle.remaining_usd,
        budgetUsedRatio: currentCycle.budget_used_ratio,
        totalRuntimeTokens: currentCycle.total_runtime_tokens,
        pricedRuntimeTokens: currentCycle.priced_runtime_tokens,
        modelCount: currentCycle.model_count,
        activeDays: currentCycle.active_days,
      },
      coverageSummary,
      currentCycleSection: {
        title: "Current cycle by model",
        table: createUsageCurrentCycleTable(dailyRows, currentCycleRange),
      },
      dailySection: {
        title: "Daily usage",
        table: createUsageDailyTable(dailyRows),
      },
      weeklySection: {
        title: "Weekly cycles",
        table: createUsageWeeklyTable(cycleRows),
      },
    };
  } finally {
    db.close();
  }
}

function renderDashboardHtml(data: DashboardData, display: DashboardDisplayMode): string {
  const generatedAt = new Date(data.generatedAt);

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>himan-tracker</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(DASHBOARD_ICON_DATA_URL)}">
  <meta name="theme-color" content="#f7f8fa">
  <style>${getSharedCss()}</style>
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
        <a href="/usage">Usage</a>
      </nav>
    </div>
  </header>
  <main>
    <div class="metrics">
      ${renderMetric("Projects", String(data.summary.project_count))}
      ${renderMetric("Sessions", String(data.summary.session_count))}
      ${renderMetric("Turns", String(data.summary.turn_count))}
      ${renderMetric("Runtime tokens", formatTokenCount(data.summary.total_tokens))}
      ${renderMetric("Avg latency", formatAverageDurationMs(data.summary.duration_ms, data.summary.turn_count))}
    </div>
    ${renderSection(data.summarySection, display)}
    ${renderTabbedSection("Runtime token usage", "token", data.tokenTabs, display)}
    ${data.sections.map((section) => renderSection(section, display)).join("\n")}
    ${renderTabbedSection("Capability ROI views", "capability-roi", data.capabilityViewTabs, display)}
    ${renderTabbedSection("Capability calls", "capability-calls", data.capabilityCallTabs, display)}
    ${renderTabbedSection("Overview", "overview", data.overviewTabs, display)}
  </main>
  <script>
    document.querySelectorAll("[data-tabs]").forEach((root) => {
      const buttons = [...root.querySelectorAll("[role='tab']")];
      const panels = [...root.querySelectorAll("[role='tabpanel']")];
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const selectedPanel = btn.getAttribute("aria-controls");
          buttons.forEach((b) => {
            const active = b === btn;
            b.setAttribute("aria-current", active ? "true" : "false");
            b.classList.toggle("outline", !active);
            b.setAttribute("tabindex", active ? "0" : "-1");
          });
          panels.forEach((p) => { p.hidden = p.id !== selectedPanel; });
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
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>himan-tracker Metrics</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(DASHBOARD_ICON_DATA_URL)}">
  <meta name="theme-color" content="#f7f8fa">
  <style>${getSharedCss()}</style>
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
        <a href="/usage">Usage</a>
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
      const buttons = [...root.querySelectorAll("[role='tab']")];
      const panels = [...root.querySelectorAll("[role='tabpanel']")];
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const selectedPanel = btn.getAttribute("aria-controls");
          buttons.forEach((b) => {
            const active = b === btn;
            b.setAttribute("aria-current", active ? "true" : "false");
            b.classList.toggle("outline", !active);
            b.setAttribute("tabindex", active ? "0" : "-1");
          });
          panels.forEach((p) => { p.hidden = p.id !== selectedPanel; });
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderUsageHtml(data: UsageDashboardData, display: DashboardDisplayMode): string {
  const generatedAt = new Date(data.generatedAt);
  const cycleQuery = new URLSearchParams({ cycleStartDay: data.billingCycleStartDay }).toString();
  const usedRatio = clampRatio(data.currentCycle.budgetUsedRatio);
  const baselineRatio = clampRatio(data.currentCycle.expectedBaselineRatio);
  const baselineDelta = data.currentCycle.usedCredits - data.currentCycle.expectedBaselineCredits;
  const isOverBaseline = baselineDelta > 0.000_001;
  const usedCardClass = isOverBaseline ? " usage-legend-item is-alert" : "";
  const deltaCardClass = isOverBaseline ? " usage-summary-item is-alert" : "";
  const heroClass = isOverBaseline ? " usage-hero is-alert" : "";

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>himan-tracker Usage</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(DASHBOARD_ICON_DATA_URL)}">
  <meta name="theme-color" content="#f7f8fa">
  <style>${getSharedCss()}</style>
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>Usage</h1>
      <div class="status">${renderIngestStatus(data.lastIngest)} · Generated ${escapeHtml(
    formatLocalDateTime(generatedAt),
  )}</div>
      <nav class="nav" aria-label="Dashboard navigation">
        <a href="/">Overview</a>
        <a href="/metrics">Metrics</a>
        <a href="/usage" aria-current="page">Usage</a>
      </nav>
    </div>
  </header>
  <main>
    <section class="usage-hero${heroClass}">
      <div class="usage-hero-head">
        <div>
          <div class="usage-hero-kicker">Cycle budget progress</div>
          <div class="usage-hero-value">${escapeHtml(formatCredits(data.currentCycle.usedCredits))} / ${escapeHtml(formatCredits(CODEX_WEEKLY_BUDGET_CREDITS))} credits</div>
          <div class="usage-hero-subtitle">Current cycle: ${escapeHtml(data.currentCycle.startDate)} → ${escapeHtml(data.currentCycle.endDate)} · Remaining ${escapeHtml(formatCredits(data.currentCycle.remainingCredits))} credits (${escapeHtml(formatUsd(data.currentCycle.remainingUsd))})</div>
          ${isOverBaseline
      ? `<div class="usage-alert-badge">Over expected baseline by ${escapeHtml(formatCredits(baselineDelta))} credits</div>`
      : ""}
        </div>
        <div class="usage-badge">Coverage ${escapeHtml(formatPercent(data.coverageSummary.pricedTokenRatio))}</div>
      </div>
      <div class="usage-progress">
        <div class="usage-progress-track" aria-label="Cycle budget progress">
          <div class="usage-progress-fill" style="width: ${usedRatio}%"></div>
          <div class="usage-progress-marker is-baseline" style="left: ${baselineRatio}%"></div>
        </div>
        <div class="usage-progress-scale">
          <span>0 credits</span>
          <span>${escapeHtml(formatCredits(CODEX_WEEKLY_BUDGET_CREDITS))} credits</span>
        </div>
      </div>
      <div class="usage-legend">
        <div class="usage-legend-item${usedCardClass}">
          <div class="usage-legend-head"><span class="usage-legend-dot is-used"></span>Used</div>
          <div class="usage-legend-value">${escapeHtml(formatCredits(data.currentCycle.usedCredits))} credits</div>
          <div class="usage-legend-subtle">${escapeHtml(formatUsd(data.currentCycle.usedUsd))} · ${escapeHtml(formatPercent(data.currentCycle.budgetUsedRatio))} of total${isOverBaseline ? ` · ${escapeHtml(formatSignedCredits(baselineDelta))} vs baseline` : ""}</div>
        </div>
        <div class="usage-legend-item">
          <div class="usage-legend-head"><span class="usage-legend-dot is-baseline"></span>Expected baseline</div>
          <div class="usage-legend-value">${escapeHtml(formatCredits(data.currentCycle.expectedBaselineCredits))} credits</div>
          <div class="usage-legend-subtle">${escapeHtml(formatUsd(data.currentCycle.expectedBaselineUsd))} · 75 / 5 × ${escapeHtml(String(data.currentCycle.elapsedWorkdays))} workdays</div>
        </div>
        <div class="usage-legend-item">
          <div class="usage-legend-head"><span class="usage-legend-dot is-total"></span>Total budget</div>
          <div class="usage-legend-value">${escapeHtml(formatCredits(CODEX_WEEKLY_BUDGET_CREDITS))} credits</div>
          <div class="usage-legend-subtle">${escapeHtml(formatUsd(CODEX_WEEKLY_BUDGET_USD))} · ${escapeHtml(String(data.currentCycle.totalWorkdays))} workdays per cycle</div>
        </div>
      </div>
      <div class="usage-summary-grid">
        <div class="usage-summary-item">
          <div class="usage-summary-label">Remaining</div>
          <div class="usage-summary-value">${escapeHtml(formatCredits(data.currentCycle.remainingCredits))} credits</div>
          <div class="usage-summary-subtle">${escapeHtml(formatUsd(data.currentCycle.remainingUsd))}</div>
        </div>
        <div class="usage-summary-item${deltaCardClass}">
          <div class="usage-summary-label">Baseline delta</div>
          <div class="usage-summary-value">${escapeHtml(formatSignedCredits(baselineDelta))}</div>
          <div class="usage-summary-subtle">Used vs expected baseline</div>
        </div>
        <div class="usage-summary-item">
          <div class="usage-summary-label">Coverage</div>
          <div class="usage-summary-value">${escapeHtml(formatPercent(data.coverageSummary.pricedTokenRatio))}</div>
          <div class="usage-summary-subtle">${escapeHtml(formatTokenCount(data.coverageSummary.pricedRuntimeTokens))} of ${escapeHtml(formatTokenCount(data.coverageSummary.totalRuntimeTokens))} runtime tokens priced</div>
        </div>
        <div class="usage-summary-item">
          <div class="usage-summary-label">Active days</div>
          <div class="usage-summary-value">${escapeHtml(String(data.currentCycle.activeDays))} days</div>
          <div class="usage-summary-subtle">${escapeHtml(String(data.currentCycle.modelCount))} models in this cycle</div>
        </div>
      </div>
    </section>
    <section>
      <h2>Billing settings</h2>
      <form class="usage-controls" method="get" action="/usage">
        <div class="usage-control">
          <label for="cycleStartDay">Billing cycle starts on</label>
          <select id="cycleStartDay" name="cycleStartDay">
            ${data.availableCycleStartDays.map((day) =>
        `<option value="${escapeHtml(day)}"${day === data.billingCycleStartDay ? " selected" : ""}>${escapeHtml(formatBillingCycleStartDay(day))}</option>`
      ).join("")}
          </select>
        </div>
        <button type="submit">Update</button>
      </form>
      <div class="usage-note">
        Codex weekly budget is fixed at ${formatUsd(CODEX_WEEKLY_BUDGET_USD)} / ${formatCredits(CODEX_WEEKLY_BUDGET_CREDITS)} credits. Cost estimates use the provided Codex credit rate card, price only rows with known model pricing and observed input/output token splits, and currently do not apply cached-input discounts separately.
      </div>
    </section>
    ${renderSection(data.currentCycleSection, display)}
    ${renderSection(data.dailySection, display)}
    ${renderSection(data.weeklySection, display)}
    <section>
      <h2>Raw data</h2>
      <p class="table-note"><a class="more-link" href="/usage.json?${escapeHtml(cycleQuery)}">Open usage.json</a></p>
      <p class="usage-note">The JSON endpoint exposes the resolved billing cycle start day together with the current-cycle, daily, and weekly aggregates used by this page.</p>
    </section>
  </main>
</body>
</html>`;
}

function summarizeUsageBudgetProgress(
  cycleRange: { startDate: string; endDate: string },
  now: Date,
): {
  expectedBaselineCredits: number;
  expectedBaselineUsd: number;
  expectedBaselineRatio: number;
  elapsedWorkdays: number;
  totalWorkdays: number;
} {
  const start = parseLocalDate(cycleRange.startDate);
  const end = parseLocalDate(cycleRange.endDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const effectiveEnd = today < end ? today : end;

  let elapsedWorkdays = 0;
  let totalWorkdays = 0;

  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    if (!isWeekday(cursor)) {
      continue;
    }

    totalWorkdays += 1;
    if (cursor <= effectiveEnd) {
      elapsedWorkdays += 1;
    }
  }

  const expectedBaselineRatio = totalWorkdays > 0 ? elapsedWorkdays / totalWorkdays : 0;
  const expectedBaselineCredits = CODEX_WEEKLY_BUDGET_CREDITS * expectedBaselineRatio;

  return {
    expectedBaselineCredits,
    expectedBaselineUsd: creditsToUsd(expectedBaselineCredits),
    expectedBaselineRatio,
    elapsedWorkdays,
    totalWorkdays,
  };
}

function readUsageDailyRows(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  billingCycleStartDay: BillingCycleStartDay,
): UsageDailyRow[] {
  const rows = db
    .prepare(
      `
      select
        date,
        model,
        sum(turn_count) as turn_count,
        case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
        case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from daily_agent_stats
      where agent = 'codex'
      group by date, model
      order by date desc, model asc
      `,
    )
    .all() as UsageDailyAgentStatsRow[];

  return rows.map((row) => {
    const cycleRange = getBillingCycleRange(parseLocalDate(row.date), billingCycleStartDay);
    const estimate = estimateCodexCost({
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    });
    const pricedRuntimeTokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);

    return {
      ...row,
      cycle_start_date: cycleRange.startDate,
      cycle_end_date: cycleRange.endDate,
      estimated_credits: estimate.estimatedCredits ?? 0,
      estimated_usd: estimate.estimatedUsd ?? 0,
      priced_runtime_tokens: pricedRuntimeTokens,
      coverage: estimate.coverage,
      rate_card_model: estimate.pricing?.sourceModel ?? null,
      rate_card_alias_of: estimate.pricing?.aliasOf ?? null,
    };
  });
}

function aggregateUsageCycles(rows: UsageDailyRow[]): UsageCycleRow[] {
  const cycles = new Map<string, UsageCycleRow & { models: Set<string>; days: Set<string> }>();

  for (const row of rows) {
    const key = `${row.cycle_start_date}:${row.cycle_end_date}`;
    const existing = cycles.get(key) ?? {
      cycle_start_date: row.cycle_start_date,
      cycle_end_date: row.cycle_end_date,
      model_count: 0,
      active_days: 0,
      total_runtime_tokens: 0,
      priced_runtime_tokens: 0,
      used_credits: 0,
      used_usd: 0,
      remaining_credits: CODEX_WEEKLY_BUDGET_CREDITS,
      remaining_usd: CODEX_WEEKLY_BUDGET_USD,
      budget_used_ratio: 0,
      models: new Set<string>(),
      days: new Set<string>(),
    };

    existing.total_runtime_tokens += row.total_tokens ?? 0;
    existing.priced_runtime_tokens += row.priced_runtime_tokens;
    existing.used_credits += row.estimated_credits;
    existing.used_usd += row.estimated_usd;
    existing.models.add(row.model);
    existing.days.add(row.date);
    cycles.set(key, existing);
  }

  return [...cycles.values()]
    .map((cycle) => {
      const remainingCredits = Math.max(CODEX_WEEKLY_BUDGET_CREDITS - cycle.used_credits, 0);
      const remainingUsd = Math.max(CODEX_WEEKLY_BUDGET_USD - cycle.used_usd, 0);

      return {
        cycle_start_date: cycle.cycle_start_date,
        cycle_end_date: cycle.cycle_end_date,
        model_count: cycle.models.size,
        active_days: cycle.days.size,
        total_runtime_tokens: cycle.total_runtime_tokens,
        priced_runtime_tokens: cycle.priced_runtime_tokens,
        used_credits: cycle.used_credits,
        used_usd: cycle.used_usd,
        remaining_credits: remainingCredits,
        remaining_usd: remainingUsd,
        budget_used_ratio: cycle.used_credits / CODEX_WEEKLY_BUDGET_CREDITS,
      };
    })
    .sort((left, right) => right.cycle_start_date.localeCompare(left.cycle_start_date));
}

function summarizeUsageCoverage(rows: UsageDailyRow[]): UsageCoverageSummary {
  let pricedRuntimeTokens = 0;
  let totalRuntimeTokens = 0;
  let fullyPricedDayCount = 0;
  let partiallyPricedDayCount = 0;
  let unpricedDayCount = 0;

  for (const row of rows) {
    pricedRuntimeTokens += row.priced_runtime_tokens;
    totalRuntimeTokens += row.total_tokens ?? 0;

    if (row.coverage === "full") {
      fullyPricedDayCount += 1;
    } else if (row.coverage === "partial") {
      partiallyPricedDayCount += 1;
    } else {
      unpricedDayCount += 1;
    }
  }

  return {
    pricedRuntimeTokens,
    totalRuntimeTokens,
    pricedTokenRatio: totalRuntimeTokens > 0 ? pricedRuntimeTokens / totalRuntimeTokens : null,
    uncoveredRuntimeTokens: Math.max(totalRuntimeTokens - pricedRuntimeTokens, 0),
    fullyPricedDayCount,
    partiallyPricedDayCount,
    unpricedDayCount,
  };
}

function createUsageCurrentCycleTable(
  rows: UsageDailyRow[],
  currentCycleRange: { startDate: string; endDate: string },
): DashboardTable {
  const currentCycleRows = rows
    .filter((row) =>
      row.cycle_start_date === currentCycleRange.startDate && row.cycle_end_date === currentCycleRange.endDate
    )
    .sort((left, right) => right.estimated_credits - left.estimated_credits || left.model.localeCompare(right.model));

  const aggregates = new Map<string, UsageDailyRow & { day_count: number }>();
  for (const row of currentCycleRows) {
    const key = `${row.model}:${row.rate_card_model ?? "unknown"}`;
    const existing = aggregates.get(key) ?? {
      ...row,
      turn_count: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      estimated_credits: 0,
      estimated_usd: 0,
      priced_runtime_tokens: 0,
      day_count: 0,
      coverage: "full" as CodexCostEstimate["coverage"],
    };
    existing.turn_count += row.turn_count;
    existing.input_tokens = sumNullable(existing.input_tokens, row.input_tokens);
    existing.output_tokens = sumNullable(existing.output_tokens, row.output_tokens);
    existing.total_tokens = sumNullable(existing.total_tokens, row.total_tokens);
    existing.estimated_credits += row.estimated_credits;
    existing.estimated_usd += row.estimated_usd;
    existing.priced_runtime_tokens += row.priced_runtime_tokens;
    existing.day_count += 1;
    existing.coverage = mergeCoverage(existing.coverage, row.coverage);
    aggregates.set(key, existing);
  }

  const modelRows = [...aggregates.values()].sort(
    (left, right) => right.estimated_credits - left.estimated_credits || left.model.localeCompare(right.model),
  );

  return {
    columns: [
      "Model",
      "Rate card",
      "Days",
      "Turns",
      "Input",
      "Output",
      "Runtime tokens",
      "Credits",
      "USD",
      "Coverage",
    ],
    rows: modelRows.map((row) => [
      row.model,
      row.rate_card_alias_of ? `${row.rate_card_model} via ${row.rate_card_alias_of}` : formatNullableText(row.rate_card_model),
      String(row.day_count),
      String(row.turn_count),
      formatTokenCount(row.input_tokens),
      formatTokenCount(row.output_tokens),
      formatTokenCount(row.total_tokens),
      formatCredits(row.estimated_credits),
      formatUsd(row.estimated_usd),
      formatCoverageLabel(row.coverage),
    ]),
    emptyText: "No Codex usage found in the current billing cycle.",
    note: `Current cycle ${currentCycleRange.startDate} to ${currentCycleRange.endDate}.`,
  };
}

function createUsageDailyTable(rows: UsageDailyRow[]): DashboardTable {
  return {
    columns: [
      "Date",
      "Cycle",
      "Model",
      "Rate card",
      "Turns",
      "Input",
      "Output",
      "Runtime tokens",
      "Credits",
      "USD",
      "Coverage",
    ],
    rows: rows.map((row) => [
      row.date,
      `${formatShortDate(parseLocalDate(row.cycle_start_date))} → ${formatShortDate(parseLocalDate(row.cycle_end_date))}`,
      row.model,
      row.rate_card_alias_of ? `${row.rate_card_model} via ${row.rate_card_alias_of}` : formatNullableText(row.rate_card_model),
      String(row.turn_count),
      formatTokenCount(row.input_tokens),
      formatTokenCount(row.output_tokens),
      formatTokenCount(row.total_tokens),
      formatCredits(row.estimated_credits),
      formatUsd(row.estimated_usd),
      formatCoverageLabel(row.coverage),
    ]),
    emptyText: "No Codex usage found yet.",
    note: "Daily runtime-token usage and estimated cost by model.",
  };
}

function createUsageWeeklyTable(rows: UsageCycleRow[]): DashboardTable {
  return {
    columns: [
      "Cycle",
      "Active days",
      "Models",
      "Runtime tokens",
      "Priced tokens",
      "Credits used",
      "USD used",
      "Budget used",
      "Credits left",
      "USD left",
    ],
    rows: rows.map((row) => [
      `${row.cycle_start_date} → ${row.cycle_end_date}`,
      String(row.active_days),
      String(row.model_count),
      formatTokenCount(row.total_runtime_tokens),
      formatTokenCount(row.priced_runtime_tokens),
      formatCredits(row.used_credits),
      formatUsd(row.used_usd),
      formatPercent(row.budget_used_ratio),
      formatCredits(row.remaining_credits),
      formatUsd(row.remaining_usd),
    ]),
    emptyText: "No Codex billing cycles found yet.",
    note: "Weekly budget assumes $75 = 1,875 credits with no carry-over between cycles.",
  };
}

function createEmptyUsageCycle(startDate: string, endDate: string): UsageCycleRow {
  return {
    cycle_start_date: startDate,
    cycle_end_date: endDate,
    model_count: 0,
    active_days: 0,
    total_runtime_tokens: 0,
    priced_runtime_tokens: 0,
    used_credits: 0,
    used_usd: 0,
    remaining_credits: CODEX_WEEKLY_BUDGET_CREDITS,
    remaining_usd: CODEX_WEEKLY_BUDGET_USD,
    budget_used_ratio: 0,
  };
}

function renderListPageHtml(options: {
  title: string;
  table: DashboardTable;
  ingestStatus: string;
  generatedAt: string;
  display: DashboardDisplayMode;
}): string {
  const { title, table, ingestStatus, generatedAt, display } = options;
  const breadcrumb = `<a href="/">Overview</a> <span class="breadcrumb-sep">›</span> <span class="breadcrumb-current">${escapeHtml(title)}</span>`;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} – himan-tracker</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(DASHBOARD_ICON_DATA_URL)}">
  <meta name="theme-color" content="#f7f8fa">
  <style>${getSharedCss()}</style>
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>${escapeHtml(title)}</h1>
      <div class="status">${ingestStatus} · Generated ${escapeHtml(generatedAt)}</div>
      <nav class="breadcrumb" aria-label="Breadcrumb">
        ${breadcrumb}
      </nav>
    </div>
  </header>
  <main>
    <section>
      <h2>${escapeHtml(title)}</h2>
      ${renderDashboardContent(table, display)}
    </section>
  </main>
</body>
</html>`;
}

async function renderProjectsHtml(options: {
  paths: TrackerPaths;
  since: string;
  page: number;
  pageSize: number;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): Promise<string> {
  const generatedAt = options.now();
  const range = parseSinceRange(options.since, generatedAt);
  const config = await readOrCreateUserConfig(options.paths);
  const projectDisplayNames = createKnownProjectDisplayNameMap(config);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const table = readDashboardProjects(
      db,
      range,
      { page: options.page, pageSize: options.pageSize, basePath: "/projects" },
      projectDisplayNames,
    );
    return renderListPageHtml({
      title: "Projects",
      table,
      ingestStatus: renderIngestStatus(options.lastIngest),
      generatedAt: formatLocalDateTime(generatedAt),
      display: options.display,
    });
  } finally {
    db.close();
  }
}

function renderSessionsHtml(options: {
  paths: TrackerPaths;
  since: string;
  page: number;
  pageSize: number;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): string {
  const generatedAt = options.now();
  const range = parseSinceRange(options.since, generatedAt);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const table = readDashboardSessions(db, range, {
      page: options.page,
      pageSize: options.pageSize,
      basePath: "/sessions",
    });
    return renderListPageHtml({
      title: "Sessions",
      table,
      ingestStatus: renderIngestStatus(options.lastIngest),
      generatedAt: formatLocalDateTime(generatedAt),
      display: options.display,
    });
  } finally {
    db.close();
  }
}

function renderTurnsHtml(options: {
  paths: TrackerPaths;
  since: string;
  page: number;
  pageSize: number;
  display: DashboardDisplayMode;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): string {
  const generatedAt = options.now();
  const range = parseSinceRange(options.since, generatedAt);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const table = readDashboardTurns(db, range, {
      page: options.page,
      pageSize: options.pageSize,
      basePath: "/turns",
    });
    return renderListPageHtml({
      title: "Turns",
      table,
      ingestStatus: renderIngestStatus(options.lastIngest),
      generatedAt: formatLocalDateTime(generatedAt),
      display: options.display,
    });
  } finally {
    db.close();
  }
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
      ["Projects", String(summary.project_count)],
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
          c.static_package_tokens,
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
        case when count(static_package_tokens) = 0 then null else max(static_package_tokens) end as static_package_tokens,
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
    columns: ["Agent", "Type", "Capability", "Invocations", "Runtime tokens", "Static tokens", "Duration"],
    rows: rows.map((row) => [
      row.agent,
      row.capability_type,
      row.capability_name,
      String(row.invocation_count),
      formatTokenCount(row.total_tokens),
      formatTokenCount(row.static_package_tokens),
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
    view?: DashboardCapabilityView;
    strictScoreThreshold?: number;
  },
): DashboardTable {
  const view = filters.view ?? "raw";
  const strictScoreThreshold = filters.strictScoreThreshold ?? DEFAULT_STRICT_SCORE_THRESHOLD;
  const clauses = ["date(c.occurred_at, 'localtime') between ? and ?"];
  const params: Array<string | number> = [range.startDate, range.endDate];

  if (filters.excludeSystem) {
    const condition = createExcludeSystemCapabilityCondition("c");
    clauses.push(condition.sql);
    params.push(...condition.params);
  }

  if (view === "strict") {
    clauses.push(`${EFFECTIVE_ATTRIBUTION_SCORE_SQL} >= ?`);
    params.push(strictScoreThreshold);
  }

  const invocationMetricSql =
    view === "weighted" ? "sum(weight) as invocation_count" : "count(*) as invocation_count";
  const totalTokensMetricSql =
    view === "weighted"
      ? "case when count(weighted_total_tokens) = 0 then null else sum(weighted_total_tokens) end as total_tokens"
      : "case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens";
  const durationCountMetricSql =
    view === "weighted"
      ? "sum(case when effective_duration_ms is null then 0 else weight end) as duration_count"
      : "count(effective_duration_ms) as duration_count";
  const durationMetricSql =
    view === "weighted"
      ? "case when count(weighted_duration_ms) = 0 then null else sum(weighted_duration_ms) end as duration_ms"
      : `
        case
          when count(effective_duration_ms) = 0 then null
          else sum(effective_duration_ms)
        end as duration_ms
      `;

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
          c.static_package_tokens,
          coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
            as effective_duration_ms,
          case
            when c.total_tokens is null then null
            else (
              c.total_tokens * (${EFFECTIVE_ATTRIBUTION_SCORE_SQL} / 100.0)
            )
          end as weighted_total_tokens,
          case
            when coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) is null
              then null
            else (
              coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) *
              (${EFFECTIVE_ATTRIBUTION_SCORE_SQL} / 100.0)
            )
          end as weighted_duration_ms,
          (${EFFECTIVE_ATTRIBUTION_SCORE_SQL} / 100.0) as weight,
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
          ${invocationMetricSql},
          ${totalTokensMetricSql},
          case when count(static_package_tokens) = 0 then null else max(static_package_tokens) end as static_package_tokens,
          ${durationCountMetricSql},
          ${durationMetricSql},
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
      "Static tokens",
      "Avg duration",
      "Min duration",
      "Max duration",
      "Success rate",
    ],
    rows: visibleRows.map((row) => [
      row.agent,
      row.capability_type,
      row.capability_name,
      formatDashboardInvocationCount(view, row.invocation_count),
      String(row.explicit_invocation_count),
      String(row.inferred_invocation_count),
      String(row.observed_invocation_count),
      String(row.unknown_origin_count),
      formatTokenCount(row.total_tokens),
      formatTokenCount(row.static_package_tokens),
      formatAverageDurationMs(row.duration_ms, row.duration_count),
      formatDurationMs(row.min_duration_ms),
      formatDurationMs(row.max_duration_ms),
      formatSuccessRate(row.success_count, row.failure_count),
    ]),
    emptyText: "No capability usage found for this range.",
    note: createCapabilitiesNote({
      range,
      view,
      strictScoreThreshold,
      visibleCount: visibleRows.length,
      totalCount: rows.length,
      noteLabel: filters.noteLabel,
    }),
  };
}

function createCapabilitiesNote(options: {
  range: { startDate: string; endDate: string };
  view: DashboardCapabilityView;
  strictScoreThreshold: number;
  visibleCount: number;
  totalCount: number;
  noteLabel: string;
}): string {
  const base = `Showing ${options.visibleCount} of ${options.totalCount} ${options.noteLabel} (${formatDateRange(
    options.range,
  )})`;

  if (options.view === "strict") {
    return `${base}, view=strict, score>=${options.strictScoreThreshold}.`;
  }

  if (options.view === "weighted") {
    return `${base}, view=weighted (confidence-weighted invocations/tokens/duration).`;
  }

  return `${base}, view=raw.`;
}

function formatDashboardInvocationCount(view: DashboardCapabilityView, value: number): string {
  if (view !== "weighted") {
    return String(value);
  }

  return value.toFixed(2).replace(/\.00$/, "");
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
  limit: number | PaginationQuery,
): DashboardTable {
  const paginated = typeof limit !== "number";
  const pagination = normalizePaginationQuery(limit, "/turns");
  const offset = getPaginationOffset(pagination);
  const totalRow = db
    .prepare(
      `
      select count(*) as total_count
      from turns
      where date(occurred_at, 'localtime') between ? and ?
      `,
    )
    .get(range.startDate, range.endDate) as { total_count: number };
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
      limit ? offset ?
      `,
    )
    .all(range.startDate, range.endDate, pagination.pageSize, offset) as DashboardTurnRow[];

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
    note: paginated
      ? formatPaginationNote("turns", pagination.page, pagination.pageSize, totalRow.total_count, range)
      : `Showing latest ${rows.length} turns (${formatDateRange(range)}).`,
    pagination: paginated ? createDashboardPagination(pagination, totalRow.total_count) : undefined,
  };
}

type PaginationQuery = {
  page: number;
  pageSize: number;
  basePath: string;
};

function readDashboardProjects(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  limit: number | PaginationQuery,
  projectDisplayNames: ReadonlyMap<string, string> = new Map(),
): DashboardTable {
  const paginated = typeof limit !== "number";
  const pagination = normalizePaginationQuery(limit, "/projects");
  const offset = getPaginationOffset(pagination);
  const totalRow = db
    .prepare(
      `
      select count(*) as total_count
      from (
        select 1
        from turns
        where date(occurred_at, 'localtime') between ? and ?
        group by repo_hash
      )
      `,
    )
    .get(range.startDate, range.endDate) as { total_count: number };
  const rows = db
    .prepare(
      `
      select
        coalesce(repo_hash, 'unknown') as repo_hash,
        count(distinct session_id) as session_count,
        count(*) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms
      from turns
      where date(occurred_at, 'localtime') between ? and ?
      group by repo_hash
      order by turn_count desc, repo_hash asc
      limit ? offset ?
      `,
    )
    .all(range.startDate, range.endDate, pagination.pageSize, offset) as DashboardProjectRow[];

  return {
    columns: ["Project", "Sessions", "Turns", "Runtime tokens", "Avg latency"],
    rows: rows.map((row) => [
      repoHashToDisplay(row.repo_hash, projectDisplayNames),
      String(row.session_count),
      String(row.turn_count),
      formatTokenCount(row.total_tokens),
      formatAverageDurationMs(row.duration_ms, row.turn_count),
    ]),
    emptyText: "No project data found for this range.",
    note: paginated
      ? formatPaginationNote("projects", pagination.page, pagination.pageSize, totalRow.total_count, range)
      : `Top ${rows.length} projects (${formatDateRange(range)}).`,
    pagination: paginated ? createDashboardPagination(pagination, totalRow.total_count) : undefined,
  };
}

function repoHashToDisplay(
  repoHash: string,
  displayNames: ReadonlyMap<string, string>,
): string {
  if (repoHash === "unknown") return "unknown";
  return displayNames.get(repoHash) ?? repoHash.slice(0, 8);
}

function readDashboardSessions(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
  limit: number | PaginationQuery,
): DashboardTable {
  const paginated = typeof limit !== "number";
  const pagination = normalizePaginationQuery(limit, "/sessions");
  const offset = getPaginationOffset(pagination);
  const totalRow = db
    .prepare(
      `
      select count(*) as total_count
      from sessions
      where date(coalesce(started_at, ended_at, '1970-01-01'), 'localtime') between ? and ?
      `,
    )
    .get(range.startDate, range.endDate) as { total_count: number };
  const rows = db
    .prepare(
      `
      select
        id,
        agent,
        started_at,
        ended_at,
        duration_ms,
        turn_count,
        status
      from sessions
      where date(coalesce(started_at, ended_at, '1970-01-01'), 'localtime') between ? and ?
      order by coalesce(started_at, ended_at) desc
      limit ? offset ?
      `,
    )
    .all(range.startDate, range.endDate, pagination.pageSize, offset) as DashboardSessionRow[];

  return {
    columns: ["Session", "Agent", "Turns", "Duration", "Status"],
    rows: rows.map((row) => [
      shortenId(row.id),
      row.agent,
      String(row.turn_count),
      formatDurationMs(row.duration_ms),
      row.status,
    ]),
    emptyText: "No sessions found for this range.",
    note: paginated
      ? formatPaginationNote("sessions", pagination.page, pagination.pageSize, totalRow.total_count, range)
      : `Latest ${rows.length} sessions (${formatDateRange(range)}).`,
    pagination: paginated ? createDashboardPagination(pagination, totalRow.total_count) : undefined,
  };
}

function normalizePaginationQuery(
  query: number | PaginationQuery,
  basePath: string,
): PaginationQuery {
  if (typeof query === "number") {
    return { page: 1, pageSize: query, basePath };
  }

  return query;
}

function getPaginationOffset(pagination: Pick<PaginationQuery, "page" | "pageSize">): number {
  return (pagination.page - 1) * pagination.pageSize;
}

function createDashboardPagination(
  pagination: PaginationQuery,
  totalCount: number,
): DashboardPagination | undefined {
  if (totalCount <= pagination.pageSize) {
    return undefined;
  }

  const previousHref =
    pagination.page > 1
      ? createPaginationHref(pagination.basePath, pagination.page - 1, pagination.pageSize)
      : undefined;
  const nextHref =
    getPaginationOffset(pagination) + pagination.pageSize < totalCount
      ? createPaginationHref(pagination.basePath, pagination.page + 1, pagination.pageSize)
      : undefined;

  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalCount,
    previousHref,
    nextHref,
  };
}

function createPaginationHref(basePath: string, page: number, pageSize: number): string {
  return `${basePath}?page=${page}&pageSize=${pageSize}`;
}

function formatPaginationNote(
  label: string,
  page: number,
  pageSize: number,
  totalCount: number,
  range: { startDate: string; endDate: string },
): string {
  if (totalCount === 0) {
    return `No ${label} found (${formatDateRange(range)}).`;
  }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalCount);
  return `Showing ${start}-${end} of ${totalCount} ${label} (${formatDateRange(range)}).`;
}

function parseDashboardPageParam(page: string | null): number {
  const value = Number(page ?? "1");
  if (!Number.isInteger(value) || value <= 0) {
    return 1;
  }

  return value;
}

function parseDashboardPageSizeParam(pageSize: string | null): number {
  const value = Number(pageSize ?? "50");
  if (!Number.isInteger(value) || value <= 0 || value > 200) {
    return 50;
  }

  return value;
}

function readDashboardSummary(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
): DashboardSummary {
  const row = db
    .prepare(
      `
      select
        coalesce(
          (
            select count(distinct coalesce(repo_hash, 'unknown'))
            from turns
            where date(occurred_at, 'localtime') between ? and ?
          ),
          0
        ) as project_count,
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
    .get(range.startDate, range.endDate, range.startDate, range.endDate) as {
      project_count: number;
      session_count: number;
      turn_count: number;
      total_tokens: number | null;
      duration_ms: number | null;
      success_count: number;
      failure_count: number;
    };

  return {
    project_count: row.project_count,
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
    helperText?: string;
  } = {},
): string {
  const toneClass = options.tone ? ` is-${options.tone}` : "";
  const helperText = options.helperText
    ? `<div class="metric-subtle">${escapeHtml(options.helperText)}</div>`
    : "";

  return `<div class="metric${toneClass}"><div class="metric-label">${escapeHtml(
    label,
  )}</div><div class="metric-value">${escapeHtml(value)}</div>${helperText}</div>`;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  if (value >= 100) {
    return value.toFixed(1).replace(/\.0$/, "");
  }

  if (value >= 10) {
    return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedCredits(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  if (value === 0) {
    return "0 credits";
  }

  const sign = value > 0 ? "+" : "-";
  return `${sign}${formatCredits(Math.abs(value))} credits`;
}

function formatCoverageLabel(coverage: CodexCostEstimate["coverage"]): string {
  switch (coverage) {
    case "full":
      return "Full";
    case "partial":
      return "Partial";
    default:
      return "Unpriced";
  }
}

function clampRatio(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value * 100));
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function sumNullable(
  current: number | null | undefined,
  next: number | null | undefined,
): number | null {
  if (current === null || current === undefined) {
    return next ?? null;
  }

  if (next === null || next === undefined) {
    return current;
  }

  return current + next;
}

function mergeCoverage(
  left: CodexCostEstimate["coverage"],
  right: CodexCostEstimate["coverage"],
): CodexCostEstimate["coverage"] {
  if (left === right) {
    return left;
  }

  if (left === "none" || right === "none") {
    return "partial";
  }

  return "partial";
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
      return `<button${active ? ' aria-current="true"' : ''} id="${escapeHtml(
        idPrefix,
      )}-tab-${escapeHtml(
        tab.id,
      )}" role="tab" type="button" aria-controls="${escapeHtml(idPrefix)}-panel-${escapeHtml(tab.id)}" tabindex="${active ? "0" : "-1"
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
  )}</h2><div class="tab-bar" aria-label="${escapeHtml(
    title,
  )}">${tabButtons}</div></div>${panels}</section>`;
}

function renderDashboardContent(table: DashboardTable, display: DashboardDisplayMode): string {
  const moreLink = table.moreHref
    ? ` <a href="${escapeHtml(table.moreHref)}" class="more-link">More \u2192</a>`
    : "";
  const note = renderDashboardTableMeta(table, moreLink);
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

function renderDashboardTableMeta(table: DashboardTable, moreLink: string): string {
  if (!table.note && !moreLink && !table.pagination) {
    return "";
  }

  const pagination = table.pagination ? renderPaginationControls(table.pagination) : "";
  return `<div class="table-meta"><p class="table-note">${escapeHtml(table.note ?? "")}${moreLink}</p>${pagination}</div>`;
}

function renderPaginationControls(pagination: DashboardPagination): string {
  const previous = pagination.previousHref
    ? `<a href="${escapeHtml(pagination.previousHref)}" rel="prev">← Previous</a>`
    : `<span aria-disabled="true">← Previous</span>`;
  const next = pagination.nextHref
    ? `<a href="${escapeHtml(pagination.nextHref)}" rel="next">Next →</a>`
    : `<span aria-disabled="true">Next →</span>`;

  return `<nav class="pagination" aria-label="Pagination"><span>Page ${pagination.page}</span><div class="pagination-links">${previous}${next}</div></nav>`;
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
  return renderIngestStatusHTML(snapshot);
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
