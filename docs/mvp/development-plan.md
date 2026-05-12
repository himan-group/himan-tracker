# MVP 开发计划

本文档用于按步骤推进 `himan-tracker` MVP 开发。每一步都应形成可运行、可验证的增量，避免长期停留在半成品状态。

阶段名称：MVP 阶段

需求与技术来源：

- `docs/mvp/features.md`
- `docs/mvp/technical-plan.md`
- `docs/technical-design.md`
- `AGENTS.md`
- `docs/codex/repo-map.md`

## 开发原则

- 先打通本地数据闭环，再接入真实 agent。
- 先用 fixture 验证行为，再接入 Codex / Claude Code hook。
- 每个步骤尽量独立提交，避免把无关变更混在一起。
- `MVP-F10` 隐私与安全要求贯穿所有步骤，不作为最后补丁。
- 每步完成后至少运行对应的最小验证命令。

## 总体顺序

```text
工程骨架与 CLI
  -> 配置、路径与事件契约
  -> JSONL Collector
  -> SQLite 与 Ingest
  -> CLI 报表
  -> Agent Adapter
  -> 测试与 MVP 收口
```

## 当前进度

最后检查日期：2026-05-12

| Step | 状态 | 说明 |
| --- | --- | --- |
| Step 1：工程骨架与 CLI 基础 | 已完成 | CLI 工程、package scripts、TypeScript、`doctor`、默认路径解析已可运行 |
| Step 2：配置、路径与事件契约 | 已完成 | 配置、事件类型、schema、normalizer、repo hash、capability classifier 已完成 |
| Step 3：JSONL Collector | 已完成 | JSONL writer、fail-open collector、错误日志和隐私测试已完成 |
| Step 4：SQLite 与 Ingest | 已完成 | SQLite schema、migration runner、幂等 ingest、`--from`、`--rebuild` 和 daily stats 已完成 |
| Step 5：CLI 报表 | 已完成 | `summary`、`agents`、`capabilities`、`unused`、表格输出、筛选排序和空状态已完成 |
| Step 6：Agent Adapter | 已完成 | Codex/Claude Code 构造 fixture、adapter 解析、Codex setup/collect 入口和 normalized fixture 测试已完成 |
| Step 7：测试与 MVP 收口 | 已完成 | schema、JSONL、aggregator、CLI、privacy、adapter fixture 测试和 README/docs 同步已完成 |

最近验证：

- `pnpm run typecheck`：通过。
- `pnpm test`：通过，46 个测试全部通过。
- `pnpm run build`：通过。
- `pnpm cli --help`：通过。
- `pnpm cli setup --dry-run`：通过，可预览项目级 Codex hooks 安装内容且不写入文件。
- `HIMAN_TRACKER_HOME=/private/tmp/himan-tracker-final-check-95ad7ef pnpm cli doctor`：通过，SQLite 可初始化并应用 `001_initial` migration，未安装 hooks 时显示 `codex hooks` warning。
- `HIMAN_TRACKER_HOME=/private/tmp/himan-tracker-final-check-95ad7ef pnpm cli ingest --rebuild`：通过，空事件日志可重建 SQLite 投影。
- `HIMAN_TRACKER_HOME=/tmp/himan-tracker-collect-check pnpm cli collect --agent codex --from tests/fixtures/codex/raw/session.json --sync --strict`：通过，Codex payload 可入队并前台 drain 到日分片 JSONL。
- `HIMAN_TRACKER_HOME=/tmp/himan-tracker-async-check pnpm cli collect --agent codex --from tests/fixtures/codex/raw/session.json`：通过，默认异步 worker 可 drain 队列且命令返回 0。
- `HIMAN_TRACKER_HOME=/tmp/himan-tracker-quiet-check pnpm cli collect --agent codex --from tests/fixtures/codex/raw/session.json --quiet`：通过，hook 场景可关闭 collector summary 输出并异步写入事件。
- `HIMAN_TRACKER_HOME=/private/tmp/himan-tracker-final-check-95ad7ef pnpm cli summary --since 7d`：通过，空数据库输出明确空状态。
- `HIMAN_TRACKER_HOME=/private/tmp/himan-tracker-report-check-9b56998 pnpm cli agents --date 2026-05-12`：通过，空数据库输出明确空状态。
- `HIMAN_TRACKER_HOME=/private/tmp/himan-tracker-report-check-9b56998 pnpm cli capabilities --since 30d`：通过，空数据库输出明确空状态。
- `HIMAN_TRACKER_HOME=/private/tmp/himan-tracker-report-check-9b56998 pnpm cli unused --since 30d`：通过，空数据库输出明确空状态。

