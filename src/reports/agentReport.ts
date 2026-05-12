import type { SqliteDatabase } from "../storage/sqlite.js";
import {
  formatAverageDurationMs,
  formatNullableNumber,
  formatNullableText,
  formatSuccessRate,
  formatTable,
} from "./formatTable.js";

type AgentReportRow = {
  agent: string;
  model: string;
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
  success_count: number;
  failure_count: number;
};

export function renderAgentReport(db: SqliteDatabase, date: string): string[] {
  const rows = db
    .prepare(
      `
      select
        agent,
        model,
        sum(session_count) as session_count,
        sum(turn_count) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms,
        sum(success_count) as success_count,
        sum(failure_count) as failure_count
      from daily_agent_stats
      where date = ?
      group by agent, model
      order by coalesce(total_tokens, -1) desc, turn_count desc
      `,
    )
    .all(date) as AgentReportRow[];

  if (rows.length === 0) {
    return [`Agents (${date})`, "", "No agent usage found for this date."];
  }

  return [
    `Agents (${date})`,
    "",
    ...formatTable(
      ["Agent", "Model", "Sessions", "Turns", "Tokens", "Avg latency", "Success rate"],
      rows.map((row) => [
        row.agent,
        formatNullableText(row.model),
        String(row.session_count),
        String(row.turn_count),
        formatNullableNumber(row.total_tokens),
        formatAverageDurationMs(row.duration_ms, row.turn_count),
        formatSuccessRate(row.success_count, row.failure_count),
      ]),
    ),
  ];
}
