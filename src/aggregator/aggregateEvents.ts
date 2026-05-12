import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { validateNormalizedEvent } from "../normalizer/eventSchema.js";
import { initializeTrackerDatabase, type SqliteDatabase } from "../storage/sqlite.js";
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
};

export async function ingestEvents(options: IngestEventsOptions): Promise<IngestEventsResult> {
  if (options.rebuild) {
    await removeSqliteProjection(options.sqlitePath);
  }

  const eventFiles = await resolveEventFiles(options);
  const events = await readJsonlEvents(eventFiles);
  const { db, appliedMigrations } = initializeTrackerDatabase(options.sqlitePath);

  try {
    const result = insertEvents(db, events, options.now ?? (() => new Date()));

    return {
      sqlite_path: options.sqlitePath,
      events_path: options.eventsPath ?? options.eventsDir ?? "",
      event_files: eventFiles,
      events_read: events.length,
      events_inserted: result.inserted,
      events_skipped: result.skipped,
      affected_dates: result.affectedDates,
      applied_migrations: appliedMigrations,
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

async function readJsonlEvents(eventsPaths: string[]): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];

  for (const eventsPath of eventsPaths) {
    const rawEvents = await readFile(eventsPath, "utf8");

    for (const [index, line] of rawEvents.split(/\r?\n/).entries()) {
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
  }

  return events;
}

function insertEvents(
  db: SqliteDatabase,
  events: NormalizedEvent[],
  now: () => Date,
): { inserted: number; skipped: number; affectedDates: string[] } {
  const hasIngestedEvent = db.prepare("select event_id from ingested_events where event_id = ?");
  const insertIngestedEvent = db.prepare(
    `
    insert into ingested_events (event_id, event_type, occurred_at, ingested_at)
    values (?, ?, ?, ?)
    `,
  );
  const affectedDates = new Set<string>();

  let inserted = 0;
  let skipped = 0;

  const insertTransaction = db.transaction(() => {
    for (const event of events) {
      if (hasIngestedEvent.get(event.event_id)) {
        skipped += 1;
        continue;
      }

      insertBaseEvent(db, event);
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
  });

  insertTransaction();

  return {
    inserted,
    skipped,
    affectedDates: [...affectedDates].sort(),
  };
}

function insertBaseEvent(db: SqliteDatabase, event: NormalizedEvent): void {
  switch (event.event_type) {
    case "turn_summary":
      upsertSessionFromEvent(db, event);
      upsertTurn(db, event);
      break;
    case "capability_usage":
      upsertSessionFromEvent(db, event);
      insertCapabilityUsage(db, event);
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
      output_tokens,
      total_tokens,
      status,
      repo_hash
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      event_id = excluded.event_id,
      session_id = excluded.session_id,
      agent = excluded.agent,
      model = excluded.model,
      occurred_at = excluded.occurred_at,
      duration_ms = excluded.duration_ms,
      input_tokens = excluded.input_tokens,
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
    event.output_tokens,
    event.total_tokens,
    event.status,
    event.repo_hash ?? null,
  );
}

function insertCapabilityUsage(db: SqliteDatabase, event: CapabilityUsageEvent): void {
  db.prepare(
    `
    insert into capability_usages (
      id,
      session_id,
      turn_id,
      agent,
      capability_type,
      capability_name,
      occurred_at,
      duration_ms,
      input_tokens,
      output_tokens,
      total_tokens,
      status,
      adopted,
      attribution_confidence,
      repo_hash
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.event_id,
    event.session_id,
    event.turn_id ?? null,
    event.agent,
    event.capability_type,
    event.capability_name,
    event.occurred_at,
    event.duration_ms,
    event.input_tokens,
    event.output_tokens,
    event.total_tokens,
    event.status,
    event.adopted,
    event.attribution_confidence,
    event.repo_hash ?? null,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
