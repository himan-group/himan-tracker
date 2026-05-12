import { access, constants } from "node:fs/promises";

import {
  ensureJsonlFile,
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
        )}`,
      ),
    );
  } catch (error) {
    ok = false;
    lines.push(formatCheck("fail", "config", getErrorMessage(error)));
  }

  for (const [label, filePath] of [
    ["events log", paths.eventsPath],
    ["errors log", paths.errorsPath],
  ] as const) {
    try {
      await ensureJsonlFile(filePath);
      await access(filePath, constants.R_OK | constants.W_OK);
      lines.push(formatCheck("ok", label, filePath));
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
        `${paths.sqlitePath}${
          appliedMigrations.length > 0 ? ` (applied ${appliedMigrations.join(", ")})` : ""
        }`,
      ),
    );
  } catch (error) {
    ok = false;
    lines.push(formatCheck("fail", "sqlite", getErrorMessage(error)));
  }

  lines.push(formatCheck("warn", "hooks", "not configured yet"));

  return { ok, lines };
}

function formatCheck(status: CheckStatus, label: string, message: string): string {
  return `[${status}] ${label}: ${message}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
