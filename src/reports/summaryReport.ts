import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import {
  formatAverageDurationMs,
  formatNullableText,
  formatSuccessRate,
  formatTable,
  formatTokenCount,
} from "./formatTable.js";
import { createExcludeSystemCapabilityCondition } from "./systemCapabilityFilter.js";

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
  duration_ms: number | null;
  duration_count: number;
};

const TOP_AGENT_LIMIT = 5;
const DEFAULT_TOP_CAPABILITY_LIMIT = 10;

export type SummaryReportOptions = {
  capabilityLimit?: number;
  excludeSystem?: boolean;
};

export function renderSummaryReport(
  db: SqliteDatabase,
  range: DateRange,
  options: SummaryReportOptions = {},
): string[] {
  const capabilityLimit = options.capabilityLimit ?? DEFAULT_TOP_CAPABILITY_LIMIT;
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
        ["Total runtime tokens", formatTokenCount(summary.total_tokens)],
        ["Average latency", formatAverageDurationMs(summary.duration_ms, summary.turn_count)],
        ["Success rate", formatSuccessRate(summary.success_count, summary.failure_count)],
      ],
    ),
    "",
    `Top ${TOP_AGENT_LIMIT} agents`,
    "",
    ...renderTopAgents(db, range),
    "",
    `Top ${capabilityLimit} capabilities`,
    "",
    ...renderTopCapabilities(db, range, {
      excludeSystem: options.excludeSystem ?? false,
      limit: capabilityLimit,
    }),
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
      order by turn_count desc, coalesce(total_tokens, -1) desc, agent asc, model asc
      limit ${TOP_AGENT_LIMIT}
      `,
    )
    .all(range.startDate, range.endDate) as TopAgentRow[];

  if (rows.length === 0) {
    return ["No agent usage found."];
  }

  return formatTable(
    ["Agent", "Model", "Turns", "Runtime tokens"],
    rows.map((row) => [
      row.agent,
      formatNullableText(row.model),
      String(row.turn_count),
      formatTokenCount(row.total_tokens),
    ]),
  );
}

function renderTopCapabilities(
  db: SqliteDatabase,
  range: DateRange,
  filters: {
    excludeSystem: boolean;
    limit: number;
  },
): string[] {
  const clauses = ["date(c.occurred_at, 'localtime') between ? and ?"];
  const params: Array<string | number> = [range.startDate, range.endDate];

  if (filters.excludeSystem) {
    const condition = createExcludeSystemCapabilityCondition("c");
    clauses.push(condition.sql);
    params.push(...condition.params);
  }

  params.push(filters.limit);

  const rows = db
    .prepare(
      `
      with capability_events as (
        select
          c.agent,
          c.capability_type,
          c.capability_name,
          c.total_tokens,
          coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
            as effective_duration_ms
        from capability_usages c
        left join turns t
          on t.id = c.turn_id
          and t.session_id = c.session_id
          and t.agent = c.agent
        where ${clauses.join(" and ")}
      )
      select
        agent,
        capability_type,
        capability_name,
        count(*) as invocation_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(effective_duration_ms) = 0 then null else sum(effective_duration_ms) end as duration_ms,
        count(effective_duration_ms) as duration_count
      from capability_events
      group by agent, capability_type, capability_name
      order by coalesce(total_tokens, -1) desc, invocation_count desc
      limit ?
      `,
    )
    .all(...params) as TopCapabilityRow[];

  if (rows.length === 0) {
    return ["No capability usage found."];
  }

  return formatTable(
    ["Agent", "Type", "Capability", "Invocations", "Runtime tokens", "Duration"],
    rows.map((row) => [
      row.agent,
      row.capability_type,
      row.capability_name,
      String(row.invocation_count),
      formatTokenCount(row.total_tokens),
      formatAverageDurationMs(row.duration_ms, row.duration_count),
    ]),
  );
}

export function parseSummaryLimit(limit: string | number | undefined): number {
  const value =
    typeof limit === "number" ? limit : Number(limit ?? DEFAULT_TOP_CAPABILITY_LIMIT);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("Expected --limit to be an integer between 1 and 200");
  }
  return value;
}
