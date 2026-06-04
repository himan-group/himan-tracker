import { createReadStream } from "node:fs";
import { access, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  discoverSkillMetadata,
  type SkillDefinitionMetadata,
  type SkillMetadataIssue,
} from "../adapters/himan/metadata.js";
import { validateNormalizedEvent } from "../normalizer/eventSchema.js";
import {
  initializeTrackerDatabase,
  openTrackerDatabase,
  type SqliteDatabase,
} from "../storage/sqlite.js";
import type {
  CapabilityUsageEvent,
  NormalizedEvent,
  SessionSummaryEvent,
  TurnSummaryEvent,
} from "../types/events.js";
import { recomputeDailyStats, toLocalDate } from "./dailyStats.js";

export type IngestEventsOptions = {
  sqlitePath: string;
  eventsPath?: string;
  eventsDir?: string;
  skillMetadataRoots?: string[];
  rebuild?: boolean;
  now?: () => Date;
};

export type IngestEventsResult = {
  sqlite_path: string;
  events_path: string;
  event_files: string[];
  events_read: number;
  events_inserted: number;
  events_skipped: number;
  affected_dates: string[];
  applied_migrations: string[];
  skill_metadata_definitions: number;
  skill_metadata_issues: number;
};

type IngestFileCursorRow = {
  file_path: string;
  inode: string;
  size_bytes: number;
  offset_bytes: number;
  mtime_ms: number;
};

type IngestReadCursor = {
  filePath: string;
  inode: string;
  sizeBytes: number;
  offsetBytes: number;
  mtimeMs: number;
};

export async function ingestEvents(options: IngestEventsOptions): Promise<IngestEventsResult> {
  if (options.rebuild) {
    await removeSqliteProjection(options.sqlitePath);
  }

  const eventFiles = await resolveEventFiles(options);
  const now = options.now ?? (() => new Date());
  const skillMetadata =
    options.skillMetadataRoots && options.skillMetadataRoots.length > 0
      ? await discoverSkillMetadata({ roots: options.skillMetadataRoots, now })
      : { definitions: [], issues: [] };
  const { db, appliedMigrations } = initializeTrackerDatabase(options.sqlitePath);

  try {
    const ingestReadResult = await readIncrementalJsonlEvents(db, eventFiles);
    const result = insertEvents(
      db,
      ingestReadResult.events,
      ingestReadResult.cursors,
      now,
      skillMetadata.definitions,
      skillMetadata.issues,
    );

    return {
      sqlite_path: options.sqlitePath,
      events_path: options.eventsPath ?? options.eventsDir ?? "",
      event_files: eventFiles,
      events_read: ingestReadResult.events.length,
      events_inserted: result.inserted,
      events_skipped: result.skipped,
      affected_dates: result.affectedDates,
      applied_migrations: appliedMigrations,
      skill_metadata_definitions: skillMetadata.definitions.length,
      skill_metadata_issues: skillMetadata.issues.length,
    };
  } finally {
    db.close();
  }
}

async function removeSqliteProjection(sqlitePath: string): Promise<void> {
  await Promise.all([
    rm(sqlitePath, { force: true }),
    rm(`${sqlitePath}-shm`, { force: true }),
    rm(`${sqlitePath}-wal`, { force: true }),
  ]);
}

