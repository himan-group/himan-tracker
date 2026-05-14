import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

import { ingestEvents } from "../aggregator/aggregateEvents.js";
import { ensureTrackerDirectories, type TrackerPaths } from "../config/paths.js";
import { formatDateRange, parseSinceRange, todayLocalDate } from "../reports/dateRange.js";
import {
  formatAverageDurationMs,
  formatDurationMs,
  formatNullableText,
  formatSuccessRate,
  formatTokenCount,
} from "../reports/formatTable.js";
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

export type ReportServerState = {
  pid: number;
  host: string;
  port: number;
  url: string;
  started_at: string;
  interval_seconds: number;
  since: string;
  last_ingest: ReportServerIngestSnapshot | null;
};

export type StartReportHttpServerOptions = {
  paths: TrackerPaths;
  host?: string;
  port?: number;
  intervalSeconds?: number;
  since?: string;
  now?: () => Date;
};

export type ReportHttpServerInstance = {
  server: Server;
  url: string;
  state: ReportServerState;
  close: () => Promise<void>;
  runIngestNow: () => Promise<void>;
};

type DashboardTab = {
  id: string;
  label: string;
  table: DashboardTable;
};

type DashboardSection = {
  title: string;
  table: DashboardTable;
};

type DashboardTable = {
  columns: string[];
  rows: string[][];
  emptyText: string;
  note?: string;
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

type DashboardCapabilityCallType = "skill" | "mcp_tool";

type DashboardSummary = {
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
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

type DashboardTokenDayRow = {
  date: string;
  turn_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

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

type DashboardTurnRow = {
  occurred_at: string;
  agent: string;
  model: string;
  id: string;
  duration_ms: number | null;
  total_tokens: number | null;
  status: string;
};

export async function startReportHttpServer(
  options: StartReportHttpServerOptions,
): Promise<ReportHttpServerInstance> {
  const paths = options.paths;
  const host = options.host ?? DEFAULT_SERVER_HOST;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_SERVER_INTERVAL_SECONDS;
  const since = options.since ?? DEFAULT_SERVER_SINCE;
  const now = options.now ?? (() => new Date());
  let lastIngest: ReportServerIngestSnapshot | null = null;
  let currentState: ReportServerState | null = null;
  let ingestInFlight: Promise<void> | null = null;

  await ensureTrackerDirectories(paths);

  const runIngestNow = async (): Promise<void> => {
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
          currentState = { ...currentState, last_ingest: lastIngest };
          await writeReportServerState(paths, currentState);
        }
      });

    return ingestInFlight;
  };

  await runIngestNow();

  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      paths,
      since,
      now,
      getLastIngest: () => lastIngest,
      runIngestNow,
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
    void runIngestNow();
  }, intervalSeconds * 1_000);

  currentState = {
    pid: process.pid,
    host,
    port: resolvedPort,
    url,
    started_at: now().toISOString(),
    interval_seconds: intervalSeconds,
    since,
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
    runIngestNow,
  };
}

