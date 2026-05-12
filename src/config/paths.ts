import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type TrackerPaths = {
  homeDir: string;
  configPath: string;
  eventsDir: string;
  errorsDir: string;
  queueDir: string;
  /** Legacy single-file paths kept for explicit imports and older local data. */
  eventsPath: string;
  errorsPath: string;
  sqlitePath: string;
  locksDir: string;
};

export function resolveTrackerPaths(env: NodeJS.ProcessEnv = process.env): TrackerPaths {
  const homeDir =
    env.HIMAN_TRACKER_HOME && env.HIMAN_TRACKER_HOME.trim().length > 0
      ? path.resolve(env.HIMAN_TRACKER_HOME)
      : path.join(homedir(), ".himan-tracker");

  return {
    homeDir,
    configPath: path.join(homeDir, "config.json"),
    eventsDir: path.join(homeDir, "events"),
    errorsDir: path.join(homeDir, "errors"),
    queueDir: path.join(homeDir, "queue"),
    eventsPath: path.join(homeDir, "events.jsonl"),
    errorsPath: path.join(homeDir, "errors.jsonl"),
    sqlitePath: path.join(homeDir, "himan.sqlite"),
    locksDir: path.join(homeDir, "locks"),
  };
}

export async function ensureTrackerDirectories(paths: TrackerPaths): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.eventsDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.errorsDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.queueDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.locksDir, { recursive: true, mode: 0o700 });
}

export function resolveDailyEventsPath(paths: TrackerPaths, occurredAt: string): string {
  return resolveDailyJsonlPath(paths.eventsDir, occurredAt);
}

export function resolveDailyErrorsPath(paths: TrackerPaths, occurredAt: string): string {
  return resolveDailyJsonlPath(paths.errorsDir, occurredAt);
}

function resolveDailyJsonlPath(directory: string, occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid JSONL shard timestamp: ${occurredAt}`);
  }

  return path.join(directory, `${formatLocalDate(date)}.jsonl`);
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
