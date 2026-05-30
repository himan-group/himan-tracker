import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AdapterEvent } from "../types/events.js";
import type { KnownProject, UserConfig } from "../types/config.js";
import type { TrackerPaths } from "./paths.js";
import { writeUserConfig } from "./userConfig.js";
import { hashRepoPath } from "../normalizer/privacy.js";

const MAX_DISPLAY_NAME_LENGTH = 120;

export function createKnownProjectDisplayNameMap(config: UserConfig): Map<string, string> {
  return new Map((config.known_projects ?? []).map((project) => [project.repo_hash, project.display_name]));
}

export async function learnKnownProjectsFromAdapterEvents(options: {
  paths: TrackerPaths;
  config: UserConfig;
  events: AdapterEvent[];
  persist: boolean;
}): Promise<void> {
  if (!options.persist) {
    return;
  }

  const nextProjects = new Map(
    (options.config.known_projects ?? []).map((project) => [project.repo_hash, project]),
  );
  let changed = false;

  for (const event of options.events) {
    const repoHash = resolveRepoHash(event, options.config);
    if (!repoHash || nextProjects.has(repoHash)) {
      continue;
    }

    const display = await resolveDisplayName(event.repo_path ?? null);
    if (!display) {
      continue;
    }

    nextProjects.set(repoHash, {
      repo_hash: repoHash,
      display_name: display.name,
      source: display.source,
    });
    changed = true;
  }

  if (!changed) {
    return;
  }

  options.config.known_projects = [...nextProjects.values()].sort(compareKnownProjects);
  await writeUserConfig(options.paths, options.config);
}

function resolveRepoHash(event: AdapterEvent, config: UserConfig): string | null {
  if (event.repo_hash) {
    return event.repo_hash;
  }

  if (!event.repo_path || !config.privacy.hash_repo_path) {
    return null;
  }

  return hashRepoPath(event.repo_path, config.local_salt);
}

async function resolveDisplayName(repoPath: string | null): Promise<{
  name: string;
  source: KnownProject["source"];
} | null> {
  if (!repoPath) {
    return null;
  }

  const normalizedRepoPath = path.resolve(repoPath);
  const packageName = await readPackageName(normalizedRepoPath);
  if (packageName) {
    return {
      name: packageName,
      source: "package_name",
    };
  }

  const folderName = sanitizeDisplayName(path.basename(normalizedRepoPath));
  if (!folderName) {
    return null;
  }

  return {
    name: folderName,
    source: "folder_name",
  };
}

async function readPackageName(repoPath: string): Promise<string | null> {
  try {
    const rawPackage = await readFile(path.join(repoPath, "package.json"), "utf8");
    const parsed = JSON.parse(rawPackage) as { name?: unknown };
    return sanitizeDisplayName(parsed.name);
  } catch {
    return null;
  }
}

function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function compareKnownProjects(left: KnownProject, right: KnownProject): number {
  const displayNameOrder = left.display_name.localeCompare(right.display_name);
  if (displayNameOrder !== 0) {
    return displayNameOrder;
  }

  return left.repo_hash.localeCompare(right.repo_hash);
}
