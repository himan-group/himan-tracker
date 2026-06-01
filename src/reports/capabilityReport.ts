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
export type CapabilityView = "raw" | "strict" | "weighted";

export type CapabilityReportFilters = {
  sort: CapabilitySort;
  view?: CapabilityView;
  strictScoreThreshold?: number;
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

const DEFAULT_STRICT_SCORE_THRESHOLD = 80;

const EFFECTIVE_ATTRIBUTION_SCORE_SQL = `
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
)
`;

export function renderCapabilityReport(
  db: SqliteDatabase,
  range: DateRange,
  filters: CapabilityReportFilters,
): string[] {
  const view = filters.view ?? "raw";
  const strictScoreThreshold = filters.strictScoreThreshold ?? DEFAULT_STRICT_SCORE_THRESHOLD;
  const sortSql = resolveSortSql(filters.sort, view);
  const invocationMetricSql = view === "weighted" ? "sum(weight) as invocation_count" : "count(*) as invocation_count";
  const totalTokensMetricSql =
    view === "weighted"
      ? "case when count(weighted_total_tokens) = 0 then null else sum(weighted_total_tokens) end as total_tokens"
      : "case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens";
  const durationCountMetricSql =
    view === "weighted"
      ? "sum(case when effective_duration_ms is null then 0 else weight end) as duration_count"
      : "count(effective_duration_ms) as duration_count";
  const durationMetricSql =
    view === "weighted"
      ? "case when count(weighted_duration_ms) = 0 then null else sum(weighted_duration_ms) end as duration_ms"
      : `
      case
        when count(effective_duration_ms) = 0 then null
        else sum(effective_duration_ms)
      end as duration_ms
      `;
  const clauses = ["date(c.occurred_at, 'localtime') between ? and ?"];
  const params: Array<string | number> = [range.startDate, range.endDate];

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

  if (view === "strict") {
    clauses.push(`${EFFECTIVE_ATTRIBUTION_SCORE_SQL} >= ?`);
    params.push(strictScoreThreshold);
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
          case
            when c.total_tokens is null then null
            else (
              c.total_tokens * (${EFFECTIVE_ATTRIBUTION_SCORE_SQL} / 100.0)
            )
          end as weighted_total_tokens,
          case
            when coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) is null
              then null
            else (
              coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) *
              (${EFFECTIVE_ATTRIBUTION_SCORE_SQL} / 100.0)
            )
          end as weighted_duration_ms,
          (${EFFECTIVE_ATTRIBUTION_SCORE_SQL} / 100.0) as weight,
          c.status,
          c.invocation_origin,
          ${EFFECTIVE_ATTRIBUTION_SCORE_SQL} as effective_attribution_score
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
          ${invocationMetricSql},
          ${totalTokensMetricSql},
          ${durationCountMetricSql},
          ${durationMetricSql},
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
      order by ${sortSql} desc, invocation_count desc, capability_name asc
      `,
    )
    .all(...params) as CapabilityReportRow[];
  const visibleRows = filters.limit === undefined ? rows : rows.slice(0, filters.limit);
  const countLines = filters.showTotal
    ? [
        `Showing ${visibleRows.length} of ${rows.length} capabilities (view=${view}).`,
        "",
      ]
    : [];

  if (rows.length === 0) {
    return [
      `Capabilities (${formatDateRange(range)}, view=${view})`,
      "",
      ...countLines,
      "No capability usage found for this range.",
    ];
  }

  return [
    `Capabilities (${formatDateRange(range)}, view=${view})`,
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
        formatInvocationCount(view, row.invocation_count),
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

export function parseCapabilityView(view: string): CapabilityView {
  if (view === "raw" || view === "strict" || view === "weighted") {
    return view;
  }

  throw new Error("Expected --view to be raw, strict, or weighted");
}

export function parseStrictScoreThreshold(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("Expected --strict-score-threshold to be an integer between 0 and 100");
  }

  return parsed;
}

function resolveSortSql(sort: CapabilitySort, view: CapabilityView): string {
  if (view === "weighted") {
    if (sort === "invocations") {
      return "invocation_count";
    }
    if (sort === "tokens") {
      return "coalesce(total_tokens, -1)";
    }
    if (sort === "duration") {
      return "case when duration_count = 0 then -1 else duration_ms * 1.0 / duration_count end";
    }
    return "failure_count";
  }

  return SORT_SQL[sort];
}

function formatInvocationCount(view: CapabilityView, value: number): string {
  if (view !== "weighted") {
    return String(value);
  }

  return value.toFixed(2).replace(/\.00$/, "");
}
