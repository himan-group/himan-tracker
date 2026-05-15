import type { DateRange } from "./dateRange.js";

export function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid local date: ${value}`);
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  return addDays(start, -daysSinceMonday);
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function formatShortDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${month}-${day}`;
}

export function formatShortDateRange(range: DateRange): string {
  const start = formatShortDate(parseLocalDate(range.startDate));
  const end = formatShortDate(parseLocalDate(range.endDate));

  return start === end ? start : `${start} ~ ${end}`;
}

export function formatYearWeekLabel(date: Date): string {
  const weekStart = startOfLocalWeek(date);
  const weekThursday = addDays(weekStart, 3);
  const weekYear = weekThursday.getFullYear();
  const firstWeekStart = startOfLocalWeek(new Date(weekYear, 0, 4));
  const weekNumber = Math.floor(daysBetween(firstWeekStart, weekStart) / 7) + 1;

  return `${weekYear} Week ${weekNumber}`;
}

export function formatNaturalWeekRangeLabel(range: DateRange): string {
  return `${formatYearWeekLabel(parseLocalDate(range.startDate))} (${formatShortDateRange(range)})`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((startOfLocalDay(end).getTime() - startOfLocalDay(start).getTime()) / 86_400_000);
}
