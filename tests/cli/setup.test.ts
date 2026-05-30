import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runSetup, setupCodex, setupCopilot } from "../../src/cli/commands/setup.js";

describe("setup command", () => {
    // ── Codex ──

    it("installs project-scoped Codex hooks via runSetup", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-project-test-"));

        try {
            const result = await runSetup({ cwd });

            assert.equal(result.ok, true);
            assert.equal(result.exitCode, 0);
            assert.match(result.lines.join("\n"), /Agent: codex/);
            assert.match(result.lines.join("\n"), /Scope: project/);
            assert.match(
                result.lines.join("\n"),
                /Collector command: himan-tracker collect --agent codex --quiet/,
            );

            const codexDir = path.join(cwd, ".codex");
            const configToml = await readFile(path.join(codexDir, "config.toml"), "utf8");
            const hooksJson = JSON.parse(
                await readFile(path.join(codexDir, "hooks.json"), "utf8"),
            ) as CodexHooksJson;
            const helperPath = path.join(codexDir, "hooks", "himan-tracker-collect.sh");
            const helperScript = await readFile(helperPath, "utf8");
            const helperStat = await stat(helperPath);

            assert.equal(configToml, "[features]\nhooks = true\n");
            assert.equal(hooksJson.hooks.UserPromptSubmit.length, 1);
            assert.equal(hooksJson.hooks.PostToolUse.length, 1);
            assert.equal(hooksJson.hooks.Stop.length, 1);
            assert.match(
                hooksJson.hooks.PostToolUse[0]?.hooks[0]?.command ?? "",
                /himan-tracker-collect\.sh'$/,
            );
            assert.match(helperScript, /himan-tracker collect --agent codex --quiet/);
            assert.match(helperScript, /TRACKER_DIST_CLI=/);
            assert.match(
                helperScript,
                new RegExp(escapeRegExp(path.join(cwd, "dist", "cli", "index.js"))),
            );
            assert.equal(helperScript.includes(["pnpm", "cli"].join(" ")), false);
            assert.notEqual(helperStat.mode & 0o111, 0);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("Codex is idempotent when run repeatedly", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-test-"));

        try {
            await runSetup({ cwd });
            await runSetup({ cwd });

            const hooksJson = JSON.parse(
                await readFile(path.join(cwd, ".codex", "hooks.json"), "utf8"),
            ) as CodexHooksJson;

            assert.equal(hooksJson.hooks.PostToolUse.length, 1);
            assert.equal(hooksJson.hooks.UserPromptSubmit.length, 1);
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

    it("normalizes one-line Codex feature config", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-config-test-"));

        try {
            const codexDir = path.join(cwd, ".codex");
            await mkdir(codexDir, { recursive: true });
            await writeFile(
                path.join(codexDir, "config.toml"),
                "[features] codex_hooks = false\n",
                "utf8",
            );

            const result = await runSetup({ cwd });
            const configToml = await readFile(path.join(codexDir, "config.toml"), "utf8");

            assert.equal(result.ok, true);
            assert.equal(configToml, "[features]\nhooks = true\n");
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("removes deprecated Codex hook feature config while preserving other features", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-config-test-"));

        try {
            const codexDir = path.join(cwd, ".codex");
            await mkdir(codexDir, { recursive: true });
            await writeFile(
                path.join(codexDir, "config.toml"),
                "[features]\ncodex_hooks = true\nshell_snapshot = true\n",
                "utf8",
            );

            const result = await runSetup({ cwd });
            const configToml = await readFile(path.join(codexDir, "config.toml"), "utf8");

            assert.equal(result.ok, true);
            assert.equal(configToml, "[features]\nhooks = true\nshell_snapshot = true\n");
            assert.equal(configToml.includes("codex_hooks"), false);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("can install global Codex hooks", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-source-test-"));
        const homeDir = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-global-test-"));

        try {
            const result = await runSetup({ cwd, homeDir, global: true });

            assert.equal(result.ok, true);
            assert.match(result.lines.join("\n"), /Scope: global/);
            await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
            await readFile(path.join(homeDir, ".codex", "hooks.json"), "utf8");
            const helperScript = await readFile(
                path.join(homeDir, ".codex", "hooks", "himan-tracker-collect.sh"),
                "utf8",
            );
            assert.match(
                helperScript,
                new RegExp(escapeRegExp(path.join(cwd, "dist", "cli", "index.js"))),
            );
        } finally {
            await rm(cwd, { recursive: true, force: true });
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it("Codex warns when global and project hooks would both be configured", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-project-test-"));
        const homeDir = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-global-test-"));

        try {
            await runSetup({ cwd });

            const result = await runSetup({ cwd, homeDir, global: true });

            assert.equal(result.ok, true);
            assert.match(
                result.lines.join("\n"),
                /Himan Codex hooks are also configured in project scope/,
            );
            await readFile(path.join(homeDir, ".codex", "hooks.json"), "utf8");
        } finally {
            await rm(cwd, { recursive: true, force: true });
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it("rejects unsupported agents", async () => {
        const result = await runSetup({ agent: "claude-code" });

        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 1);
        assert.match(result.lines.join("\n"), /Unsupported setup agent/);
    });

    it("installs project-scoped Codex hooks via setupCodex directly", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-codex-direct-test-"));

        try {
            const result = await setupCodex({ cwd });

            assert.equal(result.ok, true);
            assert.match(result.lines.join("\n"), /Agent: codex/);
            assert.match(result.lines.join("\n"), /Scope: project/);

            const codexDir = path.join(cwd, ".codex");
            assert.ok(await stat(codexDir).catch(() => null), "Codex dir not created");
            assert.ok(
                await stat(path.join(codexDir, "hooks.json")).catch(() => null),
                "hooks.json not created",
            );
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    // ── Copilot ──

    it("installs project-scoped Copilot hooks via runSetup", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-copilot-project-test-"));

        try {
            const result = await runSetup({ cwd, agent: "copilot" });

            assert.equal(result.ok, true);
            assert.equal(result.exitCode, 0);
            assert.match(result.lines.join("\n"), /Agent: copilot/);
            assert.match(result.lines.join("\n"), /Scope: project/);
            assert.match(
                result.lines.join("\n"),
                /Collector command: himan-tracker collect --agent copilot --sync --quiet/,
            );

            const hooksDir = path.join(cwd, ".github", "hooks");
            const hooksJson = JSON.parse(
                await readFile(path.join(hooksDir, "himan-tracker.json"), "utf8"),
            ) as CopilotHooksJson;
            const helperPath = path.join(hooksDir, "scripts", "himan-tracker-collect.sh");
            const helperScript = await readFile(helperPath, "utf8");
            const helperStat = await stat(helperPath);

            assert.equal(hooksJson.version, 1);
            assert.equal(hooksJson.hooks.SessionStart.length, 1);
            assert.equal(hooksJson.hooks.PostToolUse.length, 1);
            assert.equal(hooksJson.hooks.PostToolUseFailure.length, 1);
            assert.equal(hooksJson.hooks.Stop.length, 1);
            assert.equal(hooksJson.hooks.SessionEnd.length, 1);
            assert.equal(hooksJson.hooks.SessionStart[0]?.type, "command");
            assert.match(
                hooksJson.hooks.SessionStart[0]?.bash ?? "",
                /himan-tracker-collect\.sh'$/,
            );
            assert.match(helperScript, /himan-tracker collect --agent copilot --sync --quiet/);
            assert.match(helperScript, /TRACKER_DIST_CLI=/);
            assert.notEqual(helperStat.mode & 0o111, 0);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("installs project-scoped Copilot hooks via setupCopilot directly", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-copilot-direct-test-"));

        try {
            const result = await setupCopilot({ cwd });

            assert.equal(result.ok, true);
            assert.match(result.lines.join("\n"), /Scope: project/);

            const hooksJsonPath = path.join(cwd, ".github", "hooks", "himan-tracker.json");
            assert.ok(await stat(hooksJsonPath).catch(() => null), "hooks config not created");
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("Copilot is idempotent when run repeatedly", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-copilot-test-"));

        try {
            await setupCopilot({ cwd });
            await setupCopilot({ cwd });

            const hooksJson = JSON.parse(
                await readFile(path.join(cwd, ".github", "hooks", "himan-tracker.json"), "utf8"),
            ) as CopilotHooksJson;

            assert.equal(hooksJson.hooks.SessionStart.length, 1);
            assert.equal(hooksJson.hooks.PostToolUse.length, 1);
            assert.equal(hooksJson.hooks.SessionEnd.length, 1);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("Copilot supports dry run without writing files", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-copilot-test-"));

        try {
            const result = await setupCopilot({ cwd, dryRun: true });

            assert.equal(result.ok, true);
            assert.match(result.lines.join("\n"), /Mode: dry-run/);
            await assert.rejects(
                readFile(path.join(cwd, ".github", "hooks", "himan-tracker.json"), "utf8"),
                { code: "ENOENT" },
            );
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it("can install global Copilot hooks", async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), "himan-setup-copilot-source-test-"));
        const homeDir = await mkdtemp(path.join(tmpdir(), "himan-setup-copilot-global-test-"));

        try {
            const result = await setupCopilot({ cwd, homeDir, global: true });

            assert.equal(result.ok, true);
            assert.match(result.lines.join("\n"), /Scope: global/);

            const hooksJsonPath = path.join(homeDir, ".copilot", "hooks", "himan-tracker.json");
            const hooksJson = JSON.parse(await readFile(hooksJsonPath, "utf8")) as CopilotHooksJson;
            assert.equal(hooksJson.version, 1);
            assert.equal(hooksJson.hooks.SessionStart.length, 1);

            const helperPath = path.join(homeDir, ".himan-tracker", "scripts", "himan-tracker-collect.sh");
            const helperScript = await readFile(helperPath, "utf8");
            assert.match(helperScript, /himan-tracker collect --agent copilot --sync --quiet/);
        } finally {
            await rm(cwd, { recursive: true, force: true });
            await rm(homeDir, { recursive: true, force: true });
        }
    });
});

type CodexHooksJson = {
    hooks: {
        UserPromptSubmit: Array<{
            hooks: Array<{
                command: string;
            }>;
        }>;
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

type CopilotHooksJson = {
    version: number;
    hooks: {
        SessionStart: Array<{ type: string; bash: string; timeoutSec: number }>;
        PostToolUse: Array<{ type: string; bash: string; timeoutSec: number }>;
        PostToolUseFailure: Array<{ type: string; bash: string; timeoutSec: number }>;
        Stop: Array<{ type: string; bash: string; timeoutSec: number }>;
        SessionEnd: Array<{ type: string; bash: string; timeoutSec: number }>;
    };
};

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
