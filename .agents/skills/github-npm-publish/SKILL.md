---
name: github-npm-publish
description: Design, audit, or maintain a reusable GitHub Actions workflow for publishing npm packages. Use when Codex needs to add or review local package version scripts that update CHANGELOG.md, PR checks before merging to main/master, duplicate npm version/tag prevention, npm Trusted Publishing or NPM_TOKEN publishing, post-merge npm publish jobs, release tags, or release documentation for JavaScript/TypeScript npm packages.
---

# github-npm-publish

Use this skill to add or review a generic GitHub-driven npm release pipeline for a JavaScript or TypeScript package.

## Discover First

Before editing, inspect the target project and adapt names to local conventions:

- Package manager and lockfile: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, or `bun.lockb`.
- Runtime pinning: `.nvmrc`, `.node-version`, `volta`, or `engines.node`.
- Default release branch: usually `main` or `master`.
- Existing scripts: `test`, `typecheck`, `build`, `verify`, `release`, `version:*`, `prepublishOnly`.
- Changelog format: Keep a Changelog, Changesets, Release Please, semantic-release, or custom `CHANGELOG.md`.
- Publish auth: prefer npm Trusted Publishing with GitHub OIDC; use `NPM_TOKEN` only when Trusted Publishing is not available for the package.
- Package shape: single package, workspace package, public scoped package requiring `publishConfig.access=public`, or private/internal registry.

Do not replace an established release system such as Changesets, Release Please, or semantic-release unless the user explicitly asks. Instead, align this workflow with that system.

## Target Flow

Implement or verify this release lifecycle:

1. Local version bump updates `package.json` and moves `CHANGELOG.md` `[Unreleased]` entries into a dated release section.
2. PRs into the release branch run required checks and fail when the proposed npm version was already released or tagged.
3. A push or merge to the release branch runs verification and publishes the package to npm.
4. The release commit is tagged as `v{package.version}` or the project's existing tag format.

## Local Version And Changelog

Prefer explicit package scripts so maintainers do not hand-edit version and changelog state independently:

```json
{
  "scripts": {
    "changelog:release": "node scripts/release-changelog.mjs",
    "version:patch": "npm version patch --no-git-tag-version && npm run changelog:release",
    "version:minor": "npm version minor --no-git-tag-version && npm run changelog:release",
    "version:major": "npm version major --no-git-tag-version && npm run changelog:release"
  }
}
```

Adapt the runner for the package manager:

- pnpm project: keep `npm version ... --no-git-tag-version` for the version mutation, but call `pnpm run changelog:release`.
- npm project: use `npm run changelog:release`.
- Yarn/Bun project: prefer their local script runner after the version command if it matches project conventions.

The changelog release script should:

- Read the current package version from `package.json`.
- Require `CHANGELOG.md` to contain `## [Unreleased]`.
- Require `[Unreleased]` to have content before releasing.
- Fail if `CHANGELOG.md` already has `## [version]`.
- Insert `## [version] - YYYY-MM-DD` immediately below `[Unreleased]`.
- Move the old unreleased body into the new version section.
- Leave `[Unreleased]` present at the top for future changes.

Use the current local date for `YYYY-MM-DD`. Do not guess stale release dates.

## PR Checks

Create one workflow for normal verification and one workflow for version availability, or combine them when the project prefers fewer workflow files.

Recommended PR verification:

- Trigger on `pull_request` into the release branch.
- Check out the PR head SHA.
- Install the package manager with the pinned version when the project pins one.
- Use the pinned Node version.
- Install with frozen/immutable lockfile mode.
- Run the narrow required checks for the package, typically:
  - typecheck, if TypeScript is used
  - tests
  - build
  - optionally `npm pack --dry-run` or the package manager equivalent for publish-sensitive packages

Recommended duplicate-version check:

