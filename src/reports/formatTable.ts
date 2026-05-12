const EMPTY_VALUE = "n/a";

export function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );

  return [
    formatRow(headers, widths),
    widths.map((width) => "-".repeat(width)).join(" | "),
    ...rows.map((row) => formatRow(row, widths)),
  ];
}

export function formatNullableNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY_VALUE : String(value);
}

export function formatNullableText(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0 ? EMPTY_VALUE : value;
}

export function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return EMPTY_VALUE;
  }

  if (value < 1_000) {
    return `${value}ms`;
  }

  return `${(value / 1_000).toFixed(1)}s`;
}

export function formatAverageDurationMs(
  totalDurationMs: number | null | undefined,
  count: number,
): string {
  if (totalDurationMs === null || totalDurationMs === undefined || count <= 0) {
    return EMPTY_VALUE;
  }

  return formatDurationMs(Math.round(totalDurationMs / count));
}

export function formatSuccessRate(successCount: number, failureCount: number): string {
  const denominator = successCount + failureCount;
  if (denominator === 0) {
    return EMPTY_VALUE;
  }

  return `${((successCount / denominator) * 100).toFixed(1)}%`;
}

function formatRow(cells: string[], widths: number[]): string {
  return cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ");
}
