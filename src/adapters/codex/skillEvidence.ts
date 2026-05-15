import path from "node:path";

import { readNearestHimanLockSkillNames } from "../himan/lockfile.js";

type RawRecord = Record<string, unknown>;

export type HimanLockSkillCache = Map<string, Promise<Set<string> | null>>;

type SkillPathEvidence = {
  skillName: string;
  candidateDirs: string[];
};

const SKILL_NAME_SOURCE = "[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*";
const SKILL_NAME_PATTERN = new RegExp(`^${SKILL_NAME_SOURCE}$`);
const EXPLICIT_SKILL_PATTERN = new RegExp(
  `(?:^|[\\s([\\\`"'，。！？；：])\\$(${SKILL_NAME_SOURCE})\\b`,
  "g",
);
const PLACEHOLDER_SKILL_NAMES = new Set(["skill-name"]);
const SKILL_PATH_PATTERNS = [
  new RegExp(
    `(?:^|[^A-Za-z0-9_-])(?:\\.agents\\/skills|\\.codex\\/skills(?:\\/[^/\\s"']+)?|skills)\\/(${SKILL_NAME_SOURCE})\\/SKILL\\.md\\b`,
    "g",
  ),
  new RegExp(
    `\\/(?:\\.agents\\/skills|\\.codex\\/skills(?:\\/[^/\\s"']+)?|skills)\\/(${SKILL_NAME_SOURCE})\\/SKILL\\.md\\b`,
    "g",
  ),
  new RegExp(`\\/skill\\/(${SKILL_NAME_SOURCE})\\/[^/\\s"']+\\/SKILL\\.md\\b`, "g"),
];
const PROJECT_SKILL_ROOT_MARKERS = ["/.agents/skills/", "/.codex/skills/"];
const ABSOLUTE_PATH_PATTERN = /\/[^\s"')]+/g;

export function extractExplicitSkillNames(message: string | undefined): string[] {
  if (!message) {
    return [];
  }

  const skills = new Set<string>();
  EXPLICIT_SKILL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_SKILL_PATTERN.exec(message)) !== null) {
    const skillName = match[1];
    if (
      skillName &&
      SKILL_NAME_PATTERN.test(skillName) &&
      !PLACEHOLDER_SKILL_NAMES.has(skillName)
    ) {
      skills.add(skillName);
    }
  }

  return [...skills];
}

export async function extractSkillNamesFromToolCall(
  payload: RawRecord,
  himanLockSkillCache: HimanLockSkillCache,
): Promise<string[]> {
  const toolName = getString(payload.name);
  if (!isShellToolName(toolName)) {
    return [];
  }

  const argumentStrings = collectToolArgumentStrings(payload);
  if (!argumentStrings.some((value) => value.includes("SKILL.md"))) {
    return [];
  }

  const skills = new Set<string>();
  for (const evidence of collectSkillPathEvidence(argumentStrings)) {
    if (await isSkillAllowedByHimanLock(evidence, himanLockSkillCache)) {
      skills.add(evidence.skillName);
    }
  }

  return [...skills];
}

function isShellToolName(toolName: string | undefined): boolean {
  return (
    toolName === "exec_command" ||
    toolName === "functions.exec_command" ||
    toolName === "shell_command" ||
    toolName === "bash" ||
    toolName === "Bash"
  );
}

function collectToolArgumentStrings(payload: RawRecord): string[] {
  const values = new Set<string>();
  collectArgumentValueStrings(payload.arguments, values);
  collectArgumentValueStrings(payload.input, values);
  return [...values];
}

function collectArgumentValueStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    output.add(value);
    try {
      collectStringValues(JSON.parse(value) as unknown, output);
    } catch {
      // Plain shell snippets are expected.
    }
    return;
  }

  collectStringValues(value, output);
}

function collectStringValues(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    output.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output);
    }
    return;
  }

  const record = getRecord(value);
  if (!record) {
    return;
  }

  for (const item of Object.values(record)) {
    collectStringValues(item, output);
  }
}

