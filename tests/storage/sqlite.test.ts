import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { initializeTrackerDatabase, runMigrations } from "../../src/storage/sqlite.js";

describe("initializeTrackerDatabase", () => {
  it("creates the MVP schema and runs migrations idempotently", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-sqlite-test-"));

    try {
      const sqlitePath = path.join(homeDir, "himan.sqlite");
      const { db, appliedMigrations } = initializeTrackerDatabase(sqlitePath);

      try {
        assert.deepEqual(appliedMigrations, ["001_initial"]);

        const tables = db
          .prepare("select name from sqlite_master where type = 'table' order by name")
          .all()
          .map((row) => (row as { name: string }).name);

        assert.deepEqual(tables, [
          "capability_usages",
          "daily_agent_stats",
          "daily_capability_stats",
          "ingested_events",
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
});
