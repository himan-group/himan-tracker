import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { parseClaudeCodeTranscriptBackfill } from "../adapters/claude-code/transcriptBackfill.js";
import { parseCodexTranscriptBackfill } from "../adapters/codex/transcriptBackfill.js";
import {
  parseCopilotSessionStore,
  resolveCopilotSessionStorePath,
  parseCopilotTranscriptBackfill,
} from "../adapters/copilot/index.js";
import {
  ensureTrackerDirectories,
  resolveDailyEventsPath,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../config/paths.js";
import { learnKnownProjectsFromAdapterEvents } from "../config/knownProjects.js";
import { readOrCreateUserConfig } from "../config/userConfig.js";
import { appendJsonlRecord } from "../collector/jsonlWriter.js";
import { normalizeEvent } from "../normalizer/normalizeEvent.js";
import { parseDate, todayLocalDate } from "../reports/dateRange.js";
import type { UserConfig } from "../types/config.js";
import type { AgentName, NormalizedEvent } from "../types/events.js";

export type BackfillCommandOptions = {
  agent?: string;
  date?: string;
  since?: string;
  from?: string;
  ignoreCursor?: boolean;
  force?: boolean;
  paths?: TrackerPaths;
  config?: UserConfig;
  now?: () => Date;
};

export type BackfillCommandResult = {
  ok: boolean;
  lines: string[];
  stats: BackfillRunStats;
};

export type BackfillRunStats = {
  transcriptFiles: number;
  parsedEvents: number;
  writtenEvents: number;
  skippedDuplicates: number;
  eventFiles: number;
  skippedSourcesByCursor: number;
};

type WriteUniqueEventsResult = {
  written: number;
  skipped: number;
  eventFiles: string[];
};

type ExistingEvents = {
  eventIds: Set<string>;
  records: NormalizedEvent[];
};

const DUPLICATE_TIMESTAMP_TOLERANCE_MS = 5_000;
const BACKFILL_CURSOR_SCHEMA_VERSION = "1.0";
const BACKFILL_CURSOR_FILE = "backfill-cursors.json";
const COPILOT_SESSION_STORE_PREFIX = "__copilot_db__";

type BackfillCursorRecord = {
  source_key: string;
  agent: AgentName;
  source_path: string;
  fingerprint: string;
  updated_at: string;
};

type BackfillCursorStoreFile = {
  schema_version: typeof BACKFILL_CURSOR_SCHEMA_VERSION;
  cursors: BackfillCursorRecord[];
};

type BackfillCursorStore = {
  records: Map<string, BackfillCursorRecord>;
  changed: boolean;
};

export async function runBackfill(
  options: BackfillCommandOptions = {},
): Promise<BackfillCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();
  const now = options.now ?? (() => new Date());

  // --since mode: backfill from a date through today
  if (options.since) {
    return runBackfillSince(options, paths, now);
  }

  try {
    const agent = resolveBackfillAgent(options.agent);
    const date = options.date ? parseDate(options.date) : todayLocalDate(now());
    const transcriptDirs = options.from
      ? [path.resolve(options.from)]
      : agent === "copilot"
        ? resolveCopilotDataSource()
        : agent === "claude-code"
          ? resolveClaudeCodeTranscriptDirs()
          : [resolveCodexTranscriptDir(date)];

    await ensureTrackerDirectories(paths);
    const cursorStore = await readBackfillCursorStore(paths);
    const config = options.config ?? (await readOrCreateUserConfig(paths));

    let totalParsed = 0;
    let totalWritten = 0;
    let totalSkipped = 0;
    let skippedSourcesByCursor = 0;
    const allTranscriptFiles: string[] = [];
    const allEventFiles = new Set<string>();

    for (const transcriptDir of transcriptDirs) {
      const writeResult = await parseAndWriteBackfillEvents({
        agent,
        transcriptDir,
        paths,
        config,
        persistKnownProjects: options.config === undefined,
        ignoreCursor: options.ignoreCursor ?? false,
        force: options.force ?? false,
        cursorStore,
        now,
      });
      if (writeResult.skippedByCursor) {
        skippedSourcesByCursor += 1;
      }
      totalParsed += writeResult.parsed;
      totalWritten += writeResult.written;
      totalSkipped += writeResult.skipped;
      allTranscriptFiles.push(...writeResult.transcriptFiles);
      for (const f of writeResult.eventFiles) {
        allEventFiles.add(f);
      }
    }

    await writeBackfillCursorStore(paths, cursorStore);

    return {
      ok: true,
      lines: [
        "himan-tracker backfill",
        "",
        `Agent: ${agent}`,
        `Date: ${date}`,
        `Transcript dirs: ${transcriptDirs.length}`,
        `Transcript files: ${allTranscriptFiles.length}`,
        `Parsed events: ${totalParsed}`,
        `Written events: ${totalWritten}`,
        `Skipped duplicates: ${totalSkipped}`,
        `Sources skipped by cursor: ${skippedSourcesByCursor}`,
        `Event files: ${allEventFiles.size > 0 ? [...allEventFiles].join(", ") : "none"}`,
      ],
      stats: createBackfillRunStats({
        transcriptFiles: allTranscriptFiles.length,
        parsedEvents: totalParsed,
        writtenEvents: totalWritten,
        skippedDuplicates: totalSkipped,
        eventFiles: allEventFiles.size,
        skippedSourcesByCursor,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker backfill", "", `[fail] backfill: ${getErrorMessage(error)}`],
      stats: createBackfillRunStats(),
    };
  }
}

async function runBackfillSince(
  options: BackfillCommandOptions,
  paths: TrackerPaths,
  now: () => Date,
): Promise<BackfillCommandResult> {
  const agent = resolveBackfillAgent(options.agent);
  const sinceDate = parseDate(options.since!);
  const endDate = todayLocalDate(now());
  const dates = enumerateDates(sinceDate, endDate);

  let totalParsed = 0;
  let totalWritten = 0;
  let totalSkipped = 0;
  let skippedSourcesByCursor = 0;
  const allTranscriptFiles: string[] = [];
  const allEventFiles = new Set<string>();
  const errors: string[] = [];

  await ensureTrackerDirectories(paths);
  const cursorStore = await readBackfillCursorStore(paths);
  const config = options.config ?? (await readOrCreateUserConfig(paths));

  // Copilot and Claude Code sources are not partitioned by day, so --since should process them once.
  if (agent === "copilot" || agent === "claude-code") {
    const transcriptDirs = options.from
      ? [path.resolve(options.from)]
      : agent === "claude-code"
        ? resolveClaudeCodeTranscriptDirs()
        : resolveCopilotDataSource();
    for (const transcriptDir of transcriptDirs) {
      try {
        const writeResult = await parseAndWriteBackfillEvents({
          agent,
          transcriptDir,
          paths,
          config,
          persistKnownProjects: options.config === undefined,
          ignoreCursor: options.ignoreCursor ?? false,
          force: options.force ?? false,
          cursorStore,
          now,
        });
        if (writeResult.skippedByCursor) {
          skippedSourcesByCursor += 1;
        }
        totalParsed += writeResult.parsed;
        totalWritten += writeResult.written;
        totalSkipped += writeResult.skipped;
        allTranscriptFiles.push(...writeResult.transcriptFiles);
        for (const f of writeResult.eventFiles) {
          allEventFiles.add(f);
        }
      } catch (error) {
        errors.push(`copilot-source: ${getErrorMessage(error)}`);
      }
    }
  } else {
    for (const date of dates) {
      try {
        const transcriptDir = options.from ? path.resolve(options.from) : resolveCodexTranscriptDir(date);
        const writeResult = await parseAndWriteBackfillEvents({
          agent,
          transcriptDir,
          paths,
          config,
          persistKnownProjects: options.config === undefined,
          ignoreCursor: options.ignoreCursor ?? false,
          force: options.force ?? false,
          cursorStore,
          now,
        });
        if (writeResult.skippedByCursor) {
          skippedSourcesByCursor += 1;
        }
        totalParsed += writeResult.parsed;
        totalWritten += writeResult.written;
        totalSkipped += writeResult.skipped;
        allTranscriptFiles.push(...writeResult.transcriptFiles);
        for (const f of writeResult.eventFiles) {
          allEventFiles.add(f);
        }
      } catch (error) {
        errors.push(`${date}: ${getErrorMessage(error)}`);
      }
    }
  }

  await writeBackfillCursorStore(paths, cursorStore);

  const lines = [
    "himan-tracker backfill",
    "",
    `Agent: ${agent}`,
    `Range: ${sinceDate} → ${endDate} (${dates.length} days)`,
    `Transcript files: ${allTranscriptFiles.length}`,
    `Parsed events: ${totalParsed}`,
    `Written events: ${totalWritten}`,
    `Skipped duplicates: ${totalSkipped}`,
    `Sources skipped by cursor: ${skippedSourcesByCursor}`,
    `Event files: ${allEventFiles.size > 0 ? [...allEventFiles].join(", ") : "none"}`,
  ];

  if (errors.length > 0) {
    lines.push("", `Errors (${errors.length}):`, ...errors.map((e) => `  ${e}`));
  }

  return {
    ok: errors.length === 0,
    lines,
    stats: createBackfillRunStats({
      transcriptFiles: allTranscriptFiles.length,
      parsedEvents: totalParsed,
      writtenEvents: totalWritten,
      skippedDuplicates: totalSkipped,
      eventFiles: allEventFiles.size,
      skippedSourcesByCursor,
    }),
  };
}

function createBackfillRunStats(input: Partial<BackfillRunStats> = {}): BackfillRunStats {
  return {
    transcriptFiles: input.transcriptFiles ?? 0,
    parsedEvents: input.parsedEvents ?? 0,
    writtenEvents: input.writtenEvents ?? 0,
    skippedDuplicates: input.skippedDuplicates ?? 0,
    eventFiles: input.eventFiles ?? 0,
    skippedSourcesByCursor: input.skippedSourcesByCursor ?? 0,
  };
}

async function parseAndWriteBackfillEvents(options: {
  agent: AgentName;
  transcriptDir: string;
  paths: TrackerPaths;
  config: UserConfig;
  persistKnownProjects: boolean;
  ignoreCursor: boolean;
  force: boolean;
  cursorStore: BackfillCursorStore;
  now: () => Date;
}): Promise<{
  parsed: number;
  written: number;
  skipped: number;
  transcriptFiles: string[];
  eventFiles: string[];
  skippedByCursor: boolean;
}> {
  const sourceKey = createBackfillSourceKey(options.agent, options.transcriptDir);
  const sourceFingerprint = await computeSourceFingerprint(options.transcriptDir);
  const existingCursor = options.cursorStore.records.get(sourceKey);
  if (
    !options.ignoreCursor &&
    !options.force &&
    existingCursor &&
    existingCursor.fingerprint === sourceFingerprint
  ) {
    return {
      parsed: 0,
      written: 0,
      skipped: 0,
      transcriptFiles: [],
      eventFiles: [],
      skippedByCursor: true,
    };
  }

  const parsed = await parseAgentTranscripts(options.agent, options.transcriptDir);
  await learnKnownProjectsFromAdapterEvents({
    paths: options.paths,
    config: options.config,
    events: parsed.events,
    persist: options.persistKnownProjects,
  });
  const normalizedEvents = parsed.events.map((event) => normalizeEvent(event, options.config));
  const writeResult = await appendUniqueEvents(options.paths, normalizedEvents, options.force);

  options.cursorStore.records.set(sourceKey, {
    source_key: sourceKey,
    agent: options.agent,
    source_path: normalizeSourcePath(options.transcriptDir),
    fingerprint: sourceFingerprint,
    updated_at: options.now().toISOString(),
  });
  options.cursorStore.changed = true;

  return {
    parsed: parsed.events.length,
    written: writeResult.written,
    skipped: writeResult.skipped,
    transcriptFiles: parsed.transcriptFiles,
    eventFiles: writeResult.eventFiles,
    skippedByCursor: false,
  };
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  const endDate = new Date(end);

  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function resolveBackfillAgent(agent: string | undefined): AgentName {
  const resolvedAgent = agent ?? "codex";

  if (resolvedAgent === "codex" || resolvedAgent === "copilot" || resolvedAgent === "claude-code") {
    return resolvedAgent;
  }

  throw new Error(`Unsupported backfill agent "${resolvedAgent}". Currently "codex", "copilot", and "claude-code" are supported.`);
}

function resolveClaudeCodeTranscriptDirs(): string[] {
  const projectsDir = path.join(homedir(), ".claude", "projects");

  try {
    const projectDirs = readdirSyncSafe(projectsDir);
    const dirs: string[] = [];

    for (const projectDir of projectDirs) {
      const fullPath = path.join(projectsDir, projectDir);
      try {
        const files = readdirSyncSafe(fullPath);
        if (files.some((f) => f.endsWith(".jsonl") && !f.includes("agent-") && !f.includes("workflow"))) {
          dirs.push(fullPath);
        }
      } catch {
        // Skip inaccessible project directories
      }
    }

    if (dirs.length === 0) {
      throw new Error(
        "Could not auto-detect Claude Code transcript directories. Use --from to specify the path.\n" +
        'Example: himan-tracker backfill claude-code --from "~/.claude/projects/-Users-example/"',
      );
    }

    return dirs;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Could not auto-detect")) {
      throw error;
    }
    throw new Error(
      "Could not auto-detect Claude Code transcript directories. Use --from to specify the path.\n" +
      'Example: himan-tracker backfill claude-code --from "~/.claude/projects/-Users-example/"',
    );
  }
}

function resolveCodexTranscriptDir(date: string): string {
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) {
    throw new Error("Expected --date to use YYYY-MM-DD");
  }

  return path.join(homedir(), ".codex", "sessions", year, month, day);
}

function resolveCopilotDataSource(): string[] {
  const sessionStorePath = resolveCopilotSessionStorePath();
  if (existsSync(sessionStorePath)) {
    return [`${COPILOT_SESSION_STORE_PREFIX}${sessionStorePath}`];
  }

  return resolveCopilotTranscriptDirs();
}

function resolveCopilotTranscriptDirs(): string[] {
  const codeUserDir = path.join(homedir(), "Library", "Application Support", "Code", "User");
  const workspaceStorageDir = path.join(codeUserDir, "workspaceStorage");
  const transcriptRelPath = path.join("GitHub.copilot-chat", "transcripts");

  const dirs: string[] = [];

  try {
    const workspaceDirs = readdirSyncSafe(workspaceStorageDir);
    for (const wsDir of workspaceDirs) {
      const transcriptDir = path.join(workspaceStorageDir, wsDir, transcriptRelPath);
      try {
        const files = readdirSyncSafe(transcriptDir);
        if (files.some((f) => f.endsWith(".jsonl"))) {
          dirs.push(transcriptDir);
        }
      } catch {
        // Skip workspaces without Copilot transcripts
      }
    }
  } catch {
    // workspaceStorage not found
  }

  if (dirs.length === 0) {
    throw new Error(
      "Could not auto-detect Copilot transcript directories. Use --from to specify the path.\n" +
      'Example: himan-tracker backfill copilot --from "~/Library/Application Support/Code/User/workspaceStorage/{id}/GitHub.copilot-chat/transcripts/"',
    );
  }

  return dirs;
}

function readdirSyncSafe(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

async function parseAgentTranscripts(agent: AgentName, transcriptDir: string) {
  // Handle Copilot session-store DB source (sentinel prefix)
  if (transcriptDir.startsWith(COPILOT_SESSION_STORE_PREFIX)) {
    const dbPath = transcriptDir.slice(COPILOT_SESSION_STORE_PREFIX.length);
    return parseCopilotSessionStore(dbPath);
  }

  switch (agent) {
    case "codex":
      return parseCodexTranscriptBackfill({ transcriptDir });
    case "copilot":
      return parseCopilotTranscriptBackfill({ transcriptDir });
    case "claude-code":
      return parseClaudeCodeTranscriptBackfill({ transcriptDir });
  }
}

async function appendUniqueEvents(
  paths: TrackerPaths,
  events: NormalizedEvent[],
  force = false,
): Promise<WriteUniqueEventsResult> {
  const eventsByPath = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const eventPath = resolveDailyEventsPath(paths, event.occurred_at);
    const fileEvents = eventsByPath.get(eventPath) ?? [];
    fileEvents.push(event);
    eventsByPath.set(eventPath, fileEvents);
  }

  let written = 0;
  let skipped = 0;
  const eventFiles: string[] = [];

  for (const [eventPath, fileEvents] of [...eventsByPath].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    await mkdir(path.dirname(eventPath), { recursive: true, mode: 0o700 });

    // When force is true, delete the existing file so events are regenerated
    // with any new fields (e.g. cached_input_tokens added in a later version).
    if (force) {
      try {
        await rm(eventPath, { force: true });
      } catch {
        // File may not exist yet — that's fine
      }
    }

    const existingEvents = await readExistingEvents(eventPath);

    for (const event of fileEvents) {
      if (
        existingEvents.eventIds.has(event.event_id) ||
        isSimilarExistingEvent(event, existingEvents.records)
      ) {
        skipped += 1;
        continue;
      }

      await appendJsonlRecord(eventPath, event);
      existingEvents.eventIds.add(event.event_id);
      existingEvents.records.push(event);
      written += 1;
    }

    if (fileEvents.length > 0) {
      eventFiles.push(eventPath);
    }
  }

  return {
    written,
    skipped,
    eventFiles,
  };
}

async function readExistingEvents(eventPath: string): Promise<ExistingEvents> {
  const eventIds = new Set<string>();
  const records: NormalizedEvent[] = [];

  try {
    const rawEvents = await readFile(eventPath, "utf8");
    for (const line of rawEvents.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }

      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && typeof parsed.event_id === "string") {
        eventIds.add(parsed.event_id);
        records.push(parsed as NormalizedEvent);
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return {
    eventIds,
    records,
  };
}

function isSimilarExistingEvent(event: NormalizedEvent, existingEvents: NormalizedEvent[]): boolean {
  return existingEvents.some((existingEvent) => {
    if (
      existingEvent.agent !== event.agent ||
      existingEvent.event_type !== event.event_type ||
      existingEvent.session_id !== event.session_id
    ) {
      return false;
    }

    if (event.event_type === "session_summary") {
      return true;
    }

    if (event.event_type === "turn_summary") {
      return existingEvent.turn_id === event.turn_id;
    }

    if (
      existingEvent.event_type !== "capability_usage" ||
      existingEvent.turn_id !== event.turn_id ||
      existingEvent.capability_type !== event.capability_type ||
      existingEvent.capability_name !== event.capability_name
    ) {
      return false;
    }

    if (event.capability_type === "skill") {
      return true;
    }

    const existingMs = Date.parse(existingEvent.occurred_at);
    const eventMs = Date.parse(event.occurred_at);
    return (
      !Number.isNaN(existingMs) &&
      !Number.isNaN(eventMs) &&
      Math.abs(existingMs - eventMs) <= DUPLICATE_TIMESTAMP_TOLERANCE_MS
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBackfillCursorStore(paths: TrackerPaths): Promise<BackfillCursorStore> {
  const storePath = resolveBackfillCursorPath(paths);
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BackfillCursorStoreFile>;
    if (
      parsed.schema_version !== BACKFILL_CURSOR_SCHEMA_VERSION ||
      !Array.isArray(parsed.cursors)
    ) {
      return { records: new Map(), changed: false };
    }

    const records = new Map<string, BackfillCursorRecord>();
    for (const cursor of parsed.cursors) {
      if (
        cursor &&
        typeof cursor.source_key === "string" &&
        typeof cursor.agent === "string" &&
        typeof cursor.source_path === "string" &&
        typeof cursor.fingerprint === "string" &&
        typeof cursor.updated_at === "string"
      ) {
        records.set(cursor.source_key, cursor as BackfillCursorRecord);
      }
    }

    return { records, changed: false };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { records: new Map(), changed: false };
    }
    return { records: new Map(), changed: false };
  }
}

async function writeBackfillCursorStore(paths: TrackerPaths, store: BackfillCursorStore): Promise<void> {
  if (!store.changed) {
    return;
  }

  const file: BackfillCursorStoreFile = {
    schema_version: BACKFILL_CURSOR_SCHEMA_VERSION,
    cursors: [...store.records.values()].sort((left, right) =>
      left.source_key.localeCompare(right.source_key),
    ),
  };

  await writeFile(resolveBackfillCursorPath(paths), `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  store.changed = false;
}

function resolveBackfillCursorPath(paths: TrackerPaths): string {
  return path.join(paths.homeDir, BACKFILL_CURSOR_FILE);
}

function createBackfillSourceKey(agent: AgentName, sourcePath: string): string {
  return `${agent}:${normalizeSourcePath(sourcePath)}`;
}

function normalizeSourcePath(sourcePath: string): string {
  if (sourcePath.startsWith(COPILOT_SESSION_STORE_PREFIX)) {
    const dbPath = sourcePath.slice(COPILOT_SESSION_STORE_PREFIX.length);
    return `${COPILOT_SESSION_STORE_PREFIX}${path.resolve(dbPath)}`;
  }
  return path.resolve(sourcePath);
}

async function computeSourceFingerprint(sourcePath: string): Promise<string> {
  if (sourcePath.startsWith(COPILOT_SESSION_STORE_PREFIX)) {
    const dbPath = sourcePath.slice(COPILOT_SESSION_STORE_PREFIX.length);
    return computeFileFingerprint(path.resolve(dbPath));
  }

  return computeDirectoryFingerprint(path.resolve(sourcePath));
}

async function computeFileFingerprint(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    return hashFingerprintParts([
      "file",
      filePath,
      String(fileStat.ino),
      String(fileStat.size),
      String(fileStat.mtimeMs),
    ]);
  } catch (error) {
    if (isMissingFileError(error)) {
      return hashFingerprintParts(["file", filePath, "missing"]);
    }
    throw error;
  }
}

async function computeDirectoryFingerprint(dirPath: string): Promise<string> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const parts: string[] = ["dir", dirPath];
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();

    for (const fileName of files) {
      const filePath = path.join(dirPath, fileName);
      const fileStat = await stat(filePath);
      parts.push(
        `${fileName}:${String(fileStat.ino)}:${String(fileStat.size)}:${String(fileStat.mtimeMs)}`,
      );
    }

    return hashFingerprintParts(parts);
  } catch (error) {
    if (isMissingFileError(error)) {
      return hashFingerprintParts(["dir", dirPath, "missing"]);
    }
    throw error;
  }
}

function hashFingerprintParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}
