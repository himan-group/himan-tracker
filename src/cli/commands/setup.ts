import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;
const HOOK_TIMEOUT_SECONDS = 5;

export type SetupCommandOptions = {
  agent?: string;
  global?: boolean;
  dryRun?: boolean;
  cwd?: string;
  homeDir?: string;
};

export type SetupCommandResult = {
  ok: boolean;
  exitCode: number;
  lines: string[];
};

type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

type JsonObject = Record<string, unknown>;

type CodexHooksFile = {
  hooks: Record<string, JsonObject[]>;
};

export async function runSetup(
  options: SetupCommandOptions = {},
): Promise<SetupCommandResult> {
  try {
    const agent = resolveSetupAgent(options.agent);

    switch (agent) {
      case "codex":
        return setupCodex(options);
    }
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      lines: ["himan-tracker setup", "", `[fail] ${getErrorMessage(error)}`],
    };
  }
}

async function setupCodex(
  options: SetupCommandOptions,
): Promise<SetupCommandResult> {
  try {
    const scope = options.global ? "global" : "project";
    const codexDir =
      scope === "global"
        ? path.join(options.homeDir ?? homedir(), ".codex")
        : path.join(options.cwd ?? process.cwd(), ".codex");
    const helperPath = path.join(codexDir, "hooks", "himan-tracker-collect.sh");
    const hooksJsonPath = path.join(codexDir, "hooks.json");
    const configTomlPath = path.join(codexDir, "config.toml");
    const hookCommand = shellQuote(helperPath);
    const collectorCommand = "himan-tracker collect --agent codex --quiet";

    const existingHooks = await readJsonFile(hooksJsonPath);
    const mergedHooks = mergeCodexHooks(existingHooks, hookCommand);
    const existingConfig = await readTextFile(configTomlPath);
    const configToml = ensureCodexHooksFeature(existingConfig ?? "");
    const helperScript = createHelperScript();

    if (!options.dryRun) {
      await mkdir(path.dirname(helperPath), { recursive: true, mode: 0o700 });
      await writeFile(helperPath, helperScript, { encoding: "utf8", mode: 0o700 });
      await chmod(helperPath, 0o700);
      await writeFile(configTomlPath, configToml, { encoding: "utf8", mode: 0o600 });
      await writeFile(hooksJsonPath, `${JSON.stringify(mergedHooks, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    return {
      ok: true,
      exitCode: 0,
      lines: [
        "himan-tracker setup",
        "",
        "Agent: codex",
        `Scope: ${scope}`,
        `Mode: ${options.dryRun ? "dry-run" : "write"}`,
        `Codex config: ${configTomlPath}`,
        `Codex hooks: ${hooksJsonPath}`,
        `Hook helper: ${helperPath}`,
        `Hook events: ${CODEX_HOOK_EVENTS.join(", ")}`,
        `Collector command: ${collectorCommand}`,
        "",
        "Next steps:",
        "1. Restart Codex so it reloads hooks.",
        "2. Run a Codex turn that uses a tool.",
        "3. Run `himan-tracker ingest` and then `himan-tracker summary --since 7d`.",
      ],
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      lines: ["himan-tracker setup", "", `[fail] ${getErrorMessage(error)}`],
    };
  }
}

function mergeCodexHooks(existingHooks: unknown, hookCommand: string): CodexHooksFile {
  const hooksFile = normalizeHooksFile(existingHooks);

  for (const eventName of CODEX_HOOK_EVENTS) {
    const eventGroups = hooksFile.hooks[eventName] ?? [];
    if (!hasHookCommand(eventGroups, hookCommand)) {
      eventGroups.push(createHookGroup(eventName, hookCommand));
    }
    hooksFile.hooks[eventName] = eventGroups;
  }

  return hooksFile;
}

function normalizeHooksFile(existingHooks: unknown): CodexHooksFile {
  if (existingHooks === null) {
    return { hooks: {} };
  }

  if (!isRecord(existingHooks)) {
    throw new Error("Existing hooks.json must be a JSON object");
  }

  const hooks = existingHooks.hooks;
  if (hooks === undefined) {
    return { ...existingHooks, hooks: {} } as CodexHooksFile;
  }

  if (!isRecord(hooks)) {
    throw new Error("Existing hooks.json field `hooks` must be a JSON object");
  }

  const normalizedHooks: Record<string, JsonObject[]> = {};
  for (const [eventName, eventGroups] of Object.entries(hooks)) {
    if (!Array.isArray(eventGroups) || !eventGroups.every(isRecord)) {
      throw new Error(`Existing hooks.json event ${eventName} must be an array of objects`);
    }
    normalizedHooks[eventName] = eventGroups;
  }

  return {
    ...existingHooks,
    hooks: normalizedHooks,
  } as CodexHooksFile;
}

function createHookGroup(eventName: CodexHookEvent, hookCommand: string): JsonObject {
  return {
    hooks: [
      {
        type: "command",
        command: hookCommand,
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
    ...(eventName === "PostToolUse" ? { matcher: "*" } : {}),
  };
}

function hasHookCommand(eventGroups: JsonObject[], hookCommand: string): boolean {
  return eventGroups.some((group) => {
    const hooks = group.hooks;
    return (
      Array.isArray(hooks) &&
      hooks.some((hook) => isRecord(hook) && hook.command === hookCommand)
    );
  });
}

function ensureCodexHooksFeature(configToml: string): string {
  const normalizedConfig = expandInlineCodexHooksFeature(configToml).trimEnd();
  const featuresMatch = normalizedConfig.match(/^(\s*)\[features\]\s*$/m);

  if (!featuresMatch || featuresMatch.index === undefined) {
    return appendBlock(normalizedConfig, "[features]\nhooks = true\n");
  }

  const sectionStart = featuresMatch.index;
  const afterHeaderStart = sectionStart + featuresMatch[0].length;
  const nextSectionMatch = normalizedConfig.slice(afterHeaderStart).match(/\n\s*\[[^\]]+\]\s*$/m);
  const sectionEnd =
    nextSectionMatch?.index === undefined
      ? normalizedConfig.length
      : afterHeaderStart + nextSectionMatch.index;
  const beforeSection = normalizedConfig.slice(0, afterHeaderStart);
  const sectionBody = removeDeprecatedCodexHooksFeature(
    normalizedConfig.slice(afterHeaderStart, sectionEnd),
  );
  const afterSection = normalizedConfig.slice(sectionEnd);

  if (/^[ \t]*hooks[ \t]*=/m.test(sectionBody)) {
    return `${beforeSection}${sectionBody.replace(
      /^([ \t]*)hooks[ \t]*=.*$/m,
      "$1hooks = true",
    )}${afterSection}\n`;
  }

  return `${beforeSection}\nhooks = true${sectionBody}${afterSection}\n`;
}

function expandInlineCodexHooksFeature(configToml: string): string {
  return configToml.replace(
    /^(\s*)\[features\]\s+(?:codex_hooks|hooks)\s*=.*$/m,
    "$1[features]\n$1hooks = true",
  );
}

function removeDeprecatedCodexHooksFeature(sectionBody: string): string {
  return sectionBody.replace(/^[ \t]*codex_hooks[ \t]*=.*(?:\r?\n)?/gm, "");
}

function appendBlock(configToml: string, block: string): string {
  return configToml.length === 0 ? block : `${configToml}\n\n${block}`;
}

function createHelperScript(): string {
  return `#!/usr/bin/env sh
# Generated by himan-tracker. This script must never block Codex.

if command -v himan-tracker >/dev/null 2>&1; then
  himan-tracker collect --agent codex --quiet >/dev/null 2>&1
fi
exit 0
`;
}

function resolveSetupAgent(agent: string | undefined): "codex" {
  const resolvedAgent = agent ?? "codex";
  if (resolvedAgent === "codex") {
    return resolvedAgent;
  }

  throw new Error(`Unsupported setup agent "${resolvedAgent}". Currently only "codex" is supported.`);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const content = await readTextFile(filePath);
  if (content === null) {
    return null;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${getErrorMessage(error)}`);
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
