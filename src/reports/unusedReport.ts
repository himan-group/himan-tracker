import type { KnownCapability } from "../types/config.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import {
  formatNullableNumber,
  formatNullableText,
  formatTable,
} from "./formatTable.js";

type HistoricalCapabilityRow = {
  capability_type: string;
  capability_name: string;
  last_used_at: string | null;
  historical_invocations: number;
  historical_tokens: number | null;
  range_invocations: number;
};

type UnusedCapabilityRow = {
  type: string;
  name: string;
  last_used_at: string | null;
  historical_invocations: number;
  historical_tokens: number | null;
  range_invocations: number;
};

const KEY_SEPARATOR = "\u001f";

export function renderUnusedReport(
  db: SqliteDatabase,
  range: DateRange,
  knownCapabilities: KnownCapability[],
): string[] {
  const candidates = loadHistoricalCapabilities(db, range);

  for (const capability of knownCapabilities) {
    const key = createCapabilityKey(capability.type, capability.name);
    if (!candidates.has(key)) {
      candidates.set(key, {
        type: capability.type,
        name: capability.name,
        last_used_at: null,
        historical_invocations: 0,
        historical_tokens: null,
        range_invocations: 0,
      });
    }
  }

  if (candidates.size === 0) {
    return [
      `Unused capabilities (${formatDateRange(range)})`,
      "",
      "No capability candidates found. Ingest events or add known_capabilities to config.",
    ];
  }

  const rows = [...candidates.values()]
    .filter((row) => row.range_invocations === 0)
    .sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));

  if (rows.length === 0) {
    return [
      `Unused capabilities (${formatDateRange(range)})`,
      "",
      "No unused capabilities found for this range.",
    ];
  }

  return [
    `Unused capabilities (${formatDateRange(range)})`,
    "",
    ...formatTable(
      ["Type", "Name", "Last used", "Historical invocations", "Historical tokens"],
      rows.map((row) => [
        row.type,
        row.name,
        formatNullableText(row.last_used_at),
        String(row.historical_invocations),
        formatNullableNumber(row.historical_tokens),
      ]),
    ),
  ];
}

function loadHistoricalCapabilities(
  db: SqliteDatabase,
  range: DateRange,
): Map<string, UnusedCapabilityRow> {
  const rows = db
    .prepare(
      `
      select
        capability_type,
        capability_name,
        max(date) as last_used_at,
        sum(invocation_count) as historical_invocations,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as historical_tokens,
        sum(case when date between ? and ? then invocation_count else 0 end) as range_invocations
      from daily_capability_stats
      group by capability_type, capability_name
      `,
    )
    .all(range.startDate, range.endDate) as HistoricalCapabilityRow[];

  return new Map(
    rows.map((row) => [
      createCapabilityKey(row.capability_type, row.capability_name),
      {
        type: row.capability_type,
        name: row.capability_name,
        last_used_at: row.last_used_at,
        historical_invocations: row.historical_invocations,
        historical_tokens: row.historical_tokens,
        range_invocations: row.range_invocations,
      },
    ]),
  );
}

function createCapabilityKey(type: string, name: string): string {
  return `${type}${KEY_SEPARATOR}${name}`;
}
