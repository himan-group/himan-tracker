---
name: common-git-commit
description: Create clean local Git commits quickly from the current project changes without pushing. Use when the user asks Codex to commit code, generate a commit message and commit, split a large diff into logical commits, or simplify a Git commit workflow based on conversation context and project diffs.
---

# Common Git Commit

## Goal

Create focused local commits with minimal latency. For this project, commit preparation should be a lightweight packaging step after implementation and validation, not a second full code review.

## Fast Workflow

1. Run `git status --short`.
2. Build a cheap change map with `git diff --stat` and, when useful, `git diff --name-status`.
3. If files are already staged, also run `git diff --cached --stat` and `git diff --cached --name-status`.
4. Use the recent conversation plus the change map to infer the intended scope and message.
5. Stage only the intended files.
6. Re-check `git diff --cached --stat`.
7. Commit with a concise Conventional Commits subject.
8. Do not push.

When Codex just made the changes in the current conversation and the file list matches that work, skip full-diff reading. Do not spend time re-reading every changed line just to reconstruct changes already made and validated.

## When To Inspect More

Use targeted inspection only for uncertainty:

- `git diff -- <path>` or `git diff --cached -- <path>` when a file's purpose, risk, or commit boundary is unclear.
- Read untracked files only enough to identify their purpose and whether they belong in the commit.
- Use `git add -p` only when unrelated hunks in the same file must be separated.

Avoid full-repository `git diff` unless the status/stat output reveals surprising files, risky migrations, lockfiles, generated output, or unrelated user changes.

## Commit Splitting

Default to one commit for a cohesive task. Split only when changes are clearly independent and can be reviewed or reverted separately.

Good split boundaries include user-visible behavior, storage or migration changes, tests, docs, refactors, and generated artifacts when those changes can stand independently.

Keep one commit when splitting would require re-reading large diffs, when files are tightly coupled, or when the user asked for a simple commit.

## Message Standard

Use a concise Conventional Commits subject:

```text
type(scope): summary
```

Rules:

- Use lower-case `type`, such as `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `build`, or `ci`.
- Add a narrow `scope` when obvious; omit it if it would be vague.
- Write the summary in imperative mood, under 72 characters when practical, without a trailing period.
- Add a short body only when the reason, migration note, or multi-part behavior is not clear from the subject.

Project examples:

```text
feat(collect): enrich codex session metadata
fix(ingest): preserve hook-safe collect failures
docs(mvp): update development plan status
test(reports): cover capability duration totals
```

## Validation And Hooks

Do not run broad validation as part of the commit skill unless the user explicitly asks or the current conversation has not already validated the code. `common-dev-pattern` owns code validation before commit.

If `git commit` fails because a hook runs lint, typecheck, tests, formatting, secret scanning, or commit message validation, report the blocking output. Fix only safe, directly related issues and retry; otherwise stop and ask for direction.

Do not bypass hooks unless the user explicitly asks.

## Guardrails

- Never run `git push`.
- Never commit unrelated user changes unless explicitly included in the requested scope.
- Never rewrite history, amend, reset, clean, discard files, or alter prepared staged content unless the user explicitly asks.
- Preserve staged changes that appear user-prepared. If staged content does not match the requested commit, explain before changing the index.
- Prefer low-latency commands and targeted inspection over exhaustive diff review.
- In the final response, list each commit hash and subject, or report the exact failure that prevented committing.
