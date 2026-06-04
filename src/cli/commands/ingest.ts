import path from "node:path";
import { homedir } from "node:os";

import { ingestEvents, type IngestEventsResult } from "../../aggregator/aggregateEvents.js";
import { ensureTrackerDirectories, resolveTrackerPaths, type TrackerPaths } from "../../config/paths.js";
import { parseDate } from "../../reports/dateRange.js";
import type { AgentName } from "../../types/events.js";

export type IngestCommandOptions = {
  from?: string;
  rebuild?: boolean;
  date?: string;
  agent?: string;
  paths?: TrackerPaths;
};

export type IngestCommandResult = {
  ok: boolean;
  lines: string[];
};

export async function runIngest(options: IngestCommandOptions = {}): Promise<IngestCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();
  const eventsPath = options.from ? path.resolve(options.from) : undefined;

  try {
    if (options.rebuild && options.date) {
      throw new Error("Expected exactly one of --rebuild or --date");
    }

    if (eventsPath && options.date) {
      throw new Error("Expected --date to be used without --from");
    }

    const rebuildAgent = resolveIngestAgent(options.agent);
    if (rebuildAgent && !options.date) {
      throw new Error("Expected --agent to be used together with --date");
    }

    await ensureTrackerDirectories(paths);
    const ingestSource = eventsPath ? { eventsPath } : { eventsDir: paths.eventsDir };
    const rebuildDates = options.date ? [parseDate(options.date)] : undefined;

    const result = await ingestEvents({
      sqlitePath: paths.sqlitePath,
      ...ingestSource,
      skillMetadataRoots: [process.cwd(), homedir()],
      rebuild: options.rebuild ?? false,
      rebuildDates,
      rebuildAgent: rebuildAgent ?? undefined,
    });

    return {
      ok: true,
      lines: formatIngestResult(result, {
        rebuild: options.rebuild ?? false,
        rebuildDate: rebuildDates?.[0],
        rebuildAgent,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker ingest", "", `[fail] ingest: ${getErrorMessage(error)}`],
    };
  }
}

function formatIngestResult(
  result: IngestEventsResult,
  options: { rebuild: boolean; rebuildDate?: string; rebuildAgent?: AgentName | null },
): string[] {
  const mode = options.rebuild
    ? "rebuild"
    : options.rebuildDate && options.rebuildAgent
      ? `date-agent-rebuild (${options.rebuildDate}, ${options.rebuildAgent})`
      : options.rebuildDate
        ? `date-rebuild (${options.rebuildDate})`
        : "incremental";

  return [
    "himan-tracker ingest",
    "",
    `Events: ${result.events_path}`,
    `SQLite: ${result.sqlite_path}`,
    `Mode: ${mode}`,
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

function resolveIngestAgent(agent: string | undefined): AgentName | null {
  if (!agent) {
    return null;
  }

  if (agent === "codex" || agent === "copilot" || agent === "claude-code") {
    return agent;
  }

  throw new Error(
    `Unsupported ingest agent "${agent}". Currently "codex", "copilot", and "claude-code" are supported.`,
  );
}
