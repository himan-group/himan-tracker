import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runCleanup } from "../../src/cli/commands/cleanup.js";
import {
  ensureTrackerDirectories,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../../src/config/paths.js";
import { initializeTrackerDatabase } from "../../src/storage/sqlite.js";
import type { NormalizedEvent } from "../../src/types/events.js";

describe("cleanup command", () => {
  it("previews raw log deletion without touching files", async () => {
    const { homeDir, paths } = await createCleanupFixture();

    try {
      const result = await runCleanup({
        paths,
        from: "2026-05-10",
        to: "2026-05-12",
        dryRun: true,
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Mode: dry-run/);
      assert.match(result.lines.join("\n"), /Total files matched: 2/);
      await assertExists(path.join(paths.eventsDir, "2026-05-10.jsonl"));
      await assertExists(path.join(paths.errorsDir, "2026-05-12.jsonl"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes a selected date range while keeping SQLite statistics", async () => {
    const { homeDir, paths } = await createCleanupFixture();

    try {
      const result = await runCleanup({
        paths,
        from: "2026-05-10",
        to: "2026-05-12",
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Deleted files: 2/);
      await assertMissing(path.join(paths.eventsDir, "2026-05-10.jsonl"));
      await assertMissing(path.join(paths.errorsDir, "2026-05-12.jsonl"));
      await assertExists(path.join(paths.eventsDir, "2026-05-13.jsonl"));
      assert.equal(await readFile(paths.sqlitePath, "utf8"), "stats stay");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes logs older than a retention period", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      await ensureTrackerDirectories(paths);
      await writeLog(paths, "events", "2026-05-01");
      await writeLog(paths, "events", "2026-05-06");
      await writeLog(paths, "events", "2026-05-07");
      await writeLog(paths, "events", "2026-05-13");

      const result = await runCleanup({
        paths,
        olderThan: "7d",
        now: () => new Date("2026-05-13T12:00:00.000Z"),
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /before 2026-05-07/);
      assert.match(result.lines.join("\n"), /Deleted files: 2/);
      await assertMissing(path.join(paths.eventsDir, "2026-05-01.jsonl"));
      await assertMissing(path.join(paths.eventsDir, "2026-05-06.jsonl"));
      await assertExists(path.join(paths.eventsDir, "2026-05-07.jsonl"));
      await assertExists(path.join(paths.eventsDir, "2026-05-13.jsonl"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes logs before an absolute cutoff date", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      await ensureTrackerDirectories(paths);
      await writeLog(paths, "events", "2026-05-10");
      await writeLog(paths, "events", "2026-05-12");
      await writeLog(paths, "events", "2026-05-13");
      await writeLog(paths, "errors", "2026-05-11");

      const result = await runCleanup({
        paths,
        before: "2026-05-12",
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Scope: before 2026-05-12/);
      assert.match(result.lines.join("\n"), /Deleted files: 2/);
      await assertMissing(path.join(paths.eventsDir, "2026-05-10.jsonl"));
      await assertMissing(path.join(paths.errorsDir, "2026-05-11.jsonl"));
      await assertExists(path.join(paths.eventsDir, "2026-05-12.jsonl"));
      await assertExists(path.join(paths.eventsDir, "2026-05-13.jsonl"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes all daily and legacy raw logs", async () => {
    const { homeDir, paths } = await createCleanupFixture();

    try {
      const result = await runCleanup({ paths, all: true });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Scope: all raw JSONL logs/);
      assert.match(result.lines.join("\n"), /Deleted files: 5/);
      await assertMissing(path.join(paths.eventsDir, "2026-05-10.jsonl"));
      await assertMissing(path.join(paths.eventsDir, "2026-05-13.jsonl"));
      await assertMissing(path.join(paths.errorsDir, "2026-05-12.jsonl"));
      await assertMissing(paths.eventsPath);
      await assertMissing(paths.errorsPath);
      assert.equal(await readFile(paths.sqlitePath, "utf8"), "stats stay");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("removes ingest cursor rows for deleted raw log files", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      await ensureTrackerDirectories(paths);
      await writeLog(paths, "events", "2026-05-10");
      const deletedLog = path.join(paths.eventsDir, "2026-05-10.jsonl");
      const retainedLog = path.join(paths.eventsDir, "2026-05-13.jsonl");
      await writeLog(paths, "events", "2026-05-13");

      const { db } = initializeTrackerDatabase(paths.sqlitePath);
      try {
        db.prepare(
          `
          insert into ingest_file_cursors (
            file_path,
            inode,
            size_bytes,
            offset_bytes,
            mtime_ms,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?)
          `,
        ).run(deletedLog, "1", 20, 20, 1_000, "2026-05-13T00:00:00.000Z");
        db.prepare(
          `
          insert into ingest_file_cursors (
            file_path,
            inode,
            size_bytes,
            offset_bytes,
            mtime_ms,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?)
          `,
        ).run(retainedLog, "2", 20, 20, 1_000, "2026-05-13T00:00:00.000Z");
      } finally {
        db.close();
      }

      const result = await runCleanup({
        paths,
        before: "2026-05-11",
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Cursor rows deleted: 1/);

      const { db: verifyDb } = initializeTrackerDatabase(paths.sqlitePath);
      try {
        const cursorRows = verifyDb.prepare("select file_path from ingest_file_cursors").all() as Array<{
          file_path: string;
        }>;
        assert.deepEqual(cursorRows.map((row) => row.file_path), [retainedLog]);
      } finally {
        verifyDb.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes only matching agent records from mixed event shards", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      await ensureTrackerDirectories(paths);
      await writeEventLog(paths, "2026-06-04", [
        createCleanupEvent({
          eventId: "evt_codex_1",
          occurredAt: "2026-06-04T08:00:00.000Z",
          agent: "codex",
        }),
        createCleanupEvent({
          eventId: "evt_copilot_1",
          occurredAt: "2026-06-04T09:00:00.000Z",
          agent: "copilot",
        }),
        createCleanupEvent({
          eventId: "evt_codex_2",
          occurredAt: "2026-06-04T10:00:00.000Z",
          agent: "codex",
        }),
      ]);
      await writeLog(paths, "errors", "2026-06-04");

      const result = await runCleanup({
        paths,
        agent: "codex",
        from: "2026-06-04",
        to: "2026-06-04",
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Agent filter: codex/);
      assert.match(result.lines.join("\n"), /Event files matched: 1/);
      assert.match(result.lines.join("\n"), /Error files matched: 0/);
      assert.match(result.lines.join("\n"), /Event records matched: 2/);

      const rawEvents = await readFile(path.join(paths.eventsDir, "2026-06-04.jsonl"), "utf8");
      assert.equal(rawEvents.includes('"agent":"codex"'), false);
      assert.equal(rawEvents.includes('"agent":"copilot"'), true);
      await assertExists(path.join(paths.errorsDir, "2026-06-04.jsonl"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite legacy events.jsonl unless agent cleanup runs with --all", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      await ensureTrackerDirectories(paths);
      await writeEventLog(paths, "2026-06-04", [
        createCleanupEvent({
          eventId: "evt_codex_1",
          occurredAt: "2026-06-04T08:00:00.000Z",
          agent: "codex",
        }),
      ]);
      await writeFile(
        paths.eventsPath,
        `${JSON.stringify(
          createCleanupEvent({
            eventId: "evt_legacy_codex_1",
            occurredAt: "2026-05-01T08:00:00.000Z",
            agent: "codex",
          }),
        )}\n`,
        "utf8",
      );

      const result = await runCleanup({
        paths,
        agent: "codex",
        from: "2026-06-04",
        to: "2026-06-04",
      });

      assert.equal(result.ok, true);
      await assertMissing(path.join(paths.eventsDir, "2026-06-04.jsonl"));
      const legacyEvents = await readFile(paths.eventsPath, "utf8");
      assert.match(legacyEvents, /evt_legacy_codex_1/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("removes ingest cursor rows for agent-filtered rewritten event files", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      await ensureTrackerDirectories(paths);
      const rewrittenLog = path.join(paths.eventsDir, "2026-06-04.jsonl");
      const untouchedLog = path.join(paths.eventsDir, "2026-06-05.jsonl");
      await writeEventLog(paths, "2026-06-04", [
        createCleanupEvent({
          eventId: "evt_codex_1",
          occurredAt: "2026-06-04T08:00:00.000Z",
          agent: "codex",
        }),
        createCleanupEvent({
          eventId: "evt_copilot_1",
          occurredAt: "2026-06-04T09:00:00.000Z",
          agent: "copilot",
        }),
      ]);
      await writeEventLog(paths, "2026-06-05", [
        createCleanupEvent({
          eventId: "evt_copilot_2",
          occurredAt: "2026-06-05T08:00:00.000Z",
          agent: "copilot",
        }),
      ]);

      const { db } = initializeTrackerDatabase(paths.sqlitePath);
      try {
        db.prepare(
          `
          insert into ingest_file_cursors (
            file_path,
            inode,
            size_bytes,
            offset_bytes,
            mtime_ms,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?)
          `,
        ).run(rewrittenLog, "1", 40, 40, 1_000, "2026-06-13T00:00:00.000Z");
        db.prepare(
          `
          insert into ingest_file_cursors (
            file_path,
            inode,
            size_bytes,
            offset_bytes,
            mtime_ms,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?)
          `,
        ).run(untouchedLog, "2", 40, 40, 1_000, "2026-06-13T00:00:00.000Z");
      } finally {
        db.close();
      }

      const result = await runCleanup({
        paths,
        agent: "codex",
        from: "2026-06-04",
        to: "2026-06-04",
      });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Cursor rows deleted: 1/);

      const { db: verifyDb } = initializeTrackerDatabase(paths.sqlitePath);
      try {
        const cursorRows = verifyDb.prepare("select file_path from ingest_file_cursors").all() as Array<{
          file_path: string;
        }>;
        assert.deepEqual(cursorRows.map((row) => row.file_path), [untouchedLog]);
      } finally {
        verifyDb.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects missing or conflicting cleanup scopes", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const missing = await runCleanup({ paths });
      const conflicting = await runCleanup({ paths, before: "2026-05-01", olderThan: "30d" });

      assert.equal(missing.ok, false);
      assert.match(missing.lines.join("\n"), /Specify exactly one cleanup scope/);
      assert.equal(conflicting.ok, false);
      assert.match(conflicting.lines.join("\n"), /Specify exactly one cleanup scope/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function createCleanupFixture(): Promise<{ homeDir: string; paths: TrackerPaths }> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "himan-cleanup-test-"));
  const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

  await ensureTrackerDirectories(paths);
  await writeLog(paths, "events", "2026-05-10");
  await writeLog(paths, "events", "2026-05-13");
  await writeLog(paths, "errors", "2026-05-12");
  await writeFile(paths.eventsPath, "{}\n", "utf8");
  await writeFile(paths.errorsPath, "{}\n", "utf8");
  await writeFile(paths.sqlitePath, "stats stay", "utf8");

  return { homeDir, paths };
}

async function writeLog(
  paths: TrackerPaths,
  category: "events" | "errors",
  date: string,
): Promise<void> {
  const directory = category === "events" ? paths.eventsDir : paths.errorsDir;
  await writeFile(path.join(directory, `${date}.jsonl`), "{}\n", "utf8");
}

async function writeEventLog(
  paths: TrackerPaths,
  date: string,
  events: NormalizedEvent[],
): Promise<void> {
  await writeFile(
    path.join(paths.eventsDir, `${date}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function createCleanupEvent(options: {
  eventId: string;
  occurredAt: string;
  agent: "codex" | "copilot" | "claude-code";
}): NormalizedEvent {
  return {
    schema_version: "1.0",
    event_id: options.eventId,
    event_type: "turn_summary",
    occurred_at: options.occurredAt,
    agent: options.agent,
    source: "fixture",
    session_id: `${options.eventId}-session`,
    turn_id: `${options.eventId}-turn`,
    repo_hash: "repo_hash_cleanup",
    status: "success",
    model: options.agent === "codex" ? "gpt-5.4" : null,
    duration_ms: 1_000,
    input_tokens: 10,
    cached_input_tokens: null,
    output_tokens: 2,
    total_tokens: 12,
  };
}

async function assertExists(filePath: string): Promise<void> {
  await access(filePath);
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}