function collectSkillPathEvidence(argumentStrings: string[]): SkillPathEvidence[] {
  const fallbackCandidateDirs = collectFallbackCandidateDirs(argumentStrings);
  const evidenceBySkill = new Map<string, Set<string>>();

  for (const text of argumentStrings) {
    const skillNames = extractSkillNamesFromSkillPaths(text);
    if (skillNames.length === 0) {
      continue;
    }

    const rootCandidates = extractProjectRootCandidatesFromSkillPaths(text);
    for (const skillName of skillNames) {
      const candidateDirs = evidenceBySkill.get(skillName) ?? new Set<string>();
      for (const rootCandidate of rootCandidates) {
        candidateDirs.add(rootCandidate);
      }
      for (const fallbackCandidateDir of fallbackCandidateDirs) {
        candidateDirs.add(fallbackCandidateDir);
      }
      evidenceBySkill.set(skillName, candidateDirs);
    }
  }

  return [...evidenceBySkill].map(([skillName, candidateDirs]) => ({
    skillName,
    candidateDirs: [...candidateDirs],
  }));
}

function extractSkillNamesFromSkillPaths(text: string): string[] {
  const skills = new Set<string>();

  for (const pattern of SKILL_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const skillName = match[1];
      if (skillName && SKILL_NAME_PATTERN.test(skillName)) {
        skills.add(skillName);
      }
    }
  }

  return [...skills];
}

function extractProjectRootCandidatesFromSkillPaths(text: string): string[] {
  const roots = new Set<string>();
  const pathMatches = text.matchAll(ABSOLUTE_PATH_PATTERN);

  for (const match of pathMatches) {
    const candidatePath = trimPathCandidate(match[0] ?? "");
    if (!isLocalAbsolutePath(candidatePath)) {
      continue;
    }

    for (const marker of PROJECT_SKILL_ROOT_MARKERS) {
      const markerIndex = candidatePath.indexOf(marker);
      if (markerIndex > 0) {
        roots.add(candidatePath.slice(0, markerIndex));
      }
    }
  }

  return [...roots];
}

function collectFallbackCandidateDirs(argumentStrings: string[]): string[] {
  const candidates = new Set<string>();

  for (const text of argumentStrings) {
    for (const match of text.matchAll(ABSOLUTE_PATH_PATTERN)) {
      const candidatePath = trimPathCandidate(match[0] ?? "");
      if (isLocalAbsolutePath(candidatePath) && !candidatePath.includes("SKILL.md")) {
        candidates.add(candidatePath);
      }
    }
  }

  return [...candidates];
}

async function isSkillAllowedByHimanLock(
  evidence: SkillPathEvidence,
  himanLockSkillCache: HimanLockSkillCache,
): Promise<boolean> {
  if (evidence.candidateDirs.length === 0) {
    return true;
  }

  let foundHimanLock = false;
  for (const candidateDir of evidence.candidateDirs) {
    const skills = await readHimanLockSkills(candidateDir, himanLockSkillCache);
    if (!skills) {
      continue;
    }

    foundHimanLock = true;
    if (skills.has(evidence.skillName)) {
      return true;
    }
  }

  return !foundHimanLock;
}

function readHimanLockSkills(
  candidateDir: string,
  himanLockSkillCache: HimanLockSkillCache,
): Promise<Set<string> | null> {
  const cacheKey = path.resolve(candidateDir);
  const cached = himanLockSkillCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const skills = readNearestHimanLockSkillNames({
    startDir: cacheKey,
    agent: "codex",
  });
  himanLockSkillCache.set(cacheKey, skills);
  return skills;
}

function trimPathCandidate(candidatePath: string): string {
  return candidatePath.replace(/[.,;:]+$/g, "");
}

function isLocalAbsolutePath(candidatePath: string): boolean {
  return path.isAbsolute(candidatePath) && !candidatePath.startsWith("//");
}

function getRecord(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
