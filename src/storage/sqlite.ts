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

export const SKILL_METADATA_MIGRATION_SQL = `
alter table capability_usages add column capability_version text;
alter table capability_usages add column capability_content_hash text;
alter table capability_usages add column static_entry_tokens integer;
alter table capability_usages add column static_package_tokens integer;
alter table capability_usages add column static_metadata_confidence text not null default 'unknown';

alter table daily_capability_stats add column static_entry_tokens integer;
alter table daily_capability_stats add column static_package_tokens integer;
alter table daily_capability_stats add column estimated_static_entry_load integer;
alter table daily_capability_stats add column estimated_static_package_load integer;
alter table daily_capability_stats add column metadata_exact_count integer not null default 0;
alter table daily_capability_stats add column metadata_estimated_count integer not null default 0;
alter table daily_capability_stats add column metadata_unknown_count integer not null default 0;

alter table monthly_capability_stats add column estimated_static_entry_load integer;
alter table monthly_capability_stats add column estimated_static_package_load integer;
alter table monthly_capability_stats add column metadata_exact_count integer not null default 0;
alter table monthly_capability_stats add column metadata_estimated_count integer not null default 0;
alter table monthly_capability_stats add column metadata_unknown_count integer not null default 0;

create table if not exists capability_definitions (
  id text primary key,
  capability_type text not null,
  capability_name text not null,
  version text,
  content_hash text,
  entry text not null,
  description text,
  agents_json text not null,
  static_entry_tokens integer,
  static_package_tokens integer,
  tokenizer text,
  token_estimator text,
  measured_at text,
  measured_by text,
  generated_at text,
  generated_by text,
  source_path_hash text,
  discovered_at text not null
);

create unique index if not exists idx_capability_definitions_identity
  on capability_definitions(
    capability_type,
    capability_name,
    coalesce(version, ''),
    coalesce(content_hash, ''),
    coalesce(source_path_hash, '')
  );

create table if not exists capability_definition_dependencies (
  definition_id text not null,
  dependency_type text not null,
  dependency_name text,
  dependency_path text
);

create unique index if not exists idx_capability_definition_dependencies_identity
  on capability_definition_dependencies(
    definition_id,
    dependency_type,
    coalesce(dependency_name, ''),
    coalesce(dependency_path, '')
  );

create index if not exists idx_capability_definition_dependencies_lookup
  on capability_definition_dependencies(dependency_type, dependency_name);

create table if not exists capability_metadata_issues (
  id text primary key,
  capability_type text not null,
  capability_name text not null,
  version text,
  content_hash text,
  issue_type text not null,
  severity text not null,
  message text not null,
  detected_at text not null
);

create index if not exists idx_capability_metadata_issues_lookup
  on capability_metadata_issues(capability_type, capability_name, issue_type);
`;

export const INGEST_FILE_CURSOR_MIGRATION_SQL = `
create table if not exists ingest_file_cursors (
  file_path text primary key,
  inode text not null,
  size_bytes integer not null,
  offset_bytes integer not null,
  mtime_ms integer not null,
  updated_at text not null
);

create index if not exists idx_ingest_file_cursors_updated_at
  on ingest_file_cursors(updated_at);
`;

export const CAPABILITY_ATTRIBUTION_DETAILS_MIGRATION_SQL = `
alter table capability_usages add column attribution_basis text not null default 'unknown';
alter table capability_usages add column attribution_score integer;
alter table capability_usages add column attribution_reason text;
alter table capability_usages add column attribution_context_source text not null default 'none';

update capability_usages
set attribution_basis = case
    when invocation_origin = 'explicit' then 'prompt_explicit_skill'
    when capability_type = 'mcp_tool' and invocation_origin = 'observed' and attribution_confidence = 'exact'
      then 'transcript_mcp_tool_end'
    when capability_type = 'builtin_tool' then 'classifier_builtin'
    when capability_type = 'shell_command' then 'classifier_shell'
    when invocation_origin = 'inferred' then 'transcript_shell_skill_path'
    else 'fallback_unknown'
  end,
  attribution_score = case
    when attribution_confidence = 'exact' then 100
    when invocation_origin = 'inferred' then 60
    when capability_type = 'builtin_tool' then 55
    when capability_type = 'shell_command' then 50
    when attribution_confidence = 'unknown' then 0
    else null
  end,
  attribution_context_source = case
    when invocation_origin = 'inferred' then 'transcript_only'
    else 'none'
  end
where attribution_basis = 'unknown'
  and attribution_score is null
  and attribution_reason is null
  and attribution_context_source = 'none';
`;

