import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { appendJsonlRecord } from "../../src/collector/jsonlWriter.js";

describe("appendJsonlRecord", () => {
  it("writes append-only JSONL records and creates parent directories", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-jsonl-writer-test-"));

    try {
      const filePath = path.join(homeDir, "nested", "events.jsonl");

      await appendJsonlRecord(filePath, { event_id: "evt_001", value: 1 });
      await appendJsonlRecord(filePath, { event_id: "evt_002", value: 2 });

      const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");

      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0] ?? ""), { event_id: "evt_001", value: 1 });
      assert.deepEqual(JSON.parse(lines[1] ?? ""), { event_id: "evt_002", value: 2 });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects values that cannot be represented as JSON records", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-jsonl-writer-test-"));

    try {
      await assert.rejects(
        appendJsonlRecord(path.join(homeDir, "events.jsonl"), undefined),
        TypeError,
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
