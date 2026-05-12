import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type TrackerPaths = {
  homeDir: string;
  configPath: string;
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
    eventsPath: path.join(homeDir, "events.jsonl"),
    errorsPath: path.join(homeDir, "errors.jsonl"),
    sqlitePath: path.join(homeDir, "himan.sqlite"),
    locksDir: path.join(homeDir, "locks"),
  };
}

export async function ensureTrackerDirectories(paths: TrackerPaths): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.locksDir, { recursive: true, mode: 0o700 });
}

export async function ensureJsonlFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "a", 0o600);
  await handle.close();
}
