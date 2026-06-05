import { formatLocalDate } from "./periodFormatter.js";

export type DateRange = {
  startDate: string;
  endDate: string;
};

const SINCE_PATTERN = /^([1-9]\d*)([dwm])$/;

export function parseSinceRange(since: string, now: Date = new Date()): DateRange {
  const match = SINCE_PATTERN.exec(since.trim());
  if (!match) {
    throw new Error("Expected --since to use a value like 7d, 4w, or 1m");
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const days = unit === "d" ? amount : unit === "w" ? amount * 7 : amount * 30;
  const end = startOfLocalDay(now);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);

  return {
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
  };
}

export function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Expected --date to use YYYY-MM-DD");
  }

  return value;
}

export function todayLocalDate(now: Date = new Date()): string {
  return formatLocalDate(startOfLocalDay(now));
}

export function formatDateRange(range: DateRange): string {
  return range.startDate === range.endDate ? range.startDate : `${range.startDate} to ${range.endDate}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
