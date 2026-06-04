import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveTrackerPaths } from "../../src/config/paths.js";
import { readOrCreateUserConfig } from "../../src/config/userConfig.js";

describe("readOrCreateUserConfig", () => {
  it("creates a privacy-first default config", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-config-test-"));

    try {
      const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
      const config = await readOrCreateUserConfig(paths);

      assert.equal(config.schema_version, "1.0");
      assert.equal(config.privacy.capture_content, false);
      assert.equal(config.privacy.hash_repo_path, true);
      assert.equal(config.privacy.capture_shell_args, false);
      assert.equal(config.usage.billing_cycle_start_day, "wednesday");
      assert.equal(config.agents.codex.enabled, true);
      assert.equal(config.agents["claude-code"].enabled, true);
      assert.match(config.local_salt, /^[a-f0-9]{32}$/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
