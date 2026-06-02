import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { initializeTrackerDatabase, type SqliteDatabase } from "../storage/sqlite.js";
import type { TrackerPaths } from "../config/paths.js";

export type ArchiveMonthlyOptions = {
  paths: TrackerPaths;
  now?: () => Date;
  dryRun?: boolean;
};

export type ArchiveMonthlyResult = {
  sqlite_path: string;
  retention_months: number;
  first_retained_month: string;
  archived_months: string[];
  monthly_agent_rows: number;
  monthly_capability_rows: number;
  deleted_daily_agent_rows: number;
  deleted_daily_capability_rows: number;
  deleted_event_files: string[];
  deleted_error_files: string[];
  applied_migrations: string[];
  dry_run: boolean;
};

type ArchivePlan = {
  firstRetainedMonth: string;
  archivedMonths: string[];
  dailyAgentRows: number;
  dailyCapabilityRows: number;
  monthlyAgentRows: number;
  monthlyCapabilityRows: number;
  eventFiles: string[];
  errorFiles: string[];
};

const RETENTION_MONTHS = 6;
const DAILY_JSONL_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export async function archiveMonthly(options: ArchiveMonthlyOptions): Promise<ArchiveMonthlyResult> {
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun ?? false;
  const { db, appliedMigrations } = initializeTrackerDatabase(options.paths.sqlitePath);

  try {
    const firstRetainedMonth = resolveFirstRetainedMonth(now());
    const plan = await createArchivePlan(db, options.paths, firstRetainedMonth);

    if (!dryRun && plan.archivedMonths.length > 0) {
      applyMonthlyArchive(db, plan, now);
      await deleteFiles(plan.eventFiles);
      await deleteFiles(plan.errorFiles);
    }

    return {
      sqlite_path: options.paths.sqlitePath,
      retention_months: RETENTION_MONTHS,
      first_retained_month: firstRetainedMonth,
      archived_months: plan.archivedMonths,
      monthly_agent_rows: plan.monthlyAgentRows,
      monthly_capability_rows: plan.monthlyCapabilityRows,
      deleted_daily_agent_rows: dryRun ? 0 : plan.dailyAgentRows,
      deleted_daily_capability_rows: dryRun ? 0 : plan.dailyCapabilityRows,
      deleted_event_files: dryRun ? [] : plan.eventFiles,
      deleted_error_files: dryRun ? [] : plan.errorFiles,
      applied_migrations: appliedMigrations,
      dry_run: dryRun,
    };
  } finally {
    db.close();
  }
}

async function createArchivePlan(
  db: SqliteDatabase,
  paths: TrackerPaths,
  firstRetainedMonth: string,
): Promise<ArchivePlan> {
  const archivedMonths = listArchivableMonths(db, firstRetainedMonth);
  const eventFiles = await listArchivedDailyFiles(paths.eventsDir, firstRetainedMonth);
  const errorFiles = await listArchivedDailyFiles(paths.errorsDir, firstRetainedMonth);

  return {
    firstRetainedMonth,
    archivedMonths,
    dailyAgentRows: countDailyRows(db, "daily_agent_stats", firstRetainedMonth),
    dailyCapabilityRows: countDailyRows(db, "daily_capability_stats", firstRetainedMonth),
    monthlyAgentRows: countMonthlyAgentRows(db, firstRetainedMonth),
    monthlyCapabilityRows: countMonthlyCapabilityRows(db, firstRetainedMonth),
    eventFiles,
    errorFiles,
  };
}

function applyMonthlyArchive(db: SqliteDatabase, plan: ArchivePlan, now: () => Date): void {
  const archivedAt = now().toISOString();
  const transaction = db.transaction(() => {
    upsertMonthlyAgentStats(db, plan.firstRetainedMonth, archivedAt);
    upsertMonthlyCapabilityStats(db, plan.firstRetainedMonth, archivedAt);
    deleteDailyRows(db, "daily_agent_stats", plan.firstRetainedMonth);
    deleteDailyRows(db, "daily_capability_stats", plan.firstRetainedMonth);
  });

  transaction();
}

