# MVP 详细技术方案

本文档将 MVP feature 拆解为可实现的模块方案。除非后续代码约定另有调整，开发时应优先遵循本方案。

## 1. 技术栈建议

| 领域 | 建议 | 理由 |
| --- | --- | --- |
| Runtime | Node.js LTS | 跨平台、适合 CLI 和本地 hook 集成 |
| Language | TypeScript | 数据契约清晰，便于 adapter 和报表演进 |
| CLI parser | `commander` | 命令结构简单稳定 |
| Runtime schema | `zod` | normalized event 校验需要运行时保障 |
| SQLite driver | `better-sqlite3` | 本地 CLI 同步读写简单，部署成本低 |
| Test runner | `vitest` | TypeScript 项目启动成本低，适合 fixtures |
| Table output | `cli-table3` 或轻量自实现 | MVP 只需要稳定表格输出 |

依赖选择应在初始化工程时最终确认。若项目决定减少依赖，schema validator 和 table formatter 可以先自实现，但接口边界保持不变。

## 2. 模块边界

```text
src/
  adapters/         # Agent-specific payload -> adapter event
  normalizer/       # adapter event -> normalized event
  collector/        # write normalized event to JSONL
  storage/          # SQLite connection and migrations
  aggregator/       # JSONL -> SQLite projection
  reports/          # query result -> display model/table
  cli/              # command parsing and orchestration
  config/           # paths, config file, privacy defaults
  types/            # shared event and storage types
tests/
  fixtures/         # stable raw and normalized examples
```

核心约束：

- Adapter 不写文件、不写 SQLite。
- Normalizer 不知道 CLI。
- Collector 只负责 JSONL 和错误日志。
- Aggregator 只消费 normalized events。
- Reports 只读取 SQLite 查询结果。
- CLI 只做参数解析和模块编排。

## 3. 数据流

### 3.1 采集路径

```text
Agent Hook Payload
  -> AgentAdapter.parseHookPayload
  -> normalizeEvent
  -> validateNormalizedEvent
  -> writeEventJsonl
```

失败策略：

- Adapter parse 失败：写 `errors/YYYY-MM-DD.jsonl`，返回成功 exit code，避免阻塞 agent。
- Normalizer 校验失败：写 `errors/YYYY-MM-DD.jsonl`，跳过该事件。
- JSONL 写入失败：写 stderr 或 fallback error record，不影响 agent 流程。

### 3.2 查询路径

```text
events/*.jsonl
  -> himan-tracker ingest
  -> SQLite base tables
  -> daily stats tables
  -> report queries
  -> CLI table output
```

MVP 不要求实时聚合。用户可以显式执行 `ingest`，后续可在 report 命令执行前自动触发增量 ingest。

## 4. Event Contract 实现

### 4.1 TypeScript 类型

建议文件：

- `src/types/events.ts`

核心类型：

```ts
type AgentName = "codex" | "claude-code";
type EventStatus = "success" | "failure" | "cancelled" | "unknown";
type CapabilityType =
  | "skill"
  | "mcp_tool"
  | "plugin"
  | "builtin_tool"
  | "shell_command"
  | "unknown";
type AttributionConfidence = "exact" | "estimated" | "unknown";
```

事件类型：

- `TurnSummaryEvent`
- `CapabilityUsageEvent`
- `SessionSummaryEvent`
- `NormalizedEvent`

### 4.2 Event ID

建议文件：

- `src/normalizer/normalizeEvent.ts`

`event_id` 生成规则：

```text
sha256(schema_version + event_type + agent + session_id + turn_id + occurred_at + capability_type + capability_name)
```

规则要求：

- 使用稳定字段，不使用 ingest 时间。
- capability 字段为空时使用空字符串。
- 同一事件重复归一化必须得到同一个 ID。

### 4.3 Token 字段

规则：

- 来源提供 `total_tokens` 时直接使用。
- 来源未提供总数，但有 input/output 时计算总数。
- input/output 都缺失时，三个 token 字段保持 `null`。
- 聚合报表中 `null` 显示为 `n/a`，不要当作 0 展示给用户。

## 5. Config 与 Path 实现

建议文件：

- `src/config/paths.ts`
- `src/config/userConfig.ts`

### 5.1 路径解析

优先级：

```text
HIMAN_TRACKER_HOME
  -> ~/.himan-tracker
```

派生路径：

```ts
type TrackerPaths = {
  homeDir: string;
  configPath: string;
  eventsPath: string;
  errorsPath: string;
  sqlitePath: string;
  locksDir: string;
};
```

### 5.2 配置读取

启动时行为：

- 如果 config 不存在，创建默认配置。
- 如果 config 存在，读取并合并默认值。
- 未知字段保留但不参与 MVP 逻辑。
- 本地 salt 首次生成后持久化。

建议配置字段：

