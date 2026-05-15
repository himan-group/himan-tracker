import { archiveMonthly, type ArchiveMonthlyResult } from "../../aggregator/monthlyArchive.js";
import { ensureTrackerDirectories, resolveTrackerPaths, type TrackerPaths } from "../../config/paths.js";

export type ArchiveCommandOptions = {
  dryRun?: boolean;
  paths?: TrackerPaths;
  now?: () => Date;
};

export type ArchiveCommandResult = {
  ok: boolean;
  lines: string[];
};

export async function runArchiveMonthly(
  options: ArchiveCommandOptions = {},
): Promise<ArchiveCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();

  try {
    await ensureTrackerDirectories(paths);
    const result = await archiveMonthly({
      paths,
      now: options.now,
      dryRun: options.dryRun ?? false,
    });

    return {
      ok: true,
      lines: formatArchiveMonthlyResult(result),
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker archive monthly", "", `[fail] archive: ${getErrorMessage(error)}`],
    };
  }
}

function formatArchiveMonthlyResult(result: ArchiveMonthlyResult): string[] {
  return [
    "himan-tracker archive monthly",
    "",
    `Mode: ${result.dry_run ? "dry-run" : "write"}`,
    `SQLite: ${result.sqlite_path}`,
    `Retention: recent ${result.retention_months} calendar months`,
    `First retained month: ${result.first_retained_month}`,
    `Archived months: ${
      result.archived_months.length > 0 ? result.archived_months.join(", ") : "none"
    }`,
    `Monthly agent rows: ${result.monthly_agent_rows}`,
    `Monthly capability rows: ${result.monthly_capability_rows}`,
    `Deleted daily agent rows: ${result.deleted_daily_agent_rows}`,
    `Deleted daily capability rows: ${result.deleted_daily_capability_rows}`,
    `Deleted event files: ${result.deleted_event_files.length}`,
    `Deleted error files: ${result.deleted_error_files.length}`,
    `Migrations applied: ${
      result.applied_migrations.length > 0 ? result.applied_migrations.join(", ") : "none"
    }`,
  ];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
