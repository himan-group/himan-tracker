import { createHash } from "node:crypto";
import path from "node:path";

export function hashRepoPath(repoPath: string, localSalt: string): string {
  const normalizedPath = normalizeRepoPath(repoPath);
  return createHash("sha256").update(`${normalizedPath}:${localSalt}`).digest("hex");
}

export function normalizeRepoPath(repoPath: string): string {
  return path.resolve(repoPath).replaceAll(path.sep, "/");
}