export function resolveReportServerStatePath(paths: TrackerPaths): string {
  return path.join(paths.homeDir, "server-state.json");
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
  now: () => Date;
  getLastIngest: () => ReportServerIngestSnapshot | null;
  runIngestNow: () => Promise<void>;
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
        last_ingest: options.getLastIngest(),
      }),
    );
    return;
  }

  if (url.pathname === "/dashboard.json") {
    await options.runIngestNow();
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

  if (url.pathname !== "/") {
    writeResponse(options.response, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }

  await options.runIngestNow();
  const html = renderDashboardPage({
    paths: options.paths,
    since: options.since,
    now: options.now,
    lastIngest: options.getLastIngest(),
  });
  writeResponse(options.response, 200, "text/html; charset=utf-8", html);
}

function renderDashboardPage(options: {
  paths: TrackerPaths;
  since: string;
  now: () => Date;
  lastIngest: ReportServerIngestSnapshot | null;
}): string {
  return renderDashboardHtml(readDashboardData(options));
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

    return {
      generatedAt: generatedAt.toISOString(),
      lastIngest: options.lastIngest,
      summary,
      summarySection: {
        title: "Summary",
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

function renderDashboardHtml(data: DashboardData): string {
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

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
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
    </div>
  </header>
  <main>
    <div class="metrics">
      ${renderMetric("Sessions", String(data.summary.session_count))}
      ${renderMetric("Turns", String(data.summary.turn_count))}
      ${renderMetric("Tokens", formatTokenCount(data.summary.total_tokens))}
      ${renderMetric("Avg latency", formatAverageDurationMs(data.summary.duration_ms, data.summary.turn_count))}
    </div>
    ${renderSection(data.summarySection)}
    ${renderTabbedSection("Token usage", "token", data.tokenTabs)}
    ${data.sections.map(renderSection).join("\n")}
    ${renderTabbedSection("Capability calls", "capability-calls", data.capabilityCallTabs)}
    ${renderSection(data.recentTurnsSection)}
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
    columns: ["Time", "Agent", "Source", "Capability", "Duration", "Basis", "Tokens", "Status", "Origin"],
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
    columns: ["Agent", "Model", "Sessions", "Turns", "Tokens", "Avg latency", "Success rate"],
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
      "Tokens",
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
    emptyText: "No token usage found for this range.",
    note: `Token usage by ${period} (${formatDateRange(range)}).`,
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
    columns: ["Time", "Agent", "Model", "Turn", "Duration", "Tokens", "Status"],
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
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms
      from daily_agent_stats
      where date between ? and ?
      `,
    )
    .get(range.startDate, range.endDate) as {
    session_count: number;
    turn_count: number;
    total_tokens: number | null;
    duration_ms: number | null;
  };

  return {
    session_count: row.session_count,
    turn_count: row.turn_count,
    total_tokens: row.total_tokens,
    duration_ms: row.duration_ms,
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

  return [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key));
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
    label: `${formatLocalDate(weekStart)} to ${formatLocalDate(weekEnd)}`,
  };
}

function parseLocalDate(dateText: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) {
    throw new Error(`Invalid local date: ${dateText}`);
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
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

function renderMetric(label: string, value: string): string {
  return `<div class="metric"><div class="metric-label">${escapeHtml(
    label,
  )}</div><div class="metric-value">${escapeHtml(value)}</div></div>`;
}

function renderSection(section: DashboardSection): string {
  return `<section><h2>${escapeHtml(section.title)}</h2>${renderDashboardTable(
    section.table,
  )}</section>`;
}

function renderTabbedSection(title: string, idPrefix: string, tabs: DashboardTab[]): string {
  const tabButtons = tabs
    .map((tab, index) => {
      const active = index === 0;
      return `<button class="tab${active ? " is-active" : ""}" id="${escapeHtml(
        idPrefix,
      )}-tab-${escapeHtml(
        tab.id,
      )}" role="tab" type="button" aria-selected="${String(
        active,
      )}" aria-controls="${escapeHtml(idPrefix)}-panel-${escapeHtml(tab.id)}" tabindex="${
        active ? "0" : "-1"
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
      )}"${hidden}>${renderDashboardTable(tab.table)}</div>`;
    })
    .join("");

  return `<section data-tabs><div class="section-heading"><h2>${escapeHtml(
    title,
  )}</h2><div class="tabs" role="tablist" aria-label="${escapeHtml(
    title,
  )}">${tabButtons}</div></div>${panels}</section>`;
}

function renderDashboardTable(table: DashboardTable): string {
  const note = table.note
    ? `<p class="table-note">${escapeHtml(table.note)}</p>`
    : "";
  if (table.rows.length === 0) {
    return `${note}<p class="empty-state">${escapeHtml(table.emptyText)}</p>`;
  }

  const header = table.columns
    .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
    .join("");
  const rows = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td>${escapeHtml(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");

  return `${note}<div class="table-scroll"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
    return value as ReportServerState;
  }

  throw new Error(`Invalid server state file: ${statePath}`);
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
