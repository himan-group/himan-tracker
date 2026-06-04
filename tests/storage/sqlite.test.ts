import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  INITIAL_MIGRATION_SQL,
  initializeTrackerDatabase,
  openTrackerDatabase,
  runMigrations,
} from "../../src/storage/sqlite.js";

describe("initializeTrackerDatabase", () => {
  it("creates the MVP schema and runs migrations idempotently", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-sqlite-test-"));

    try {
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const { db, appliedMigrations } = initializeTrackerDatabase(sqlitePath);

      try {
        assert.deepEqual(appliedMigrations, [
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

        const tables = db
          .prepare("select name from sqlite_master where type = 'table' order by name")
          .all()
          .map((row) => (row as { name: string }).name);

        assert.deepEqual(tables, [
          "capability_definition_dependencies",
          "capability_definitions",
          "capability_metadata_issues",
          "capability_usage_evidence",
          "capability_usages",
          "daily_agent_stats",
          "daily_capability_stats",
          "ingest_file_cursors",
          "ingested_events",
          "monthly_agent_stats",
          "monthly_capability_stats",
          "schema_migrations",
          "sessions",
          "turns",
        ]);
        assert.deepEqual(runMigrations(db), []);
      } finally {
        db.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("migrates existing capability stats with invocation origins", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-sqlite-test-"));

    try {
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const db = openTrackerDatabase(sqlitePath);

      try {
        db.exec(`
          create table if not exists schema_migrations (
            version text primary key,
            applied_at text not null
          );
        `);
        db.exec(INITIAL_MIGRATION_SQL);
        db.prepare("insert into schema_migrations (version, applied_at) values (?, ?)").run(
          "001_initial",
          "2026-05-12T00:00:00.000Z",
        );
        db.prepare(
          `
          insert into capability_usages (
            id,
            session_id,
            turn_id,
            agent,
            capability_type,
            capability_name,
            occurred_at,
            duration_ms,
            input_tokens,
            output_tokens,
            total_tokens,
            status,
            adopted,
            attribution_confidence,
            repo_hash
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          "evt_capability_001",
          "s_001",
          "t_001",
          "codex",
          "skill",
          "common-dev-pattern",
          "2026-05-12T12:00:00.000Z",
          null,
          null,
          null,
          null,
          "unknown",
          "unknown",
          "estimated",
          "repo_hash_001",
        );
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
            estimated_token_count
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          "2026-05-12",
          "codex",
          "skill",
          "common-dev-pattern",
          1,
          null,
          null,
          null,
          null,
          0,
          0,
          1,
        );

        assert.deepEqual(runMigrations(db), [
          "002_capability_invocation_origin",
          "003_monthly_archive",
          "004_skill_metadata",
          "005_ingest_file_cursors",
          "006_capability_attribution_details",
          "007_capability_usage_evidence",
          "008_capability_weighted_stats",
          "009_cached_input_tokens",
        ]);

        const capability = db
          .prepare(
            "select source, invocation_origin, attribution_basis, attribution_score, attribution_context_source from capability_usages",
          )
          .get() as {
          source: string;
          invocation_origin: string;
          attribution_basis: string;
          attribution_score: number;
          attribution_context_source: string;
        };
        assert.deepEqual(capability, {
          source: "unknown",
          invocation_origin: "inferred",
          attribution_basis: "transcript_shell_skill_path",
          attribution_score: 60,
          attribution_context_source: "transcript_only",
        });

        const stats = db.prepare("select * from daily_capability_stats").get() as {
          estimated_attribution_count: number;
          explicit_invocation_count: number;
          inferred_invocation_count: number;
          observed_invocation_count: number;
          unknown_origin_count: number;
        };
        assert.equal(stats.estimated_attribution_count, 1);
        assert.equal(stats.explicit_invocation_count, 0);
        assert.equal(stats.inferred_invocation_count, 1);
        assert.equal(stats.observed_invocation_count, 0);
        assert.equal(stats.unknown_origin_count, 0);
      } finally {
        db.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
