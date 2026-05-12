---
name: common-sprint-autopilot
description: Plan and execute a named sprint or development stage across multiple requirements. Use when Codex is asked to run a sprint, execute an MVP/stage plan step by step, convert stage requirements plus technical design into a development plan, or repeatedly implement requirements with dev-pattern, changelog updates, and git commits until the stage is complete.
---

# Common Sprint Autopilot

## Purpose

Use this skill to coordinate a sprint-like development stage from planning through repeated implementation steps. It does not replace implementation, changelog, or commit skills; it orchestrates them in a strict loop.

## Required Inputs

Before planning or executing, require:

- Stage name, such as `MVP Step 3`, `v0.1 Usage Tracker`, or `Sprint 2026-05-12`.
- Stage requirements from user prompt or project files.
- Technical guidance files relevant to the stage.

If the stage name is missing, ask for it. If requirement or technical files are referenced but missing, stop and report exactly what is missing. Do not invent requirements, file contents, or technical decisions.

## Stage File Check

Inspect the smallest useful set of files:

- Existing sprint/stage plan, if any.
- Product or requirement docs, such as `docs/blueprint.md`, issue specs, tickets, or user-provided notes.
- Technical design docs, such as `docs/technical-design.md`, `docs/mvp/technical-plan.md`, or module-level docs.
- Existing progress docs, such as `docs/mvp/development-plan.md`.
- `AGENTS.md` and `docs/codex/repo-map.md` when available.
- `CHANGELOG.md`.
- Current `git status --short`.

Only proceed when the required files for the requested stage are present or the user explicitly provides enough content in the prompt.

## Phase 1: Build The Development Plan

Create or update a stage development plan before implementation.

The plan must include:

- Stage name.
- Source files or user-provided requirements used.
- Step list with stable IDs.
- For each step:
  - goal
  - scope
  - main files or modules
  - dependencies
  - validation commands
  - acceptance criteria
  - status
- Known blockers or missing inputs.

Use existing project planning conventions when present. For this repository, prefer `docs/mvp/development-plan.md` for MVP progress.

Do not mark a step complete until code/docs are implemented, validation is run or explicitly skipped with reason, changelog is updated when needed, and the work is committed.

## Phase 2: Execute One Step At A Time

For each incomplete step, run this loop.

### 1. Select The Next Step

- Pick the first unblocked incomplete step.
- Re-read its requirements and acceptance criteria.
- Check `git status --short` before editing.
- If unrelated dirty changes exist, avoid touching them. If they block the step, ask the user.

### 2. Implement With Dev Pattern

Use `common-dev-pattern` for implementation work.

Implementation rules:

- Read nearby code and tests first.
- Follow existing repository conventions.
- Keep edits scoped to the selected step.
- Add or update tests based on risk.
- Run the narrowest reliable validation, then broaden if the change touches shared contracts.
- Update the development plan status after implementation and validation.

### 3. Update Changelog

Use `common-project-changelog` after implementation and before committing when the step changes user-visible behavior, CLI/API behavior, release notes, package version metadata, developer-facing workflow, or project capability.

Rules:

- If `CHANGELOG.md` is missing, initialize it through the changelog skill.
- Add entries under `## [Unreleased]`.
- Do not place new work under an older dated release.
- Keep entries concise and user/developer visible.

### 4. Commit The Step

Use `common-git-commit` after implementation, validation, changelog update, and plan status update.

Rules:

- Commit only files belonging to the completed step.
- Use Conventional Commits.
- Do not push unless the user explicitly asks.
- If a step naturally splits into independent commits, use separate commits.

### 5. Continue Or Stop

After committing:

- Re-check the development plan.
- Move to the next incomplete unblocked step.
- Stop and report when all steps are complete.
- Stop and ask when a step requires missing requirements, missing files, failed validation needing judgment, secrets, credentials, or destructive actions.

## Progress Status Rules

Use these statuses:

- `pending`: not started.
- `in_progress`: currently being implemented.
- `blocked`: waiting on missing input or external dependency.
- `completed`: implemented, validated or skipped with reason, changelog updated if needed, and committed.

Only one step should be `in_progress` at a time.

## Final Response

When stopping, report:

- Current stage name.
- Completed steps.
- Current/next step.
- Commits created.
- Checks run and results.
- Blockers, if any.

Keep the response concise and point to the plan file for details.
