import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentName } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export async function readNearestHimanLockSkillNames(options: {
  startDir: string;
  agent: AgentName;
}): Promise<Set<string> | null> {
  const rawLock = await readNearestHimanLock(options.startDir);
  if (!rawLock) {
    return null;
  }

  try {
    return parseHimanLockSkillNames(rawLock, options.agent);
  } catch {
    return null;
  }
}

async function readNearestHimanLock(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const lockPath = path.join(currentDir, "himan.lock");
    try {
      return await readFile(lockPath, "utf8");
    } catch {
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        return null;
      }
      currentDir = parentDir;
    }
  }
}

function parseHimanLockSkillNames(raw: string, agent: AgentName): Set<string> {
  const parsed = JSON.parse(raw) as unknown;
  const lock = getRecord(parsed);
  const resources = Array.isArray(lock?.resources) ? lock.resources : [];
  const skills = new Set<string>();

  for (const resource of resources) {
    const record = getRecord(resource);
    const name = getString(record?.name);
    if (!record || record.type !== "skill" || !name || !matchesAgent(record, agent)) {
      continue;
    }
    skills.add(name);
  }

  return skills;
}

function matchesAgent(resource: RawRecord, agent: AgentName): boolean {
  const agents = getStringArray(resource.agents);
  if (agents.length > 0) {
    return agents.includes(agent);
  }

  const singleAgent = getString(resource.agent);
  return singleAgent ? singleAgent === agent : true;
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
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
