# Codex Instructions

## Project Snapshot

`himan-tracker` is a local-first TypeScript CLI for AI coding agent observability. The MVP focuses on Codex and Claude Code metadata tracking: sessions, turns, tokens, latency, success status, and capability usage.

Current implementation is early MVP:

- CLI skeleton, `doctor`, `collect`, `ingest`, and report commands are implemented.
- Config/path handling, normalized event contracts, JSONL collection, SQLite ingestion, and agent adapters are implemented.
- `collect --agent codex` is the current Codex data entry point; Claude Code collection remains future work.

## Commands

Use the package scripts from `package.json` for build/test, and the published CLI command for smoke checks:

```bash
pnpm run build
pnpm run typecheck
pnpm test
himan-tracker --help
himan-tracker doctor
himan-tracker setup --dry-run
himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
```

In Codex sandboxed sessions, prefer this build command because `pnpm run build` may hang and then fail with `fetch failed`:

```bash
npm run build:sandbox
```

If npm is not available, run the same compiler directly:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
```

When running `doctor`, prefer a temp data home:

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
```

When validating `collect`, prefer a temp data home and `--sync --strict` for deterministic foreground processing:

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
```

## Architecture

Current source layout:

- `src/cli/`: CLI entry and commands.
- `src/config/`: tracker data paths and user config defaults.
- `src/types/`: shared TypeScript contracts.
- `src/normalizer/`: adapter event to normalized event conversion, zod schema validation, privacy helpers, and capability classification.
- `src/collector/`: JSONL event/error writers and async collect queue.
- `src/storage/`: SQLite connection and migrations.
- `src/aggregator/`: JSONL-to-SQLite projection and daily stats.
- `src/reports/`: report queries and formatting.
- `src/adapters/`: Codex and Claude Code payload parsers.

Follow `docs/technical-design.md` and `docs/mvp/development-plan.md` for expected module boundaries.

## Coding Workflow

- Read nearby files before editing and follow existing TypeScript style.
- Keep CLI orchestration thin; put behavior in command modules and shared helpers.
- Keep adapter parsing separate from normalizer, collector, storage, and reports.
- Keep `collect` hook-safe: default behavior must not return non-zero or block Codex when collection fails; use `--quiet` in hooks and `--strict` only for manual validation.
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
npm run build:sandbox
```

For CLI behavior changes, also run a smoke command such as:

```bash
himan-tracker --help
himan-tracker setup --dry-run
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
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
