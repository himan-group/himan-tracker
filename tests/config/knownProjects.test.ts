import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ensureTrackerDirectories, resolveTrackerPaths } from "../../src/config/paths.js";
import {
  createKnownProjectDisplayNameMap,
  learnKnownProjectsFromAdapterEvents,
} from "../../src/config/knownProjects.js";
import {
  createDefaultUserConfig,
  readOrCreateUserConfig,
  writeUserConfig,
} from "../../src/config/userConfig.js";
import type { AdapterEvent } from "../../src/types/events.js";

describe("known projects", () => {
  it("learns package.json name first", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-known-projects-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const repoDir = path.join(homeDir, "my-repo");

    try {
      await ensureTrackerDirectories(paths);
      await mkdir(repoDir, { recursive: true });
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify({ name: "@scope/example-app" }),
        "utf8",
      );

      const config = createDefaultUserConfig();
      await writeUserConfig(paths, config);
      const events = [createTurnEvent(repoDir)];

      await learnKnownProjectsFromAdapterEvents({
        paths,
        config,
        events,
        persist: true,
      });

      const persisted = await readOrCreateUserConfig(paths);
      assert.equal(persisted.known_projects?.length, 1);
      assert.equal(persisted.known_projects?.[0]?.display_name, "@scope/example-app");
      assert.equal(persisted.known_projects?.[0]?.source, "package_name");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to folder name when package.json is unavailable", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-known-projects-test-"));
    const paths = resolveTrackerPaths({ HIMAN_TRACKER_HOME: homeDir });
    const repoDir = path.join(homeDir, "repo-folder-only");

    try {
      await ensureTrackerDirectories(paths);
      await mkdir(repoDir, { recursive: true });

      const config = createDefaultUserConfig();
      await writeUserConfig(paths, config);

      await learnKnownProjectsFromAdapterEvents({
        paths,
        config,
        events: [createTurnEvent(repoDir)],
        persist: true,
      });

      const map = createKnownProjectDisplayNameMap(config);
      const knownProject = config.known_projects?.[0];
      assert.ok(knownProject);
      assert.equal(knownProject.display_name, "repo-folder-only");
      assert.equal(knownProject.source, "folder_name");
      assert.equal(map.get(knownProject.repo_hash), "repo-folder-only");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function createTurnEvent(repoPath: string): AdapterEvent {
  return {
    event_type: "turn_summary",
    occurred_at: "2026-05-29T12:00:00.000Z",
    agent: "codex",
    source: "fixture",
    session_id: "session_001",
    turn_id: "turn_001",
    repo_path: repoPath,
    status: "success",
    model: "gpt-5.1-codex",
    duration_ms: 1200,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
  };
}
