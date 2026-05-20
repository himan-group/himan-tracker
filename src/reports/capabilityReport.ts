import type { CapabilityType, AgentName } from "../types/events.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import {
  formatAverageDurationMs,
  formatDurationMs,
  formatSuccessRate,
  formatTable,
  formatTokenCount,
} from "./formatTable.js";
import { createExcludeSystemCapabilityCondition } from "./systemCapabilityFilter.js";

export type CapabilitySort = "invocations" | "tokens" | "duration" | "failures";

export type CapabilityReportFilters = {
  sort: CapabilitySort;
  agent?: AgentName;
  type?: CapabilityType;
  excludeSystem?: boolean;
  limit?: number;
  showTotal?: boolean;
};

type CapabilityReportRow = {
  agent: string;
  capability_type: string;
  capability_name: string;
  invocation_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  duration_count: number;
  min_duration_ms: number | null;
  max_duration_ms: number | null;
  success_count: number;
  failure_count: number;
  explicit_invocation_count: number;
  inferred_invocation_count: number;
  observed_invocation_count: number;
  unknown_origin_count: number;
};

const SORT_SQL: Record<CapabilitySort, string> = {
  invocations: "invocation_count",
  tokens: "coalesce(total_tokens, -1)",
  duration: "case when duration_count = 0 then -1 else duration_ms * 1.0 / duration_count end",
  failures: "failure_count",
};

export function renderCapabilityReport(
  db: SqliteDatabase,
  range: DateRange,
  filters: CapabilityReportFilters,
): string[] {
  const clauses = ["date(c.occurred_at, 'localtime') between ? and ?"];
  const params: string[] = [range.startDate, range.endDate];

  if (filters.agent) {
    clauses.push("c.agent = ?");
    params.push(filters.agent);
  }

  if (filters.type) {
    clauses.push("c.capability_type = ?");
    params.push(filters.type);
  }

  if (filters.excludeSystem) {
    const condition = createExcludeSystemCapabilityCondition("c");
    clauses.push(condition.sql);
    params.push(...condition.params);
  }

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
            as effective_duration_ms,
          c.status,
          c.invocation_origin
        from capability_usages c
        left join turns t
          on t.id = c.turn_id
          and t.session_id = c.session_id
          and t.agent = c.agent
        where ${clauses.join(" and ")}
      ),
      capability_stats as (
        select
          agent,
          capability_type,
          capability_name,
          count(*) as invocation_count,
          case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
          count(effective_duration_ms) as duration_count,
          case
            when count(effective_duration_ms) = 0 then null
            else sum(effective_duration_ms)
          end as duration_ms,
          min(effective_duration_ms) as min_duration_ms,
          max(effective_duration_ms) as max_duration_ms,
          sum(case when status = 'success' then 1 else 0 end) as success_count,
          sum(case when status = 'failure' then 1 else 0 end) as failure_count,
          sum(case when invocation_origin = 'explicit' then 1 else 0 end) as explicit_invocation_count,
          sum(case when invocation_origin = 'inferred' then 1 else 0 end) as inferred_invocation_count,
          sum(case when invocation_origin = 'observed' then 1 else 0 end) as observed_invocation_count,
          sum(case when invocation_origin = 'unknown' then 1 else 0 end) as unknown_origin_count
        from capability_events
        group by agent, capability_type, capability_name
      )
      select *
      from capability_stats
      order by ${SORT_SQL[filters.sort]} desc, invocation_count desc, capability_name asc
      `,
    )
    .all(...params) as CapabilityReportRow[];
  const visibleRows = filters.limit === undefined ? rows : rows.slice(0, filters.limit);
  const countLines = filters.showTotal
    ? [
        `Showing ${visibleRows.length} of ${rows.length} capabilities.`,
        "",
      ]
    : [];

  if (rows.length === 0) {
    return [
      `Capabilities (${formatDateRange(range)})`,
      "",
      ...countLines,
      "No capability usage found for this range.",
    ];
  }

  return [
    `Capabilities (${formatDateRange(range)})`,
    "",
    ...countLines,
    ...formatTable(
      [
        "Agent",
        "Type",
        "Capability",
        "Invocations",
        "Explicit",
        "Inferred",
        "Observed",
        "Unknown",
        "Runtime tokens",
        "Avg duration",
        "Min duration",
        "Max duration",
        "Success rate",
      ],
      visibleRows.map((row) => [
        row.agent,
        row.capability_type,
        row.capability_name,
        String(row.invocation_count),
        String(row.explicit_invocation_count),
        String(row.inferred_invocation_count),
        String(row.observed_invocation_count),
        String(row.unknown_origin_count),
        formatTokenCount(row.total_tokens),
        formatAverageDurationMs(row.duration_ms, row.duration_count),
        formatDurationMs(row.min_duration_ms),
        formatDurationMs(row.max_duration_ms),
        formatSuccessRate(row.success_count, row.failure_count),
      ]),
    ),
  ];
}

export function parseCapabilitySort(sort: string): CapabilitySort {
  if (sort === "invocations" || sort === "tokens" || sort === "duration" || sort === "failures") {
    return sort;
  }

  throw new Error("Expected --sort to be one of invocations, tokens, duration, or failures");
}
