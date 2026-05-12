# 开发与验证

本文档面向项目开发者和维护者，记录从源码运行、构建、测试和 smoke check 的常用命令。最终用户使用说明见 [README.md](../README.md)。

## 环境要求

- Node.js `>=20.11`
- pnpm `10.33.4`，或使用项目锁定版本兼容的 pnpm

安装依赖：

```bash
pnpm install
```

## 从源码运行 CLI

查看帮助：

```bash
pnpm cli --help
```

运行 `doctor` 时建议使用临时 tracker home，避免污染真实用户目录：

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli doctor
```

当前阶段 `doctor` 输出 `hooks: not configured yet` 是预期结果，因为一键 hook 安装尚未实现。

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
pnpm cli --help
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli doctor
```

涉及 ingest 或报表时，可以继续用临时 tracker home 做 smoke check：

```bash
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli ingest --rebuild
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli summary --since 7d
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli agents --date 2026-05-12
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli capabilities --since 30d
HIMAN_TRACKER_HOME=/tmp/himan-tracker-check pnpm cli unused --since 30d
```

## 开发注意事项

- 不要直接编辑 `dist/` 输出。
- 使用 `HIMAN_TRACKER_HOME` 隔离本地验证数据。
- JSONL 输入必须是一行一个 normalized event。
- `ingest --rebuild` 会删除并重建 SQLite 投影文件。
- README 面向最终用户，不放构建、测试、源码运行和内部验证流程。