```ts
type UserConfig = {
  schema_version: "1.0";
  privacy: {
    capture_content: boolean;
    hash_repo_path: boolean;
    capture_shell_args: boolean;
  };
  agents: {
    codex: { enabled: boolean };
    "claude-code": { enabled: boolean };
  };
  known_capabilities: Array<{
    type: CapabilityType;
    name: string;
  }>;
  local_salt: string;
};
```

## 6. Collector 实现

建议文件：

- `src/collector/hookCollector.ts`
- `src/collector/jsonlWriter.ts`

### 6.1 JSONL Writer

接口：

```ts
type JsonlWriter = {
  append(path: string, record: unknown): Promise<void>;
};
```

实现要求：

- `JSON.stringify(record) + "\n"` 一次性 append。
- 写入前确保父目录存在。
- 捕获异常并交给 error logger。
- 不 pretty-print，保证一行一个事件。

### 6.2 Error Record

错误日志结构：

```json
{
  "schema_version": "1.0",
  "occurred_at": "2026-05-12T03:45:00.000Z",
  "source": "collector",
  "agent": "codex",
  "message": "validation failed",
  "details": {
    "reason": "missing session_id"
  }
}
```

不得将原始 prompt、response 或代码片段放入 `details`。

## 7. SQLite 与 Migration 实现

建议文件：

- `src/storage/sqlite.ts`
- `src/storage/migrations/001_initial.sql`

### 7.1 Migration 表

增加内部 migration 表：

```sql
create table if not exists schema_migrations (
  version text primary key,
  applied_at text not null
);
```

### 7.2 MVP 表

基础表：

- `ingested_events`
- `sessions`
- `turns`
- `capability_usages`

聚合表：

- `daily_agent_stats`
- `daily_capability_stats`

关键索引：

```sql
create index if not exists idx_turns_occurred_at on turns(occurred_at);
create index if not exists idx_turns_agent_model on turns(agent, model);
create index if not exists idx_capability_usages_occurred_at on capability_usages(occurred_at);
create index if not exists idx_capability_usages_lookup
  on capability_usages(agent, capability_type, capability_name);
create index if not exists idx_daily_agent_stats_date on daily_agent_stats(date);
create index if not exists idx_daily_capability_stats_date on daily_capability_stats(date);
```

## 8. Aggregator 实现

建议文件：

- `src/aggregator/aggregateEvents.ts`
- `src/aggregator/dailyStats.ts`

### 8.1 Ingest 算法

```text
open sqlite transaction
read JSONL line by line
  parse line as JSON
  validate normalized event
  if event_id already exists:
    skip
  insert into base table
  insert into ingested_events
  remember affected date
for each affected date:
  delete daily stats for date
  recompute daily agent stats from turns
  recompute daily capability stats from capability_usages
commit transaction
```

### 8.2 Base Table 写入

`turn_summary`：

- upsert `turns` by `event_id` 或 `turn_id`。
- upsert `sessions` with minimal session metadata when session does not exist.

`capability_usage`：

- insert `capability_usages` with `event_id` as primary key.
- preserve `attribution_confidence`.

`session_summary`：

- upsert `sessions` by `session_id`。
- update `ended_at`、`duration_ms`、`turn_count`、`status`。

### 8.3 Daily Stats 重算

日期来源：

```text
date = occurred_at converted to local date, formatted YYYY-MM-DD
```

MVP 使用本机时区即可。未来如果要团队协作，应在配置中显式指定 timezone。

## 9. CLI 报表实现

建议文件：

- `src/cli/index.ts`
- `src/cli/commands/*.ts`
- `src/reports/formatTable.ts`
- `src/reports/summaryReport.ts`

### 9.1 参数解析

时间参数：

- `--since 7d`
- `--since 30d`
- `--date YYYY-MM-DD`

`--since` MVP 支持单位：

- `d`：天
- `w`：周，按 7 天计算
- `m`：月，按 30 天计算

### 9.2 Summary 查询

输出字段：

- date range
- sessions
- turns
- total tokens
- average latency
- success rate
- top agents
- top capabilities by tokens

### 9.3 Agents 查询

SQL 读取 `daily_agent_stats`，按 date range 聚合：

```text
group by agent, model
```

排序：

```text
total_tokens desc, turn_count desc
```

### 9.4 Capabilities 查询

SQL 读取 `daily_capability_stats`，按 date range 聚合：

```text
group by agent, capability_type, capability_name
```

支持：

- `--sort invocations`
- `--sort tokens`
- `--sort duration`
- `--sort failures`
- `--type <capability_type>`
- `--agent <agent>`

### 9.5 Unused 查询

候选集合：

```text
historical capabilities union config.known_capabilities
```

未使用判断：

```text
no capability_usage in target date range
```

输出字段：

- type
- name
- last_used_at
- historical_invocations
- historical_tokens

## 10. Adapter 实现

建议文件：

- `src/adapters/codex/index.ts`
- `src/adapters/claude-code/index.ts`

### 10.1 Adapter 接口

```ts
type AgentAdapter = {
  agent: "codex" | "claude-code";
  parseHookPayload(payload: unknown): AdapterEvent[];
};
```