export const CAPABILITY_USAGE_EVIDENCE_MIGRATION_SQL = `
create table if not exists capability_usage_evidence (
  id text primary key,
  usage_id text not null,
  evidence_type text not null,
  confidence text not null,
  score integer,
  summary text not null,
  context_source text not null,
  occurred_at text not null
);

create index if not exists idx_capability_usage_evidence_usage
  on capability_usage_evidence(usage_id);

create index if not exists idx_capability_usage_evidence_occurred_at
  on capability_usage_evidence(occurred_at);
`;

export const CAPABILITY_WEIGHTED_STATS_MIGRATION_SQL = `
alter table daily_capability_stats add column strict_attribution_count integer not null default 0;
alter table daily_capability_stats add column weighted_invocation_count real not null default 0;
alter table daily_capability_stats add column weighted_total_tokens real;
alter table daily_capability_stats add column weighted_duration_ms real;

alter table monthly_capability_stats add column strict_attribution_count integer not null default 0;
alter table monthly_capability_stats add column weighted_invocation_count real not null default 0;
alter table monthly_capability_stats add column weighted_total_tokens real;
alter table monthly_capability_stats add column weighted_duration_ms real;

update daily_capability_stats
set strict_attribution_count = (
    select coalesce(sum(
      case
        when coalesce(
          c.attribution_score,
          case
            when c.attribution_confidence = 'exact' then 100
            when c.capability_type = 'builtin_tool' then 55
            when c.capability_type = 'shell_command' then 50
            when c.attribution_confidence = 'estimated' then 60
            when c.attribution_confidence = 'unknown' then 0
            else 0
          end
        ) >= 80 then 1 else 0
      end
    ), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  weighted_invocation_count = (
    select coalesce(sum(
      coalesce(
        c.attribution_score,
        case
          when c.attribution_confidence = 'exact' then 100
          when c.capability_type = 'builtin_tool' then 55
          when c.capability_type = 'shell_command' then 50
          when c.attribution_confidence = 'estimated' then 60
          when c.attribution_confidence = 'unknown' then 0
          else 0
        end
      ) / 100.0
    ), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  weighted_total_tokens = (
    select case
      when count(c.total_tokens) = 0 then null
      else sum(
        c.total_tokens * (
          coalesce(
            c.attribution_score,
            case
              when c.attribution_confidence = 'exact' then 100
              when c.capability_type = 'builtin_tool' then 55
              when c.capability_type = 'shell_command' then 50
              when c.attribution_confidence = 'estimated' then 60
              when c.attribution_confidence = 'unknown' then 0
              else 0
            end
          ) / 100.0
        )
      )
    end
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  weighted_duration_ms = (
    select case
      when count(
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
      ) = 0 then null
      else sum(
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) * (
          coalesce(
            c.attribution_score,
            case
              when c.attribution_confidence = 'exact' then 100
              when c.capability_type = 'builtin_tool' then 55
              when c.capability_type = 'shell_command' then 50
              when c.attribution_confidence = 'estimated' then 60
              when c.attribution_confidence = 'unknown' then 0
              else 0
            end
          ) / 100.0
        )
      )
    end
    from capability_usages c
    left join turns t
      on c.turn_id = t.id
      and c.session_id = t.session_id
      and c.agent = t.agent
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  );
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
  {
    version: "004_skill_metadata",
    sql: SKILL_METADATA_MIGRATION_SQL,
  },
  {
    version: "005_ingest_file_cursors",
    sql: INGEST_FILE_CURSOR_MIGRATION_SQL,
  },
  {
    version: "006_capability_attribution_details",
    sql: CAPABILITY_ATTRIBUTION_DETAILS_MIGRATION_SQL,
  },
  {
    version: "007_capability_usage_evidence",
    sql: CAPABILITY_USAGE_EVIDENCE_MIGRATION_SQL,
  },
  {
    version: "008_capability_weighted_stats",
    sql: CAPABILITY_WEIGHTED_STATS_MIGRATION_SQL,
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
