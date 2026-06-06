# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [AGENTS.md](AGENTS.md) for the full project reference, architecture overview, commands, and coding workflow. This file only covers Claude Code-specific information and critical constraints not obvious from reading AGENTS.md alone.

**⚠️ After every code change that affects user-visible behavior, CLI surface, or data storage, you MUST update these three files:**
1. **[CHANGELOG.md](CHANGELOG.md)** — add entries under `## [Unreleased]` using Keep a Changelog sections (`Added`, `Changed`, `Fixed`, `Removed`).
2. **[README.md](README.md)** — update support status tables, command descriptions, or feature lists if affected.
3. **[AGENTS.md](AGENTS.md)** — update implementation status, commands, or architecture sections if affected.

## Project summary

`himan-tracker` is a local-first TypeScript CLI + web server for AI coding agent observability. It records sessions, turns, token usage, latency, and capability usage from agent transcripts and hook payloads into local daily JSONL shards projected to SQLite.

## Commands

```bash
# TypeScript build — prefer sandbox variant: `pnpm run build` may hang in containerized/headless envs
npm run build:sandbox          # node node_modules/typescript/bin/tsc -p tsconfig.json
pnpm run typecheck             # Type-check only (no emit)
pnpm test                      # All tests (Node.js native runner via tsx)
pnpm run verify                # typecheck + test + build
node --import tsx --test tests/<path>/<file>.test.ts   # Single test

# Version bump + changelog
pnpm run version:patch / version:minor / version:major
```

See AGENTS.md for the full CLI smoke test commands.

## Project conventions (from `.agents/` skills)

Before performing certain tasks, **read and follow** the corresponding skill definition. These are checked into the repo at `.agents/skills/<name>/SKILL.md` and define the project's workflow standards.

| When you... | Read and follow this skill |
|---|---|
| Edit or add code | **[common-dev-pattern](.agents/skills/common-dev-pattern/SKILL.md)** — read 2-3 nearby files first, match local conventions, validate with `pnpm run verify` before finishing |
| Commit changes | **[common-git-commit](.agents/skills/common-git-commit/SKILL.md)** — lightweight packaging after validation, no push unless asked |
| Update CHANGELOG or docs | **[common-project-changelog](.agents/skills/common-project-changelog/SKILL.md)** — Keep a Changelog style, `## [Unreleased]` with `Added/Changed/Fixed/Removed` sections |
| Encounter vague requirements | **[common-issue-spec](.agents/skills/common-issue-spec/SKILL.md)** — write a short spec before coding, ask one question if unclear |
| Design architecture or data model | **[common-project-tech-design](.agents/skills/common-project-tech-design/SKILL.md)** |
| Plan MVP / milestones | **[common-project-mvp](.agents/skills/common-project-mvp/SKILL.md)** |
| Write product/scope docs | **[common-project-blueprint](.agents/skills/common-project-blueprint/SKILL.md)** |
| Onboard to an unfamiliar repo | **[common-project-startup](.agents/skills/common-project-startup/SKILL.md)** |
| Execute a sprint | **[common-sprint-autopilot](.agents/skills/common-sprint-autopilot/SKILL.md)** |
| Set up npm publish workflow | **[github-npm-publish](.agents/skills/github-npm-publish/SKILL.md)** |

## Critical architecture rules

**Privacy by default.** Do NOT persist prompt, response, code content, stdout/stderr, or shell arguments to normalized events. Repo paths are hashed unless the user opts out. New content fields must be gated behind `capture_content` or equivalent config flags. See `src/normalizer/normalizeEvent.ts` and `src/config/userConfig.ts`.

**Fail-open collector.** `src/collector/hookCollector.ts` must never crash or block the agent workflow. On failure, write an error record to `errors/YYYY-MM-DD.jsonl` and return `{ ok: true, accepted: false }`.

**Thin CLI handlers.** Commands in `src/cli/commands/*.ts` are orchestration only. Business logic stays in collector, aggregator, reports, etc. All handlers return `{ lines: string[]; ok: boolean; exitCode?: number }`.

## SQLite migrations

Migrations are embedded in `src/storage/sqlite.ts` as exported SQL string constants in the `MIGRATIONS` array. They run sequentially in a transaction — each fully applies or rolls back. The separate SQL files under `src/storage/migrations/` are reference-only; the canonical source is `sqlite.ts`. To add one: define a new SQL constant, append to `MIGRATIONS`, run `pnpm test`.

## Event type system

Three event types in `src/types/events.ts`: `TurnSummaryEvent`, `CapabilityUsageEvent`, `SessionSummaryEvent`. Each has an `Adapter*` variant (partial fields, loose types, input side) and a normalized variant (fully validated, output side). `normalizeEvent()` in `src/normalizer/normalizeEvent.ts` bridges them.
