import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;
const COPILOT_HOOK_EVENTS = ["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"] as const;
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
      case "copilot":
        return setupCopilot(options);
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
    const fallbackCliPath = resolveFallbackCliPath(options);

    const existingHooks = await readJsonFile(hooksJsonPath);
    const mergedHooks = mergeCodexHooks(existingHooks, hookCommand);
    const existingConfig = await readTextFile(configTomlPath);
    const configToml = ensureCodexHooksFeature(existingConfig ?? "");
    const helperScript = createHelperScript(fallbackCliPath);
    const otherConfiguredScope = await findOtherConfiguredScope(scope, options);

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
        ...(otherConfiguredScope
          ? [
            "",
            `[warn] Himan Codex hooks are also configured in ${otherConfiguredScope} scope. Keep one scope enabled to avoid duplicate hook execution.`,
          ]
          : []),
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

async function setupCopilot(
  options: SetupCommandOptions,
): Promise<SetupCommandResult> {
  try {
    const cwd = options.cwd ?? process.cwd();
    const hooksDir = path.join(cwd, ".github", "hooks");
    const scriptsDir = path.join(hooksDir, "scripts");
    const hooksJsonPath = path.join(hooksDir, "himan-tracker.json");
    const helperPath = path.join(scriptsDir, "himan-tracker-collect.sh");
    const hookCommand = shellQuote(helperPath);
    const collectorCommand = "himan-tracker collect --agent copilot --sync --quiet";
    const fallbackCliPath = resolveFallbackCliPath(options);

    const existingHooks = await readJsonFile(hooksJsonPath);
    const mergedHooks = mergeCopilotHooks(existingHooks, hookCommand);
    const helperScript = createCopilotHelperScript(fallbackCliPath);

    if (!options.dryRun) {
      await mkdir(scriptsDir, { recursive: true, mode: 0o700 });
      await writeFile(helperPath, helperScript, { encoding: "utf8", mode: 0o700 });
      await chmod(helperPath, 0o700);
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
        "Agent: copilot",
        "Mode: project-level hooks",
        `Mode: ${options.dryRun ? "dry-run" : "write"}`,
        `Hooks config: ${hooksJsonPath}`,
        `Hook helper: ${helperPath}`,
        `Hook events: ${COPILOT_HOOK_EVENTS.join(", ")}`,
        `Collector command: ${collectorCommand}`,
        "",
        "Next steps:",
        "1. Restart Copilot so it reloads hooks.",
        "2. Run a Copilot session that uses tools.",
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

async function findOtherConfiguredScope(
  scope: "global" | "project",
  options: SetupCommandOptions,
): Promise<"global" | "project" | null> {
  const otherScope = scope === "global" ? "project" : "global";
  const codexDir =
    otherScope === "global"
      ? path.join(options.homeDir ?? homedir(), ".codex")
      : path.join(options.cwd ?? process.cwd(), ".codex");

  return (await hasEnabledHimanCodexHooks(codexDir)) ? otherScope : null;
}

async function hasEnabledHimanCodexHooks(codexDir: string): Promise<boolean> {
  const [configToml, hooksJson] = await Promise.all([
    readTextFile(path.join(codexDir, "config.toml")),
    readTextFile(path.join(codexDir, "hooks.json")),
  ]);

  return Boolean(
    configToml &&
    hooksJson &&
    isCodexHooksFeatureEnabled(configToml) &&
    hooksJson.includes("himan-tracker-collect.sh"),
  );
}

function isCodexHooksFeatureEnabled(configToml: string): boolean {
  return (
    /(^|\n)\s*hooks\s*=\s*true\s*(\n|$)/.test(configToml) ||
    /(^|\n)\s*codex_hooks\s*=\s*true\s*(\n|$)/.test(configToml)
  );
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

function resolveFallbackCliPath(options: SetupCommandOptions): string {
  const cliPathFromCompiledModule = path.normalize(
    fileURLToPath(new URL("../index.js", import.meta.url)),
  );

  if (
    cliPathFromCompiledModule.includes(`${path.sep}dist${path.sep}cli${path.sep}index.js`)
  ) {
    return cliPathFromCompiledModule;
  }

  return path.join(options.cwd ?? process.cwd(), "dist", "cli", "index.js");
}

// ── Copilot hook helpers ──

type CopilotHooksFile = {
  version: number;
  hooks: Record<string, JsonObject[]>;
};

function mergeCopilotHooks(existingHooks: unknown, hookCommand: string): CopilotHooksFile {
  const hooksFile = normalizeCopilotHooksFile(existingHooks);

  for (const eventName of COPILOT_HOOK_EVENTS) {
    const eventGroups = hooksFile.hooks[eventName] ?? [];
    if (!hasCopilotHookCommand(eventGroups, hookCommand)) {
      eventGroups.push(createCopilotHookEntry(hookCommand));
    }
    hooksFile.hooks[eventName] = eventGroups;
  }

  return hooksFile;
}

function normalizeCopilotHooksFile(existingHooks: unknown): CopilotHooksFile {
  if (existingHooks === null) {
    return { version: 1, hooks: {} };
  }

  if (!isRecord(existingHooks)) {
    throw new Error("Existing hooks file must be a JSON object");
  }

  const version = typeof existingHooks.version === "number" ? existingHooks.version : 1;
  const hooks = existingHooks.hooks;

  if (hooks === undefined) {
    return { version, hooks: {} };
  }

  if (!isRecord(hooks)) {
    throw new Error("Existing hooks file field `hooks` must be a JSON object");
  }

  const normalizedHooks: Record<string, JsonObject[]> = {};
  for (const [eventName, eventGroups] of Object.entries(hooks)) {
    if (!Array.isArray(eventGroups) || !eventGroups.every(isRecord)) {
      throw new Error(
        `Existing hooks file event ${eventName} must be an array of objects`,
      );
    }
    normalizedHooks[eventName] = eventGroups;
  }

  return { version, hooks: normalizedHooks };
}

function createCopilotHookEntry(hookCommand: string): JsonObject {
  return {
    type: "command",
    bash: hookCommand,
    timeoutSec: HOOK_TIMEOUT_SECONDS,
  };
}

function hasCopilotHookCommand(
  eventGroups: JsonObject[],
  hookCommand: string,
): boolean {
  return eventGroups.some((group) => {
    if (isRecord(group)) {
      const bash = group.bash;
      const command = group.command;
      if (typeof bash === "string" && bash === hookCommand) return true;
      if (typeof command === "string" && command === hookCommand) return true;
    }
    return false;
  });
}

function createCopilotHelperScript(fallbackCliPath: string): string {
  return `#!/usr/bin/env sh
# Generated by himan-tracker. This script must never block Copilot.
# Reads hook JSON from stdin and forwards to himan-tracker.

if command -v himan-tracker >/dev/null 2>&1; then
  himan-tracker collect --agent copilot --sync --quiet
  exit 0
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

TRACKER_DIST_CLI=${shellQuote(fallbackCliPath)}
if [ -n "$NODE_BIN" ] && [ -f "$TRACKER_DIST_CLI" ]; then
  "$NODE_BIN" "$TRACKER_DIST_CLI" collect --agent copilot --sync --quiet
fi
exit 0
`;
}

function createHelperScript(fallbackCliPath: string): string {
  return `#!/usr/bin/env sh
# Generated by himan-tracker. This script must never block Codex.

if command -v himan-tracker >/dev/null 2>&1; then
  himan-tracker collect --agent codex --quiet >/dev/null 2>&1
  exit 0
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
  NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
fi

TRACKER_DIST_CLI=${shellQuote(fallbackCliPath)}
if [ -n "$NODE_BIN" ] && [ -f "$TRACKER_DIST_CLI" ]; then
  "$NODE_BIN" "$TRACKER_DIST_CLI" collect --agent codex --quiet >/dev/null 2>&1
fi
exit 0
`;
}

function resolveSetupAgent(agent: string | undefined): "codex" | "copilot" {
  const resolvedAgent = agent ?? "codex";
  if (resolvedAgent === "codex" || resolvedAgent === "copilot") {
    return resolvedAgent;
  }

  throw new Error(`Unsupported setup agent "${resolvedAgent}". Currently "codex" and "copilot" are supported.`);
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
