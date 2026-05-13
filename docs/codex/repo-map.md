# Repository Map

## Overview

`himan-tracker` is a local-first TypeScript CLI for AI coding agent observability. The MVP tracks Codex and Claude Code usage metadata, normalizes events, stores local JSONL/SQLite data, and reports agent/model/capability usage.

Current implementation status:

- CLI skeleton, `doctor`, `setup`, `collect`, `ingest`, and report commands are implemented.
- Config/path resolution, user config defaults, normalized event contracts, schema validation, repo path hashing, token normalization, capability classification, async collect queue, Codex hook setup, JSONL collection, SQLite migrations, JSONL ingest, daily stats aggregation, CLI reports, fixture-first agent adapters, and MVP documentation are implemented.
- Richer real-world adapter fixtures remain future work.

## Commands

Common commands:

```bash
pnpm run build
pnpm run typecheck
pnpm test
himan-tracker --help
himan-tracker doctor
himan-tracker setup --dry-run
himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
himan-tracker ingest
himan-tracker summary --since 7d
himan-tracker agents --date YYYY-MM-DD
himan-tracker capabilities --since 30d
himan-tracker unused --since 30d
```

Notes:

- The published `himan-tracker` bin points to `./dist/cli/index.js`, so run `pnpm run build` before local package-link or packed CLI testing.
- The `doctor` command creates/checks local tracker files. Use `HIMAN_TRACKER_HOME=/tmp/path` or another temp path during tests/manual checks when you do not want to touch `~/.himan-tracker`.
- The `setup` command installs current-project Codex hooks by default and supports `-g, --global` for `~/.codex` setup. Generated helpers call `himan-tracker collect --agent codex --quiet`.
- The `collect` command is hook-safe by default: it returns 0 unless `--strict` is used, queues sanitized normalized events, and drains asynchronously unless `--sync` is used. Use `--quiet` in hooks.

## Source Layout

```text
src/
  cli/
    index.ts
    commands/agents.ts
    commands/capabilities.ts
    commands/collect.ts
    commands/doctor.ts
    commands/ingest.ts
    commands/reportContext.ts
    commands/setup.ts
    commands/summary.ts
    commands/unused.ts
  aggregator/
    aggregateEvents.ts
    dailyStats.ts
  collector/
    eventQueue.ts
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
    claude-code/
      index.ts
      fixtures/
    codex/
      index.ts
      fixtures/
  reports/
    agentReport.ts
    capabilityReport.ts
    dateRange.ts
    formatTable.ts
    summaryReport.ts
    unusedReport.ts
  storage/
    sqlite.ts
    migrations/
      001_initial.sql
tests/
  adapters/
  aggregator/
  cli/
  collector/
  config/
  normalizer/
  reports/
  fixtures/
    claude-code/
      raw/
      normalized/
    codex/
      raw/
      normalized/
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
  - `setup --agent codex` -> `src/cli/commands/setup.ts`
  - `collect --agent codex` -> `src/cli/commands/collect.ts`
  - `ingest` -> `src/cli/commands/ingest.ts`
  - `summary`
  - `agents`
  - `capabilities`
  - `unused`

`src/cli/index.ts` currently routes all MVP commands. `setup --agent codex` is the Codex hook installer, and `collect --agent codex` is the current data-source entry point; `--agent claude-code` remains future work.

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
- `collectAdapterEvent` normalizes adapter events, appends accepted events to `events/YYYY-MM-DD.jsonl`, writes sanitized collector errors to `errors/YYYY-MM-DD.jsonl`, and fails open so agent workflows are not blocked.
- `eventQueue` stores already-normalized events under `queue/`, uses `locks/collect-<agent>.lock` to avoid concurrent drains, and appends queued events to daily JSONL in the background.
- Hook-facing collect behavior must remain non-blocking: default exit code is 0 even when collection fails; `--quiet` suppresses stdout for hooks; `--strict` is only for manual validation.

SQLite and ingest rules:

- `src/storage/sqlite.ts` initializes `schema_migrations`, applies `001_initial`, and opens `better-sqlite3` with WAL and foreign keys enabled.
- `src/aggregator/aggregateEvents.ts` imports normalized JSONL, skips duplicate `event_id` values through `ingested_events`, supports rebuild by removing projection database files, and recomputes affected daily stats.
- `src/aggregator/dailyStats.ts` recomputes `daily_agent_stats` and `daily_capability_stats` by local date.

Report rules:

- Report commands read SQLite through `src/cli/commands/reportContext.ts`; they initialize migrations if needed and render empty states when no data exists.
- `summary` supports `--since`, shows overall usage, top agents, and top capabilities.
- `agents` supports `--date` and groups by agent/model.
- `turns` supports `--since`, `--agent`, and `--limit` for per-turn duration/token/status output.
- `capabilities` supports `--since`, `--sort`, `--type`, and `--agent`.
- `unused` combines historical capability stats with `config.known_capabilities`.
- Missing token or duration values are rendered as `n/a`.

Adapter rules:

- `src/adapters/codex/index.ts` parses constructed fixtures and current Codex hook fields such as `hook_event_name`, `cwd`, `PostToolUse`, and `Stop`.
- `src/adapters/claude-code/index.ts` parses constructed Claude Code fixtures for `tool_result`/`tool_use`, `message_stop`, and `session_end`.
- Adapters return `AdapterEvent[]` only; they do not write JSONL or SQLite.
- Unknown hooks are ignored so adapter parsing fails open for unsupported future payloads.

## Config And Local Data

Config types live in `src/types/config.ts`.

Config/path implementation:

- `src/config/paths.ts`
- `src/config/userConfig.ts`

Default local paths:

```text
~/.himan-tracker/config.json
~/.himan-tracker/events/YYYY-MM-DD.jsonl
~/.himan-tracker/errors/YYYY-MM-DD.jsonl
~/.himan-tracker/queue/
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

- `tests/adapters/claudeCode.test.ts`
- `tests/adapters/codex.test.ts`
- `tests/aggregator/aggregateEvents.test.ts`
- `tests/cli/collect.test.ts`
- `tests/cli/reportCommands.test.ts`
- `tests/cli/setupCodex.test.ts`
- `tests/collector/hookCollector.test.ts`
- `tests/collector/jsonlWriter.test.ts`
- `tests/config/paths.test.ts`
- `tests/config/userConfig.test.ts`
- `tests/normalizer/eventSchema.test.ts`
- `tests/normalizer/normalizeEvent.test.ts`
- `tests/normalizer/capabilityClassifier.test.ts`
- `tests/reports/formatTable.test.ts`
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
himan-tracker --help
himan-tracker setup --dry-run
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
```

Use a temporary `HIMAN_TRACKER_HOME` for manual `doctor` and `collect` checks to avoid changing the user's real tracker home. Use `--dry-run` for setup smoke checks unless intentionally writing `.codex/`.
