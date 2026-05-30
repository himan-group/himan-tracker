import type { AgentName, CapabilityType } from "./events.js";

export type KnownCapability = {
  type: CapabilityType;
  name: string;
};

export type KnownProject = {
  repo_hash: string;
  display_name: string;
  source: "package_name" | "folder_name";
};

export type UserConfig = {
  schema_version: "1.0";
  privacy: {
    capture_content: boolean;
    hash_repo_path: boolean;
    capture_shell_args: boolean;
  };
  agents: Record<AgentName, { enabled: boolean }>;
  known_capabilities: KnownCapability[];
  known_projects?: KnownProject[];
  local_salt: string;
};
