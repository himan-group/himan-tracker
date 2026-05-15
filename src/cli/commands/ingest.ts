import path from "node:path";
import { homedir } from "node:os";

import { ingestEvents, type IngestEventsResult } from "../../aggregator/aggregateEvents.js";
import { ensureTrackerDirectories, resolveTrackerPaths } from "../../config/paths.js";

export type IngestCommandOptions = {
  from?: string;
  rebuild?: boolean;
};

export type IngestCommandResult = {
  ok: boolean;
  lines: string[];
};

export async function runIngest(options: IngestCommandOptions = {}): Promise<IngestCommandResult> {
  const paths = resolveTrackerPaths();
  const eventsPath = options.from ? path.resolve(options.from) : undefined;

  try {
    await ensureTrackerDirectories(paths);
    const ingestSource = eventsPath ? { eventsPath } : { eventsDir: paths.eventsDir };

    const result = await ingestEvents({
      sqlitePath: paths.sqlitePath,
      ...ingestSource,
      skillMetadataRoots: [process.cwd(), homedir()],
      rebuild: options.rebuild ?? false,
    });

    return {
      ok: true,
      lines: formatIngestResult(result, options.rebuild ?? false),
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker ingest", "", `[fail] ingest: ${getErrorMessage(error)}`],
    };
  }
}

function formatIngestResult(result: IngestEventsResult, rebuild: boolean): string[] {
  return [
    "himan-tracker ingest",
    "",
    `Events: ${result.events_path}`,
    `SQLite: ${result.sqlite_path}`,
    `Mode: ${rebuild ? "rebuild" : "incremental"}`,
    `Migrations applied: ${
      result.applied_migrations.length > 0 ? result.applied_migrations.join(", ") : "none"
    }`,
    `Event files: ${result.event_files.length}`,
    `Events read: ${result.events_read}`,
    `Events inserted: ${result.events_inserted}`,
    `Events skipped: ${result.events_skipped}`,
    `Affected dates: ${
      result.affected_dates.length > 0 ? result.affected_dates.join(", ") : "none"
    }`,
  ];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
