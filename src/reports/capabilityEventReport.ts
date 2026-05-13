import type { AgentName, CapabilityType } from "../types/events.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import { formatDurationMs, formatNullableText, formatTable, formatTokenCount } from "./formatTable.js";

export type CapabilityEventReportFilters = {
  agent?: AgentName;
  type: CapabilityType;
  name: string;
  limit: number;
};

type CapabilityEventReportRow = {
  occurred_at: string;
  agent: string;
  model: string | null;
  turn_id: string | null;
  duration_ms: number | null;
  duration_basis: string;
  total_tokens: number | null;
  status: string;
  adopted: string;
  attribution_confidence: string;
};

export function renderCapabilityEventReport(
  db: SqliteDatabase,
  range: DateRange,
  filters: CapabilityEventReportFilters,
): string[] {
  const clauses = [
    "date(c.occurred_at, 'localtime') between ? and ?",
    "c.capability_type = ?",
    "c.capability_name = ?",
  ];
  const params: Array<string | number> = [
    range.startDate,
    range.endDate,
    filters.type,
    filters.name,
  ];

  if (filters.agent) {
    clauses.push("c.agent = ?");
    params.push(filters.agent);
  }

  params.push(filters.limit);

  const rows = db
    .prepare(
      `
      select
        c.occurred_at,
        c.agent,
        t.model,
        c.turn_id,
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) as duration_ms,
        case
          when c.duration_ms is not null then 'event'
          when c.capability_type = 'skill' and t.duration_ms is not null then 'turn'
          else 'n/a'
        end as duration_basis,
        c.total_tokens,
        c.status,
        c.adopted,
        c.attribution_confidence
      from capability_usages c
      left join turns t
        on t.id = c.turn_id
        and t.session_id = c.session_id
        and t.agent = c.agent
      where ${clauses.join(" and ")}
      order by c.occurred_at desc
      limit ?
      `,
    )
    .all(...params) as CapabilityEventReportRow[];

  const title = `Capability events (${filters.type}:${filters.name}, ${formatDateRange(range)})`;
  if (rows.length === 0) {
    return [title, "", "No capability events found for this range."];
  }

  return [
    title,
    "",
    ...formatTable(
      [
        "Time",
        "Agent",
        "Model",
        "Turn",
        "Duration",
        "Basis",
        "Tokens",
        "Status",
        "Adopted",
        "Confidence",
      ],
      rows.map((row) => [
        formatLocalDateTime(row.occurred_at),
        row.agent,
        formatNullableText(row.model),
        shortenId(row.turn_id),
        formatDurationMs(row.duration_ms),
        row.duration_basis,
        formatTokenCount(row.total_tokens),
        row.status,
        row.adopted,
        row.attribution_confidence,
      ]),
    ),
  ];
}

export function parseCapabilityEventLimit(limit: string | number | undefined): number {
  const value = typeof limit === "number" ? limit : Number(limit ?? 50);
  if (!Number.isInteger(value) || value <= 0 || value > 200) {
    throw new Error("Expected --limit to be an integer between 1 and 200");
  }

  return value;
}

function formatLocalDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) {
    return timestamp;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function shortenId(id: string | null): string {
  if (!id) {
    return "n/a";
  }

  return id.length > 12 ? id.slice(0, 12) : id;
}
