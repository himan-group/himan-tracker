import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

import { ingestEvents } from "../aggregator/aggregateEvents.js";
import { ensureTrackerDirectories, type TrackerPaths } from "../config/paths.js";
import { parseSinceRange, todayLocalDate } from "../reports/dateRange.js";
import {
  formatAverageDurationMs,
  formatTokenCount,
} from "../reports/formatTable.js";
import { renderAgentReport } from "../reports/agentReport.js";
import { renderCapabilityReport } from "../reports/capabilityReport.js";
import { renderSummaryReport } from "../reports/summaryReport.js";
import { renderTokenReport } from "../reports/tokenReport.js";
import { renderTurnReport } from "../reports/turnReport.js";
import { initializeTrackerDatabase } from "../storage/sqlite.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 5127;
export const DEFAULT_SERVER_INTERVAL_SECONDS = 300;
export const DEFAULT_SERVER_SINCE = "7d";

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

type DashboardSection = {
  title: string;
  lines: string[];
};

type DashboardTab = {
  id: string;
  label: string;
  lines: string[];
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
  const generatedAt = options.now();
  const range = parseSinceRange(options.since, generatedAt);
  const agentDate = todayLocalDate(generatedAt);
  const { db } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const summarySection: DashboardSection = {
      title: "Summary",
      lines: renderSummaryReport(db, range, {
        capabilityLimit: 15,
        excludeSystem: true,
      }),
    };
    const sections: DashboardSection[] = [
      {
        title: "Agents",
        lines: renderAgentReport(db, agentDate),
      },
      {
        title: "Capabilities",
        lines: renderCapabilityReport(db, range, {
          sort: "tokens",
          limit: 25,
          showTotal: true,
        }),
      },
      {
        title: "Recent turns",
        lines: renderTurnReport(db, range, { limit: 20 }),
      },
    ];
    const tokenTabs: DashboardTab[] = [
      {
        id: "day",
        label: "Daily",
        lines: renderTokenReport(db, range, "day"),
      },
      {
        id: "week",
        label: "Weekly",
        lines: renderTokenReport(db, range, "week"),
      },
      {
        id: "month",
        label: "Monthly",
        lines: renderTokenReport(db, range, "month"),
      },
    ];

    const summary = readDashboardSummary(db, range);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>himan-tracker</title>
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
      color: ${options.lastIngest?.ok === false ? "var(--danger)" : "var(--accent)"};
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

    pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      color: #24313d;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.5;
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
      <div class="status">${renderIngestStatus(options.lastIngest)} · Generated ${escapeHtml(
        formatLocalDateTime(generatedAt),
      )}</div>
    </div>
  </header>
  <main>
    <div class="metrics">
      ${renderMetric("Sessions", String(summary.session_count))}
      ${renderMetric("Turns", String(summary.turn_count))}
      ${renderMetric("Tokens", formatTokenCount(summary.total_tokens))}
      ${renderMetric("Avg latency", formatAverageDurationMs(summary.duration_ms, summary.turn_count))}
    </div>
    ${renderSection(summarySection)}
    ${renderTabbedSection("Token usage", tokenTabs)}
    ${sections.map(renderSection).join("\n")}
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
  } finally {
    db.close();
  }
}

function readDashboardSummary(
  db: ReturnType<typeof initializeTrackerDatabase>["db"],
  range: { startDate: string; endDate: string },
): {
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
} {
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

function renderMetric(label: string, value: string): string {
  return `<div class="metric"><div class="metric-label">${escapeHtml(
    label,
  )}</div><div class="metric-value">${escapeHtml(value)}</div></div>`;
}

function renderSection(section: DashboardSection): string {
  return `<section><h2>${escapeHtml(section.title)}</h2><pre>${escapeHtml(
    section.lines.join("\n"),
  )}</pre></section>`;
}

function renderTabbedSection(title: string, tabs: DashboardTab[]): string {
  const tabButtons = tabs
    .map((tab, index) => {
      const active = index === 0;
      return `<button class="tab${active ? " is-active" : ""}" id="token-tab-${escapeHtml(
        tab.id,
      )}" role="tab" type="button" aria-selected="${String(
        active,
      )}" aria-controls="token-panel-${escapeHtml(tab.id)}" tabindex="${
        active ? "0" : "-1"
      }">${escapeHtml(tab.label)}</button>`;
    })
    .join("");
  const panels = tabs
    .map((tab, index) => {
      const hidden = index === 0 ? "" : " hidden";
      return `<div id="token-panel-${escapeHtml(
        tab.id,
      )}" role="tabpanel" aria-labelledby="token-tab-${escapeHtml(
        tab.id,
      )}"${hidden}><pre>${escapeHtml(tab.lines.join("\n"))}</pre></div>`;
    })
    .join("");

  return `<section data-tabs><div class="section-heading"><h2>${escapeHtml(
    title,
  )}</h2><div class="tabs" role="tablist" aria-label="${escapeHtml(
    title,
  )}">${tabButtons}</div></div>${panels}</section>`;
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
