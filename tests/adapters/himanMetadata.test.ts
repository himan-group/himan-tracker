import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { discoverSkillMetadata } from "../../src/adapters/himan/metadata.js";

describe("discoverSkillMetadata", () => {
  it("reads static skill metadata from project himan.yaml files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himan-metadata-test-"));

    try {
      const skillDir = path.join(root, ".agents", "skills", "common-dev-pattern");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "himan.yaml"),
        `name: common-dev-pattern
type: skill
version: 0.0.6
entry: SKILL.md
description: Follow existing repository patterns for code changes and validate
  them before the final response.
agents:
  - codex
analysis:
  content:
    tokenizer: approx-char-v1
    tokenEstimator: ceil(chars/4)
    entryTokens: 847
    packageTokens: 901
    contentHash: sha256:abc123
    measuredAt: 2026-05-14T07:52:32.527Z
    measuredBy: codex
  dependencies:
    skills:
      - common-project-changelog
    scripts:
      - path: scripts/build_himan_yaml.mjs
    mcpTools:
      - functions.exec_command
  generation:
    generatedBy: codex
    generatedAt: 2026-05-14T07:52:32.527Z
`,
      );

      const result = await discoverSkillMetadata({
        roots: [root],
        now: () => new Date("2026-05-15T00:00:00.000Z"),
      });

      assert.equal(result.issues.length, 0);
      assert.equal(result.definitions.length, 1);
      assert.deepEqual(result.definitions[0], {
        id: result.definitions[0]?.id,
        name: "common-dev-pattern",
        version: "0.0.6",
        entry: "SKILL.md",
        description:
          "Follow existing repository patterns for code changes and validate them before the final response.",
        agents: ["codex"],
        contentHash: "sha256:abc123",
        staticEntryTokens: 847,
        staticPackageTokens: 901,
        tokenizer: "approx-char-v1",
        tokenEstimator: "ceil(chars/4)",
        measuredAt: "2026-05-14T07:52:32.527Z",
        measuredBy: "codex",
        generatedAt: "2026-05-14T07:52:32.527Z",
        generatedBy: "codex",
        sourcePathHash: result.definitions[0]?.sourcePathHash,
        discoveredAt: "2026-05-15T00:00:00.000Z",
        dependencies: [
          {
            type: "skill",
            name: "common-project-changelog",
            path: null,
          },
          {
            type: "mcp_tool",
            name: "functions.exec_command",
            path: null,
          },
          {
            type: "script",
            name: null,
            path: "scripts/build_himan_yaml.mjs",
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
