import type { CapabilityType, AgentName } from "../types/events.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import {
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
};

type CapabilityReportRow = {
  agent: string;
  capability_type: string;
  capability_name: string;
  invocation_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
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
  duration: "coalesce(duration_ms, -1)",
  failures: "failure_count",
};

export function renderCapabilityReport(
  db: SqliteDatabase,
  range: DateRange,
  filters: CapabilityReportFilters,
): string[] {
  const clauses = ["date between ? and ?"];
  const params: string[] = [range.startDate, range.endDate];

  if (filters.agent) {
    clauses.push("agent = ?");
    params.push(filters.agent);
  }

  if (filters.type) {
    clauses.push("capability_type = ?");
    params.push(filters.type);
  }

  if (filters.excludeSystem) {
    const condition = createExcludeSystemCapabilityCondition();
    clauses.push(condition.sql);
    params.push(...condition.params);
  }

  const rows = db
    .prepare(
      `
      select
        agent,
        capability_type,
        capability_name,
        sum(invocation_count) as invocation_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
        sum(success_count) as success_count,
        sum(failure_count) as failure_count,
        sum(explicit_invocation_count) as explicit_invocation_count,
        sum(inferred_invocation_count) as inferred_invocation_count,
        sum(observed_invocation_count) as observed_invocation_count,
        sum(unknown_origin_count) as unknown_origin_count
      from daily_capability_stats
      where ${clauses.join(" and ")}
      group by agent, capability_type, capability_name
      order by ${SORT_SQL[filters.sort]} desc, invocation_count desc, capability_name asc
      `,
    )
    .all(...params) as CapabilityReportRow[];

  if (rows.length === 0) {
    return [
      `Capabilities (${formatDateRange(range)})`,
      "",
      "No capability usage found for this range.",
    ];
  }

  return [
    `Capabilities (${formatDateRange(range)})`,
    "",
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
        "Tokens",
        "Duration",
        "Success rate",
      ],
      rows.map((row) => [
        row.agent,
        row.capability_type,
        row.capability_name,
        String(row.invocation_count),
        String(row.explicit_invocation_count),
        String(row.inferred_invocation_count),
        String(row.observed_invocation_count),
        String(row.unknown_origin_count),
        formatTokenCount(row.total_tokens),
        formatDurationMs(row.duration_ms),
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
