---
name: common-project-changelog
description: Maintain project CHANGELOG.md and package version history correctly. Use for user-visible CLI behavior changes, new commands/options, direct CHANGELOG.md edits, moving Unreleased entries into a release, package version bumps, release notes, or changelog placement fixes.
---

# common-project-changelog

Use this skill whenever project changelog or package version metadata is edited, and proactively for user-visible CLI behavior changes such as new commands, new options, changed output, install/publish workflow changes, or error behavior changes.

## Missing Changelog Rule

If `CHANGELOG.md` does not exist and the repository has user-visible behavior, a package version, a CLI/API surface, or an expected release flow, create it before documenting the change.

Use this initial template:

```md
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
```

After creating the template, add current unreleased entries under `## [Unreleased]` using the category rules below.

## Workflow

1. Check whether `CHANGELOG.md` exists. If it is missing and the project needs release/user-visible change tracking, create the template above.
2. Read `CHANGELOG.md` top sections and `package.json` version before editing.
3. Identify whether the task is:
   - documenting unreleased work,
   - cutting a new release/version,
   - correcting an existing changelog mistake.
4. Edit only the relevant changelog sections and version fields.
5. Re-read the top of `CHANGELOG.md` after editing to verify entries are in the right section.

## Placement Rules

- Keep `## [Unreleased]` at the top.
- Put all work done after the latest released version under `## [Unreleased]`.
- Do not add new changes to an already dated release section. Treat dated sections as immutable release history unless the user explicitly asks to correct that release note.
- When bumping a version for release, move the current `[Unreleased]` entries into a new dated section:
  - format: `## [x.y.z] - YYYY-MM-DD`
  - date must be the current local date, not a guessed or stale date
  - insert it immediately below `[Unreleased]`
  - leave `[Unreleased]` present and empty unless there are later changes to record
- After a version section has been created, any subsequent implementation or fix goes back under `[Unreleased]` unless the user explicitly asks to recut that same release.

## Category Rules

Use Keep a Changelog style headings when possible:

- `### Added` for new commands, features, files, or capabilities.
- `### Changed` for behavior changes, workflow updates, docs policy changes, or refactors visible to users/developers.
- `### Fixed` for bug fixes.
- `### Removed` for removed behavior or files.
- `### Deprecated` for planned removals.
- `### Security` for security changes.

Keep entries user-visible and concise. Do not mention internal back-and-forth, failed attempts, temporary cache cleanup, or validation commands unless the change itself affects users.

## Version Rules

- Use project scripts for package version bumps when available, such as `pnpm run version:minor`.
- If the repository defines a changelog release script, use it instead of manually moving entries.
- If the repository defines `version:patch`, `version:minor`, or `version:major` scripts, inspect them before running so you know whether they also update the changelog.
- If package version changes, verify `package.json` and any lockfile/version references that the script updates.
- Do not manually create Git tags or release commits unless the user asks.

## Validation

Before final response:

- Re-read the first 40-80 lines of `CHANGELOG.md`.
- Confirm new work is not placed under an older dated version.
- Run `git diff --check` for changelog/version edits.
- For changelog-only edits, no tests are required unless the user asks or code changed too.

## Common Mistake To Avoid

If `CHANGELOG.md` already contains:

```md
## [Unreleased]

## [0.3.0] - 2026-05-07
```

and a new fix is made after `0.3.0`, add it under `[Unreleased]`, not inside `0.3.0`.