`AdapterEvent` 是进入 normalizer 前的中间结构。它可以包含来源私有字段，但不得被 storage 或 report 直接依赖。

### 10.2 Codex Adapter

处理 hook：

- `UserPromptSubmit`：提取 session、repo、显式 skill 候选。
- `PreToolUse`：提取 tool name，并记录开始时间。
- `PostToolUse`：生成 capability usage 候选。
- `Stop`：生成 turn/session summary 候选。

Codex 具体字段以 fixture 为准。第一版开发必须先提交 raw fixture，再实现 parser。

### 10.3 Claude Code Adapter

处理 hook：

- 工具调用前后事件映射为 capability usage。
- 会话或 turn 结束事件映射为 summary。
- 不存在 token 信息时保留 `null`。

Claude Code 具体字段以 fixture 为准。第一版开发必须先提交 raw fixture，再实现 parser。

## 11. Capability 分类实现

建议文件：

- `src/normalizer/capabilityClassifier.ts`

分类顺序：

1. 来源字段明确声明类型。
2. MCP 命名空间，例如 `mcp__server__tool`。
3. 已知 plugin 前缀。
4. shell execution 事件。
5. 内置工具映射表。
6. `unknown`。

输出：

```ts
type ClassifiedCapability = {
  type: CapabilityType;
  name: string;
  confidence: "exact" | "estimated" | "unknown";
};
```

注意：classification confidence 不等于 token attribution confidence，两者不要混用。

## 12. 隐私实现

### 12.1 Repo Hash

```text
repo_hash = sha256(normalizePath(repoPath) + local_salt)
```

要求：

- `repoPath` 不进入 normalized event。
- `local_salt` 仅保存在本地配置中。
- 测试中使用固定 salt，保证 snapshot 稳定。

### 12.2 Shell Command

默认记录：

```json
{
  "capability_type": "shell_command",
  "capability_name": "git",
  "status": "success"
}
```

不记录：

- 完整命令行。
- 参数。
- stdout/stderr。

未来可通过 `capture_shell_args=true` 开启参数采集，但不属于 MVP。

## 13. 测试方案

### 13.1 Fixture 目录

建议结构：

```text
tests/fixtures/
  codex/
    raw/
    normalized/
  claude-code/
    raw/
    normalized/
  jsonl/
  sqlite/
  reports/
```

### 13.2 测试清单

| 测试 | 覆盖 |
| --- | --- |
| Adapter fixture tests | raw hook payload 到 adapter event |
| Normalizer tests | adapter event 到 normalized event |
| Schema tests | required fields、enum、schema version |
| JSONL tests | 一行一 JSON、写入失败处理 |
| Aggregator tests | 幂等导入、daily stats 重算 |
| CLI tests | 参数解析、空状态、表格输出 |
| Privacy tests | 不输出 prompt、response、code、明文 repo path |

### 13.3 质量门禁

MVP 合并前至少运行：

```bash
pnpm test
pnpm run typecheck
```

如果工程初始化后使用不同脚本，应同步更新本文档。

## 14. 开发顺序

### Milestone 1：工程骨架

交付：

- `package.json`
- TypeScript config
- CLI entry
- `doctor`
- config/path module

验收：

- `himan-tracker --help` 可运行。
- `himan-tracker doctor` 可检查默认目录。

### Milestone 2：事件与落盘

交付：

- event types
- schema validator
- normalizer
- JSONL writer
- error writer

验收：

- 手工输入 normalized event 可以落盘。
- 非法事件进入 error log。

### Milestone 3：SQLite 与聚合

交付：

- migrations
- ingest
- base tables
- daily stats

验收：

- JSONL fixture 可导入。
- 重复导入不重复计数。

### Milestone 4：报表

交付：

- summary
- agents
- capabilities
- unused
- table formatter

验收：

- fixture SQLite 输出稳定报表。
- 空数据库输出可读空状态。

### Milestone 5：Agent Adapter

交付：

- Codex raw fixtures
- Codex adapter
- Claude Code raw fixtures
- Claude Code adapter

验收：

- 两类 agent fixture 均可输出 normalized events。
- adapter 失败不会阻断 agent。

### Milestone 6：MVP 收口

交付：

- privacy tests
- README 使用说明
- docs 同步
- release checklist

验收：

- 本地完整测试通过。
- MVP features 中所有 `P0` 完成，`P1` 至少完成 adapter fixture 和关键测试。

## 15. MVP Definition of Done

MVP 完成需要同时满足：

- `himan-tracker doctor` 可运行并报告本地状态。
- Codex 和 Claude Code 的 fixture 可以生成 normalized events。
- `events/*.jsonl` 可以作为事实源重建 SQLite。
- `summary`、`agents`、`capabilities`、`unused` 可以基于 fixture 数据输出报表。
- 重复 ingest 不产生重复统计。
- 默认事件不包含 prompt、response、代码内容或明文 repo path。
- 测试覆盖核心数据路径和隐私约束。