function upsertMonthlyAgentStats(
  db: SqliteDatabase,
  firstRetainedMonth: string,
  archivedAt: string,
): void {
  db.prepare(
    `
    insert into monthly_agent_stats (
      month,
      agent,
      model,
      session_count,
      turn_count,
      input_tokens,
      output_tokens,
      total_tokens,
      duration_ms,
      success_count,
      failure_count,
      source_start_date,
      source_end_date,
      archived_at
    )
    select
      substr(date, 1, 7) as month,
      agent,
      model,
      sum(session_count) as session_count,
      sum(turn_count) as turn_count,
      case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
      case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
      case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
      case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
      sum(success_count) as success_count,
      sum(failure_count) as failure_count,
      min(date) as source_start_date,
      max(date) as source_end_date,
      ? as archived_at
    from daily_agent_stats
    where date < ?
    group by substr(date, 1, 7), agent, model
    on conflict(month, agent, model) do update set
      session_count = excluded.session_count,
      turn_count = excluded.turn_count,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      duration_ms = excluded.duration_ms,
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      source_start_date = excluded.source_start_date,
      source_end_date = excluded.source_end_date,
      archived_at = excluded.archived_at
    `,
  ).run(archivedAt, firstRetainedMonth);
}

function upsertMonthlyCapabilityStats(
  db: SqliteDatabase,
  firstRetainedMonth: string,
  archivedAt: string,
): void {
  db.prepare(
    `
    insert into monthly_capability_stats (
      month,
      agent,
      capability_type,
      capability_name,
      invocation_count,
      input_tokens,
      output_tokens,
      total_tokens,
      duration_ms,
      success_count,
      failure_count,
      estimated_token_count,
      estimated_attribution_count,
      explicit_invocation_count,
      inferred_invocation_count,
      observed_invocation_count,
      unknown_origin_count,
      estimated_static_entry_load,
      estimated_static_package_load,
      metadata_exact_count,
      metadata_estimated_count,
      metadata_unknown_count,
      strict_attribution_count,
      weighted_invocation_count,
      weighted_total_tokens,
      weighted_duration_ms,
      source_start_date,
      source_end_date,
      archived_at
    )
    select
      substr(date, 1, 7) as month,
      agent,
      capability_type,
      capability_name,
      sum(invocation_count) as invocation_count,
      case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
      case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
      case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
      case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
      sum(success_count) as success_count,
      sum(failure_count) as failure_count,
      sum(estimated_token_count) as estimated_token_count,
      sum(estimated_attribution_count) as estimated_attribution_count,
      sum(explicit_invocation_count) as explicit_invocation_count,
      sum(inferred_invocation_count) as inferred_invocation_count,
      sum(observed_invocation_count) as observed_invocation_count,
      sum(unknown_origin_count) as unknown_origin_count,
      case
        when count(estimated_static_entry_load) = 0 then null
        else sum(estimated_static_entry_load)
      end as estimated_static_entry_load,
      case
        when count(estimated_static_package_load) = 0 then null
        else sum(estimated_static_package_load)
      end as estimated_static_package_load,
      sum(metadata_exact_count) as metadata_exact_count,
      sum(metadata_estimated_count) as metadata_estimated_count,
      sum(metadata_unknown_count) as metadata_unknown_count,
      sum(strict_attribution_count) as strict_attribution_count,
      sum(weighted_invocation_count) as weighted_invocation_count,
      case
        when count(weighted_total_tokens) = 0 then null
        else sum(weighted_total_tokens)
      end as weighted_total_tokens,
      case
        when count(weighted_duration_ms) = 0 then null
        else sum(weighted_duration_ms)
      end as weighted_duration_ms,
      min(date) as source_start_date,
      max(date) as source_end_date,
      ? as archived_at
    from daily_capability_stats
    where date < ?
    group by substr(date, 1, 7), agent, capability_type, capability_name
    on conflict(month, agent, capability_type, capability_name) do update set
      invocation_count = excluded.invocation_count,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      duration_ms = excluded.duration_ms,
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      estimated_token_count = excluded.estimated_token_count,
      estimated_attribution_count = excluded.estimated_attribution_count,
      explicit_invocation_count = excluded.explicit_invocation_count,
      inferred_invocation_count = excluded.inferred_invocation_count,
      observed_invocation_count = excluded.observed_invocation_count,
      unknown_origin_count = excluded.unknown_origin_count,
      estimated_static_entry_load = excluded.estimated_static_entry_load,
      estimated_static_package_load = excluded.estimated_static_package_load,
      metadata_exact_count = excluded.metadata_exact_count,
      metadata_estimated_count = excluded.metadata_estimated_count,
      metadata_unknown_count = excluded.metadata_unknown_count,
      strict_attribution_count = excluded.strict_attribution_count,
      weighted_invocation_count = excluded.weighted_invocation_count,
      weighted_total_tokens = excluded.weighted_total_tokens,
      weighted_duration_ms = excluded.weighted_duration_ms,
      source_start_date = excluded.source_start_date,
      source_end_date = excluded.source_end_date,
      archived_at = excluded.archived_at
    `,
  ).run(archivedAt, firstRetainedMonth);
}

