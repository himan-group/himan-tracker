# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.5] - 2026-06-06

### Added

- Added Claude Code agent support: `collect --agent claude-code` for hook-based event collection, `backfill claude-code` for transcript-based backfill, `setup claude-code` for hook configuration, and `rebuild claude-code` for end-to-end data rebuild.
- Added Claude Code hook parser (`src/adapters/claude-code/index.ts`) supporting `PostToolUse`, `PostToolUseFailure`, `Stop`, and `SessionEnd` hook events from Claude Code's stdin JSON hook format.
- Added Claude Code transcript backfill parser (`src/adapters/claude-code/transcriptBackfill.ts`) that reads `~/.claude/projects/` session JSONL files and handles the split-block transcript format to extract turns, tool calls, and token usage.

### Changed

- Moved Himan lockfile and metadata utilities from `src/adapters/himan/` to `src/metadata/` as they are not agent adapters.

### Fixed

- Claude Code transcript backfill now captures `cwd` from transcript records as `repo_path`, fixing missing project name in dashboard reports.
- Added `Agent`, `EnterPlanMode`, and `ExitPlanMode` to built-in tool classifier so Claude Code native tools are classified as `builtin_tool` instead of `unknown`.

## [0.5.4] - 2026-06-05

### Changed

- Migrated Dashboard server-side HTML rendering from raw string concatenation to Preact JSX components (`preact` + `preact-render-to-string`), improving view-layer maintainability and component reuse.

## [0.5.3] - 2026-06-04

### Added

- Added `cached_input_tokens` to Codex transcript/enrichment ingestion so newly collected and backfilled turn data can preserve cached input token usage alongside input, output, and total tokens.
- Added `himan-tracker ingest --date YYYY-MM-DD` to rebuild one local-date SQLite projection from the matching `events/YYYY-MM-DD.jsonl` shard without resetting the full database.
- Added `himan-tracker cleanup --agent codex|copilot|claude-code` to remove only one agent's raw event records from date-sharded JSONL without deleting other agents' events from the same day.
- Added `himan-tracker ingest --date YYYY-MM-DD --agent codex|copilot|claude-code` to rebuild one agent's SQLite projection from a mixed daily JSONL shard without resetting the full date or database.
- Added `himan-tracker rebuild codex|copilot --date YYYY-MM-DD` to orchestrate agent-scoped cleanup, forced backfill, and agent/date-scoped ingest with step-by-step progress output.

### Changed

- Changed Codex `Usage` cost estimation to price cached input tokens separately from regular input tokens using the Codex credit rate card, and surfaced cached-input usage in the Usage tables.
- Changed Codex transcript backfill to skip empty model-less turns with no observed token usage, and changed the Usage page to hide model-less rows while rendering unknown cost fields as `n/a` instead of `0`.

## [0.5.2] - 2026-06-04

### Changed

- Redesigned dashboard and report pages with a cleaner, more compact visual style.
- Tab navigation is now a compact segmented control instead of pill-shaped buttons.
- Left-aligned navigation and breadcrumb links so they no longer stretch across the full page width.
- Billing cycle start day selections now persist to user config and survive server restarts.

### Fixed

- Fixed invisible text on active tab buttons.
- Changed billing cycle dropdown to start from Monday instead of Sunday.

## [0.5.1] - 2026-06-04

### Changed

- Changed the local report server `Usage` page to replace the top metric cards with a budget progress view, keep only the expected-baseline marker on the progress bar, and highlight cycles that are already over the expected baseline (`75 / 5 × N` workdays).

## [0.5.0] - 2026-06-04

### Added

- Added a local report server `Usage` page (`/usage` and `/usage.json`) for Codex, with daily model-level cost estimates, weekly credit budget tracking, and configurable billing-cycle start day (default Wednesday).

## [0.4.2] - 2026-06-04

### Changed

- Changed local report server detail pages `/projects`, `/sessions`, and `/turns` to support `page` and `pageSize` query pagination with previous/next navigation, while keeping the Overview dashboard summary lists unpaginated.

## [0.4.1] - 2026-06-03

### Added

- Added Copilot hook health check in `doctor` command, covering both global (`~/.copilot/hooks/`) and project (`.github/hooks/`) scope.
- Added `UserPromptSubmit` hook event to Copilot hook configuration for accurate per-turn duration tracking.
- Added session state tracker for Copilot (`sessionState.ts`) to compute session and turn duration from hook timestamps across independent hook invocations.

### Changed

- `doctor` agents display now includes `copilot` alongside `codex` and `claude-code`.
- Copilot `parseCopilotHookPayload` is now async to support session state lookups for duration computation.
- Copilot turn duration is now computed from `UserPromptSubmit` → `Stop` timestamps when available, falling back to session start / previous turn end.

## [0.4.0] - 2026-06-02