## Step 1：工程骨架与 CLI 基础

覆盖 feature：

- `MVP-F01`
- `MVP-F02` 的基础部分

目标：

- 初始化 Node.js + TypeScript CLI 工程。
- 建立 `himan-tracker` 命令入口。
- 实现 `--help` 和 `doctor` 的最小可用版本。

主要文件：

- `package.json`
- `tsconfig.json`
- `src/cli/index.ts`
- `src/cli/commands/doctor.ts`
- `src/config/paths.ts`

任务清单：

- [x] 初始化 package scripts。
- [x] 配置 TypeScript 编译。
- [x] 接入 CLI parser。
- [x] 暴露 `himan-tracker` bin。
- [x] 实现 `doctor` 基础输出。
- [x] 实现默认数据目录解析。

验收标准：

- [x] `himan-tracker --help` 可运行。
- [x] `himan-tracker doctor` 可运行。
- [x] `doctor` 能显示配置、数据目录、事件日志和 SQLite 路径状态。

建议验证：

```bash
pnpm run typecheck
pnpm test
```

## Step 2：配置、路径与事件契约

覆盖 feature：

- `MVP-F02`
- `MVP-F03`
- `MVP-F10` 的基础部分

目标：

- 实现本地配置读写。
- 定义 normalized event 类型和 schema。
- 实现稳定 `event_id`。
- 实现 repo path hash 和隐私默认值。

主要文件：

- `src/config/userConfig.ts`
- `src/types/events.ts`
- `src/normalizer/normalizeEvent.ts`
- `src/normalizer/capabilityClassifier.ts`

任务清单：

- [x] 支持 `HIMAN_TRACKER_HOME`。
- [x] 生成默认 `config.json`。
- [x] 持久化 `local_salt`。
- [x] 定义 `TurnSummaryEvent`。
- [x] 定义 `CapabilityUsageEvent`。
- [x] 定义 `SessionSummaryEvent`。
- [x] 实现 schema validation。
- [x] 实现 `event_id` 生成。
- [x] 实现 capability 分类基础规则。

验收标准：

- [x] 未设置环境变量时使用 `~/.himan-tracker`。
- [x] 设置 `HIMAN_TRACKER_HOME` 后读写目录切换。
- [x] 非法事件能被拒绝并返回可解释错误。
- [x] 重复输入同一事件能生成相同 `event_id`。
- [x] normalized event 不包含 prompt、response、代码内容或明文 repo path。

建议验证：

```bash
pnpm run typecheck
pnpm test
```

## Step 3：JSONL Collector

覆盖 feature：

- `MVP-F04`
- `MVP-F10`

目标：

- 实现 append-only JSONL 事件日志。
- 实现错误日志。
- 保证采集失败不阻塞 agent 工作流。

主要文件：

- `src/collector/jsonlWriter.ts`
- `src/collector/hookCollector.ts`

任务清单：

- [x] 实现一行一 JSON 的 append writer。
- [x] 写入前确保父目录存在。
- [x] 实现 `events/YYYY-MM-DD.jsonl` writer。
- [x] 实现 `errors/YYYY-MM-DD.jsonl` writer。
- [x] 实现 collector fail-open 行为。
- [x] 增加 JSONL writer tests。
- [x] 增加 privacy tests。

验收标准：

- [x] 连续写入多条事件后每行都可以独立解析。
- [x] 写入失败不会让 collector 崩溃。
- [x] error record 不包含敏感原文。

建议验证：

```bash
pnpm test
```

## Step 4：SQLite 与 Ingest

覆盖 feature：

- `MVP-F05`
- `MVP-F06`

目标：

- 建立 SQLite schema 和 migrations。
- 实现 JSONL 到 SQLite 的导入。
- 实现幂等去重和 daily stats 重算。

主要文件：

- `src/storage/sqlite.ts`
- `src/storage/migrations/001_initial.sql`
- `src/aggregator/aggregateEvents.ts`
- `src/aggregator/dailyStats.ts`
- `src/cli/commands/ingest.ts`

任务清单：

- [x] 实现 `schema_migrations`。
- [x] 创建 base tables。
- [x] 创建 daily stats tables。
- [x] 实现 migration runner。
- [x] 实现 `ingest` 命令。
- [x] 支持 `--from <path>`。
- [x] 支持 `--rebuild`。
- [x] 实现 `ingested_events` 去重。
- [x] 实现按日期重算 stats。
- [x] 增加 aggregator fixture tests。

验收标准：

