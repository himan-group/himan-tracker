import type { AgentName } from "../types/events.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import { formatDurationMs, formatNullableText, formatTable, formatTokenCount } from "./formatTable.js";
import { formatLocalDateTime } from "./periodFormatter.js";

export type TurnReportFilters = {
  agent?: AgentName;
  limit: number;
};

type TurnReportRow = {
  occurred_at: string;
  agent: string;
  model: string;
  id: string;
  duration_ms: number | null;
  total_tokens: number | null;
  status: string;
};

export function renderTurnReport(
  db: SqliteDatabase,
  range: DateRange,
  filters: TurnReportFilters,
): string[] {
  const clauses = ["date(occurred_at, 'localtime') between ? and ?"];
  const params: Array<string | number> = [range.startDate, range.endDate];

  if (filters.agent) {
    clauses.push("agent = ?");
    params.push(filters.agent);
  }

  params.push(filters.limit);

  const rows = db
    .prepare(
      `
      select
        occurred_at,
        agent,
        model,
        id,
        duration_ms,
        total_tokens,
        status
      from turns
      where ${clauses.join(" and ")}
      order by occurred_at desc
      limit ?
      `,
    )
    .all(...params) as TurnReportRow[];

  if (rows.length === 0) {
    return [
      `Turns (${formatDateRange(range)})`,
      "",
      "No turn usage found for this range.",
    ];
  }

  return [
    `Turns (${formatDateRange(range)})`,
    "",
    ...formatTable(
      ["Time", "Agent", "Model", "Turn", "Duration", "Runtime tokens", "Status"],
      rows.map((row) => [
        formatLocalDateTime(row.occurred_at),
        row.agent,
        formatNullableText(row.model),
        shortenId(row.id),
        formatDurationMs(row.duration_ms),
        formatTokenCount(row.total_tokens),
        row.status,
      ]),
    ),
  ];
}

export function parseTurnLimit(limit: string | number | undefined): number {
  const value = typeof limit === "number" ? limit : Number(limit ?? 20);
  if (!Number.isInteger(value) || value <= 0 || value > 200) {
    throw new Error("Expected --limit to be an integer between 1 and 200");
  }

  return value;
}

function shortenId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}
