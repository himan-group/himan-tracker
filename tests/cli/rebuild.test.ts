import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRebuild } from "../../src/cli/commands/rebuild.js";

describe("rebuild command", () => {
  it("runs cleanup, backfill, and ingest in order with progress output", async () => {
    const calls: string[] = [];
    const progress: string[] = [];

    const result = await runRebuild({
      agent: "codex",
      date: "2026-06-04",
      from: "/tmp/transcripts",
      progress: (line) => progress.push(line),
      runners: {
        cleanup: async (options) => {
          calls.push(`cleanup:${options.agent}:${options.from}:${options.to}`);
          return { ok: true, lines: ["cleanup ok"] };
        },
        backfill: async (options) => {
          calls.push(
            `backfill:${options.agent}:${options.date}:${options.from}:${String(options.force)}:${String(options.ignoreCursor)}`,
          );
          return {
            ok: true,
            lines: ["backfill ok"],
            stats: {
              transcriptFiles: 1,
              parsedEvents: 2,
              writtenEvents: 2,
              skippedDuplicates: 0,
              eventFiles: 1,
              skippedSourcesByCursor: 0,
            },
          };
        },
        ingest: async (options) => {
          calls.push(`ingest:${options.agent}:${options.date}`);
          return { ok: true, lines: ["ingest ok"] };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      "cleanup:codex:2026-06-04:2026-06-04",
      "backfill:codex:2026-06-04:/tmp/transcripts:true:true",
      "ingest:codex:2026-06-04",
    ]);
    assert.deepEqual(progress, [
      "[1/3] Cleanup raw events for codex on 2026-06-04",
      "[1/3] Cleanup finished",
      "[2/3] Backfill raw events for codex on 2026-06-04",
      "[2/3] Backfill finished",
      "[3/3] Rebuild SQLite projection for codex on 2026-06-04",
      "[3/3] Ingest finished",
    ]);
    assert.match(result.lines.join("\n"), /1\. cleanup: ok/);
    assert.match(result.lines.join("\n"), /2\. backfill: ok/);
    assert.match(result.lines.join("\n"), /3\. ingest: ok/);
  });

  it("stops when cleanup fails", async () => {
    const calls: string[] = [];

    const result = await runRebuild({
      agent: "codex",
      date: "2026-06-04",
      runners: {
        cleanup: async () => {
          calls.push("cleanup");
          return { ok: false, lines: ["cleanup failed"] };
        },
        backfill: async () => {
          calls.push("backfill");
          return {
            ok: true,
            lines: [],
            stats: {
              transcriptFiles: 0,
              parsedEvents: 0,
              writtenEvents: 0,
              skippedDuplicates: 0,
              eventFiles: 0,
              skippedSourcesByCursor: 0,
            },
          };
        },
        ingest: async () => {
          calls.push("ingest");
          return { ok: true, lines: [] };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, ["cleanup"]);
    assert.match(result.lines.join("\n"), /stopped at cleanup/);
  });

  it("rejects unsupported rebuild agents", async () => {
    const result = await runRebuild({
      agent: "unknown-agent",
      date: "2026-06-04",
    });

    assert.equal(result.ok, false);
    assert.match(result.lines.join("\n"), /Unsupported rebuild agent "unknown-agent"/);
  });
});
