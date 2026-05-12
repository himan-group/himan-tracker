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

const MIGRATIONS: Migration[] = [
  {
    version: "001_initial",
    sql: INITIAL_MIGRATION_SQL,
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
