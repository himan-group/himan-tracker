import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ensureTrackerDirectories,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../../config/paths.js";
import { parseSinceRange } from "../../reports/dateRange.js";
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_INTERVAL_SECONDS,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_SINCE,
  isProcessRunning,
  readReportServerState,
  removeReportServerState,
  resolveReportServerLogPath,
  resolveReportServerStatePath,
  startReportHttpServer,
  type ReportServerState,
} from "../../server/reportServer.js";

export type ServerCommandResult = {
  ok: boolean;
  lines: string[];
};

export type ServerStartCommandOptions = ServerCommonOptions & {
  waitMs?: number;
  spawnServer?: SpawnReportServer;
  open?: boolean;
  openBrowser?: OpenBrowser;
};

export type ServerStopCommandOptions = ServerCommonOptions & {
  waitMs?: number;
};

export type ServerStatusCommandOptions = ServerCommonOptions;

export type ServerServeCommandOptions = ServerCommonOptions & {
  host?: string;
  port?: string | number;
  interval?: string | number;
  since?: string;
  now?: () => Date;
};

type ServerCommonOptions = {
  paths?: TrackerPaths;
};

type ParsedServerOptions = {
  host: string;
  port: number;
  intervalSeconds: number;
  since: string;
};

type SpawnReportServerInput = ParsedServerOptions & {
  paths: TrackerPaths;
};

type SpawnReportServer = (input: SpawnReportServerInput) => { pid: number };
type OpenBrowser = (url: string) => Promise<void>;

const READY_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

export async function runServerStart(
  options: ServerStartCommandOptions & {
    host?: string;
    port?: string | number;
    interval?: string | number;
    since?: string;
  } = {},
): Promise<ServerCommandResult> {
  const commandName = "server start";

  try {
    const paths = options.paths ?? resolveTrackerPaths();
    const parsed = parseServerOptions(options);
    await ensureTrackerDirectories(paths);

    const existingState = await readReportServerState(paths);
    if (existingState && isProcessRunning(existingState.pid)) {
      const browserLines = await resolveBrowserLines(existingState.url, options);
      return {
        ok: true,
        lines: [
          "himan-tracker server start",
          "",
          `Already running: ${existingState.url}`,
          `PID: ${existingState.pid}`,
          `State: ${resolveReportServerStateLabel(paths)}`,
          ...browserLines,
        ],
      };
    }

    if (existingState) {
      await removeReportServerState(paths);
    }

    const spawnServer = options.spawnServer ?? spawnDetachedReportServer;
    const child = spawnServer({ paths, ...parsed });
    const state = await waitForServerReady(paths, child.pid, options.waitMs ?? READY_TIMEOUT_MS);
    const browserLines = await resolveBrowserLines(state.url, options);

    return {
      ok: true,
      lines: [
        "himan-tracker server start",
        "",
        `Started: ${state.url}`,
        `PID: ${state.pid}`,
        `Ingest interval: ${state.interval_seconds}s`,
        `Report range: ${state.since}`,
        `State: ${resolveReportServerStateLabel(paths)}`,
        `Log: ${resolveReportServerLogPath(paths)}`,
        ...browserLines,
      ],
    };
  } catch (error) {
    return formatServerError(commandName, error);
  }
}

export async function runServerStop(
  options: ServerStopCommandOptions = {},
): Promise<ServerCommandResult> {
  const commandName = "server stop";

  try {
    const paths = options.paths ?? resolveTrackerPaths();
    await ensureTrackerDirectories(paths);
    const state = await readReportServerState(paths);

    if (!state) {
      return {
        ok: true,
        lines: ["himan-tracker server stop", "", "Server is not running."],
      };
    }

    if (!isProcessRunning(state.pid)) {
      await removeReportServerState(paths);
      return {
        ok: true,
        lines: [
          "himan-tracker server stop",
          "",
          `Removed stale state for PID ${state.pid}.`,
        ],
      };
    }

    try {
      process.kill(state.pid, "SIGTERM");
    } catch (error) {
      if (!isNodeErrorCode(error, "ESRCH")) {
        throw error;
      }
    }

    const stopped = await waitForServerStopped(
      paths,
      state.pid,
      options.waitMs ?? READY_TIMEOUT_MS,
    );
    if (!stopped) {
      return {
        ok: false,
        lines: [
          "himan-tracker server stop",
          "",
          `[fail] server did not stop within ${options.waitMs ?? READY_TIMEOUT_MS}ms`,
        ],
      };
    }

    await removeReportServerState(paths, state.pid);

    return {
      ok: true,
      lines: ["himan-tracker server stop", "", `Stopped PID ${state.pid}.`],
    };
  } catch (error) {
    return formatServerError(commandName, error);
  }
}

export async function runServerStatus(
  options: ServerStatusCommandOptions = {},
): Promise<ServerCommandResult> {
  const commandName = "server status";

  try {
    const paths = options.paths ?? resolveTrackerPaths();
    await ensureTrackerDirectories(paths);
    const state = await readReportServerState(paths);

    if (!state) {
      return {
        ok: true,
        lines: ["himan-tracker server status", "", "Server is not running."],
      };
    }

    const running = isProcessRunning(state.pid);

    return {
      ok: true,
      lines: [
        "himan-tracker server status",
        "",
        `[${running ? "ok" : "warn"}] ${running ? "running" : "stale state"}`,
        `URL: ${state.url}`,
        `PID: ${state.pid}`,
        `Started: ${state.started_at}`,
        `Ingest interval: ${state.interval_seconds}s`,
        `Report range: ${state.since}`,
        `Last ingest: ${formatLastIngest(state)}`,
        `State: ${resolveReportServerStateLabel(paths)}`,
        `Log: ${resolveReportServerLogPath(paths)}`,
      ],
    };
  } catch (error) {
    return formatServerError(commandName, error);
  }
}

