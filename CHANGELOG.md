# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Added `collect --agent codex` as a non-blocking Codex data entry point with a local async queue and hook-friendly `--quiet` mode.
- Added `setup --agent codex` to install Codex hooks for the current project by default, with `-g, --global` for global installation.

### Changed

- Documented the current Codex integration workflow in README.
- Changed generated Codex hook helpers to run `pnpm cli collect` from the source checkout while no npm package is published.
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
