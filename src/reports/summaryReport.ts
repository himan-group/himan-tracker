import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import {
  formatAverageDurationMs,
  formatNullableNumber,
  formatNullableText,
  formatSuccessRate,
  formatTable,
} from "./formatTable.js";

type SummaryAggregateRow = {
  row_count: number;
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  success_count: number;
  failure_count: number;
};

type TopAgentRow = {
  agent: string;
  model: string;
  turn_count: number;
  total_tokens: number | null;
};

type TopCapabilityRow = {
  agent: string;
  capability_type: string;
  capability_name: string;
  invocation_count: number;
  total_tokens: number | null;
};

export function renderSummaryReport(db: SqliteDatabase, range: DateRange): string[] {
  const summary = db
    .prepare(
      `
      select
        count(*) as row_count,
        coalesce(sum(session_count), 0) as session_count,
        coalesce(sum(turn_count), 0) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
        coalesce(sum(success_count), 0) as success_count,
        coalesce(sum(failure_count), 0) as failure_count
      from daily_agent_stats
      where date between ? and ?
      `,
    )
    .get(range.startDate, range.endDate) as SummaryAggregateRow;

  if (summary.row_count === 0) {
    return [
      `Summary (${formatDateRange(range)})`,
      "",
      "No usage data found. Run `himan-tracker ingest` after collecting events.",
    ];
  }

  return [
    `Summary (${formatDateRange(range)})`,
    "",
    ...formatTable(
      ["Metric", "Value"],
      [
        ["Sessions", String(summary.session_count)],
        ["Turns", String(summary.turn_count)],
        ["Total tokens", formatNullableNumber(summary.total_tokens)],
        ["Average latency", formatAverageDurationMs(summary.duration_ms, summary.turn_count)],
        ["Success rate", formatSuccessRate(summary.success_count, summary.failure_count)],
      ],
    ),
    "",
    "Top agents",
    "",
    ...renderTopAgents(db, range),
    "",
    "Top capabilities",
    "",
    ...renderTopCapabilities(db, range),
  ];
}

function renderTopAgents(db: SqliteDatabase, range: DateRange): string[] {
  const rows = db
    .prepare(
      `
      select
        agent,
        model,
        sum(turn_count) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from daily_agent_stats
      where date between ? and ?
      group by agent, model
      order by coalesce(total_tokens, -1) desc, turn_count desc
      limit 5
      `,
    )
    .all(range.startDate, range.endDate) as TopAgentRow[];

  if (rows.length === 0) {
    return ["No agent usage found."];
  }

  return formatTable(
    ["Agent", "Model", "Turns", "Tokens"],
    rows.map((row) => [
      row.agent,
      formatNullableText(row.model),
      String(row.turn_count),
      formatNullableNumber(row.total_tokens),
    ]),
  );
}

function renderTopCapabilities(db: SqliteDatabase, range: DateRange): string[] {
  const rows = db
    .prepare(
      `
      select
        agent,
        capability_type,
        capability_name,
        sum(invocation_count) as invocation_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from daily_capability_stats
      where date between ? and ?
      group by agent, capability_type, capability_name
      order by coalesce(total_tokens, -1) desc, invocation_count desc
      limit 5
      `,
    )
    .all(range.startDate, range.endDate) as TopCapabilityRow[];

  if (rows.length === 0) {
    return ["No capability usage found."];
  }

  return formatTable(
    ["Agent", "Type", "Capability", "Invocations", "Tokens"],
    rows.map((row) => [
      row.agent,
      row.capability_type,
      row.capability_name,
      String(row.invocation_count),
      formatNullableNumber(row.total_tokens),
    ]),
  );
}
