# Metrics & Alerts Sprint

阶段名称：Metrics & Alerts Sprint

需求与技术来源：

- 用户提供的指标与预警需求：
  - 整体日/周/月 token 消费量与增长、对话时长与变化。
  - 项目维度 token 消耗、skill/MCP 调用量和 token 占比。
  - Capability 维度耗时、token、调用量、成功率以及平均/最大/最小/标准差。
  - 整体、项目、Capability 的 20% / 40% / 60% 变化预警。
  - Capability 耗时、token、调用量、成功率的标准差和变化预警。
- `docs/technical-design.md`
- `src/server/reportServer.ts`
- `src/reports/*`
- `src/storage/sqlite.ts`
- `CHANGELOG.md`

已知约束：

- runtime token 只使用事件中的 `total_tokens`，不混入 `entryTokens` 或 `packageTokens`。
- 项目维度使用 `repo_hash`，不显示明文项目路径。
- 新指标优先通过本地 server 新页面展示；CLI 可后续扩展。
- 标准差在应用层计算，避免依赖 SQLite 数学扩展。

| Step | 状态 | 说明 |
| --- | --- | --- |
| MAS-1：指标与预警计算内核 | completed | 新增整体、项目、Capability 的 period metrics、growth、stddev 和 alert 计算 |
| MAS-2：Metrics 页面与 JSON API | completed | 新增 `/metrics` 和 `/metrics.json`，展示日/周/月指标与预警 |
| MAS-3：文档、changelog、验证与提交 | completed | 更新 changelog，运行验证，完成提交 |

## MAS-1：指标与预警计算内核

目标：

- 建立可复用的 metrics service，计算整体、项目、Capability 的日/周/月指标。
- 支持当前周期与上一周期的增长率计算。
- 支持 20% / 40% / 60% 分级预警。
- 支持 Capability 耗时和 token 的平均、最大、最小、标准差。

范围：

- `src/reports/metricsInsights.ts`
- `tests/reports/metricsInsights.test.ts`

依赖：

- SQLite 中已有 `turns`、`capability_usages`、`daily_agent_stats`、`daily_capability_stats`。
- project 维度使用 `repo_hash`。

验证命令：

```bash
node --import tsx --test tests/reports/metricsInsights.test.ts
npx tsc -p tsconfig.json --noEmit
```

验收标准：

- [x] 能返回日/周/月三个 period 的整体 token、duration、growth 和 alerts。
- [x] 能按 `repo_hash` 返回项目 token、duration、skill/MCP 调用和占比。
- [x] 能按 capability 返回调用量、成功率、duration/token avg/min/max/stddev 和 growth。
- [x] 上一周期为空或为 0 时 growth 为 `null` 且不触发变化预警。
- [x] 标准差计算不依赖 SQLite 扩展。

## MAS-2：Metrics 页面与 JSON API

目标：

- 在本地 server 新增独立 Metrics 页面。
- 暴露结构化 `/metrics.json` 数据。
- 页面展示整体、项目、Capability 指标和预警。

范围：

- `src/server/reportServer.ts`
- `tests/cli/server.test.ts`

依赖：

- MAS-1 完成。

验证命令：

```bash
node --import tsx --test tests/cli/server.test.ts
npx tsc -p tsconfig.json --noEmit
```

验收标准：

- [x] `GET /metrics` 返回 HTML 页面。
- [x] `GET /metrics.json` 返回 metrics insight DTO。
- [x] 页面导航包含 Overview 与 Metrics。
- [x] 页面明确展示日/周/月 tabs 或分组。
- [x] 空数据时有明确 empty state。

## MAS-3：文档、changelog、验证与提交

目标：

- 更新 changelog。
- 运行完整验证。
- 完成 sprint 提交。

范围：

- `CHANGELOG.md`
- `docs/sprints/metrics-alerts-sprint.md`

依赖：

- MAS-1、MAS-2 完成。

验证命令：

```bash
pnpm test
npm run build:sandbox
git diff --check
```

验收标准：

- [x] Changelog 位于 `[Unreleased]`。
- [x] Sprint 计划状态更新。
- [x] 完整测试和 sandbox build 通过。
- [x] 创建本地 commit，不 push。

验证记录：

- `node --import tsx --test tests/reports/metricsInsights.test.ts`
- `node --import tsx --test tests/cli/server.test.ts`
- `pnpm run typecheck`
- `pnpm test`
- `npm run build:sandbox`
- `git diff --check`
