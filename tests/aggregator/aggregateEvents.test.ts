import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      assert.deepEqual(first.applied_migrations, [
        "001_initial",
        "002_capability_invocation_origin",
        "003_monthly_archive",
        "004_skill_metadata",
        "005_ingest_file_cursors",
        "006_capability_attribution_details",
        "007_capability_usage_evidence",
        "008_capability_weighted_stats",
        "009_cached_input_tokens",
      ]);
      assert.deepEqual(first.affected_dates, [toLocalDate(events[0].occurred_at)]);

      const second = await ingestEvents({
        sqlitePath,
        eventsPath,
        now: () => new Date("2026-05-12T05:05:00.000Z"),
      });

      assert.equal(second.events_read, 0);
      assert.equal(second.events_inserted, 0);
      assert.equal(second.events_skipped, 0);
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
      assert.deepEqual(rebuilt.applied_migrations, [
        "001_initial",
        "002_capability_invocation_origin",
        "003_monthly_archive",
        "004_skill_metadata",
        "005_ingest_file_cursors",
        "006_capability_attribution_details",
        "007_capability_usage_evidence",
        "008_capability_weighted_stats",
        "009_cached_input_tokens",
      ]);

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

      const incremental = await ingestEvents({
        sqlitePath,
        eventsDir,
        now: () => new Date("2026-05-13T13:05:00.000Z"),
      });
      assert.equal(incremental.events_read, 0);
      assert.equal(incremental.events_inserted, 0);
      assert.equal(incremental.events_skipped, 0);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("consumes himan.yaml metadata for skill capability usages", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-test-"));

    try {
      const eventsPath = path.join(homeDir, "events.jsonl");
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const metadataRoot = path.join(homeDir, "workspace");
      const skillDir = path.join(metadataRoot, ".agents", "skills", "common-dev-pattern");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "himan.yaml"),
        `name: common-dev-pattern
type: skill
version: 0.0.6
entry: SKILL.md
description: Follow existing repository patterns.
agents:
  - codex
analysis:
  content:
    tokenizer: approx-char-v1
    tokenEstimator: ceil(chars/4)
    entryTokens: 847
    packageTokens: 901
    contentHash: sha256:abc123
    measuredAt: 2026-05-14T07:52:32.527Z
    measuredBy: codex
  dependencies:
    skills:
      - common-project-changelog
    scripts: []
    mcpTools:
      - functions.exec_command
  generation:
    generatedBy: codex
    generatedAt: 2026-05-14T07:52:32.527Z
`,
      );

      const skillEvent: NormalizedEvent = {
        schema_version: "1.0",
        event_id: "evt_skill_001",
        event_type: "capability_usage",
        occurred_at: "2026-05-12T12:00:02.000Z",
        agent: "codex",
        source: "fixture",
        session_id: "s_001",
        turn_id: "t_001",
        repo_hash: "repo_hash_001",
        status: "success",
        capability_type: "skill",
        capability_name: "common-dev-pattern",
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        adopted: "unknown",
        attribution_confidence: "estimated",
        invocation_origin: "inferred",
      };
      await appendJsonlRecord(eventsPath, skillEvent);

      const result = await ingestEvents({
        sqlitePath,
        eventsPath,
        skillMetadataRoots: [metadataRoot],
        now: () => new Date("2026-05-15T00:00:00.000Z"),
      });

      assert.equal(result.skill_metadata_definitions, 1);
      assert.equal(result.skill_metadata_issues, 0);

      const db = new Database(sqlitePath);
      try {
        const usage = db.prepare("select * from capability_usages").get() as {
          capability_version: string;
          capability_content_hash: string;
          static_entry_tokens: number;
          static_package_tokens: number;
          static_metadata_confidence: string;
          total_tokens: number | null;
        };
        assert.equal(usage.capability_version, "0.0.6");
        assert.equal(usage.capability_content_hash, "sha256:abc123");
        assert.equal(usage.static_entry_tokens, 847);
        assert.equal(usage.static_package_tokens, 901);
        assert.equal(usage.static_metadata_confidence, "exact");
        assert.equal(usage.total_tokens, null);

        const evidence = db.prepare("select * from capability_usage_evidence").get() as {
          evidence_type: string;
          confidence: string;
          summary: string;
          context_source: string;
        };
        assert.equal(evidence.evidence_type, "unknown");
        assert.equal(evidence.confidence, "estimated");
        assert.equal(evidence.summary, "No strong attribution evidence found.");
        assert.equal(evidence.context_source, "none");

        const definition = db.prepare("select * from capability_definitions").get() as {
          capability_name: string;
          version: string;
          static_entry_tokens: number;
          static_package_tokens: number;
        };
        assert.equal(definition.capability_name, "common-dev-pattern");
        assert.equal(definition.version, "0.0.6");
        assert.equal(definition.static_entry_tokens, 847);
        assert.equal(definition.static_package_tokens, 901);

        const dependencyCount = db
          .prepare("select count(*) as count from capability_definition_dependencies")
          .get() as { count: number };
        assert.equal(dependencyCount.count, 2);

        const dailyStats = db.prepare("select * from daily_capability_stats").get() as {
          total_tokens: number | null;
          static_entry_tokens: number;
          static_package_tokens: number;
          estimated_static_entry_load: number;
          estimated_static_package_load: number;
          metadata_exact_count: number;
          metadata_unknown_count: number;
          strict_attribution_count: number;
          weighted_invocation_count: number;
          weighted_total_tokens: number | null;
          weighted_duration_ms: number | null;
        };
        assert.equal(dailyStats.total_tokens, null);
        assert.equal(dailyStats.static_entry_tokens, 847);
        assert.equal(dailyStats.static_package_tokens, 901);
        assert.equal(dailyStats.estimated_static_entry_load, 847);
        assert.equal(dailyStats.estimated_static_package_load, 901);
        assert.equal(dailyStats.metadata_exact_count, 1);
        assert.equal(dailyStats.metadata_unknown_count, 0);
        assert.equal(dailyStats.strict_attribution_count, 0);
        assert.equal(dailyStats.weighted_invocation_count, 0.6);
        assert.equal(dailyStats.weighted_total_tokens, null);
        assert.equal(dailyStats.weighted_duration_ms, null);
      } finally {
        db.close();
      }
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
      invocation_origin: "observed",
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
      cached_input_tokens: null,
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
      estimated_attribution_count: number;
      explicit_invocation_count: number;
      inferred_invocation_count: number;
      observed_invocation_count: number;
      unknown_origin_count: number;
      static_entry_tokens: number | null;
      static_package_tokens: number | null;
      estimated_static_entry_load: number | null;
      estimated_static_package_load: number | null;
      metadata_exact_count: number;
      metadata_estimated_count: number;
      metadata_unknown_count: number;
      strict_attribution_count: number;
      weighted_invocation_count: number;
      weighted_total_tokens: number | null;
      weighted_duration_ms: number | null;
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
      estimated_attribution_count: 1,
      explicit_invocation_count: 0,
      inferred_invocation_count: 0,
      observed_invocation_count: 1,
      unknown_origin_count: 0,
      static_entry_tokens: null,
      static_package_tokens: null,
      estimated_static_entry_load: null,
      estimated_static_package_load: null,
      metadata_exact_count: 0,
      metadata_estimated_count: 0,
      metadata_unknown_count: 1,
      strict_attribution_count: 0,
      weighted_invocation_count: 0.6,
      weighted_total_tokens: 3,
      weighted_duration_ms: 120,
    });

    const evidenceCount = db
      .prepare("select count(*) as count from capability_usage_evidence")
      .get() as { count: number };
    assert.equal(evidenceCount.count, 1);
  } finally {
    db.close();
  }
}
