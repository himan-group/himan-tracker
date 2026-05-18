# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