### Added

- Added capability attribution confidence reporting surfaces for ROI analysis: `capabilities --view strict|weighted` with `--strict-score-threshold`, `capability-events --min-score`, and attribution score/basis/context columns in capability event details.
- Added weighted capability aggregation fields in daily/monthly stats (`strict_attribution_count`, `weighted_invocation_count`, `weighted_total_tokens`, `weighted_duration_ms`) and attribution drift alerts (`unknown_origin_ratio`, `attribution_score_drop`) in Metrics.
- Added an Overview dashboard `Capability ROI views` tab group on `server start` pages, with `Raw`, `Strict (>=80)`, and `Weighted` capability tables sourced from the same attribution-confidence logic.
- Added `Static tokens` to Overview dashboard capability tables for skill `himan.yaml` package token estimates.
- Added project counts to Summary reports and Overview dashboard summary metrics.

### Changed

- Updated user guide capability documentation to cover raw/strict/weighted views, strict threshold semantics, score-based capability-event filtering, and fail-open handling for non-Himan skill sources without `himan.yaml`/`himan.lock`.

### Fixed

- Fixed system capability filtering to treat `write_stdin` (including `functions.write_stdin`) as a built-in tool, so `summary --exclude-system`, `capabilities --exclude-system`, and dashboard Top capabilities no longer show it.

## [0.3.2] - 2026-06-01

### Changed

- Changed minimum supported Node.js version declaration from `>=20.11` to `>=20`, and aligned project docs/PR workflows with the new baseline.

## [0.3.1] - 2026-06-01

### Changed

- Changed `server start` / `server serve` to support `--startup-backfill none|copilot|codex|all` (default `none`), so backfill can be controlled explicitly at startup.
- Changed report server sync scheduling to run backfill only during startup (when enabled by `--startup-backfill`) and keep periodic `--interval` runs ingest-only.

### Fixed

- Fixed Copilot session-store backfill to persist only shell command names (for example `bash`) instead of full command strings, preventing shell arguments from being recorded in capability names.
- Fixed `backfill copilot --since` to process Copilot data sources once per run instead of repeating full-source scans for each day in the range, so parsed/transcript statistics and duplicate counts are no longer inflated.
- Fixed report server backfill integration to use shared structured backfill stats instead of parsing CLI text output, and moved backfill execution logic into a shared module so CLI entrypoints remain thin.
- Fixed setup documentation examples to match current CLI subcommands (`setup codex` / `setup copilot`) and removed outdated `setup --agent ...` / `setup -g` command forms.
- Fixed repeated backfill scans by adding persisted source fingerprints (`backfill-cursors.json`) for both Codex transcript directories and Copilot sources, allowing unchanged sources to be skipped on subsequent runs.
- Fixed backfill cursor workflow by adding `--ignore-cursor` to `backfill codex` and `backfill copilot`, allowing forced re-parse when source fingerprints are unchanged.

## [0.3.0] - 2026-05-30

### Added

- Added Copilot hook-based collect via `himan-tracker collect --agent copilot`, supporting real-time event collection from GitHub Copilot hooks (SessionStart, PostToolUse, PostToolUseFailure, Stop, SessionEnd).
- Added `himan-tracker setup copilot` subcommand to generate `.github/hooks/himan-tracker.json` and a lightweight hook helper script that forwards Copilot hook JSON to the collector.
- Added Copilot hook payload parsing support for both camelCase (Copilot CLI native) and PascalCase/snake_case (VS Code compatible) field formats.
- Added Copilot CLI session-store database (`~/.copilot/session-store.db`) support as a faster and more reliable data source than transcript scanning for `backfill copilot`.
- Added `copilot` agent support with `himan-tracker backfill copilot` for parsing VS Code Copilot transcript JSONL files into normalized session, turn, and capability usage events.
- Added `--since <date>` option to `himan-tracker backfill` for backfilling from a date through today.
- Added automatic Copilot transcript backfill to `himan-tracker server start`, so the dashboard stays in sync without manual backfill runs.

### Changed

