import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import type { UserConfig } from "../types/config.js";
import type { TrackerPaths } from "./paths.js";

export function createDefaultUserConfig(): UserConfig {
  return {
    schema_version: "1.0",
    privacy: {
      capture_content: false,
      hash_repo_path: true,
      capture_shell_args: false,
    },
    agents: {
      codex: {
        enabled: true,
      },
      "claude-code": {
        enabled: true,
      },
      copilot: {
        enabled: true,
      },
    },
    known_capabilities: [],
    known_projects: [],
    local_salt: randomBytes(16).toString("hex"),
  };
}

export async function readOrCreateUserConfig(paths: TrackerPaths): Promise<UserConfig> {
  try {
    const rawConfig = await readFile(paths.configPath, "utf8");
    const parsedConfig = JSON.parse(rawConfig) as Partial<UserConfig>;
    const defaults = createDefaultUserConfig();

    return {
      ...defaults,
      ...parsedConfig,
      privacy: {
        ...defaults.privacy,
        ...parsedConfig.privacy,
      },
      agents: {
        ...defaults.agents,
        ...parsedConfig.agents,
      },
      known_capabilities: parsedConfig.known_capabilities ?? defaults.known_capabilities,
      known_projects: parsedConfig.known_projects ?? defaults.known_projects,
      local_salt: parsedConfig.local_salt ?? defaults.local_salt,
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    const config = createDefaultUserConfig();
    await writeUserConfig(paths, config);
    return config;
  }
}

export async function writeUserConfig(paths: TrackerPaths, config: UserConfig): Promise<void> {
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