async function resolveEventFiles(options: IngestEventsOptions): Promise<string[]> {
  if (options.eventsPath) {
    return [options.eventsPath];
  }

  if (!options.eventsDir) {
    throw new Error("Expected eventsPath or eventsDir");
  }

  try {
    const eventsDir = options.eventsDir;
    const entries = await readdir(eventsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(eventsDir, entry.name))
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readIncrementalJsonlEvents(
  db: SqliteDatabase,
  eventsPaths: string[],
): Promise<{ events: NormalizedEvent[]; cursors: IngestReadCursor[] }> {
  const currentCursors = readIngestFileCursors(db);
  const events: NormalizedEvent[] = [];
  const nextCursors: IngestReadCursor[] = [];

  for (const eventsPath of eventsPaths) {
    let fileStat;
    try {
      fileStat = await stat(eventsPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const inode = String(fileStat.ino);
    const sizeBytes = fileStat.size;
    const mtimeMs = Math.floor(fileStat.mtimeMs);
    const previousCursor = currentCursors.get(eventsPath);
    const offsetBytes = resolveReadOffset(previousCursor, inode, sizeBytes);
    const fileDelta = await readFileDelta(eventsPath, offsetBytes);

    for (const [index, line] of fileDelta.lines.entries()) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        events.push(validateNormalizedEvent(JSON.parse(line)));
      } catch (error) {
        throw new Error(
          `Invalid JSONL event at ${eventsPath}:${index + 1}: ${getErrorMessage(error)}`,
        );
      }
    }

    nextCursors.push({
      filePath: eventsPath,
      inode,
      sizeBytes,
      offsetBytes: sizeBytes,
      mtimeMs,
    });
  }

  return { events, cursors: nextCursors };
}

function insertEvents(
  db: SqliteDatabase,
  events: NormalizedEvent[],
  cursors: IngestReadCursor[],
  now: () => Date,
  skillDefinitions: SkillDefinitionMetadata[],
  skillIssues: SkillMetadataIssue[],
): { inserted: number; skipped: number; affectedDates: string[] } {
  const hasIngestedEvent = db.prepare("select event_id from ingested_events where event_id = ?");
  const insertIngestedEvent = db.prepare(
    `
    insert into ingested_events (event_id, event_type, occurred_at, ingested_at)
    values (?, ?, ?, ?)
    `,
  );
  const upsertIngestFileCursor = db.prepare(
    `
    insert into ingest_file_cursors (
      file_path,
      inode,
      size_bytes,
      offset_bytes,
      mtime_ms,
      updated_at
    )
    values (?, ?, ?, ?, ?, ?)
    on conflict(file_path) do update set
      inode = excluded.inode,
      size_bytes = excluded.size_bytes,
      offset_bytes = excluded.offset_bytes,
      mtime_ms = excluded.mtime_ms,
      updated_at = excluded.updated_at
    `,
  );
  const affectedDates = new Set<string>();

  let inserted = 0;
  let skipped = 0;
  const skillMetadataIndex = createSkillMetadataIndex(skillDefinitions);

  const insertTransaction = db.transaction(() => {
    upsertSkillDefinitions(db, skillDefinitions);
    upsertSkillMetadataIssues(db, skillIssues);

    for (const event of events) {
      if (hasIngestedEvent.get(event.event_id)) {
        skipped += 1;
        continue;
      }

      insertBaseEvent(db, event, skillMetadataIndex);
      insertIngestedEvent.run(
        event.event_id,
        event.event_type,
        event.occurred_at,
        now().toISOString(),
      );
      affectedDates.add(toLocalDate(event.occurred_at));
      inserted += 1;
    }

    recomputeDailyStats(db, affectedDates);
    const updatedAt = now().toISOString();
    for (const cursor of cursors) {
      upsertIngestFileCursor.run(
        cursor.filePath,
        cursor.inode,
        cursor.sizeBytes,
        cursor.offsetBytes,
        cursor.mtimeMs,
        updatedAt,
      );
    }
  });

  insertTransaction();

  return {
    inserted,
    skipped,
    affectedDates: [...affectedDates].sort(),
  };
}

function readIngestFileCursors(db: SqliteDatabase): Map<string, IngestFileCursorRow> {
  const hasCursorTable = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name = 'ingest_file_cursors' limit 1",
    )
    .get() as { name: string } | undefined;
  if (!hasCursorTable) {
    return new Map();
  }

  const rows = db.prepare("select * from ingest_file_cursors").all() as IngestFileCursorRow[];
  return new Map(rows.map((row) => [row.file_path, row]));
}

function resolveReadOffset(
  cursor: IngestFileCursorRow | undefined,
  inode: string,
  fileSize: number,
): number {
  if (!cursor) {
    return 0;
  }
  if (cursor.inode !== inode) {
    return 0;
  }
  if (fileSize < cursor.offset_bytes) {
    return 0;
  }

  return cursor.offset_bytes;
}

async function readFileDelta(
  filePath: string,
  startOffset: number,
): Promise<{ lines: string[] }> {
  if (startOffset < 0) {
    throw new Error(`Invalid read offset for ${filePath}: ${startOffset}`);
  }

  const text = await new Promise<string>((resolve, reject) => {
    let chunks = "";
    const stream = createReadStream(filePath, {
      encoding: "utf8",
      start: startOffset,
    });
    stream.on("data", (chunk: string | Buffer) => {
      chunks += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(chunks);
    });
  });

  return { lines: text.split(/\r?\n/) };
}

export async function deleteIngestFileCursorsForFiles(
  sqlitePath: string,
  filePaths: string[],
): Promise<number> {
  const targetPaths = [...new Set(filePaths)];
  if (targetPaths.length === 0) {
    return 0;
  }

  try {
    await access(sqlitePath);
  } catch {
    return 0;
  }

  let db: SqliteDatabase | null = null;
  try {
    db = openTrackerDatabase(sqlitePath);
    const hasCursorTable = db
      .prepare(
        "select name from sqlite_master where type = 'table' and name = 'ingest_file_cursors' limit 1",
      )
      .get() as { name: string } | undefined;
    if (!hasCursorTable) {
      return 0;
    }

    const deleteCursor = db.prepare("delete from ingest_file_cursors where file_path = ?");
    const deleteTransaction = db.transaction((paths: string[]) => {
      let deleted = 0;
      for (const filePath of paths) {
        deleted += deleteCursor.run(filePath).changes;
      }
      return deleted;
    });

    return deleteTransaction(targetPaths);
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

function insertBaseEvent(
  db: SqliteDatabase,
  event: NormalizedEvent,
  skillMetadataIndex: SkillMetadataIndex,
): void {
  switch (event.event_type) {
    case "turn_summary":
      upsertSessionFromEvent(db, event);
      upsertTurn(db, event);
      break;
    case "capability_usage":
      upsertSessionFromEvent(db, event);
      insertCapabilityUsage(db, event, skillMetadataIndex);
      break;
    case "session_summary":
      upsertSessionSummary(db, event);
      break;
  }
}

function upsertSessionFromEvent(
  db: SqliteDatabase,
  event: TurnSummaryEvent | CapabilityUsageEvent,
): void {
  db.prepare(
    `
    insert into sessions (id, agent, started_at, ended_at, duration_ms, turn_count, status, repo_hash)
    values (?, ?, ?, null, null, 0, ?, ?)
    on conflict(id) do update set
      agent = excluded.agent,
      started_at = case
        when sessions.started_at is null then excluded.started_at
        when excluded.started_at < sessions.started_at then excluded.started_at
        else sessions.started_at
      end,
      status = case
        when sessions.status = 'unknown' then excluded.status
        else sessions.status
      end,
      repo_hash = coalesce(sessions.repo_hash, excluded.repo_hash)
    `,
  ).run(event.session_id, event.agent, event.occurred_at, event.status, event.repo_hash ?? null);
}

function upsertSessionSummary(db: SqliteDatabase, event: SessionSummaryEvent): void {
  db.prepare(
    `
    insert into sessions (id, agent, started_at, ended_at, duration_ms, turn_count, status, repo_hash)
    values (?, ?, null, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      agent = excluded.agent,
      ended_at = excluded.ended_at,
      duration_ms = excluded.duration_ms,
      turn_count = excluded.turn_count,
      status = excluded.status,
      repo_hash = coalesce(sessions.repo_hash, excluded.repo_hash)
    `,
  ).run(
    event.session_id,
    event.agent,
    event.occurred_at,
    event.duration_ms,
    event.turn_count ?? 0,
    event.status,
    event.repo_hash ?? null,
  );
}

function upsertTurn(db: SqliteDatabase, event: TurnSummaryEvent): void {
  db.prepare(
    `
    insert into turns (
      id,
      event_id,
      session_id,
      agent,
      model,
      occurred_at,
      duration_ms,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      total_tokens,
      status,
      repo_hash
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      event_id = excluded.event_id,
      session_id = excluded.session_id,
      agent = excluded.agent,
      model = excluded.model,
      occurred_at = excluded.occurred_at,
      duration_ms = excluded.duration_ms,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      status = excluded.status,
      repo_hash = excluded.repo_hash
    `,
  ).run(
    event.turn_id ?? event.event_id,
    event.event_id,
    event.session_id,
    event.agent,
    event.model ?? "",
    event.occurred_at,
    event.duration_ms,
    event.input_tokens,
    event.cached_input_tokens,
    event.output_tokens,
    event.total_tokens,
    event.status,
    event.repo_hash ?? null,
  );
}

function insertCapabilityUsage(
  db: SqliteDatabase,
  event: CapabilityUsageEvent,
  skillMetadataIndex: SkillMetadataIndex,
): void {
  const skillMetadata = resolveSkillMetadataSnapshot(event, skillMetadataIndex);

  db.prepare(
    `
    insert into capability_usages (
      id,
      session_id,
      turn_id,
      agent,
      source,
      capability_type,
      capability_name,
      occurred_at,
      duration_ms,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      total_tokens,
      status,
      adopted,
      attribution_confidence,
      invocation_origin,
      attribution_basis,
      attribution_score,
      attribution_reason,
      attribution_context_source,
      capability_version,
      capability_content_hash,
      static_entry_tokens,
      static_package_tokens,
      static_metadata_confidence,
      repo_hash
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.event_id,
    event.session_id,
    event.turn_id ?? null,
    event.agent,
    event.source,
    event.capability_type,
    event.capability_name,
    event.occurred_at,
    event.duration_ms,
    event.input_tokens,
    event.cached_input_tokens,
    event.output_tokens,
    event.total_tokens,
    event.status,
    event.adopted,
    event.attribution_confidence,
    event.invocation_origin,
    event.attribution_basis ?? "unknown",
    event.attribution_score ?? null,
    event.attribution_reason ?? null,
    event.attribution_context_source ?? "none",
    skillMetadata.version,
    skillMetadata.contentHash,
    skillMetadata.staticEntryTokens,
    skillMetadata.staticPackageTokens,
    skillMetadata.confidence,
    event.repo_hash ?? null,
  );

  insertCapabilityUsageEvidence(db, event);
}

function insertCapabilityUsageEvidence(
  db: SqliteDatabase,
  event: CapabilityUsageEvent,
): void {
  const evidenceType = event.attribution_basis ?? "unknown";
  const confidence = event.attribution_confidence;
  const score = event.attribution_score ?? null;
  const summary = sanitizeAttributionSummary(
    event.attribution_reason ?? defaultAttributionSummary(evidenceType),
  );
  const contextSource = event.attribution_context_source ?? "none";

  db.prepare(
    `
    insert into capability_usage_evidence (
      id,
      usage_id,
      evidence_type,
      confidence,
      score,
      summary,
      context_source,
      occurred_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    `${event.event_id}:0`,
    event.event_id,
    evidenceType,
    confidence,
    score,
    summary,
    contextSource,
    event.occurred_at,
  );
}

function defaultAttributionSummary(basis: string): string {
  switch (basis) {
    case "prompt_explicit_skill":
      return "Skill explicitly referenced in prompt.";
    case "transcript_mcp_tool_end":
      return "Structured MCP tool completion observed.";
    case "transcript_tool_name":
      return "Tool name observed from runtime event.";
    case "transcript_shell_skill_path":
      return "Skill path inferred from shell tool call.";
    case "himan_lock_match":
      return "Matched with installed skill in himan.lock.";
    case "himan_manifest_match":
      return "Matched with project install manifest.";
    case "himan_dependency_match":
      return "Matched with declared dependency mapping.";
    case "classifier_builtin":
      return "Classified as built-in tool.";
    case "classifier_shell":
      return "Classified as shell command.";
    case "fallback_unknown":
    case "unknown":
    default:
      return "No strong attribution evidence found.";
  }
}

function sanitizeAttributionSummary(summary: string): string {
  const collapsed = summary.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "No strong attribution evidence found.";
  }

  // Keep evidence summaries safe for local logs/reports by redacting absolute paths.
  const redactedUnixPaths = collapsed.replace(/(?:^|\s)\/[^\s]+/g, (value) =>
    value.startsWith("/") ? "<path>" : value.replace(/\/[^\s]+/, " <path>"),
  );
  const redacted = redactedUnixPaths.replace(/[A-Za-z]:\\[^\s]+/g, "<path>");
  return redacted.slice(0, 240);
}

type SkillMetadataIndex = Map<string, { definition: SkillDefinitionMetadata; ambiguous: boolean }>;

type SkillMetadataSnapshot = {
  version: string | null;
  contentHash: string | null;
  staticEntryTokens: number | null;
  staticPackageTokens: number | null;
  confidence: "exact" | "estimated" | "unknown";
};

function upsertSkillDefinitions(
  db: SqliteDatabase,
  definitions: SkillDefinitionMetadata[],
): void {
  if (definitions.length === 0) {
    return;
  }

  const upsertDefinition = db.prepare(
    `
    insert into capability_definitions (
      id,
      capability_type,
      capability_name,
      version,
      content_hash,
      entry,
      description,
      agents_json,
      static_entry_tokens,
      static_package_tokens,
      tokenizer,
      token_estimator,
      measured_at,
      measured_by,
      generated_at,
      generated_by,
      source_path_hash,
      discovered_at
    )
    values (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      capability_name = excluded.capability_name,
      version = excluded.version,
      content_hash = excluded.content_hash,
      entry = excluded.entry,
      description = excluded.description,
      agents_json = excluded.agents_json,
      static_entry_tokens = excluded.static_entry_tokens,
      static_package_tokens = excluded.static_package_tokens,
      tokenizer = excluded.tokenizer,
      token_estimator = excluded.token_estimator,
      measured_at = excluded.measured_at,
      measured_by = excluded.measured_by,
      generated_at = excluded.generated_at,
      generated_by = excluded.generated_by,
      source_path_hash = excluded.source_path_hash,
      discovered_at = excluded.discovered_at
    `,
  );
  const deleteDependencies = db.prepare(
    "delete from capability_definition_dependencies where definition_id = ?",
  );
  const insertDependency = db.prepare(
    `
    insert or ignore into capability_definition_dependencies (
      definition_id,
      dependency_type,
      dependency_name,
      dependency_path
    )
    values (?, ?, ?, ?)
    `,
  );

  for (const definition of definitions) {
    upsertDefinition.run(
      definition.id,
      definition.name,
      definition.version,
      definition.contentHash,
      definition.entry,
      definition.description,
      JSON.stringify(definition.agents),
      definition.staticEntryTokens,
      definition.staticPackageTokens,
      definition.tokenizer,
      definition.tokenEstimator,
      definition.measuredAt,
      definition.measuredBy,
      definition.generatedAt,
      definition.generatedBy,
      definition.sourcePathHash,
      definition.discoveredAt,
    );
    deleteDependencies.run(definition.id);
    for (const dependency of definition.dependencies) {
      insertDependency.run(definition.id, dependency.type, dependency.name, dependency.path);
    }
  }
}

function upsertSkillMetadataIssues(
  db: SqliteDatabase,
  issues: SkillMetadataIssue[],
): void {
  if (issues.length === 0) {
    return;
  }

  const upsertIssue = db.prepare(
    `
    insert into capability_metadata_issues (
      id,
      capability_type,
      capability_name,
      version,
      content_hash,
      issue_type,
      severity,
      message,
      detected_at
    )
    values (?, 'skill', ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      capability_name = excluded.capability_name,
      version = excluded.version,
      content_hash = excluded.content_hash,
      issue_type = excluded.issue_type,
      severity = excluded.severity,
      message = excluded.message,
      detected_at = excluded.detected_at
    `,
  );

  for (const issue of issues) {
    upsertIssue.run(
      issue.id,
      issue.capabilityName,
      issue.version,
      issue.contentHash,
      issue.issueType,
      issue.severity,
      issue.message,
      issue.detectedAt,
    );
  }
}

function createSkillMetadataIndex(definitions: SkillDefinitionMetadata[]): SkillMetadataIndex {
  const definitionsByName = new Map<string, SkillDefinitionMetadata[]>();
  for (const definition of definitions) {
    const candidates = definitionsByName.get(definition.name) ?? [];
    candidates.push(definition);
    definitionsByName.set(definition.name, candidates);
  }

  const index: SkillMetadataIndex = new Map();
  for (const [name, candidates] of definitionsByName) {
    const sortedCandidates = [...candidates].sort(compareSkillDefinitions);
    const definition = sortedCandidates[0];
    if (definition) {
      index.set(name, { definition, ambiguous: sortedCandidates.length > 1 });
    }
  }

  return index;
}

function compareSkillDefinitions(
  left: SkillDefinitionMetadata,
  right: SkillDefinitionMetadata,
): number {
  const versionCompare = compareVersions(right.version, left.version);
  if (versionCompare !== 0) {
    return versionCompare;
  }

  return right.discoveredAt.localeCompare(left.discoveredAt);
}

function compareVersions(left: string | null, right: string | null): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function parseVersionParts(version: string | null): number[] {
  return version
    ? version
        .replace(/^v/, "")
        .split(".")
        .map((part) => Number(part))
        .filter((part) => Number.isFinite(part))
    : [];
}

function resolveSkillMetadataSnapshot(
  event: CapabilityUsageEvent,
  skillMetadataIndex: SkillMetadataIndex,
): SkillMetadataSnapshot {
  if (event.capability_type !== "skill") {
    return createUnknownSkillMetadataSnapshot();
  }

  const candidate = skillMetadataIndex.get(event.capability_name);
  if (!candidate) {
    return createUnknownSkillMetadataSnapshot();
  }

  return {
    version: candidate.definition.version,
    contentHash: candidate.definition.contentHash,
    staticEntryTokens: candidate.definition.staticEntryTokens,
    staticPackageTokens: candidate.definition.staticPackageTokens,
    confidence: candidate.ambiguous ? "estimated" : "exact",
  };
}

function createUnknownSkillMetadataSnapshot(): SkillMetadataSnapshot {
  return {
    version: null,
    contentHash: null,
    staticEntryTokens: null,
    staticPackageTokens: null,
    confidence: "unknown",
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
