---
name: common-project-startup
description: Onboard Codex to an existing repository by inspecting structure, commands, rules, generated files, and validation workflow; create or update docs/codex/repo-map.md and AGENTS.md. Use when starting work in an unfamiliar project, refreshing project guidance, or syncing local rules into Codex instructions.
---

# common-project-startup

Use this skill when Codex needs durable project understanding before broad or repeated work in a repository.

## Inspect

Read only the files needed to map the project:

- Build manifests and lockfiles: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, lockfiles
- Existing guidance: `AGENTS.md`, `.cursor/rules/**/*.mdc`, `docs/codex/repo-map.md`, relevant local docs
- Source roots and entry points: `src/`, `app/`, `lib/`, `packages/`, `services/`, `server/`, `client/`, `tests/`
- APIs and data: clients, schemas, generated clients, migrations, models, fixtures
- Tooling: type, lint, format, test, bundler, framework, Docker, CI, deployment config

Skip vendored dependencies, build output, caches, coverage, `.git/`, and large generated files unless directly relevant.

## Repository Map

Create or update `docs/codex/repo-map.md` when the project needs a durable map. Keep it factual and concise:

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

## Validation Notes
...
```

Record what exists; do not prescribe a new architecture. Prefer representative paths over exhaustive file lists. Include exact commands from manifests or docs.

## AGENTS.md

Create or update repository-root `AGENTS.md` when Codex instructions should be persisted. Prefer this structure and omit sections that do not apply:

```md
# Codex Instructions

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

## Skill Routing
...
```

Preserve user-maintained content. If manual notes are needed, keep them under:

```md
<!-- codex:manual-start -->
...
<!-- codex:manual-end -->
```

## Rules

- Convert local rules into short Codex instructions instead of copying them wholesale.
- Mention generated or derived files and how they are produced when the repository makes that clear.
- Mention conventions only when they are visible in the repository.
- Route vague work to `common-issue-spec` and code-change work to `common-dev-pattern`.
- Do not include secrets, tokens, private URLs beyond what already exists in committed project files.