export async function runServerServe(
  options: ServerServeCommandOptions = {},
): Promise<ServerCommandResult> {
  const commandName = "server serve";

  try {
    const paths = options.paths ?? resolveTrackerPaths();
    const parsed = parseServerOptions(options);
    const instance = await startReportHttpServer({
      paths,
      host: parsed.host,
      port: parsed.port,
      intervalSeconds: parsed.intervalSeconds,
      since: parsed.since,
      now: options.now,
    });

    let resolveStopped: (() => void) | undefined;
    let shuttingDown = false;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const shutdown = (): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      void instance.close().finally(() => {
        resolveStopped?.();
      });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await stopped;

    return {
      ok: true,
      lines: ["himan-tracker server serve", "", `Stopped ${instance.url}`],
    };
  } catch (error) {
    return formatServerError(commandName, error);
  }
}

function spawnDetachedReportServer(input: SpawnReportServerInput): { pid: number } {
  const entrypoint = fileURLToPath(new URL("../index.js", import.meta.url));
  const logPath = resolveReportServerLogPath(input.paths);
  const logFd = openSync(logPath, "a", 0o600);

  try {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        entrypoint,
        "server",
        "serve",
        "--host",
        input.host,
        "--port",
        String(input.port),
        "--interval",
        String(input.intervalSeconds),
        "--since",
        input.since,
      ],
      {
        detached: true,
        env: {
          ...process.env,
          HIMAN_TRACKER_HOME: input.paths.homeDir,
        },
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      },
    );

    if (!child.pid) {
      throw new Error("Could not start server process");
    }

    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

async function resolveBrowserLines(
  url: string,
  options: Pick<ServerStartCommandOptions, "open" | "openBrowser">,
): Promise<string[]> {
  if (!options.open) {
    return [];
  }

  try {
    await (options.openBrowser ?? openUrlInDefaultBrowser)(url);
    return [`Opened browser: ${url}`];
  } catch (error) {
    return [`[warn] Could not open browser: ${getErrorMessage(error)}`];
  }
}

async function openUrlInDefaultBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url], { timeout: 5_000, windowsHide: true });
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url], {
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }

  await execFileAsync("xdg-open", [url], { timeout: 5_000, windowsHide: true });
}

function parseServerOptions(options: {
  host?: string;
  port?: string | number;
  interval?: string | number;
  since?: string;
}): ParsedServerOptions {
  const host = options.host?.trim() || DEFAULT_SERVER_HOST;
  const port = parsePort(options.port);
  const intervalSeconds = parseInterval(options.interval);
  const since = options.since ?? DEFAULT_SERVER_SINCE;

  parseSinceRange(since, new Date());

  return {
    host,
    port,
    intervalSeconds,
    since,
  };
}

function parsePort(value: string | number | undefined): number {
  const port = typeof value === "number" ? value : Number(value ?? DEFAULT_SERVER_PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Expected --port to be an integer between 0 and 65535");
  }

  return port;
}

function parseInterval(value: string | number | undefined): number {
  const interval =
    typeof value === "number" ? value : Number(value ?? DEFAULT_SERVER_INTERVAL_SECONDS);

  if (!Number.isInteger(interval) || interval < 1 || interval > 86_400) {
    throw new Error("Expected --interval to be an integer between 1 and 86400 seconds");
  }

  return interval;
}

async function waitForServerReady(
  paths: TrackerPaths,
  pid: number,
  timeoutMs: number,
): Promise<ReportServerState> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readReportServerState(paths);
    if (state?.pid === pid && isProcessRunning(pid)) {
      return state;
    }

    if (!isProcessRunning(pid)) {
      throw new Error(
        `Server process exited before it was ready. See ${resolveReportServerLogPath(paths)}`,
      );
    }

    await sleep(100);
  }

  throw new Error(
    `Server did not become ready within ${timeoutMs}ms. See ${resolveReportServerLogPath(paths)}`,
  );
}

async function waitForServerStopped(
  paths: TrackerPaths,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readReportServerState(paths);
    if (!state || state.pid !== pid) {
      return true;
    }

    if (!isProcessRunning(pid)) {
      return true;
    }

    await sleep(100);
  }

  const state = await readReportServerState(paths);
  return !state || state.pid !== pid || !isProcessRunning(pid);
}

function resolveReportServerStateLabel(paths: TrackerPaths): string {
  return resolveReportServerStatePath(paths);
}

function formatLastIngest(state: ReportServerState): string {
  if (!state.last_ingest) {
    return "pending";
  }

  if (!state.last_ingest.ok) {
    return `failed at ${state.last_ingest.at}: ${state.last_ingest.error}`;
  }

  return `${state.last_ingest.at}, inserted=${state.last_ingest.events_inserted}, skipped=${state.last_ingest.events_skipped}`;
}

function formatServerError(commandName: string, error: unknown): ServerCommandResult {
  return {
    ok: false,
    lines: [`himan-tracker ${commandName}`, "", `[fail] ${getErrorMessage(error)}`],
  };
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
