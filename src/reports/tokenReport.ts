import type { SqliteDatabase } from "../storage/sqlite.js";
import { formatDateRange, type DateRange } from "./dateRange.js";
import { formatTable, formatTokenCount } from "./formatTable.js";

export type TokenPeriod = "day" | "week" | "month";

type DailyTokenRow = {
  date: string;
  turn_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

type TokenBucket = {
  key: string;
  label: string;
  turn_count: number;
  input_tokens: number;
  input_count: number;
  output_tokens: number;
  output_count: number;
  total_tokens: number;
  total_count: number;
};

export function renderTokenReport(
  db: SqliteDatabase,
  range: DateRange,
  period: TokenPeriod,
): string[] {
  const rows = db
    .prepare(
      `
      select
        date,
        coalesce(sum(turn_count), 0) as turn_count,
        case when count(input_tokens) = 0 then null else sum(input_tokens) end as input_tokens,
        case when count(output_tokens) = 0 then null else sum(output_tokens) end as output_tokens,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from daily_agent_stats
      where date between ? and ?
      group by date
      order by date asc
      `,
    )
    .all(range.startDate, range.endDate) as DailyTokenRow[];

  if (rows.length === 0) {
    return [
      `Token usage by ${period} (${formatDateRange(range)})`,
      "",
      "No token usage found for this range.",
    ];
  }

  const buckets = aggregateTokenRows(rows, period);

  return [
    `Token usage by ${period} (${formatDateRange(range)})`,
    "",
    ...formatTable(
      ["Period", "Turns", "Input", "Output", "Total", "Avg / turn"],
      buckets.map((bucket) => {
        const totalTokens = bucket.total_count > 0 ? bucket.total_tokens : null;

        return [
          bucket.label,
          String(bucket.turn_count),
          formatNullableTokenCount(bucket.input_tokens, bucket.input_count),
          formatNullableTokenCount(bucket.output_tokens, bucket.output_count),
          formatTokenCount(totalTokens),
          formatAverageTokens(totalTokens, bucket.turn_count),
        ];
      }),
    ),
  ];
}

export function parseTokenPeriod(period: string | undefined): TokenPeriod {
  const value = period ?? "day";
  if (value === "day" || value === "week" || value === "month") {
    return value;
  }
  if (value === "daily") {
    return "day";
  }
  if (value === "weekly") {
    return "week";
  }
  if (value === "monthly") {
    return "month";
  }

  throw new Error("Expected --period to be day, week, month, daily, weekly, or monthly");
}

function aggregateTokenRows(rows: DailyTokenRow[], period: TokenPeriod): TokenBucket[] {
  const buckets = new Map<string, TokenBucket>();

  for (const row of rows) {
    const descriptor = describePeriod(row.date, period);
    const bucket = buckets.get(descriptor.key) ?? {
      key: descriptor.key,
      label: descriptor.label,
      turn_count: 0,
      input_tokens: 0,
      input_count: 0,
      output_tokens: 0,
      output_count: 0,
      total_tokens: 0,
      total_count: 0,
    };

    bucket.turn_count += row.turn_count;
    if (row.input_tokens !== null) {
      bucket.input_tokens += row.input_tokens;
      bucket.input_count += 1;
    }
    if (row.output_tokens !== null) {
      bucket.output_tokens += row.output_tokens;
      bucket.output_count += 1;
    }
    if (row.total_tokens !== null) {
      bucket.total_tokens += row.total_tokens;
      bucket.total_count += 1;
    }

    buckets.set(descriptor.key, bucket);
  }

  return [...buckets.values()].sort((left, right) => right.key.localeCompare(left.key));
}

function describePeriod(dateText: string, period: TokenPeriod): { key: string; label: string } {
  if (period === "day") {
    return { key: dateText, label: dateText };
  }

  if (period === "month") {
    const month = dateText.slice(0, 7);
    return { key: month, label: month };
  }

  const weekStart = startOfLocalWeek(parseLocalDate(dateText));
  const weekEnd = addDays(weekStart, 6);
  const label = `${formatLocalDate(weekStart)} to ${formatLocalDate(weekEnd)}`;

  return {
    key: formatLocalDate(weekStart),
    label,
  };
}

function parseLocalDate(dateText: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) {
    throw new Error(`Invalid local date: ${dateText}`);
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatNullableTokenCount(value: number, count: number): string {
  return count === 0 ? "n/a" : formatTokenCount(value);
}

function formatAverageTokens(totalTokens: number | null, turnCount: number): string {
  if (totalTokens === null || turnCount <= 0) {
    return "n/a";
  }

  return formatTokenCount(Math.round(totalTokens / turnCount));
}
