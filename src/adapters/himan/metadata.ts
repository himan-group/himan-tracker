import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type RawRecord = Record<string, unknown>;

export type SkillMetadataDependency = {
  type: "skill" | "mcp_tool" | "script";
  name: string | null;
  path: string | null;
};

export type SkillDefinitionMetadata = {
  id: string;
  name: string;
  version: string | null;
  entry: string;
  description: string | null;
  agents: string[];
  contentHash: string | null;
  staticEntryTokens: number | null;
  staticPackageTokens: number | null;
  tokenizer: string | null;
  tokenEstimator: string | null;
  measuredAt: string | null;
  measuredBy: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
  sourcePathHash: string;
  discoveredAt: string;
  dependencies: SkillMetadataDependency[];
};

export type SkillMetadataIssue = {
  id: string;
  capabilityName: string;
  version: string | null;
  contentHash: string | null;
  issueType: "invalid_shape" | "name_mismatch";
  severity: "warning" | "error";
  message: string;
  detectedAt: string;
};

export type DiscoverSkillMetadataResult = {
  definitions: SkillDefinitionMetadata[];
  issues: SkillMetadataIssue[];
};

type YamlValue = RawRecord | unknown[] | string | number | boolean | null;

const SKILL_ROOTS = [".agents/skills", ".codex/skills"] as const;

export async function discoverSkillMetadata(options: {
  roots: string[];
  now?: () => Date;
}): Promise<DiscoverSkillMetadataResult> {
  const discoveredAt = (options.now ?? (() => new Date()))().toISOString();
  const definitions: SkillDefinitionMetadata[] = [];
  const issues: SkillMetadataIssue[] = [];
  const seenManifestPaths = new Set<string>();

  for (const root of options.roots) {
    for (const manifestPath of await discoverHimanYamlPaths(root)) {
      const resolvedManifestPath = path.resolve(manifestPath);
      if (seenManifestPaths.has(resolvedManifestPath)) {
        continue;
      }
      seenManifestPaths.add(resolvedManifestPath);

      try {
        const rawManifest = await readFile(resolvedManifestPath, "utf8");
        const parsed = parseSimpleYaml(rawManifest);
        const definition = normalizeSkillDefinition({
          parsed,
          manifestPath: resolvedManifestPath,
          discoveredAt,
        });
        definitions.push(definition);

        const folderName = path.basename(path.dirname(resolvedManifestPath));
        if (definition.name !== folderName) {
          issues.push(
            createIssue({
              definition,
              issueType: "name_mismatch",
              severity: "warning",
              message: "himan.yaml name does not match the skill folder name",
              detectedAt: discoveredAt,
            }),
          );
        }
      } catch (error) {
        const capabilityName = path.basename(path.dirname(resolvedManifestPath));
        issues.push({
          id: hashParts(["metadata-issue", resolvedManifestPath, getErrorMessage(error)]),
          capabilityName,
          version: null,
          contentHash: null,
          issueType: "invalid_shape",
          severity: "error",
          message: getErrorMessage(error),
          detectedAt: discoveredAt,
        });
      }
    }
  }

  return { definitions, issues };
}

async function discoverHimanYamlPaths(root: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const manifestPaths: string[] = [];

  if (path.basename(resolvedRoot) === "himan.yaml") {
    return [resolvedRoot];
  }

  for (const skillRoot of SKILL_ROOTS) {
    const skillRootPath = path.join(resolvedRoot, skillRoot);
    for (const skillDir of await listChildDirectories(skillRootPath)) {
      manifestPaths.push(path.join(skillDir, "himan.yaml"));
    }
  }

  if (path.basename(path.dirname(resolvedRoot)) === "skills") {
    manifestPaths.push(path.join(resolvedRoot, "himan.yaml"));
  }

  return manifestPaths;
}

