import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { ingestEvents } from "../../src/aggregator/aggregateEvents.js";
import { toLocalDate } from "../../src/aggregator/dailyStats.js";
import { appendJsonlRecord } from "../../src/collector/jsonlWriter.js";
import type { NormalizedEvent } from "../../src/types/events.js";

describe("ingestEvents", () => {
  it("imports normalized JSONL events idempotently and recomputes daily stats", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-test-"));

    try {
      const eventsPath = path.join(homeDir, "events.jsonl");
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const events = createFixtureEvents();

      for (const event of events) {
        await appendJsonlRecord(eventsPath, event);
      }

      const first = await ingestEvents({
        sqlitePath,
        eventsPath,
        now: () => new Date("2026-05-12T05:00:00.000Z"),
      });

      assert.equal(first.events_read, 3);
      assert.equal(first.events_inserted, 3);
      assert.equal(first.events_skipped, 0);
      assert.deepEqual(first.applied_migrations, ["001_initial"]);
      assert.deepEqual(first.affected_dates, [toLocalDate(events[0].occurred_at)]);

      const second = await ingestEvents({
        sqlitePath,
        eventsPath,
        now: () => new Date("2026-05-12T05:05:00.000Z"),
      });

      assert.equal(second.events_inserted, 0);
      assert.equal(second.events_skipped, 3);
      assert.deepEqual(second.applied_migrations, []);

      assertDatabaseStats(sqlitePath, toLocalDate(events[0].occurred_at));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rebuilds the SQLite projection from JSONL", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-test-"));

    try {
      const eventsPath = path.join(homeDir, "events.jsonl");
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const events = createFixtureEvents();

      for (const event of events) {
        await appendJsonlRecord(eventsPath, event);
      }

      await ingestEvents({ sqlitePath, eventsPath });
      const rebuilt = await ingestEvents({ sqlitePath, eventsPath, rebuild: true });

      assert.equal(rebuilt.events_inserted, 3);
      assert.equal(rebuilt.events_skipped, 0);
      assert.deepEqual(rebuilt.applied_migrations, ["001_initial"]);

      assertDatabaseStats(sqlitePath, toLocalDate(events[0].occurred_at));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("imports all daily JSONL shards from an events directory", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-test-"));

    try {
      const eventsDir = path.join(homeDir, "events");
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const [firstEvent, secondEvent, thirdEvent] = createFixtureEvents();
      const nextDayEvent: NormalizedEvent = {
        ...firstEvent,
        event_id: "evt_turn_002",
        occurred_at: "2026-05-13T12:00:00.000Z",
        session_id: "s_002",
        turn_id: "t_002",
      };

      await appendJsonlRecord(path.join(eventsDir, "2026-05-12.jsonl"), firstEvent);
      await appendJsonlRecord(path.join(eventsDir, "2026-05-12.jsonl"), secondEvent);
      await appendJsonlRecord(path.join(eventsDir, "2026-05-12.jsonl"), thirdEvent);
      await appendJsonlRecord(path.join(eventsDir, "2026-05-13.jsonl"), nextDayEvent);

      const result = await ingestEvents({
        sqlitePath,
        eventsDir,
        now: () => new Date("2026-05-13T13:00:00.000Z"),
      });

      assert.deepEqual(result.event_files, [
        path.join(eventsDir, "2026-05-12.jsonl"),
        path.join(eventsDir, "2026-05-13.jsonl"),
      ]);
      assert.equal(result.events_read, 4);
      assert.equal(result.events_inserted, 4);
      assert.deepEqual(result.affected_dates, ["2026-05-12", "2026-05-13"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function createFixtureEvents(): NormalizedEvent[] {
  return [
    {
      schema_version: "1.0",
      event_id: "evt_turn_001",
      event_type: "turn_summary",
      occurred_at: "2026-05-12T12:00:00.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "success",
      model: "gpt-5.1-codex",
      duration_ms: 1_000,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
    {
      schema_version: "1.0",
      event_id: "evt_capability_001",
      event_type: "capability_usage",
      occurred_at: "2026-05-12T12:00:02.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      turn_id: "t_001",
      repo_hash: "repo_hash_001",
      status: "failure",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      duration_ms: 200,
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
      adopted: "unknown",
      attribution_confidence: "estimated",
    },
    {
      schema_version: "1.0",
      event_id: "evt_session_001",
      event_type: "session_summary",
      occurred_at: "2026-05-12T12:10:00.000Z",
      agent: "codex",
      source: "fixture",
      session_id: "s_001",
      repo_hash: "repo_hash_001",
      status: "success",
      turn_count: 1,
      duration_ms: 5_000,
    },
  ];
}

function assertDatabaseStats(sqlitePath: string, expectedDate: string): void {
  const db = new Database(sqlitePath);

  try {
    const ingestedCount = db.prepare("select count(*) as count from ingested_events").get() as {
      count: number;
    };
    assert.equal(ingestedCount.count, 3);

    const session = db.prepare("select * from sessions where id = ?").get("s_001") as {
      turn_count: number;
      duration_ms: number;
      status: string;
    };
    assert.equal(session.turn_count, 1);
    assert.equal(session.duration_ms, 5_000);
    assert.equal(session.status, "success");

    const agentStats = db.prepare("select * from daily_agent_stats").get() as {
      date: string;
      agent: string;
      model: string;
      session_count: number;
      turn_count: number;
      total_tokens: number;
      duration_ms: number;
      success_count: number;
      failure_count: number;
    };
    assert.deepEqual(agentStats, {
      date: expectedDate,
      agent: "codex",
      model: "gpt-5.1-codex",
      session_count: 1,
      turn_count: 1,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      duration_ms: 1_000,
      success_count: 1,
      failure_count: 0,
    });

    const capabilityStats = db.prepare("select * from daily_capability_stats").get() as {
      date: string;
      agent: string;
      capability_type: string;
      capability_name: string;
      invocation_count: number;
      total_tokens: number;
      duration_ms: number;
      success_count: number;
      failure_count: number;
      estimated_token_count: number;
    };
    assert.deepEqual(capabilityStats, {
      date: expectedDate,
      agent: "codex",
      capability_type: "mcp_tool",
      capability_name: "github.create_pull_request",
      invocation_count: 1,
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
      duration_ms: 200,
      success_count: 0,
      failure_count: 1,
      estimated_token_count: 1,
    });
  } finally {
    db.close();
  }
}
