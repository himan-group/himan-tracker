import { access, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { deleteIngestFileCursorsForFiles } from "../../aggregator/aggregateEvents.js";
import {
  ensureTrackerDirectories,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../../config/paths.js";
import { parseDate } from "../../reports/dateRange.js";
import { formatLocalDate } from "../../reports/periodFormatter.js";
import type { AgentName } from "../../types/events.js";

export type CleanupCommandOptions = {
  agent?: string;
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

type AgentCleanupCandidate = RawLogFile & {
  removedCount: number;
  remainingLines: string[];
};

const PERIOD_PATTERN = /^([1-9]\d*)([dwm])$/;
const DAILY_JSONL_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export async function runCleanup(
  options: CleanupCommandOptions = {},
): Promise<CleanupCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();

  try {
    await ensureTrackerDirectories(paths);
    const agent = resolveCleanupAgent(options.agent);
    const scope = resolveCleanupScope(options, (options.now ?? (() => new Date()))());
    const files = await listMatchingRawLogFiles(paths, scope, agent);
    let deletedCursorRows = 0;

    if (!options.dryRun) {
      if (agent) {
        for (const file of files) {
          const candidate = file as AgentCleanupCandidate;
          if (candidate.remainingLines.length === 0) {
            await rm(candidate.filePath, { force: true });
            continue;
          }

          await writeFile(candidate.filePath, `${candidate.remainingLines.join("\n")}\n`, "utf8");
        }
      } else {
        for (const file of files) {
          await rm(file.filePath, { force: true });
        }
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
        agent,
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
  agent: AgentName | null,
): Promise<Array<RawLogFile | AgentCleanupCandidate>> {
  if (agent) {
    const files = [
      ...(await listAgentCleanupCandidates(paths.eventsDir, "events", scope, agent)),
      ...(scope.kind === "all"
        ? await listAgentLegacyCandidates(paths.eventsPath, "events", agent)
        : []),
    ].sort((left, right) => left.filePath.localeCompare(right.filePath));

    return files;
  }

  const files: RawLogFile[] = [
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

async function listAgentCleanupCandidates(
  directoryPath: string,
  category: RawLogFile["category"],
  scope: CleanupScope,
  agent: AgentName,
): Promise<AgentCleanupCandidate[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: AgentCleanupCandidate[] = [];

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
    const candidate = await buildAgentCleanupCandidate(filePath, category, date, agent);
    if (candidate) {
      files.push(candidate);
    }
  }

  return files;
}

async function listAgentLegacyCandidates(
  filePath: string,
  category: RawLogFile["category"],
  agent: AgentName,
): Promise<AgentCleanupCandidate[]> {
  try {
    await access(filePath);
    const candidate = await buildAgentCleanupCandidate(filePath, category, null, agent);
    return candidate ? [candidate] : [];
  } catch {
    return [];
  }
}

async function buildAgentCleanupCandidate(
  filePath: string,
  category: RawLogFile["category"],
  date: string | null,
  agent: AgentName,
): Promise<AgentCleanupCandidate | null> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const remainingLines: string[] = [];
  let removedCount = 0;

  for (const line of lines) {
    const record = parseCleanupJsonLine(line, filePath);
    if (record.agent === agent) {
      removedCount += 1;
      continue;
    }

    remainingLines.push(line);
  }

  if (removedCount === 0) {
    return null;
  }

  const fileStat = await stat(filePath);
  return {
    category,
    filePath,
    date,
    sizeBytes: fileStat.size,
    removedCount,
    remainingLines,
  };
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
  agent: AgentName | null;
  files: Array<RawLogFile | AgentCleanupCandidate>;
  dryRun: boolean;
  deletedCursorRows: number;
}): string[] {
  const eventFiles = options.files.filter((file) => file.category === "events");
  const errorFiles = options.files.filter((file) => file.category === "errors");
  const sizeBytes = options.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const removedEvents = options.agent
    ? options.files.reduce((sum, file) => sum + ("removedCount" in file ? file.removedCount : 0), 0)
    : null;

  return [
    "himan-tracker cleanup",
    "",
    `Mode: ${options.dryRun ? "dry-run" : "delete"}`,
    `Scope: ${formatScope(options.scope)}`,
    `Agent filter: ${options.agent ?? "all"}`,
    `Events directory: ${options.paths.eventsDir}`,
    `Errors directory: ${options.paths.errorsDir}`,
    `SQLite retained: ${options.paths.sqlitePath}`,
    `Event files matched: ${eventFiles.length}`,
    `Error files matched: ${errorFiles.length}`,
    `Total files matched: ${options.files.length}`,
    ...(removedEvents === null ? [] : [`Event records matched: ${removedEvents}`]),
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCleanupAgent(agent: string | undefined): AgentName | null {
  if (!agent) {
    return null;
  }

  if (agent === "codex" || agent === "copilot" || agent === "claude-code") {
    return agent;
  }

  throw new Error(`Unsupported cleanup agent "${agent}". Currently "codex", "copilot", and "claude-code" are supported.`);
}

function parseCleanupJsonLine(line: string, filePath: string): { agent?: unknown } {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object") {
      throw new Error("Expected a JSON object");
    }

    return value as { agent?: unknown };
  } catch (error) {
    throw new Error(`Invalid cleanup JSONL record in ${filePath}: ${getErrorMessage(error)}`);
  }
}
