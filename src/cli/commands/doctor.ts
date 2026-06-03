import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  ensureTrackerDirectories,
  resolveTrackerPaths,
} from "../../config/paths.js";
import { readOrCreateUserConfig } from "../../config/userConfig.js";
import { initializeTrackerDatabase } from "../../storage/sqlite.js";

export type DoctorResult = {
  ok: boolean;
  lines: string[];
};

type CheckStatus = "ok" | "warn" | "fail";

export async function runDoctor(): Promise<DoctorResult> {
  const paths = resolveTrackerPaths();
  const lines: string[] = ["himan-tracker doctor", "", `Data home: ${paths.homeDir}`];
  let ok = true;

  try {
    await ensureTrackerDirectories(paths);
    lines.push(formatCheck("ok", "data directory", "ready"));
  } catch (error) {
    ok = false;
    lines.push(formatCheck("fail", "data directory", getErrorMessage(error)));
  }

  try {
    const config = await readOrCreateUserConfig(paths);
    lines.push(formatCheck("ok", "config", paths.configPath));
    lines.push(
      formatCheck(
        "ok",
        "privacy",
        `capture_content=${String(config.privacy.capture_content)}, hash_repo_path=${String(
          config.privacy.hash_repo_path,
        )}`,
      ),
    );
    lines.push(
      formatCheck(
        "ok",
        "agents",
        `codex=${String(config.agents.codex.enabled)}, claude-code=${String(
          config.agents["claude-code"].enabled,
        )}, copilot=${String(config.agents.copilot.enabled)}`,
      ),
    );
  } catch (error) {
    ok = false;
    lines.push(formatCheck("fail", "config", getErrorMessage(error)));
  }

  for (const [label, directoryPath] of [
    ["events directory", paths.eventsDir],
    ["errors directory", paths.errorsDir],
    ["queue directory", paths.queueDir],
    ["locks directory", paths.locksDir],
  ] as const) {
    try {
      await access(directoryPath, constants.R_OK | constants.W_OK);
      lines.push(formatCheck("ok", label, directoryPath));
    } catch (error) {
      ok = false;
      lines.push(formatCheck("fail", label, getErrorMessage(error)));
    }
  }

  try {
    const { db, appliedMigrations } = initializeTrackerDatabase(paths.sqlitePath);
    db.close();
    lines.push(
      formatCheck(
        "ok",
        "sqlite",
        `${paths.sqlitePath}${appliedMigrations.length > 0 ? ` (applied ${appliedMigrations.join(", ")})` : ""
        }`,
      ),
    );
  } catch (error) {
    ok = false;
    lines.push(formatCheck("fail", "sqlite", getErrorMessage(error)));
  }

  const codexHookStatus = await checkCodexHookSetup();
  lines.push(
    formatCheck(
      codexHookStatus.configured ? "ok" : "warn",
      "codex hooks",
      codexHookStatus.configured
        ? `configured (${codexHookStatus.scopes.join(", ")})`
        : "not configured yet",
    ),
  );

  const copilotHookStatus = await checkCopilotHookSetup();
  lines.push(
    formatCheck(
      copilotHookStatus.configured ? "ok" : "warn",
      "copilot hooks",
      copilotHookStatus.configured
        ? `configured (${copilotHookStatus.scopes.join(", ")})`
        : "not configured yet",
    ),
  );

  return { ok, lines };
}

async function checkCodexHookSetup(): Promise<{ configured: boolean; scopes: string[] }> {
  const candidates = [
    { scope: "global", codexDir: path.join(homedir(), ".codex") },
    { scope: "project", codexDir: path.join(process.cwd(), ".codex") },
  ];
  const scopes: string[] = [];

  for (const candidate of candidates) {
    if (await hasHimanTrackerCodexHooks(candidate.codexDir)) {
      scopes.push(candidate.scope);
    }
  }

  return {
    configured: scopes.length > 0,
    scopes,
  };
}

async function hasHimanTrackerCodexHooks(codexDir: string): Promise<boolean> {
  const [configToml, hooksJson] = await Promise.all([
    readOptionalFile(path.join(codexDir, "config.toml")),
    readOptionalFile(path.join(codexDir, "hooks.json")),
  ]);

  return Boolean(
    configToml &&
    hooksJson &&
    hasCodexHooksFeatureEnabled(configToml) &&
    hooksJson.includes("himan-tracker-collect.sh"),
  );
}

function hasCodexHooksFeatureEnabled(configToml: string): boolean {
  return (
    /(^|\n)\s*hooks\s*=\s*true\s*(\n|$)/.test(configToml) ||
    /(^|\n)\s*codex_hooks\s*=\s*true\s*(\n|$)/.test(configToml)
  );
}

async function checkCopilotHookSetup(): Promise<{ configured: boolean; scopes: string[] }> {
  const candidates = [
    {
      scope: "global",
      hooksDir: resolveCopilotGlobalHooksDir(),
    },
    { scope: "project", hooksDir: path.join(process.cwd(), ".github", "hooks") },
  ];
  const scopes: string[] = [];

  for (const candidate of candidates) {
    if (await hasHimanTrackerCopilotHooks(candidate.hooksDir)) {
      scopes.push(candidate.scope);
    }
  }

  return {
    configured: scopes.length > 0,
    scopes,
  };
}

function resolveCopilotGlobalHooksDir(): string {
  const copilotHome = process.env.COPILOT_HOME?.trim();
  if (copilotHome && copilotHome.length > 0) {
    return path.join(copilotHome, "hooks");
  }
  return path.join(homedir(), ".copilot", "hooks");
}

async function hasHimanTrackerCopilotHooks(hooksDir: string): Promise<boolean> {
  const hooksJson = await readOptionalFile(
    path.join(hooksDir, "himan-tracker.json"),
  );

  return Boolean(hooksJson && hooksJson.includes("himan-tracker-collect.sh"));
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function formatCheck(status: CheckStatus, label: string, message: string): string {
  return `[${status}] ${label}: ${message}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
