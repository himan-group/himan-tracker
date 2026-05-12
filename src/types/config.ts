import type { AgentName, CapabilityType } from "./events.js";

export type KnownCapability = {
  type: CapabilityType;
  name: string;
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
  local_salt: string;
};
