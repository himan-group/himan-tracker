---
name: common-project-startup
description: Onboard coding agents to an existing repository by inspecting structure, commands, rules, generated files, and validation workflow; create or update docs/repository-map.md or legacy docs/codex/repo-map.md plus AGENTS.md. Use when starting work in an unfamiliar project, refreshing project guidance, or syncing local rules into broadly compatible agent instructions.
---

# common-project-startup

Use this skill when a coding agent needs durable project understanding before broad or repeated work in a repository.

## Inspect

Read only the files needed to map the project:

- Build manifests and lockfiles: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, lockfiles
- Release/history files: `CHANGELOG.md`, release notes, package version scripts
- Existing guidance: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/**/*.mdc`, `.github/copilot-instructions.md`, `docs/repository-map.md`, legacy `docs/codex/repo-map.md`, relevant local docs
- Source roots and entry points: `src/`, `app/`, `lib/`, `packages/`, `services/`, `server/`, `client/`, `tests/`
- APIs and data: clients, schemas, generated clients, migrations, models, fixtures
- Tooling: type, lint, format, test, bundler, framework, Docker, CI, deployment config

Skip vendored dependencies, build output, caches, coverage, `.git/`, and large generated files unless directly relevant.

## Documentation Standards

Generated `AGENTS.md` and repository map docs should read like normal repository documentation:

- Use factual, stable headings and concise prose.
- Separate observed repository facts from agent workflow guidance and agent-specific tool behavior.
- Prefer standard engineering terms such as commands, source layout, entry points, generated files, validation, and release notes.
- Do not invent policy, ownership, or architecture that is not visible in the repository.
- Keep broadly useful repository information unbranded so Codex, Claude Code, Cursor, Copilot, Gemini, OpenHands, and human contributors can all use it.
- Mark agent-specific content explicitly with wording such as `Codex-specific:`, `Cursor-specific:`, `Claude Code-specific:`, `GitHub Copilot-specific:`, or a section title like `## Codex-Specific Notes`.
- Do not describe an instruction as universal when it depends on one agent's tools, memory model, slash commands, MCP servers, browser integration, or skill system.

## Agent File Conventions

Prefer conventional file names and scopes so the generated guidance works with as many agents as possible:

- Use repository-root `AGENTS.md` as the primary, agent-neutral guidance file. Use this exact uppercase name.
- Keep `AGENTS.md` content broadly applicable. It may contain explicitly labeled agent-specific subsections, but the main project facts and workflows should stay vendor-neutral.
- Use nested `AGENTS.md` files only when a subdirectory has materially different build, test, ownership, or generated-file rules.
- Use `CLAUDE.md` only for Claude Code-specific instructions that should be loaded by Claude Code. Do not duplicate the entire root `AGENTS.md`; link or summarize shared rules and keep Claude-only behavior clearly labeled.
- Use `.cursor/rules/*.mdc` only for Cursor-specific rules. Keep Cursor front matter and glob scoping valid when those files already exist.
- Use `.github/copilot-instructions.md` only for GitHub Copilot-specific repository instructions.
- Use other agent-specific files, such as `GEMINI.md` or `.openhands/microagents/`, only when the repository already uses that convention or the user explicitly asks for that agent.
- Do not create several agent-specific files by default. Start from `AGENTS.md`, then add or update dedicated files only when there is a concrete target agent requirement.
- When syncing between files, avoid copy-paste drift: keep shared facts in `AGENTS.md` or `docs/repository-map.md`, and put only the agent-specific delta in the dedicated file.

## Repository Map

Use `docs/repository-map.md` as the default repository map path for new or migrated docs. `docs/codex/repo-map.md` is a legacy Codex-specific location; keep it compatible when it already exists.

Path rules:

- If `docs/repository-map.md` exists, read and update it as the canonical map.
- If only `docs/codex/repo-map.md` exists, read it for compatibility and ask the user whether to migrate it to `docs/repository-map.md` before changing paths.
- If the user enables the new `docs/repository-map.md` path, move or recreate the map there and delete the legacy `docs/codex/repo-map.md` file so there is only one canonical map.
- If both paths exist, read both, treat `docs/repository-map.md` as canonical, and mention that `docs/codex/repo-map.md` is legacy if the difference matters.
- If no map exists and one is needed, create `docs/repository-map.md`.

Keep the map factual and concise:

```md
# Repository Map

## Overview
...

## Commands
...

## Source Layout
...

## Entry Points And Routing
...

## API And Data
...

## UI And Components
...

## Shared Modules
...

## Generated Files
...

## Project Rules
...

## Codex-Specific Notes
...

## Validation Notes
...
```

Record what exists; do not prescribe a new architecture. Prefer representative paths over exhaustive file lists. Include exact commands from manifests or docs.
Use `Codex-Specific Notes` only for agent workflow details; omit it when there is no Codex-only guidance.

## AGENTS.md

Create or update repository-root `AGENTS.md` when durable agent instructions should be persisted. Prefer this structure and omit sections that do not apply:

```md
# Repository Guidelines

## Project Snapshot
...

## Commands
...

## Architecture
...

## Coding Workflow
...

## Entry Points And Routing
...

## API And Data
...

## UI And Component Conventions
...

## Generated Files
...

## Validation
...

## Agent-Specific Notes
...

## Codex-Specific Skill Routing
...
```

Preserve user-maintained content. If manual notes are needed, keep them under:

```md
<!-- codex:manual-start -->
...
<!-- codex:manual-end -->
```

## Rules

- Convert local rules into short agent instructions instead of copying them wholesale.
- Mention generated or derived files and how they are produced when the repository makes that clear.
- Mention conventions only when they are visible in the repository.
- Route vague work to `common-issue-spec` and code-change work to `common-dev-pattern`.
- Keep Codex skill routing under `Codex-Specific Skill Routing`; do not present skills as instructions for agents that cannot use them.
- If adding Cursor, Claude Code, Copilot, Gemini, or OpenHands guidance, put it in an explicitly named agent-specific section or file and include only behavior that differs from the shared repository guidance.
- For projects with a CLI, package version, public API, release workflow, or user-visible behavior, check for release notes and `CHANGELOG.md`.
  - If `CHANGELOG.md` or equivalent release notes already exist, record the update rule in `AGENTS.md` and route release-note work to `common-project-changelog`.
  - If the repository is being newly initialized, create a Keep a Changelog style `CHANGELOG.md` when release notes are relevant.
  - If the repository is an established/legacy project and no changelog exists, do not create one by default; mention the absence only when it affects the current work.
- Do not include secrets, tokens, private URLs beyond what already exists in committed project files.