- Read `package.json` version from the PR head.
- Build the release tag, usually `v{version}`.
- Fail if the remote Git tag already exists.
- For stronger protection, also check npm for the package version:
  - `npm view <package-name>@<version> version --registry=https://registry.npmjs.org`
  - treat a returned version as already published
  - allow a 404/not-found response to pass

Require these PR workflow checks in branch protection for the release branch.

## Publish On Merge

Create a publish workflow that runs on push to the release branch and supports manual `workflow_dispatch` reruns.

Recommended behavior:

- Use `concurrency` so two publish jobs cannot race for the same package.
- Grant `contents: read`.
- Grant `id-token: write` when using npm Trusted Publishing.
- Check out the release branch commit.
- Install package manager and Node using project pins.
- Install dependencies with frozen/immutable lockfile mode.
- Run the canonical release script, usually:

```json
{
  "scripts": {
    "verify": "npm run typecheck && npm test && npm run build",
    "release": "npm run verify && npm publish"
  }
}
```

For pnpm projects, use:

```json
{
  "scripts": {
    "verify": "pnpm run typecheck && pnpm test && pnpm run build",
    "release": "pnpm run verify && npm publish"
  }
}
```

Prefer `npm publish` as the final publish command even in pnpm projects because npm owns registry publication and Trusted Publishing support.

## Authentication

Prefer npm Trusted Publishing:

- Configure the npm package Trusted Publisher to point at the repository and publish workflow filename.
- In GitHub Actions, set `permissions.id-token: write`.
- Use `actions/setup-node` with `registry-url: https://registry.npmjs.org`.
- Use an npm CLI version that supports Trusted Publishing if the runner's bundled npm is too old.

Fallback to token publishing only when required:

- Store the automation token as `NPM_TOKEN` in GitHub secrets.
- Set `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` only on the publish step.
- Do not commit `.npmrc` files containing tokens.

## Release Tags

If the project does not already have a release-tagging system, add a post-merge workflow or a publish-job step that creates `v{package.version}`.

Recommended tag behavior:

- Fetch remote tags before checking availability.
- If the tag already exists, warn or fail based on project policy.
- Create an annotated tag at the release commit.
- Push only that tag.
- If publishing succeeded but tag push failed, give maintainers a manual recovery command.

For strict release integrity, tag after successful publish. For simple branch-history traceability, tag on push to the release branch. Be explicit about the chosen tradeoff in docs.

## Workflow Files

Use local names when they already exist. Otherwise these names are clear defaults:

- `.github/workflows/pr-verify.yml`
- `.github/workflows/pr-version-check.yml`
- `.github/workflows/publish-npm.yml`
- `.github/workflows/tag-version.yml`

For branch names, replace `main` with the project's release branch when needed.

## Documentation

Document the maintainer flow in the project's development docs or README:

- Add changelog entries under `[Unreleased]`.
- Run `npm run version:patch`, `version:minor`, or `version:major` before the release PR merges.
- Confirm PR checks pass.
- Merge to the release branch.
- GitHub Actions publishes to npm.
- Rerun the publish workflow manually only for failed infrastructure/authentication attempts, not for arbitrary older commits.
- Recover failed tags manually with the exact tag name and commit SHA.

## Validation

Before finalizing changes:

- Re-read `package.json`, `CHANGELOG.md`, and all touched workflow files.
- Run the project's normal verification command if code or scripts changed.
- Run the changelog/version script in a disposable branch or test fixture when practical.
- Run `git diff --check` for YAML, markdown, and script edits.
- For publish workflow changes, run the local dry-run script when available, such as `npm publish --dry-run` or `npm run release:dry`.

## Avoid

- Do not publish directly from PR workflows.
- Do not publish before tests/build pass.
- Do not rely only on Git tags if npm can already contain the version.
- Do not create local Git tags during package version scripts unless the project intentionally releases from local tags.
- Do not hard-code `main` or `master` without checking the target repository.
- Do not introduce `NPM_TOKEN` when Trusted Publishing is already configured and working.
- Do not place new work in an older dated changelog section.
