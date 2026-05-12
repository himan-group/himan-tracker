# Codex Instructions

## Project Snapshot

`himan-tracker` is a local-first TypeScript CLI for AI coding agent observability. The MVP focuses on Codex and Claude Code metadata tracking: sessions, turns, tokens, latency, success status, and capability usage.

Current implementation is early MVP:

- CLI skeleton and `doctor` are implemented.
- Config/path handling and normalized event contracts are implemented.
- JSONL collector, SQLite ingestion, report commands, and agent adapters are still planned.

## Commands

Use the package scripts from `package.json`:

```bash
pnpm run build
pnpm run typecheck
pnpm test
pnpm cli --help
pnpm cli doctor
```

When running `doctor`, prefer a temp data home:

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli doctor
```

## Architecture

Current source layout:

- `src/cli/`: CLI entry and commands.
- `src/config/`: tracker data paths and user config defaults.
- `src/types/`: shared TypeScript contracts.
- `src/normalizer/`: adapter event to normalized event conversion, zod schema validation, privacy helpers, and capability classification.

Planned source areas:

- `src/collector/`: JSONL event/error writers.
- `src/storage/`: SQLite connection and migrations.
- `src/aggregator/`: JSONL-to-SQLite projection and daily stats.
- `src/reports/`: report queries and formatting.
- `src/adapters/`: Codex and Claude Code payload parsers.

Follow `docs/technical-design.md` and `docs/mvp/development-plan.md` for expected module boundaries.

## Coding Workflow

- Read nearby files before editing and follow existing TypeScript style.
- Keep CLI orchestration thin; put behavior in command modules and shared helpers.
- Keep adapter parsing separate from normalizer, collector, storage, and reports.
- Do not edit generated `dist/` output directly.
- Use `.gitkeep` only for empty directories that need to stay tracked.
- Preserve existing user changes; do not reset, clean, or discard files unless explicitly asked.

## Data And Privacy

Default tracker home:

```text
~/.himan-tracker
```

`HIMAN_TRACKER_HOME` overrides that location.

Privacy defaults:

- `capture_content=false`
- `hash_repo_path=true`
- `capture_shell_args=false`

Do not add prompt text, response text, code content, plaintext repo paths, stdout/stderr, or shell args to normalized events unless a future explicit opt-in feature is implemented.

## Documentation

- `README.md`: user-facing product and usage manual only.
- `CHANGELOG.md`: Keep a Changelog style release history.
- `docs/blueprint.md`: product direction and scope.
- `docs/technical-design.md`: architecture, storage, data contracts, CLI behavior, and validation strategy.
- `docs/mvp/features.md`: MVP feature inventory.
- `docs/mvp/technical-plan.md`: detailed MVP implementation plan.
- `docs/mvp/development-plan.md`: step-by-step execution status and checklists.
- `docs/codex/repo-map.md`: durable repository map for Codex.

## Validation

For code changes, run:

```bash
pnpm run typecheck
pnpm test
```

For CLI behavior changes, also run a smoke command such as:

```bash
pnpm cli --help
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli doctor
```

If a check cannot be run, report the reason and the risk.

## Skill Routing

- Use `common-dev-pattern` for nontrivial code changes.
- Use `common-project-blueprint` for product positioning, scope, target users, or user-facing README/manual content.
- Use `common-project-tech-design` for architecture, module boundaries, data contracts, storage, CLI/API design, tests, and directory bootstrap.
- Use `common-project-mvp` for MVP features, milestones, acceptance criteria, and development progress.
- Use `common-sprint-autopilot` for named sprint/stage planning and step-by-step execution across multiple requirements.
- Use `common-project-changelog` for user-visible CLI/API behavior changes, package version changes, direct changelog edits, release notes, and changelog placement fixes.
- Use `common-git-commit` when asked to commit local changes. Never push unless explicitly asked.

## Release And Changelog

Keep `CHANGELOG.md` updated under `## [Unreleased]`.

Use `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, and `### Security` headings when applicable.

Do not add new entries to dated release sections after they are cut.
