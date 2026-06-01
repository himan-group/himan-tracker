# 开发与验证

本文档面向项目开发者和维护者，记录构建、测试、已发布 CLI smoke check 和发布流程的常用命令。最终用户快速使用说明见 [README.md](../README.md)，完整用户手册见 [用户手册](./user-guide.md)。

## 环境要求

- Node.js `>=20.11`
- pnpm `10.33.4`，或使用项目锁定版本兼容的 pnpm

安装依赖：

```bash
pnpm install
```

## CLI Smoke Check

查看帮助：

```bash
himan-tracker --help
```

运行 `doctor` 时建议使用临时 tracker home，避免污染真实用户目录：

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
```

如果没有在真实 Codex 配置中运行过 `setup`，`doctor` 输出 `codex hooks: not configured yet` 是预期结果。

## 验证命令

代码变更后运行：

```bash
pnpm run typecheck
pnpm test
```

需要确认构建产物时运行：

```bash
pnpm run build
```

CLI 行为变更后至少运行：

```bash
himan-tracker --help
himan-tracker setup codex --dry-run
himan-tracker setup copilot --dry-run
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker doctor
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker collect --agent copilot --from tests/fixtures/copilot/hook-raw/session.json --sync --strict
```

涉及 ingest 或报表时，可以继续用临时 tracker home 做 smoke check：

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker ingest --rebuild
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker summary --since 7d
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker agents --date 2026-05-12
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker capabilities --since 30d
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check himan-tracker unused --since 30d
```

## npm 发布流程

包名配置为 `@hi-man/himan-tracker`，使用 npm public scoped package 发布。维护者发布前应先把用户可见变更写入 `CHANGELOG.md` 的 `## [Unreleased]`。

发布版本准备：

```bash
pnpm run version:patch
pnpm run version:minor
pnpm run version:major
```

这些脚本会使用 `npm version --no-git-tag-version` 更新 `package.json`，并运行 `scripts/release-changelog.mjs`，把 `[Unreleased]` 内容移动到当前版本的日期分区。

本地发布前检查：

```bash
pnpm run verify
pnpm run release:dry
```

GitHub Actions 发布流程：

- PR 合入 `master` 前会运行 `.github/workflows/pr-verify.yml`，执行 typecheck、test、build 和 `npm pack --dry-run`。
- PR 合入 `master` 前会运行 `.github/workflows/pr-version-check.yml`，检查 `v{version}` tag 和 npm 上的同版本包是否已存在。
- merge 或 push 到 `master` 后，`.github/workflows/publish-npm.yml` 会重新验证、通过 npm Trusted Publishing 发布，并在发布成功后创建 `v{version}` tag。
- npm 上必须先存在 `hi-man` organization，或者发布账号必须拥有这个 scope 的发布权限；否则首次发布 `@hi-man/himan-tracker` 会返回 registry 404。
- npm Trusted Publisher 需要在 npm 包设置中指向 GitHub 仓库 `himan-group/himan-tracker` 和 workflow filename `publish-npm.yml`；不要提交包含 token 的 `.npmrc`。
- publish workflow 使用 Node.js `22.14` 和 npm `^11.5.1`，以满足 npm Trusted Publishing 的 OIDC 要求。Trusted Publishing 会自动生成 provenance，不需要在发布命令里手动加 `--provenance`。
- 只在发布基础设施或认证失败时手动 rerun publish workflow，不要用它发布任意旧 commit。

如果 npm 发布成功但 tag 推送失败，可在对应 release commit 上手动恢复：

```bash
git tag -a v<version> <commit-sha> -m "Release v<version>"
git push origin v<version>
```

## 开发注意事项

- 不要直接编辑 `dist/` 输出。
- 使用 `HIMAN_TRACKER_HOME` 隔离本地验证数据。
- `setup --dry-run` 可验证 hook 安装输出，不会写入真实 `.codex/`。
- `collect --agent codex` 默认异步入队；开发验证可以加 `--sync --strict` 获得确定性结果。
- `ingest --from` 的 JSONL 输入必须是一行一个 normalized event。
- `ingest --rebuild` 会删除并重建 SQLite 投影文件。
- README 面向最终用户，不放构建、测试、源码运行和内部验证流程。