function listArchivableMonths(db: SqliteDatabase, firstRetainedMonth: string): string[] {
  return db
    .prepare(
      `
      select month from (
        select distinct substr(date, 1, 7) as month from daily_agent_stats where date < ?
        union
        select distinct substr(date, 1, 7) as month from daily_capability_stats where date < ?
      )
      order by month
      `,
    )
    .all(firstRetainedMonth, firstRetainedMonth)
    .map((row) => (row as { month: string }).month);
}

function countDailyRows(
  db: SqliteDatabase,
  table: "daily_agent_stats" | "daily_capability_stats",
  firstRetainedMonth: string,
): number {
  const row = db.prepare(`select count(*) as count from ${table} where date < ?`).get(
    firstRetainedMonth,
  ) as { count: number };
  return row.count;
}

function countMonthlyAgentRows(db: SqliteDatabase, firstRetainedMonth: string): number {
  const row = db
    .prepare(
      `
      select count(*) as count from (
        select 1
        from daily_agent_stats
        where date < ?
        group by substr(date, 1, 7), agent, model
      )
      `,
    )
    .get(firstRetainedMonth) as { count: number };
  return row.count;
}

function countMonthlyCapabilityRows(db: SqliteDatabase, firstRetainedMonth: string): number {
  const row = db
    .prepare(
      `
      select count(*) as count from (
        select 1
        from daily_capability_stats
        where date < ?
        group by substr(date, 1, 7), agent, capability_type, capability_name
      )
      `,
    )
    .get(firstRetainedMonth) as { count: number };
  return row.count;
}

function deleteDailyRows(
  db: SqliteDatabase,
  table: "daily_agent_stats" | "daily_capability_stats",
  firstRetainedMonth: string,
): void {
  db.prepare(`delete from ${table} where date < ?`).run(firstRetainedMonth);
}

async function listArchivedDailyFiles(
  directoryPath: string,
  firstRetainedMonth: string,
): Promise<string[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const match = DAILY_JSONL_PATTERN.exec(entry.name);
        return match?.[1] && match[1] < firstRetainedMonth
          ? path.join(directoryPath, entry.name)
          : null;
      })
      .filter((filePath): filePath is string => filePath !== null)
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

async function deleteFiles(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    await rm(filePath, { force: true });
  }
}

function resolveFirstRetainedMonth(now: Date): string {
  const firstDayOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  firstDayOfCurrentMonth.setMonth(firstDayOfCurrentMonth.getMonth() - RETENTION_MONTHS + 1);
  return `${firstDayOfCurrentMonth.getFullYear()}-${String(
    firstDayOfCurrentMonth.getMonth() + 1,
  ).padStart(2, "0")}-01`;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
