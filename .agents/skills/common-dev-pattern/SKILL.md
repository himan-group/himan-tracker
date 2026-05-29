---
name: common-dev-pattern
description: Follow existing repository patterns for code changes and validate them before the final response. Use for nontrivial edits across pages, components, services, tests, build config, generated files, APIs, migrations, or integration code.
---

# common-dev-pattern

Use this skill while implementing code changes in an existing repository. The goal is to make new code fit local conventions and leave the change verified.

## Before Editing

1. Locate the nearest existing implementation for the requested behavior.
   - Same feature, route, module, package, service, component, hook, model, client, test, or build area
   - Same validation, error handling, state management, styling, logging, telemetry, and naming conventions
2. Read 2-3 nearby files that represent the local pattern.
3. Check local guidance when present:
   - `AGENTS.md`
   - `docs/repository-map.md`
   - Legacy `docs/codex/repo-map.md`
   - `.cursor/rules/**/*.mdc`
   - Feature-level docs that already exist
4. Summarize the pattern you will follow in one or two sentences, then edit.

When editing repository guidance, keep `AGENTS.md` and repository map docs readable as normal engineering documentation. Mark Codex-specific content explicitly with labels such as `Codex-specific:` or `Codex-Specific Notes`.

Use `docs/repository-map.md` as the canonical repository map path. If only legacy `docs/codex/repo-map.md` exists, read it for compatibility and ask the user whether to migrate before changing paths. If the user enables the new path, move or recreate the map at `docs/repository-map.md` and delete the legacy `docs/codex/repo-map.md` file.

## During Editing

- Prefer existing helpers, shared components, hooks, services, API clients, test utilities, and module boundaries before adding new abstractions.
- Use the repository's existing dependency, UI, state, data-fetching, validation, routing, and testing conventions.
- Treat generated or derived files as outputs unless local docs explicitly say they should be edited.
- Keep entry files thin when nearby code delegates to feature components, containers, services, or helpers.
- Keep edits scoped to the requested behavior and the minimum supporting files needed for validation.
- For user-visible CLI behavior changes, new commands/options, output changes, or workflow changes, update `CHANGELOG.md` under `[Unreleased]` using `common-project-changelog`.

## Validate

Run the narrowest reliable checks first, then broaden when the change risk is higher.

1. Inspect manifests, scripts, lockfiles, and project config files to identify available checks.
2. Choose checks that match the edited surface:
   - Formatting for style-only or broad mechanical edits
   - Lint for JavaScript, TypeScript, CSS, Python, Go, Rust, Java, or project-specific static checks
   - Typecheck or compile checks for typed code changes
   - Targeted tests for changed functions, components, services, routes, or integration points
   - Build checks for user-facing, bundler, packaging, or cross-module changes
   - Code generation checks when generated artifacts or schemas are involved
3. Prefer the repository's package manager and documented commands.
4. If full validation is too expensive or blocked, run the most relevant partial check and clearly report what was not run.

## Final Response

Include:

- Checks run and pass/fail result
- Any formatter or autofix that changed files
- Any skipped check and the reason

## Avoid

- Do not add a new architecture, folder convention, state library, request layer, design system, or test framework unless the existing code already uses it or the task explicitly requires it.
- Do not refactor unrelated code while implementing the request.
- Do not hide lint, type, test, or build failures. Fix them when they are caused by your changes.
- Do not manually edit generated files to make validation pass unless the repository explicitly treats them as checked-in source artifacts.
