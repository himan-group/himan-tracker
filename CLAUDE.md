# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [AGENTS.md](AGENTS.md) for the full project reference, architecture overview, commands, and coding workflow. This file only covers Claude Code-specific information and critical constraints not obvious from reading AGENTS.md alone.

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

These Codex skill definitions describe project conventions. Follow the same principles when working with this repo:

- **common-dev-pattern** — Before editing, read 2-3 nearby files to match local conventions (naming, error handling, validation, logging patterns). Validate the change before finishing (`pnpm run verify`).
- **common-git-commit** — Commit preparation is lightweight packaging after validation, not a second review. Keep commits focused and local (no push unless asked).
- **common-issue-spec** — When a request is underspecified or cross-file, produce a short implementation spec before coding. If a key decision can't be inferred, ask one question; otherwise state the assumption and proceed.
- **common-project-changelog** — Keep `CHANGELOG.md` in Keep a Changelog style. Add new entries under `## [Unreleased]` using standard sections: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`. Run `pnpm run changelog:release` on version bumps.
- **common-project-blueprint** — For product positioning, target users, goals, scope, non-goals.
- **common-project-mvp** — For splitting MVP features, defining priorities, dependencies, milestones.
- **common-project-startup** — For onboarding to unfamiliar repos: create/update `docs/repository-map.md` and `AGENTS.md`.
- **common-project-tech-design** — For architecture, modules, data contracts, storage, CLI/API behavior, file layout, testing strategy.
- **common-sprint-autopilot** — For executing a named sprint: convert requirements into a dev plan, implement with dev-pattern, changelog, and commits.
- **github-npm-publish** — For GitHub Actions npm publish workflows.

## Critical architecture rules

**Privacy by default.** Do NOT persist prompt, response, code content, stdout/stderr, or shell arguments to normalized events. Repo paths are hashed unless the user opts out. New content fields must be gated behind `capture_content` or equivalent config flags. See `src/normalizer/normalizeEvent.ts` and `src/config/userConfig.ts`.

**Fail-open collector.** `src/collector/hookCollector.ts` must never crash or block the agent workflow. On failure, write an error record to `errors/YYYY-MM-DD.jsonl` and return `{ ok: true, accepted: false }`.

**Thin CLI handlers.** Commands in `src/cli/commands/*.ts` are orchestration only. Business logic stays in collector, aggregator, reports, etc. All handlers return `{ lines: string[]; ok: boolean; exitCode?: number }`.

## SQLite migrations

Migrations are embedded in `src/storage/sqlite.ts` as exported SQL string constants in the `MIGRATIONS` array. They run sequentially in a transaction — each fully applies or rolls back. The separate SQL files under `src/storage/migrations/` are reference-only; the canonical source is `sqlite.ts`. To add one: define a new SQL constant, append to `MIGRATIONS`, run `pnpm test`.

## Event type system

Three event types in `src/types/events.ts`: `TurnSummaryEvent`, `CapabilityUsageEvent`, `SessionSummaryEvent`. Each has an `Adapter*` variant (partial fields, loose types, input side) and a normalized variant (fully validated, output side). `normalizeEvent()` in `src/normalizer/normalizeEvent.ts` bridges them.
