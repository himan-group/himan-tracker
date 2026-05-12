# Repository Map

## Overview

`himan-tracker` is a local-first TypeScript CLI for AI coding agent observability. The MVP tracks Codex and Claude Code usage metadata, normalizes events, stores local JSONL/SQLite data, and reports agent/model/capability usage.

Current implementation status:

- CLI skeleton and `doctor` command are implemented.
- Config/path resolution, user config defaults, normalized event contracts, schema validation, repo path hashing, token normalization, capability classification, JSONL collection, SQLite migrations, JSONL ingest, and daily stats aggregation are implemented.
- CLI reports and agent adapters are planned but not implemented.

## Commands

From `package.json`:

```bash
pnpm run build
pnpm run typecheck
pnpm test
pnpm cli -- --help
pnpm cli -- doctor
pnpm cli -- ingest
```

Notes:

- `pnpm cli` runs `tsx src/cli/index.ts`.
- The package bin points to `./dist/cli/index.js`, so run `pnpm run build` before testing the built CLI path.
- The `doctor` command creates/checks local tracker files. Use `HIMAN_TRACKER_HOME=/tmp/path` or another temp path during tests/manual checks when you do not want to touch `~/.himan-tracker`.

## Source Layout

```text
src/
  cli/
    index.ts
    commands/doctor.ts
    commands/ingest.ts
  aggregator/
    aggregateEvents.ts
    dailyStats.ts
  collector/
    hookCollector.ts
    jsonlWriter.ts
  config/
    paths.ts
    userConfig.ts
  normalizer/
    capabilityClassifier.ts
    eventSchema.ts
    normalizeEvent.ts
    privacy.ts
  types/
    config.ts
    events.ts
  adapters/
  reports/
  storage/
    sqlite.ts
    migrations/
      001_initial.sql
tests/
  aggregator/
  collector/
  config/
  normalizer/
  storage/
docs/
  mvp/
  blueprint.md
  technical-design.md
```

Empty or not-yet-implemented domains currently remain as `.gitkeep` directories.

## Entry Points And Routing

- CLI entry point: `src/cli/index.ts`
- Implemented commands:
  - `doctor` -> `src/cli/commands/doctor.ts`
  - `ingest` -> `src/cli/commands/ingest.ts`
- Planned placeholder commands:
  - `summary`
  - `agents`
  - `capabilities`
  - `unused`

`src/cli/index.ts` currently reports planned report commands as not implemented and exits with non-zero status for those commands.

## Data And Contracts

Primary event contracts live in `src/types/events.ts`:

- `TurnSummaryEvent`
- `CapabilityUsageEvent`
- `SessionSummaryEvent`
- `NormalizedEvent`
- `AdapterEvent`

Runtime validation lives in `src/normalizer/eventSchema.ts` using `zod`.

Normalization rules:

- `normalizeEvent` fills defaults, hashes repo paths, normalizes token usage, classifies capabilities, creates stable event IDs, and validates output.
- `createEventId` uses stable identity fields rather than ingest time.
- Token fields remain `null` when unavailable.
- `repo_path` must not appear in normalized output.
- Shell command names are stripped to the command name unless `capture_shell_args` is enabled.

Collector rules:

- `appendJsonlRecord` writes one compact JSON object per line and creates parent directories.
- `collectAdapterEvent` normalizes adapter events, appends accepted events to `events.jsonl`, writes sanitized collector errors to `errors.jsonl`, and fails open so agent workflows are not blocked.

SQLite and ingest rules:

- `src/storage/sqlite.ts` initializes `schema_migrations`, applies `001_initial`, and opens `better-sqlite3` with WAL and foreign keys enabled.
- `src/aggregator/aggregateEvents.ts` imports normalized JSONL, skips duplicate `event_id` values through `ingested_events`, supports rebuild by removing projection database files, and recomputes affected daily stats.
- `src/aggregator/dailyStats.ts` recomputes `daily_agent_stats` and `daily_capability_stats` by local date.

## Config And Local Data

Config types live in `src/types/config.ts`.

Config/path implementation:

- `src/config/paths.ts`
- `src/config/userConfig.ts`

Default local paths:

```text
~/.himan-tracker/config.json
~/.himan-tracker/events.jsonl
~/.himan-tracker/errors.jsonl
~/.himan-tracker/himan.sqlite
~/.himan-tracker/locks/
```

`HIMAN_TRACKER_HOME` overrides the default data home.

Default privacy config:

```json
{
  "capture_content": false,
  "hash_repo_path": true,
  "capture_shell_args": false
}
```

## Tests

Current test files:

- `tests/aggregator/aggregateEvents.test.ts`
- `tests/collector/hookCollector.test.ts`
- `tests/collector/jsonlWriter.test.ts`
- `tests/config/paths.test.ts`
- `tests/config/userConfig.test.ts`
- `tests/normalizer/normalizeEvent.test.ts`
- `tests/normalizer/capabilityClassifier.test.ts`
- `tests/storage/sqlite.test.ts`

The test runner is Node's built-in test runner with `tsx`:

```bash
pnpm test
```

## Generated Files

Generated/build output:

- `dist/`

Do not edit `dist/` directly. Rebuild from `src/` with:

```bash
pnpm run build
```

Vendored/dependency output:

- `node_modules/`

Do not inspect or edit `node_modules/` unless debugging dependency behavior directly.

## Project Rules

- Keep README user-facing; do not add implementation roadmap, source layout, or internal planning details there.
- Use `docs/blueprint.md` for product direction.
- Use `docs/technical-design.md` for architecture and contracts.
- Use `docs/mvp/` for feature, technical MVP, and step-by-step development planning.
- Keep `CHANGELOG.md` in Keep a Changelog style with `## [Unreleased]` at the top.
- User-visible CLI/API behavior changes, package version changes, and release-note work should use `common-project-changelog`.
- Preserve local-first privacy: no prompt, response, code content, or plaintext repo path in normalized events by default.

## Validation Notes

Before finalizing code changes, run:

```bash
pnpm run typecheck
pnpm test
```

For CLI smoke checks:

```bash
pnpm cli -- --help
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli -- doctor
```

Use a temporary `HIMAN_TRACKER_HOME` for manual `doctor` checks to avoid changing the user's real tracker home.
