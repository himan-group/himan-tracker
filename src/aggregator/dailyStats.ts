import type { SqliteDatabase } from "../storage/sqlite.js";

export function recomputeDailyStats(db: SqliteDatabase, dates: Iterable<string>): void {
  for (const date of [...new Set(dates)].sort()) {
    recomputeDailyAgentStats(db, date);
    recomputeDailyCapabilityStats(db, date);
  }
}

export function toLocalDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid timestamp: ${isoTimestamp}`);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function recomputeDailyAgentStats(db: SqliteDatabase, date: string): void {
  db.prepare("delete from daily_agent_stats where date = ?").run(date);
  db.prepare(
    `
    insert into daily_agent_stats (
      date,
      agent,
      model,
      session_count,
      turn_count,
      input_tokens,
      output_tokens,
      total_tokens,
      duration_ms,
      success_count,
      failure_count
    )
    select
      ? as date,
      agent,
      model,
      count(distinct session_id) as session_count,
      count(*) as turn_count,
      case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
      case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
      case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
      case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
      sum(case when status = 'success' then 1 else 0 end) as success_count,
      sum(case when status = 'failure' then 1 else 0 end) as failure_count
    from turns
    where date(occurred_at, 'localtime') = ?
    group by agent, model
    `,
  ).run(date, date);
}

function recomputeDailyCapabilityStats(db: SqliteDatabase, date: string): void {
  db.prepare("delete from daily_capability_stats where date = ?").run(date);
  db.prepare(
    `
    insert into daily_capability_stats (
      date,
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
      estimated_token_count
    )
    select
      ? as date,
      agent,
      capability_type,
      capability_name,
      count(*) as invocation_count,
      case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
      case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
      case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
      case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
      sum(case when status = 'success' then 1 else 0 end) as success_count,
      sum(case when status = 'failure' then 1 else 0 end) as failure_count,
      sum(case when attribution_confidence = 'estimated' then 1 else 0 end) as estimated_token_count
    from capability_usages
    where date(occurred_at, 'localtime') = ?
    group by agent, capability_type, capability_name
    `,
  ).run(date, date);
}
