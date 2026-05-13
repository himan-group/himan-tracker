#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const packagePath = new URL("../package.json", import.meta.url);
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const version = String(packageJson.version ?? "").trim();

if (!version) {
  fail("package.json must contain a version");
}

const changelog = await readFile(changelogPath, "utf8");
const unreleasedMatch = /^## \[Unreleased\][^\n]*\n?/m.exec(changelog);

if (!unreleasedMatch) {
  fail("CHANGELOG.md must contain a ## [Unreleased] section");
}

const versionHeadingPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|-|$)`, "m");

if (versionHeadingPattern.test(changelog)) {
  fail(`CHANGELOG.md already contains a ## [${version}] section`);
}

const bodyStart = unreleasedMatch.index + unreleasedMatch[0].length;
const afterUnreleased = changelog.slice(bodyStart);
const nextHeadingMatch = /^## \[/m.exec(afterUnreleased);
const bodyEnd = nextHeadingMatch ? bodyStart + nextHeadingMatch.index : changelog.length;
const unreleasedBody = changelog.slice(bodyStart, bodyEnd).trim();

if (!unreleasedBody) {
  fail("CHANGELOG.md [Unreleased] section has no release notes to move");
}

const today = formatLocalDate(new Date());
const before = changelog.slice(0, unreleasedMatch.index);
const after = changelog.slice(bodyEnd).replace(/^\n+/, "");
const releasedSection = `## [Unreleased]\n\n## [${version}] - ${today}\n\n${unreleasedBody}\n\n`;

await writeFile(changelogPath, `${before}${releasedSection}${after}`, "utf8");
console.log(`Moved CHANGELOG.md [Unreleased] entries to [${version}] - ${today}`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatLocalDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
