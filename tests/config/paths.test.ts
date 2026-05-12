import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveTrackerPaths } from "../../src/config/paths.js";

describe("resolveTrackerPaths", () => {
  it("uses HIMAN_TRACKER_HOME when provided", () => {
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: "/tmp/custom-himan" });

    assert.equal(paths.homeDir, "/tmp/custom-himan");
    assert.equal(paths.configPath, "/tmp/custom-himan/config.json");
    assert.equal(paths.eventsPath, "/tmp/custom-himan/events.jsonl");
    assert.equal(paths.errorsPath, "/tmp/custom-himan/errors.jsonl");
    assert.equal(paths.sqlitePath, "/tmp/custom-himan/himan.sqlite");
    assert.equal(paths.locksDir, "/tmp/custom-himan/locks");
  });
});
