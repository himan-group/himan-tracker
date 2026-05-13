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

async function assertExists(filePath: string): Promise<void> {
  await access(filePath);
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}
