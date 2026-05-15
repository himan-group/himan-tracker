import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { runArchiveMonthly } from "../../src/cli/commands/archive.js";
import { appendJsonlRecord } from "../../src/collector/jsonlWriter.js";
import { resolveTrackerPaths } from "../../src/config/paths.js";
import { initializeTrackerDatabase } from "../../src/storage/sqlite.js";

describe("archive monthly command", () => {
  it("archives complete months before the six-month retention window", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-archive-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const { db } = initializeTrackerDatabase(paths.sqlitePath);
      try {
        insertDailyAgentStats(db);
        insertDailyCapabilityStats(db);
      } finally {
        db.close();
      }

      await appendJsonlRecord(path.join(paths.eventsDir, "2025-10-12.jsonl"), {
        event_id: "old_event",
      });
      await appendJsonlRecord(path.join(paths.eventsDir, "2025-11-30.jsonl"), {
        event_id: "old_event_2",
      });
      await appendJsonlRecord(path.join(paths.eventsDir, "2025-12-01.jsonl"), {
        event_id: "retained_event",
      });
      await appendJsonlRecord(path.join(paths.errorsDir, "2025-11-30.jsonl"), {
        message: "old error",
      });

      const result = await runArchiveMonthly({
        paths,
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /First retained month: 2025-12-01/);
      assert.match(result.lines.join("\n"), /Archived months: 2025-10, 2025-11/);
      assert.match(result.lines.join("\n"), /Deleted event files: 2/);
      assert.match(result.lines.join("\n"), /Deleted error files: 1/);

      const archivedDb = new Database(paths.sqlitePath);
      try {
        const monthlyAgent = archivedDb
          .prepare("select * from monthly_agent_stats where month = ?")
          .get("2025-11") as { turn_count: number; total_tokens: number };
        assert.equal(monthlyAgent.turn_count, 3);
        assert.equal(monthlyAgent.total_tokens, 30);

        const monthlyCapability = archivedDb
          .prepare("select * from monthly_capability_stats where month = ?")
          .get("2025-11") as {
          invocation_count: number;
          observed_invocation_count: number;
        };
        assert.equal(monthlyCapability.invocation_count, 4);
        assert.equal(monthlyCapability.observed_invocation_count, 4);

        const retainedDailyRows = archivedDb
          .prepare("select count(*) as count from daily_agent_stats")
          .get() as { count: number };
        assert.equal(retainedDailyRows.count, 1);
      } finally {
        archivedDb.close();
      }

      await assert.rejects(readFile(path.join(paths.eventsDir, "2025-11-30.jsonl"), "utf8"), {
        code: "ENOENT",
      });
      await readFile(path.join(paths.eventsDir, "2025-12-01.jsonl"), "utf8");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("previews archive work without deleting daily rows or files", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-archive-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const { db } = initializeTrackerDatabase(paths.sqlitePath);
      try {
        insertDailyAgentStats(db);
      } finally {
        db.close();
      }
      await appendJsonlRecord(path.join(paths.eventsDir, "2025-11-30.jsonl"), {
        event_id: "old_event",
      });

      const result = await runArchiveMonthly({
        paths,
        dryRun: true,
        now: () => new Date("2026-05-15T12:00:00.000Z"),
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Mode: dry-run/);
      assert.match(result.lines.join("\n"), /Monthly agent rows: 2/);
      assert.match(result.lines.join("\n"), /Deleted event files: 0/);

      await readFile(path.join(paths.eventsDir, "2025-11-30.jsonl"), "utf8");
      const previewDb = new Database(paths.sqlitePath);
      try {
        const dailyRows = previewDb.prepare("select count(*) as count from daily_agent_stats").get() as {
          count: number;
        };
        const monthlyRows = previewDb
          .prepare("select count(*) as count from monthly_agent_stats")
          .get() as { count: number };
        assert.equal(dailyRows.count, 3);
        assert.equal(monthlyRows.count, 0);
      } finally {
        previewDb.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function insertDailyAgentStats(db: Database.Database): void {
  const insert = db.prepare(
    `
    insert into daily_agent_stats (
      date,
      agent,
      model,
      session_count,
      turn_count,
      input_tokens,
      output_tokens,
      total_tokens,
      duration_ms,
      success_count,
      failure_count
    )
    values (?, 'codex', 'gpt-5.5', 1, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  insert.run("2025-10-12", 1, 10, 5, 15, 100, 1, 0);
  insert.run("2025-11-30", 3, 20, 10, 30, 200, 2, 1);
  insert.run("2025-12-01", 5, 50, 25, 75, 500, 5, 0);
}

function insertDailyCapabilityStats(db: Database.Database): void {
  db.prepare(
    `
    insert into daily_capability_stats (
      date,
      agent,
      capability_type,
      capability_name,
      invocation_count,
      input_tokens,
      output_tokens,
      total_tokens,
      duration_ms,
      success_count,
      failure_count,
      estimated_token_count,
      estimated_attribution_count,
      explicit_invocation_count,
      inferred_invocation_count,
      observed_invocation_count,
      unknown_origin_count
    )
    values (?, 'codex', 'mcp_tool', 'github.create_pull_request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("2025-11-30", 4, 20, 10, 30, 200, 3, 1, 0, 0, 0, 0, 4, 0);
}