async function listChildDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function normalizeSkillDefinition(options: {
  parsed: RawRecord;
  manifestPath: string;
  discoveredAt: string;
}): SkillDefinitionMetadata {
  const name = getString(options.parsed.name);
  if (!name) {
    throw new Error("Expected himan.yaml to include name");
  }

  if (getString(options.parsed.type) !== "skill") {
    throw new Error("Expected himan.yaml type to be skill");
  }

  const analysis = getRecord(options.parsed.analysis);
  const content = getRecord(analysis?.content);
  const dependencies = getRecord(analysis?.dependencies);
  const generation = getRecord(analysis?.generation);
  const contentHash = getString(content?.contentHash) ?? null;
  const version = getString(options.parsed.version) ?? null;
  const sourcePathHash = hashParts(["path", options.manifestPath]);

  const definition: SkillDefinitionMetadata = {
    id: hashParts(["skill", name, version ?? "", contentHash ?? "", sourcePathHash]),
    name,
    version,
    entry: getString(options.parsed.entry) ?? "SKILL.md",
    description: getString(options.parsed.description) ?? null,
    agents: getStringArray(options.parsed.agents),
    contentHash,
    staticEntryTokens: getNonNegativeInteger(content?.entryTokens),
    staticPackageTokens: getNonNegativeInteger(content?.packageTokens),
    tokenizer: getString(content?.tokenizer) ?? null,
    tokenEstimator: getString(content?.tokenEstimator) ?? null,
    measuredAt: getString(content?.measuredAt) ?? null,
    measuredBy: getString(content?.measuredBy) ?? null,
    generatedAt: getString(generation?.generatedAt) ?? null,
    generatedBy: getString(generation?.generatedBy) ?? null,
    sourcePathHash,
    discoveredAt: options.discoveredAt,
    dependencies: [],
  };

  definition.dependencies = [
    ...getStringArray(dependencies?.skills).map<SkillMetadataDependency>((skillName) => ({
      type: "skill",
      name: skillName,
      path: null,
    })),
    ...getStringArray(dependencies?.mcpTools).map<SkillMetadataDependency>((toolName) => ({
      type: "mcp_tool",
      name: toolName,
      path: null,
    })),
    ...getScriptDependencies(dependencies?.scripts),
  ];

  return definition;
}

function getScriptDependencies(value: unknown): SkillMetadataDependency[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => getRecord(item))
    .map((item) => getString(item?.path))
    .filter((scriptPath): scriptPath is string => Boolean(scriptPath))
    .map((scriptPath) => ({
      type: "script",
      name: null,
      path: scriptPath,
    }));
}

function parseSimpleYaml(raw: string): RawRecord {
  const root: RawRecord = {};
  const lines = raw.split(/\r?\n/);
  const stack: Array<{ indent: number; value: RawRecord | unknown[] }> = [
    { indent: -1, value: root },
  ];
  let lastScalar:
    | {
        indent: number;
        key: string;
        parent: RawRecord;
      }
    | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const arrayItem = /^-\s+(.*)$/.exec(line);
    if (arrayItem) {
      lastScalar = null;
      const parent = stack[stack.length - 1]!.value;
      if (!Array.isArray(parent)) {
        continue;
      }

      const itemText = arrayItem[1] ?? "";
      const inlineRecord = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(itemText);
      if (inlineRecord) {
        const record: RawRecord = {
          [inlineRecord[1] ?? ""]: parseYamlScalar(inlineRecord[2] ?? ""),
        };
        parent.push(record);
        stack.push({ indent, value: record });
      } else {
        parent.push(parseYamlScalar(itemText));
      }
      continue;
    }

    const keyValue = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (keyValue) {
      const key = keyValue[1] ?? "";
      const valueText = keyValue[2] ?? "";
      const parent = stack[stack.length - 1]!.value;
      if (Array.isArray(parent)) {
        lastScalar = null;
        continue;
      }

      if (valueText.length === 0) {
        const nested = nextSignificantLineIsArray(lines, index) ? [] : {};
        parent[key] = nested;
        stack.push({ indent, value: nested });
        lastScalar = null;
      } else {
        parent[key] = parseYamlScalar(valueText);
        lastScalar = { indent, key, parent };
      }
      continue;
    }

    if (lastScalar && indent > lastScalar.indent) {
      const previousValue = lastScalar.parent[lastScalar.key];
      if (typeof previousValue === "string") {
        lastScalar.parent[lastScalar.key] = `${previousValue} ${line}`;
      }
    }
  }

  return root;
}

function nextSignificantLineIsArray(lines: string[], index: number): boolean {
  for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
    const line = lines[nextIndex]?.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    return line.startsWith("- ");
  }

  return false;
}

function parseYamlScalar(value: string): YamlValue {
  const trimmed = value.trim();
  if (trimmed === "[]" || trimmed === "") {
    return [];
  }
  if (trimmed === "null") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function createIssue(options: {
  definition: SkillDefinitionMetadata;
  issueType: SkillMetadataIssue["issueType"];
  severity: SkillMetadataIssue["severity"];
  message: string;
  detectedAt: string;
}): SkillMetadataIssue {
  return {
    id: hashParts([
      "metadata-issue",
      options.definition.id,
      options.issueType,
      options.message,
    ]),
    capabilityName: options.definition.name,
    version: options.definition.version,
    contentHash: options.definition.contentHash,
    issueType: options.issueType,
    severity: options.severity,
    message: options.message,
    detectedAt: options.detectedAt,
  };
}

function hashParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function getRecord(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function getNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
