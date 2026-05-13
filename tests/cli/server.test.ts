import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { appendJsonlRecord } from "../../src/collector/jsonlWriter.js";
import {
  runServerStart,
  runServerStatus,
  runServerStop,
} from "../../src/cli/commands/server.js";
import {
  ensureTrackerDirectories,
  resolveDailyEventsPath,
  resolveTrackerPaths,
} from "../../src/config/paths.js";
import {
  readReportServerState,
  startReportHttpServer,
} from "../../src/server/reportServer.js";
import type { NormalizedEvent } from "../../src/types/events.js";

const now = new Date("2026-05-12T13:00:00.000Z");

describe("server command", () => {
  it("serves a dashboard page and ingests events before rendering", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const event = createTurnEvent();

    await ensureTrackerDirectories(paths);
    await appendJsonlRecord(resolveDailyEventsPath(paths, event.occurred_at), event);

    const instance = await startReportHttpServer({
      paths,
      host: "127.0.0.1",
      port: 0,
      intervalSeconds: 60,
      since: "7d",
      now: () => now,
    });

    try {
      const response = await fetch(instance.url);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /himan-tracker/);
      assert.match(html, /Summary/);
      assert.match(html, /Token usage/);
      assert.ok(html.indexOf("<h2>Summary</h2>") < html.indexOf("<h2>Token usage</h2>"));
      assert.match(html, /role="tablist"/);
      assert.match(html, /role="tab"[^>]*>Daily<\/button>/);
      assert.match(html, /role="tab"[^>]*>Weekly<\/button>/);
      assert.match(html, /role="tab"[^>]*>Monthly<\/button>/);
      assert.equal(html.includes("Daily tokens"), false);
      assert.equal(html.includes("Weekly tokens"), false);
      assert.equal(html.includes("Monthly tokens"), false);
      assert.match(html, /Recent turns/);
      assert.match(html, /1\.23K/);

      const healthResponse = await fetch(`${instance.url}/healthz`);
      const health = (await healthResponse.json()) as {
        ok: boolean;
        last_ingest: { ok: boolean; events_read: number; events_skipped: number };
      };
      assert.equal(health.ok, true);
      assert.equal(health.last_ingest.ok, true);
      assert.equal(health.last_ingest.events_read, 1);
      assert.equal(health.last_ingest.events_skipped, 1);

      const status = await runServerStatus({ paths });
      assert.equal(status.ok, true);
      assert.match(status.lines.join("\n"), /running/);
      assert.match(status.lines.join("\n"), new RegExp(String(instance.state.port)));

      const alreadyRunning = await runServerStart({
        paths,
        spawnServer: () => {
          throw new Error("should not spawn when state is already active");
        },
      });
      assert.equal(alreadyRunning.ok, true);
      assert.match(alreadyRunning.lines.join("\n"), /Already running/);
    } finally {
      await instance.close();
      assert.equal(await readReportServerState(paths), null);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("reports no-op status and stop when the server is not running", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-server-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });

    try {
      const status = await runServerStatus({ paths });
      assert.equal(status.ok, true);
      assert.match(status.lines.join("\n"), /not running/);

      const stop = await runServerStop({ paths });
      assert.equal(stop.ok, true);
      assert.match(stop.lines.join("\n"), /not running/);

      const invalidStart = await runServerStart({ paths, interval: "0" });
      assert.equal(invalidStart.ok, false);
      assert.match(invalidStart.lines.join("\n"), /Expected --interval/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function createTurnEvent(): NormalizedEvent {
  return {
    schema_version: "1.0",
    event_id: "evt_server_turn_001",
    event_type: "turn_summary",
    occurred_at: "2026-05-12T12:00:00.000Z",
    agent: "codex",
    source: "fixture",
    session_id: "s_server_001",
    turn_id: "t_server_001",
    repo_hash: "repo_hash_server_001",
    status: "success",
    model: "gpt-5.1-codex",
    duration_ms: 1_500,
    input_tokens: 1_000,
    output_tokens: 234,
    total_tokens: 1_234,
  };
}
