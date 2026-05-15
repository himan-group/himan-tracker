import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

type Migration = {
  version: string;
  sql: string;
};

const SCHEMA_MIGRATIONS_SQL = `
create table if not exists schema_migrations (
  version text primary key,
  applied_at text not null
);
`;

export const INITIAL_MIGRATION_SQL = `
create table if not exists ingested_events (
  event_id text primary key,
  event_type text not null,
  occurred_at text not null,
  ingested_at text not null
);

create table if not exists sessions (
  id text primary key,
  agent text not null,
  started_at text,
  ended_at text,
  duration_ms integer,
  turn_count integer not null default 0,
  status text not null,
  repo_hash text
);

create table if not exists turns (
  id text primary key,
  event_id text not null unique,
  session_id text not null,
  agent text not null,
  model text not null default '',
  occurred_at text not null,
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  status text not null,
  repo_hash text
);

create table if not exists capability_usages (
  id text primary key,
  session_id text not null,
  turn_id text,
  agent text not null,
  capability_type text not null,
  capability_name text not null,
  occurred_at text not null,
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  status text not null,
  adopted text not null,
  attribution_confidence text not null,
  repo_hash text
);

create table if not exists daily_agent_stats (
  date text not null,
  agent text not null,
  model text not null,
  session_count integer not null,
  turn_count integer not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  duration_ms integer,
  success_count integer not null,
  failure_count integer not null,
  primary key (date, agent, model)
);

create table if not exists daily_capability_stats (
  date text not null,
  agent text not null,
  capability_type text not null,
  capability_name text not null,
  invocation_count integer not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  duration_ms integer,
  success_count integer not null,
  failure_count integer not null,
  estimated_token_count integer not null,
  primary key (date, agent, capability_type, capability_name)
);

create index if not exists idx_turns_occurred_at on turns(occurred_at);
create index if not exists idx_turns_agent_model on turns(agent, model);
create index if not exists idx_capability_usages_occurred_at on capability_usages(occurred_at);
create index if not exists idx_capability_usages_lookup
  on capability_usages(agent, capability_type, capability_name);
create index if not exists idx_daily_agent_stats_date on daily_agent_stats(date);
create index if not exists idx_daily_capability_stats_date on daily_capability_stats(date);
`;

export const CAPABILITY_INVOCATION_ORIGIN_MIGRATION_SQL = `
alter table capability_usages add column source text not null default 'unknown';
alter table capability_usages add column invocation_origin text not null default 'unknown';

update capability_usages
set invocation_origin = case
  when capability_type = 'skill' and attribution_confidence = 'exact' then 'explicit'
  when capability_type = 'skill' and attribution_confidence = 'estimated' then 'inferred'
  else 'unknown'
end;

alter table daily_capability_stats add column estimated_attribution_count integer not null default 0;
alter table daily_capability_stats add column explicit_invocation_count integer not null default 0;
alter table daily_capability_stats add column inferred_invocation_count integer not null default 0;
alter table daily_capability_stats add column observed_invocation_count integer not null default 0;
alter table daily_capability_stats add column unknown_origin_count integer not null default 0;

update daily_capability_stats
set
  estimated_attribution_count = (
    select coalesce(sum(case when c.attribution_confidence = 'estimated' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  explicit_invocation_count = (
    select coalesce(sum(case when c.invocation_origin = 'explicit' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  inferred_invocation_count = (
    select coalesce(sum(case when c.invocation_origin = 'inferred' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  observed_invocation_count = (
    select coalesce(sum(case when c.invocation_origin = 'observed' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  unknown_origin_count = (
    select coalesce(sum(case when c.invocation_origin = 'unknown' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  );
`;

export const MONTHLY_ARCHIVE_MIGRATION_SQL = `
create table if not exists monthly_agent_stats (
  month text not null,
  agent text not null,
  model text not null,
  session_count integer not null,
  turn_count integer not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  duration_ms integer,
  success_count integer not null,
  failure_count integer not null,
  source_start_date text not null,
  source_end_date text not null,
  archived_at text not null,
  primary key (month, agent, model)
);

create table if not exists monthly_capability_stats (
  month text not null,
  agent text not null,
  capability_type text not null,
  capability_name text not null,
  invocation_count integer not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  duration_ms integer,
  success_count integer not null,
  failure_count integer not null,
  estimated_token_count integer not null,
  estimated_attribution_count integer not null,
  explicit_invocation_count integer not null,
  inferred_invocation_count integer not null,
  observed_invocation_count integer not null,
  unknown_origin_count integer not null,
  source_start_date text not null,
  source_end_date text not null,
  archived_at text not null,
  primary key (month, agent, capability_type, capability_name)
);

create index if not exists idx_monthly_agent_stats_month on monthly_agent_stats(month);
create index if not exists idx_monthly_capability_stats_month on monthly_capability_stats(month);
`;

const MIGRATIONS: Migration[] = [
  {
    version: "001_initial",
    sql: INITIAL_MIGRATION_SQL,
  },
  {
    version: "002_capability_invocation_origin",
    sql: CAPABILITY_INVOCATION_ORIGIN_MIGRATION_SQL,
  },
  {
    version: "003_monthly_archive",
    sql: MONTHLY_ARCHIVE_MIGRATION_SQL,
  },
];

export type InitializedDatabase = {
  db: SqliteDatabase;
  appliedMigrations: string[];
};

export function openTrackerDatabase(sqlitePath: string): SqliteDatabase {
  mkdirSync(path.dirname(sqlitePath), { recursive: true, mode: 0o700 });
  const db = new Database(sqlitePath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}

export function initializeTrackerDatabase(sqlitePath: string): InitializedDatabase {
  const db = openTrackerDatabase(sqlitePath);

  try {
    const appliedMigrations = runMigrations(db);
    return { db, appliedMigrations };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function runMigrations(db: SqliteDatabase): string[] {
  db.exec(SCHEMA_MIGRATIONS_SQL);

  const appliedMigrations: string[] = [];
  const hasMigration = db.prepare("select version from schema_migrations where version = ?");
  const recordMigration = db.prepare(
    "insert into schema_migrations (version, applied_at) values (?, ?)",
  );

  const applyMigrations = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (hasMigration.get(migration.version)) {
        continue;
      }

      db.exec(migration.sql);
      recordMigration.run(migration.version, new Date().toISOString());
      appliedMigrations.push(migration.version);
    }
  });

  applyMigrations();

  return appliedMigrations;
}
