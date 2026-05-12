import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveDailyErrorsPath,
  resolveDailyEventsPath,
  resolveTrackerPaths,
} from "../../src/config/paths.js";

describe("resolveTrackerPaths", () => {
  it("uses HIMAN_TRACKER_HOME when provided", () => {
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: "/tmp/custom-himan" });

    assert.equal(paths.homeDir, "/tmp/custom-himan");
    assert.equal(paths.configPath, "/tmp/custom-himan/config.json");
    assert.equal(paths.eventsDir, "/tmp/custom-himan/events");
    assert.equal(paths.errorsDir, "/tmp/custom-himan/errors");
    assert.equal(paths.queueDir, "/tmp/custom-himan/queue");
    assert.equal(paths.eventsPath, "/tmp/custom-himan/events.jsonl");
    assert.equal(paths.errorsPath, "/tmp/custom-himan/errors.jsonl");
    assert.equal(paths.sqlitePath, "/tmp/custom-himan/himan.sqlite");
    assert.equal(paths.locksDir, "/tmp/custom-himan/locks");
  });

  it("resolves daily JSONL shard paths from event time", () => {
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: "/tmp/custom-himan" });

    assert.equal(
      resolveDailyEventsPath(paths, "2026-05-12T12:00:00.000Z"),
      "/tmp/custom-himan/events/2026-05-12.jsonl",
    );
    assert.equal(
      resolveDailyErrorsPath(paths, "2026-05-12T12:00:00.000Z"),
      "/tmp/custom-himan/errors/2026-05-12.jsonl",
    );
  });
});
