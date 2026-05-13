---
name: common-git-commit
description: Create clean Git commits from the current workspace changes without pushing. Use when the user asks Codex to commit code, generate a commit message and commit, split a large diff into multiple logical commits, or simplify a Git commit workflow based on conversation context and project diffs.
---

# Common Git Commit

## Overview

Create one or more focused Git commits from the current repository state. Derive concise, conventional commit messages from the conversation context plus the actual diff, and stop at local commits only.

## Workflow

1. Confirm the repository state with `git status --short` and identify staged, unstaged, and untracked files.
2. Inspect relevant changes before committing:
   - Use `git diff --stat`, `git diff`, and `git diff --cached` as needed.
   - For untracked source files, read the file contents directly.
   - Use conversation context only as supporting intent; let the diff decide what will be committed.
3. Decide whether the change belongs in one commit or several commits.
4. Stage only the files or hunks that belong to the next logical commit.
5. Run `git commit` with the selected message.
6. Repeat staging and committing until all intended changes are committed.
7. Do not push.

## Commit Splitting

Use multiple commits when the diff contains separate purposes, features, or risk domains. Prefer splitting by user-visible behavior, backend contract, migrations, tests, docs, or refactors when those changes can stand independently.

Keep one commit when the changes are tightly coupled and cannot be reviewed or reverted independently without breaking the task.

When splitting:

- Use `git add <path>` for file-level commits.
- Use `git add -p` only when a file contains unrelated hunks that must be separated.
- Re-check `git diff --cached --stat` before each commit so the staged set matches the intended purpose.
- Avoid mixing generated files, formatting churn, or unrelated cleanup into a functional commit unless they are required by that commit.

## Message Standard

Use a concise Conventional Commits style subject:

```text
type(scope): summary
```

Rules:

- Use lower-case `type`, such as `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `build`, or `ci`.
- Add a narrow `scope` when it is obvious from the module or feature; omit it if it would be vague.
- Write the summary in imperative mood, under 72 characters when practical, without a trailing period.
- Use a short body only when the reason, migration note, or multi-part behavior is not clear from the subject.

Examples:

```text
feat(auth): add token refresh handling
fix(repository-skill): preserve selected cli version
refactor(api): replace lodash helpers with es-toolkit
test(router): cover nested route generation
```

## Failure Handling

If `git commit` fails, do not force the commit and do not bypass hooks unless the user explicitly asks. Report the blocking output clearly, including lint, typecheck, test, formatting, secret scanning, or commit message validation errors.

When the fix is safe and directly related to the requested commit, fix it, re-run the relevant check, and try the commit again. When the failure requires user judgment or unrelated changes, stop and ask the user to resolve or approve the next action.

## Guardrails

- Never run `git push`.
- Never commit unrelated user changes unless they are explicitly included in the requested commit scope.
- Never rewrite existing history, amend commits, reset, clean, or discard files unless the user explicitly asks.
- Preserve staged changes that appear to be user-prepared. If staged content does not match the requested commit, explain the mismatch before changing the index.
- In the final response, list the commit hash and subject for each commit, or report the exact failure that prevented committing.
