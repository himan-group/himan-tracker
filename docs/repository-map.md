# Repository Map

## Overview

`himan-tracker` is a local-first TypeScript CLI for AI coding agent observability.

It collects privacy-safe normalized events, writes local JSONL shards, projects to SQLite, and provides CLI/web reports.

Current implemented areas include:

- Codex hook collection and queue drain.
- Copilot hook collection and queue drain.
- Copilot hook setup (`.github/hooks/himan-tracker.json` generation).
- Codex transcript backfill with inferred skill/MCP usage.
- Copilot transcript backfill.
- SQLite ingestion, daily stats, and monthly archive.
- CLI reports and local server dashboards (`/` and `/metrics`).

## Commands

Build and validation:

```bash
pnpm run build
npm run build:sandbox
pnpm run typecheck
pnpm test
pnpm run verify
```

CLI usage:

```bash
himan-tracker --help
himan-tracker doctor
himan-tracker setup --dry-run
himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
himan-tracker collect --agent copilot --from tests/fixtures/copilot/hook-raw/session.json --sync --strict
himan-tracker backfill codex --date YYYY-MM-DD
himan-tracker ingest
himan-tracker archive monthly --dry-run
himan-tracker cleanup --older-than 30d --dry-run
himan-tracker summary --since 7d
himan-tracker tokens --period week --since 12w
himan-tracker agents --date YYYY-MM-DD
himan-tracker turns --since 7d --limit 20
himan-tracker capabilities --since 30d --sort tokens
himan-tracker capability-events --since 30d --type skill --name common-dev-pattern
himan-tracker unused --since 30d
himan-tracker server start
himan-tracker server status
himan-tracker server stop
```

## Source Layout

```text
src/
  adapters/
    claude-code/
      index.ts
    codex/
      index.ts
      enrichment.ts
      transcriptBackfill.ts
      skillEvidence.ts
    copilot/
      index.ts
      hookParser.ts
    himan/
      lockfile.ts
      metadata.ts
  aggregator/
    aggregateEvents.ts
    dailyStats.ts
    monthlyArchive.ts
  cli/
    index.ts
    commands/
      agents.ts
      archive.ts
      backfill.ts
      capabilities.ts
      capabilityEvents.ts
      cleanup.ts
      collect.ts
      doctor.ts
      ingest.ts
      reportContext.ts
      server.ts
      setup.ts
      summary.ts
      tokens.ts
      turns.ts
      unused.ts
  collector/
    eventQueue.ts
    hookCollector.ts
    jsonlWriter.ts
  config/
    knownProjects.ts
    paths.ts
    userConfig.ts
  normalizer/
    capabilityClassifier.ts
    eventSchema.ts
    normalizeEvent.ts
    privacy.ts
  reports/
    agentReport.ts
    capabilityEventReport.ts
    capabilityReport.ts
    dateRange.ts
    formatTable.ts
    metricsInsights.ts
    periodFormatter.ts
    summaryReport.ts
    systemCapabilityFilter.ts
    tokenReport.ts
    turnReport.ts
    unusedReport.ts
  server/
    reportServer.ts
  storage/
    sqlite.ts
    migrations/
      001_initial.sql
      002_capability_invocation_origin.sql
      005_ingest_file_cursors.sql
  types/
    config.ts
    events.ts
tests/
  adapters/
  aggregator/
  cli/
  collector/
  config/
  normalizer/
  reports/
  storage/
  fixtures/
docs/
  blueprint.md
  development.md
  technical-design.md
  user-guide.md
  mvp/
  sprints/
```

## Entry Points And Routing

CLI entry point:

- `src/cli/index.ts`

Command routing:

- `collect` -> `src/cli/commands/collect.ts`
- `setup` -> `src/cli/commands/setup.ts`
- `doctor` -> `src/cli/commands/doctor.ts`
- `backfill codex` -> `src/cli/commands/backfill.ts`
- `ingest` -> `src/cli/commands/ingest.ts`
- `archive monthly` -> `src/cli/commands/archive.ts`
- `cleanup` -> `src/cli/commands/cleanup.ts`
- `summary` -> `src/cli/commands/summary.ts`
- `tokens` -> `src/cli/commands/tokens.ts`
- `agents` -> `src/cli/commands/agents.ts`
- `turns` -> `src/cli/commands/turns.ts`
- `capabilities` -> `src/cli/commands/capabilities.ts`
- `capability-events` -> `src/cli/commands/capabilityEvents.ts`
- `unused` -> `src/cli/commands/unused.ts`
- `server start/status/stop` -> `src/cli/commands/server.ts`

Local server routes are implemented in `src/server/reportServer.ts`:

- `/` overview dashboard
- `/dashboard.json`
- `/metrics`
- `/metrics.json`
- `/healthz`

## API And Data

Core event contracts:

- `src/types/events.ts`
- `src/normalizer/eventSchema.ts`

Normalization behavior:

- `normalizeEvent` computes stable event IDs and `repo_hash`.
- `repo_hash` is path hash with local salt when `repo_path` is present.
- shell command capability names are argument-stripped by default.

Config contracts:

- `src/types/config.ts`
- `src/config/userConfig.ts`

Config includes privacy fields and local learned `known_projects` mapping (`repo_hash` -> display name).

Local data paths (`HIMAN_TRACKER_HOME` overrides default):

- `~/.himan-tracker/config.json`
- `~/.himan-tracker/events/YYYY-MM-DD.jsonl`
- `~/.himan-tracker/errors/YYYY-MM-DD.jsonl`
- `~/.himan-tracker/queue/`
- `~/.himan-tracker/himan.sqlite`
- `~/.himan-tracker/locks/`
- `~/.himan-tracker/server-state.json`
- `~/.himan-tracker/server.log`

## Generated Files

Generated/build artifacts:

- `dist/`

Do not edit generated build output directly; regenerate with:

```bash
pnpm run build
```

Sandbox fallback build:

```bash
npm run build:sandbox
```

## Project Rules

Observed repository rules and conventions:

- Keep `README.md` user-facing.
- Keep design and plan details under `docs/` (`blueprint`, `technical-design`, `mvp`, `sprints`).
- Keep changelog updates in `CHANGELOG.md` under `## [Unreleased]`.
- Preserve privacy defaults; do not store prompt/response/code/plaintext repo paths in normalized events by default.
- Keep collect behavior hook-safe and fail-open by default.

## Codex-Specific Notes

Repository map canonical path is `docs/repository-map.md`.

## Validation Notes

Recommended validation before finalizing nontrivial changes:

```bash
pnpm run typecheck
pnpm test
npm run build:sandbox
```

CLI smoke checks (prefer temp home):

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
```