- [x] 首次运行可以创建 SQLite 数据库。
- [x] 同一 JSONL 重复导入不会重复计数。
- [x] `--rebuild` 可以从 JSONL 重建投影数据库。
- [x] fixture 的 agent stats 和 capability stats 与预期一致。

建议验证：

```bash
pnpm run typecheck
pnpm test
```

## Step 5：CLI 报表

覆盖 feature：

- `MVP-F07`

目标：

- 实现用户可用的查询报表。
- 支持空状态、筛选、排序和 `n/a` 展示。

主要文件：

- `src/cli/commands/summary.ts`
- `src/cli/commands/agents.ts`
- `src/cli/commands/capabilities.ts`
- `src/cli/commands/unused.ts`
- `src/reports/formatTable.ts`
- `src/reports/summaryReport.ts`

任务清单：

- [x] 实现 `summary --since 7d`。
- [x] 实现 `agents --date YYYY-MM-DD`。
- [x] 实现 `capabilities --since 30d`。
- [x] 支持 `capabilities --sort`。
- [x] 支持 `capabilities --type`。
- [x] 支持 `capabilities --agent`。
- [x] 实现 `unused --since 30d`。
- [x] 实现空数据库输出。
- [x] 增加 CLI snapshot tests。

验收标准：

- [x] summary 显示 session、turn、token、latency、success rate 和 top capabilities。
- [x] agents 按 agent/model 聚合。
- [x] capabilities 支持排序和筛选。
- [x] unused 同时支持历史事件和 `known_capabilities`。
- [x] token 或耗时缺失时显示 `n/a`。

建议验证：

```bash
pnpm test
```

## Step 6：Agent Adapter

覆盖 feature：

- `MVP-F08`
- `MVP-F09`
- `MVP-F10`

目标：

- 通过 fixture-first 的方式接入 Codex 和 Claude Code。
- Adapter 只负责解析来源 payload，不直接写 JSONL 或 SQLite。

主要文件：

- `src/adapters/codex/index.ts`
- `src/adapters/codex/fixtures/*`
- `src/adapters/claude-code/index.ts`
- `src/adapters/claude-code/fixtures/*`
- `tests/fixtures/codex/*`
- `tests/fixtures/claude-code/*`

任务清单：

- [x] 收集或构造 Codex raw fixture。
- [x] 定义 Codex normalized fixture。
- [x] 实现 Codex adapter。
- [x] 收集或构造 Claude Code raw fixture。
- [x] 定义 Claude Code normalized fixture。
- [x] 实现 Claude Code adapter。
- [x] 确认 adapter failure 不阻塞 agent。
- [x] 增加 adapter fixture tests。

验收标准：

- [x] Codex fixture 可以产出稳定 normalized events。
- [x] Claude Code fixture 可以产出稳定 normalized events。
- [x] 未识别字段不会导致 adapter 崩溃。
- [x] adapter 不直接访问 SQLite。

建议验证：

```bash
pnpm run typecheck
pnpm test
```

## Step 7：测试与 MVP 收口

覆盖 feature：

- `MVP-F11`
- 所有 `P0` feature

目标：

- 补齐质量门禁。
- 确认 MVP Definition of Done。
- 更新用户使用说明。

主要文件：

- `tests/fixtures/*`
- `README.md`
- `docs/mvp/*`

任务清单：

- [x] 补齐 schema tests。
- [x] 补齐 JSONL tests。
- [x] 补齐 aggregator idempotency tests。
- [x] 补齐 CLI snapshot tests。
- [x] 补齐 privacy tests。
- [x] 更新 README 安装和命令说明。
- [x] 同步 docs 与实际实现。
- [x] 整体运行 typecheck 和 tests。

验收标准：

- [x] `himan-tracker doctor` 可运行并报告本地状态。
- [x] Codex 和 Claude Code fixture 可以生成 normalized events。
- [x] `events/*.jsonl` 可以作为事实源重建 SQLite。
- [x] `summary`、`agents`、`capabilities`、`unused` 可以基于 fixture 数据输出报表。
- [x] 重复 ingest 不产生重复统计。
- [x] 默认事件不包含 prompt、response、代码内容或明文 repo path。
- [x] 测试覆盖核心数据路径和隐私约束。

建议验证：

```bash
pnpm run typecheck
pnpm test
```

## 开发节奏建议

- Step 1 至 Step 5 优先完成，形成无 agent 依赖的本地分析闭环。
- Step 6 再接入 Codex 和 Claude Code，降低 hook 格式不稳定对核心架构的影响。
- 每个 Step 完成后单独提交，commit message 使用 Conventional Commits。
- 每次开始新 Step 前先检查 `git status --short`，避免混入无关变更。
