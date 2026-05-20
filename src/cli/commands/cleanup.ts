import { access, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { deleteIngestFileCursorsForFiles } from "../../aggregator/aggregateEvents.js";
import {
  ensureTrackerDirectories,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../../config/paths.js";
import { parseDate } from "../../reports/dateRange.js";

export type CleanupCommandOptions = {
  all?: boolean;
  from?: string;
  to?: string;
  before?: string;
  olderThan?: string;
  dryRun?: boolean;
  paths?: TrackerPaths;
  now?: () => Date;
};

export type CleanupCommandResult = {
  ok: boolean;
  lines: string[];
};

type CleanupScope =
  | {
      kind: "all";
    }
  | {
      kind: "range";
      fromDate?: string;
      toDate?: string;
    }
  | {
      kind: "older-than";
      period: string;
      beforeDate: string;
    }
  | {
      kind: "before";
      beforeDate: string;
    };

type RawLogFile = {
  category: "events" | "errors";
  filePath: string;
  date: string | null;
  sizeBytes: number;
};

const PERIOD_PATTERN = /^([1-9]\d*)([dwm])$/;
const DAILY_JSONL_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export async function runCleanup(
  options: CleanupCommandOptions = {},
): Promise<CleanupCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();

  try {
    await ensureTrackerDirectories(paths);
    const scope = resolveCleanupScope(options, (options.now ?? (() => new Date()))());
    const files = await listMatchingRawLogFiles(paths, scope);
    let deletedCursorRows = 0;

    if (!options.dryRun) {
      for (const file of files) {
        await rm(file.filePath, { force: true });
      }
      deletedCursorRows = await deleteIngestFileCursorsForFiles(
        paths.sqlitePath,
        files.map((file) => file.filePath),
      );
    }

    return {
      ok: true,
      lines: formatCleanupResult({
        paths,
        scope,
        files,
        dryRun: options.dryRun ?? false,
        deletedCursorRows,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker cleanup", "", `[fail] cleanup: ${getErrorMessage(error)}`],
    };
  }
}

async function listMatchingRawLogFiles(
  paths: TrackerPaths,
  scope: CleanupScope,
): Promise<RawLogFile[]> {
  const files = [
    ...(await listDailyJsonlFiles(paths.eventsDir, "events", scope)),
    ...(await listDailyJsonlFiles(paths.errorsDir, "errors", scope)),
  ].sort((left, right) => left.filePath.localeCompare(right.filePath));

  if (scope.kind !== "all") {
    return files;
  }

  return [
    ...files,
    ...(await listLegacyRawLogFile(paths.eventsPath, "events")),
    ...(await listLegacyRawLogFile(paths.errorsPath, "errors")),
  ].sort((left, right) => left.filePath.localeCompare(right.filePath));
}

async function listDailyJsonlFiles(
  directoryPath: string,
  category: RawLogFile["category"],
  scope: CleanupScope,
): Promise<RawLogFile[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: RawLogFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = DAILY_JSONL_PATTERN.exec(entry.name);
    if (!match) {
      continue;
    }

    const date = match[1];
    if (!date || !matchesScope(date, scope)) {
      continue;
    }

    const filePath = path.join(directoryPath, entry.name);
    const fileStat = await stat(filePath);
    files.push({
      category,
      filePath,
      date,
      sizeBytes: fileStat.size,
    });
  }

  return files;
}

async function listLegacyRawLogFile(
  filePath: string,
  category: RawLogFile["category"],
): Promise<RawLogFile[]> {
  try {
    await access(filePath);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return [];
    }

    return [
      {
        category,
        filePath,
        date: null,
        sizeBytes: fileStat.size,
      },
    ];
  } catch {
    return [];
  }
}

function resolveCleanupScope(options: CleanupCommandOptions, now: Date): CleanupScope {
  const hasRange = options.from !== undefined || options.to !== undefined;
  const scopeCount = [
    options.all,
    options.before !== undefined,
    options.olderThan !== undefined,
    hasRange,
  ].filter(Boolean).length;
  if (scopeCount !== 1) {
    throw new Error(
      "Specify exactly one cleanup scope: --all, --before, --older-than, or --from/--to",
    );
  }

  if (options.all) {
    return { kind: "all" };
  }

  if (options.before !== undefined) {
    return {
      kind: "before",
      beforeDate: parseDate(options.before),
    };
  }

  if (options.olderThan !== undefined) {
    const days = parsePeriodDays(options.olderThan);
    const cutoff = startOfLocalDay(now);
    cutoff.setDate(cutoff.getDate() - days + 1);

    return {
      kind: "older-than",
      period: options.olderThan,
      beforeDate: formatLocalDate(cutoff),
    };
  }

  const fromDate = options.from ? parseDate(options.from) : undefined;
  const toDate = options.to ? parseDate(options.to) : undefined;
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("Expected --from to be earlier than or equal to --to");
  }

  return {
    kind: "range",
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
  };
}

function matchesScope(date: string, scope: CleanupScope): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "before":
      return date < scope.beforeDate;
    case "older-than":
      return date < scope.beforeDate;
    case "range":
      return (!scope.fromDate || date >= scope.fromDate) && (!scope.toDate || date <= scope.toDate);
  }
}

function parsePeriodDays(period: string): number {
  const match = PERIOD_PATTERN.exec(period.trim());
  if (!match) {
    throw new Error("Expected --older-than to use a value like 30d, 12w, or 6m");
  }

  const amount = Number(match[1]);
  const unit = match[2];
  return unit === "d" ? amount : unit === "w" ? amount * 7 : amount * 30;
}

function formatCleanupResult(options: {
  paths: TrackerPaths;
  scope: CleanupScope;
  files: RawLogFile[];
  dryRun: boolean;
  deletedCursorRows: number;
}): string[] {
  const eventFiles = options.files.filter((file) => file.category === "events");
  const errorFiles = options.files.filter((file) => file.category === "errors");
  const sizeBytes = options.files.reduce((sum, file) => sum + file.sizeBytes, 0);

  return [
    "himan-tracker cleanup",
    "",
    `Mode: ${options.dryRun ? "dry-run" : "delete"}`,
    `Scope: ${formatScope(options.scope)}`,
    `Events directory: ${options.paths.eventsDir}`,
    `Errors directory: ${options.paths.errorsDir}`,
    `SQLite retained: ${options.paths.sqlitePath}`,
    `Event files matched: ${eventFiles.length}`,
    `Error files matched: ${errorFiles.length}`,
    `Total files matched: ${options.files.length}`,
    `Bytes matched: ${sizeBytes}`,
    options.dryRun ? "Deleted files: 0 (dry-run)" : `Deleted files: ${options.files.length}`,
    options.dryRun
      ? "Cursor rows deleted: 0 (dry-run)"
      : `Cursor rows deleted: ${options.deletedCursorRows}`,
    "Stats retained: yes",
  ];
}

function formatScope(scope: CleanupScope): string {
  switch (scope.kind) {
    case "all":
      return "all raw JSONL logs";
    case "before":
      return `before ${scope.beforeDate}`;
    case "older-than":
      return `older than ${scope.period} (before ${scope.beforeDate})`;
    case "range":
      if (scope.fromDate && scope.toDate) {
        return `${scope.fromDate} to ${scope.toDate}`;
      }
      if (scope.fromDate) {
        return `from ${scope.fromDate}`;
      }
      return `through ${scope.toDate}`;
  }
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
