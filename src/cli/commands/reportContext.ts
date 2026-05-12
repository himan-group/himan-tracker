import type { UserConfig } from "../../types/config.js";
import type { TrackerPaths } from "../../config/paths.js";
import { ensureTrackerDirectories, resolveTrackerPaths } from "../../config/paths.js";
import { readOrCreateUserConfig } from "../../config/userConfig.js";
import { initializeTrackerDatabase, type SqliteDatabase } from "../../storage/sqlite.js";

export type ReportCommandResult = {
  ok: boolean;
  lines: string[];
};

export type ReportCommandBaseOptions = {
  paths?: TrackerPaths;
};

export type ReportContext = {
  db: SqliteDatabase;
  paths: TrackerPaths;
  config: UserConfig;
};

export async function withReportContext<T>(
  pathsOption: TrackerPaths | undefined,
  callback: (context: ReportContext) => T,
): Promise<T> {
  const paths = pathsOption ?? resolveTrackerPaths();
  await ensureTrackerDirectories(paths);
  const config = await readOrCreateUserConfig(paths);
  const { db } = initializeTrackerDatabase(paths.sqlitePath);

  try {
    return callback({ db, paths, config });
  } finally {
    db.close();
  }
}

export function formatCommandError(commandName: string, error: unknown): ReportCommandResult {
  return {
    ok: false,
    lines: [`himan-tracker ${commandName}`, "", `[fail] ${getErrorMessage(error)}`],
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
