# Repository Guidelines

## Project Snapshot

`himan-tracker` is a local-first TypeScript CLI for AI coding agent observability.

Current MVP tracks Codex and Claude Code metadata such as:

- sessions and turns
- runtime tokens and latency
- status and capability usage

Current implementation status:

- CLI commands for setup, collect, backfill, ingest, archive, reports, and local server are implemented.
- Codex collection and Codex transcript backfill are implemented.
- Claude Code parsing fixtures are present, but `collect --agent claude-code` is not yet supported.
- Copilot transcript backfill (`backfill copilot`) is implemented.
- Copilot hook-based collect (`collect --agent copilot`) and hook setup (`setup copilot`) are implemented.

## Commands

Primary project commands:

```bash
pnpm run build
npm run build:sandbox
pnpm run typecheck
pnpm test
pnpm run verify
```

CLI smoke commands:

```bash
himan-tracker --help
himan-tracker doctor
himan-tracker setup --dry-run
himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
himan-tracker collect --agent copilot --from tests/fixtures/copilot/hook-raw/session.json --sync --strict
himan-tracker backfill codex --date YYYY-MM-DD
himan-tracker backfill copilot --from <dir>
himan-tracker ingest
himan-tracker server start
```

Codex sandbox note:

- Prefer `npm run build:sandbox` because `pnpm run build` may hang in sandboxed sessions.
- If npm is unavailable, use `node node_modules/typescript/bin/tsc -p tsconfig.json`.

## Architecture

Main source layout:

- `src/cli/`: command registration and command handlers.
- `src/config/`: tracker paths, user config defaults, known project name mapping.
- `src/types/`: shared event/config contracts.
- `src/normalizer/`: schema validation, privacy hashing, token normalization, capability classification.
- `src/collector/`: JSONL writer and async queue drain.
- `src/adapters/`: Codex/Claude Code/Copilot parsers and Himan metadata helpers.
- `src/aggregator/`: JSONL -> SQLite projection, daily stats, monthly archive.
- `src/reports/`: report queries/formatters and metrics insights.
- `src/server/`: local report web server.
- `src/storage/`: SQLite initialization and migrations.

Data flow overview:

1. Hook/transcript payload -> `AdapterEvent`.
2. `normalizeEvent` -> privacy-safe `NormalizedEvent`.
3. JSONL append (`events/YYYY-MM-DD.jsonl`) with fail-open behavior.
4. `ingest` projects JSONL into SQLite.
5. report/server commands read SQLite.

## Coding Workflow

- Read nearby files and follow existing TypeScript style and module boundaries.
- Keep CLI orchestration thin; place behavior in command modules and shared helpers.
- Keep parsing/adapters separate from normalizer, collector, storage, and reports.
- Preserve hook-safe behavior for `collect`: default should not block agent workflows.
- Do not edit `dist/` directly.
- Preserve existing user changes; do not reset or discard unrelated modifications.

## Entry Points And Routing

CLI entry point:

- `src/cli/index.ts`

Implemented command handlers:

- `doctor`: `src/cli/commands/doctor.ts`
- `setup`: `src/cli/commands/setup.ts`
- `collect`: `src/cli/commands/collect.ts`
- `backfill codex`: `src/cli/commands/backfill.ts`
- `ingest`: `src/cli/commands/ingest.ts`
- `archive monthly`: `src/cli/commands/archive.ts`
- `cleanup`: `src/cli/commands/cleanup.ts`
- `summary`, `tokens`, `agents`, `turns`, `capabilities`, `capability-events`, `unused`
- `server start/status/stop`: `src/cli/commands/server.ts`

## API And Data

Event contracts:

- `src/types/events.ts`
- `src/normalizer/eventSchema.ts`

Config contracts:

- `src/types/config.ts`
- `src/config/userConfig.ts`

Storage and migrations:

- `src/storage/sqlite.ts`
- `src/storage/migrations/001_initial.sql`
- `src/storage/migrations/002_capability_invocation_origin.sql`
- `src/storage/migrations/005_ingest_file_cursors.sql`

Default data home:

- `~/.himan-tracker` (override with `HIMAN_TRACKER_HOME`)

Privacy defaults:

- `capture_content=false`
- `hash_repo_path=true`
- `capture_shell_args=false`

Do not add prompt/response/code content or plaintext repo paths to normalized events unless explicit opt-in behavior is introduced.

## Generated Files

Generated or derived outputs:

- `dist/` build output from TypeScript compile.
- local runtime data under `~/.himan-tracker/` (or `HIMAN_TRACKER_HOME`): `events/`, `errors/`, `queue/`, `himan.sqlite`, `locks/`, server state/log.

## Validation

For code changes, run:

```bash
pnpm run typecheck
pnpm test
npm run build:sandbox
```

For CLI behavior changes, also run at least one smoke flow with temporary home:

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent copilot --from tests/fixtures/copilot/hook-raw/session.json --sync --strict
```

If a check cannot run, report the reason and risk.

## Agent-Specific Notes

Agent-neutral guidance in this repository should live in `AGENTS.md`.

Current repository map canonical path:

- `docs/repository-map.md`

## Codex-Specific Skill Routing

- Use `common-issue-spec` to clarify vague requests before coding.
- Use `common-dev-pattern` for nontrivial code changes.
- Use `common-project-blueprint` for product positioning and scope docs.
- Use `common-project-tech-design` for architecture and contract design docs.
- Use `common-project-mvp` for MVP planning and execution docs.
- Use `common-project-startup` when refreshing repository onboarding docs.
- Use `common-project-changelog` for user-visible behavior changes, release notes, and version/changelog updates.
- Use `common-git-commit` when asked to create local commits; do not push unless explicitly requested.

## Release And Changelog

- Keep `CHANGELOG.md` in Keep a Changelog style.
- Add new release notes under `## [Unreleased]`.
- Use standard sections: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`.
- Do not append new items to historical released sections.