- Changed `himan-tracker setup --agent <agent>` to subcommands `himan-tracker setup codex` and `himan-tracker setup copilot`, both supporting `-g, --global` and `--dry-run` options.
- Changed `himan-tracker setup copilot -g` to install global hooks into `~/.copilot/hooks/himan-tracker.json` (respecting `COPILOT_HOME`) with the helper script in `~/.himan-tracker/scripts/`.
- Changed `backfill copilot` default data source to prefer `~/.copilot/session-store.db` (Copilot CLI's SQLite database) over VS Code transcript scanning, falling back to transcript auto-detection when the database is not found.
- Changed Metrics `Project` column to prefer a learned local project label (`package.json` name first, folder name fallback) while keeping repo hash as the fallback display.

### Fixed

- Fixed `turns --agent`, `capabilities --agent`, and `capability-events --agent` to accept `copilot` as a valid agent filter, matching the `collect` and `setup` commands.

## [0.2.3] - 2026-05-29

### Changed

- Refreshed README positioning and onboarding so the homepage now focuses on target users, differentiators, quick start workflows, and links to detailed user and development docs.

## [0.2.2] - 2026-05-20

### Changed

- Changed token-facing CLI and dashboard labels to consistently call the tracked values `runtime tokens`, and clarified that token reports exclude `himan.yaml` static token estimates.

## [0.2.1] - 2026-05-18

### Changed

- Changed Metrics day-over-day growth to compare against the nearest prior day with recorded turns instead of strictly using calendar day minus one, so weekend/holiday gaps no longer force `n/a` growth.
- Changed Summary `Top agents` ordering to sort by turns descending first, then runtime tokens descending.
- Changed Summary `Top capabilities` duration to use average duration based on calls with available duration data.
- Changed ingest to use per-file cursor offsets for incremental JSONL reads instead of re-reading all event files on every run.
- Changed cleanup to delete matching ingest file cursor rows when raw log files are deleted.

## [0.2.0] - 2026-05-15

### Added

- Added `archive monthly` to roll up complete months older than the recent six-month retention window into monthly archive tables and remove corresponding daily raw shards and daily stats.
- Added `backfill codex --date YYYY-MM-DD` to rebuild missing Codex normalized events from local transcript JSONL files, including explicit and inferred skill usage, with event ID and similar-event deduplication.
- Added Himan skill metadata ingestion from local `himan.yaml` files, including static skill token estimates, versions, content hashes, dependencies, and metadata issues in the SQLite projection.
- Added a local server Metrics page and `/metrics.json` endpoint with daily, weekly, and monthly token, duration, project, capability, and alert insights.

### Changed

- Changed the local server Metrics page to highlight severity levels, growth, and decreases with color-coded badges and text.
- Changed Metrics weekly and monthly insights to use natural weeks and natural months with fixed Daily/Weekly/Monthly tabs and labels such as `2026 Week 14 (03-30 ~ 04-05)` and `2026-04`.
- Changed dashboard Token usage weekly rows to use year-based natural week labels such as `2026 Week 14 (03-30 ~ 04-05)`.
- Changed CLI weekly token reports to use the same year-based natural week labels as the local server.
- Changed Metrics capability tables to show total duration, duration growth, total runtime tokens, and runtime token growth alongside averages and standard deviations.
- Changed Metrics token labels to call out runtime observed tokens separately from himan.yaml static token estimates.
- Changed Metrics capability tables to show whether duration values come from capability events or turn-level estimates.
- Changed Metrics alerts to sort by severity and magnitude so the highest-risk alerts appear first.
- Changed Metrics overall tables to show recent period rows instead of only the current day, week, or month.

### Fixed

- Fixed Metrics project and capability alerts so projects or capabilities that drop to zero in the current period can trigger decrease alerts.
- Fixed Metrics alert value formatting so invocation counts render as counts instead of token units.
- Fixed generated Codex hook helpers to fall back to the source checkout `dist/cli/index.js` when the Codex hook environment cannot resolve the published `himan-tracker` command.

## [0.1.2] - 2026-05-15

### Added

- Added `server start --display table|text` to choose between HTML table dashboard sections and CLI-style text blocks.

### Changed

- Changed the local report server Summary section to include aggregate usage metrics in table and text display modes.
- Changed summary report Top agents headings to include the top-N count.
- Changed local report server Summary subheadings to use the same note-row style as other dashboard text tables.
- Changed table-mode Summary dashboard content to render as HTML tables instead of CLI-style text blocks.
- Changed token usage report periods to sort newest first.
- Changed compact Summary tables to size to their content instead of spanning the full dashboard width.

## [0.1.1] - 2026-05-14

### Added

- Added a favicon for the local report server dashboard and `server start --open` to launch the dashboard in the default browser.
- Added `/dashboard.json` to the local report server for structured dashboard data.
- Added a tabbed local report server card for recent skill and MCP tool calls.

### Changed

- Changed the local report server dashboard to render structured HTML tables instead of preformatted CLI text blocks.
- Changed the `capabilities` duration output to show average, minimum, and maximum duration in separate columns and sort `--sort duration` by average duration.

### Fixed

- Fixed `himan-tracker -v/--version` to report the current `package.json` version instead of a hard-coded `0.0.1` value.

## [0.1.0] - 2026-05-13

### Added

- Added `build:sandbox` as a local TypeScript build script that avoids the pnpm shim path in sandboxed environments.
- Added `tokens --period day|week|month` for daily, weekly, and monthly token usage reports, and surfaced the same token trend tables on the local report server dashboard.

### Changed

- Changed the local report server Summary to show 15 non-system capabilities, and the Capabilities card to show the top 25 with total capability count.
- Changed the local report server dashboard to show daily, weekly, and monthly token usage in a single tabbed card.
- Changed duration formatting in reports to use readable minute and hour units for longer runs.
- Changed Codex setup output to warn when Himan hooks are already configured in the other Codex scope.

### Fixed

- Fixed duplicate Codex global/project hooks generating separate observed event IDs for the same hook payload when Codex omits source timestamps.
- Fixed `server stop` timing out when the report server had already closed its state file but the process had not fully exited yet, and made shutdown close HTTP connections promptly.

## [0.0.3] - 2026-05-13

### Added

- Added `server start`, `server status`, and `server stop` to run a local report Web server that periodically ingests JSONL events and serves dashboard pages.

### Changed

- Changed capability reports to distinguish explicit, inferred, observed, and unknown invocation origins instead of showing the misleading `Estimated tokens` column.
- Changed capability event records to persist and report source and invocation origin alongside attribution confidence.
- Changed Codex inferred skill usage to consult project `himan.lock` when available, so transcript `SKILL.md` reads only count Codex skills installed by Himan.
- Changed `summary` to show a `Top N capabilities` heading, show up to 10 top capabilities by default, and accept `--limit` for overriding the row count.
- Added `--exclude-system` to `summary` and `capabilities` reports to hide built-in system capabilities such as `Bash` and `apply_patch`.

## [0.0.2] - 2026-05-13

### Added

- Added npm publishing configuration for the public scoped package `@hi-man/himan-tracker`, including release/version scripts and GitHub Actions publish workflows.
- Added `collect --agent codex` as a non-blocking Codex data entry point with a local async queue and hook-friendly `--quiet` mode.
- Added `setup --agent codex` to install Codex hooks for the current project by default, with `-g, --global` for global installation.
- Added asynchronous Codex transcript enrichment to fill turn token counts without blocking hooks.
- Added explicit `$skill-name` extraction from Codex `UserPromptSubmit` payloads without persisting prompt content.
- Added transcript-derived Codex MCP tool usage and inferred skill usage from `SKILL.md` reads without persisting arguments or content.
- Added `cleanup` to delete raw JSONL logs by all, cutoff date, date range, or age while retaining SQLite statistics.
- Added `turns` to show per-turn duration, token, and status details.
- Added `capability-events` to inspect individual skill, MCP tool, plugin, built-in tool, shell command, or unknown capability calls.

### Changed

- Changed npm publish workflow configuration to publish scoped packages explicitly as public and use npm Trusted Publishing's supported Node/npm versions.
- Changed package metadata from a private local package to the published npm package name `@hi-man/himan-tracker`.
- Documented the current Codex integration workflow in README.
- Changed generated Codex hook helpers to run the published `himan-tracker collect` command instead of the source checkout command.
- Changed Codex hook setup to include `UserPromptSubmit` alongside `PostToolUse` and `Stop`.
- Changed generated Codex config to use `[features].hooks` and remove deprecated `[features].codex_hooks`.
- Changed Codex transcript enrichment to fill turn and tool duration metrics when available.
- Changed token totals in CLI reports to use compact decimal units such as `K`, `M`, and `G`.
- Updated `doctor` to report collect queue, lock directory, and Codex hook readiness.
- Changed local JSONL storage to daily `events/` and `errors/` shards, with `ingest` scanning event shards by default.

## [0.0.1] - 2026-05-12

### Added

- Initialized product, technical design, MVP planning, and user-facing README documentation.
- Added project-local skills for blueprint, technical design, MVP planning, startup, changelog, and development workflow guidance.
- Added `common-sprint-autopilot` skill for named sprint planning and step-by-step development execution.
- Added Codex repository map and root `AGENTS.md` instructions for durable project onboarding.
- Initialized TypeScript CLI project structure with `himan-tracker` command metadata and `doctor` readiness checks.
- Added privacy-first local configuration and tracker path resolution.
- Added normalized event contracts, runtime validation, repo path hashing, token normalization, and capability classification.
- Added MVP development progress plan and initial normalizer/config test coverage.
- Added append-only JSONL event collection with fail-open error logging and privacy tests.
- Added SQLite schema migrations, idempotent JSONL ingest, daily stats aggregation, and `ingest --from/--rebuild`.
- Added `summary`, `agents`, `capabilities`, and `unused` CLI reports with table output, filters, sorting, empty states, and `n/a` formatting.
- Added fixture-first Codex and Claude Code adapters with stable normalized fixture coverage.
- Added developer validation documentation separate from the user-facing README.

### Changed

- Updated `doctor` to initialize and check the local SQLite projection.
- Updated README, MVP docs, and repository guidance to reflect the current MVP workflow and CLI command forms.
