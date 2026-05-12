import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runSetup } from "../../src/cli/commands/setup.js";

describe("setup command", () => {
  it("installs project-scoped Codex hooks by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-project-test-"));

    try {
      const result = await runSetup({ cwd });

      assert.equal(result.ok, true);
      assert.equal(result.exitCode, 0);
      assert.match(result.lines.join("\n"), /Agent: codex/);
      assert.match(result.lines.join("\n"), /Scope: project/);
      assert.match(
        result.lines.join("\n"),
        /Collector command: .*pnpm cli collect --agent codex --quiet/,
      );

      const codexDir = path.join(cwd, ".codex");
      const configToml = await readFile(path.join(codexDir, "config.toml"), "utf8");
      const hooksJson = JSON.parse(
        await readFile(path.join(codexDir, "hooks.json"), "utf8"),
      ) as CodexHooksJson;
      const helperPath = path.join(codexDir, "hooks", "himan-tracker-collect.sh");
      const helperScript = await readFile(helperPath, "utf8");
      const helperStat = await stat(helperPath);

      assert.match(configToml, /\[features\]/);
      assert.match(configToml, /codex_hooks = true/);
      assert.equal(hooksJson.hooks.PostToolUse.length, 1);
      assert.equal(hooksJson.hooks.Stop.length, 1);
      assert.match(
        hooksJson.hooks.PostToolUse[0]?.hooks[0]?.command ?? "",
        /himan-tracker-collect\.sh'$/,
      );
      assert.match(helperScript, /pnpm cli collect --agent codex --quiet/);
      assert.equal(helperScript.includes("himan-tracker collect"), false);
      assert.notEqual(helperStat.mode & 0o111, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent when run repeatedly", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-test-"));

    try {
      await runSetup({ cwd });
      await runSetup({ cwd });

      const hooksJson = JSON.parse(
        await readFile(path.join(cwd, ".codex", "hooks.json"), "utf8"),
      ) as CodexHooksJson;

      assert.equal(hooksJson.hooks.PostToolUse.length, 1);
      assert.equal(hooksJson.hooks.Stop.length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("supports dry run without writing files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-test-"));

    try {
      const result = await runSetup({ cwd, dryRun: true });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Mode: dry-run/);
      await assert.rejects(readFile(path.join(cwd, ".codex", "hooks.json"), "utf8"), {
        code: "ENOENT",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("can install global hooks", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-global-test-"));

    try {
      const result = await runSetup({ homeDir, global: true });

      assert.equal(result.ok, true);
      assert.match(result.lines.join("\n"), /Scope: global/);
      await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
      await readFile(path.join(homeDir, ".codex", "hooks.json"), "utf8");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported agents", async () => {
    const result = await runSetup({ agent: "claude-code" });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join("\n"), /Unsupported setup agent/);
  });
});

type CodexHooksJson = {
  hooks: {
    PostToolUse: Array<{
      hooks: Array<{
        command: string;
      }>;
    }>;
    Stop: Array<{
      hooks: Array<{
        command: string;
      }>;
    }>;
  };
};
