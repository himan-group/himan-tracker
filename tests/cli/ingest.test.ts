import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runIngest } from "../../src/cli/commands/ingest.js";

describe("ingest command", () => {
  it("rejects conflicting rebuild modes", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-command-test-"));

    try {
      process.env.HIMAN_TRACKER_HOME = homeDir;

      const result = await runIngest({ rebuild: true, date: "2026-06-04" });

      assert.equal(result.ok, false);
      assert.match(result.lines.join("\n"), /Expected exactly one of --rebuild or --date/);
    } finally {
      delete process.env.HIMAN_TRACKER_HOME;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects --date together with --from", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-command-test-"));
    const eventsPath = path.join(homeDir, "events.jsonl");

    try {
      process.env.HIMAN_TRACKER_HOME = homeDir;
      await writeFile(eventsPath, "", "utf8");

      const result = await runIngest({ from: eventsPath, date: "2026-06-04" });

      assert.equal(result.ok, false);
      assert.match(result.lines.join("\n"), /Expected --date to be used without --from/);
    } finally {
      delete process.env.HIMAN_TRACKER_HOME;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects --agent without --date", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-ingest-command-test-"));

    try {
      process.env.HIMAN_TRACKER_HOME = homeDir;

      const result = await runIngest({ agent: "codex" });

      assert.equal(result.ok, false);
      assert.match(result.lines.join("\n"), /Expected --agent to be used together with --date/);
    } finally {
      delete process.env.HIMAN_TRACKER_HOME;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
