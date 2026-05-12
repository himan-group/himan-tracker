# himan-tracker 技术方案

本文档基于 [blueprint.md](./blueprint.md) 设计，用于指导 `himan-tracker` 的 MVP 开发。

## 1. 设计目标

`himan-tracker` 是一个本地优先的 AI coding agent 使用分析工具。MVP 需要稳定回答以下问题：

- Codex 和 Claude Code 分别被使用了多少次。
- 每个模型消耗了多少 token，带来了多少延迟。
- skill、MCP tool、plugin、内置工具、shell command 等 capability 的实际调用情况。
- 哪些 capability 有调用、成本和耗时，哪些长期未使用。

MVP 不采集 prompt、response 和代码内容，只采集元数据，并以本地 JSONL 和 SQLite 作为事实源与查询源。

## 2. 核心技术决策

### 2.1 本地优先

默认数据目录：

```text
~/.himan-tracker
```

建议支持环境变量覆盖：

```text
HIMAN_TRACKER_HOME=/custom/path
```

所有写入默认发生在本机，不做远程上传。未来若加入团队分析或远程 telemetry，应作为显式 opt-in 功能。

### 2.2 事件溯源 + SQLite 投影

MVP 采用两层存储：

- `events/YYYY-MM-DD.jsonl`：按天分片的 append-only 原始事件日志，便于调试、回放和重新聚合。
- `himan.sqlite`：聚合查询数据库，服务 CLI 报表。

JSONL 是事实源。SQLite 中的数据可以通过 JSONL 重新生成，因此聚合逻辑应设计为可重放、幂等。

### 2.3 Agent Adapter 隔离差异

Codex 和 Claude Code 的 hook 事件格式可能不同。MVP 不让业务层直接依赖原始 hook 格式，而是通过 adapter 转换为统一事件。

统一流水线：

```text
Codex / Claude Code
        |
        v
Agent Adapter
        |
        v
Hook Event Collector
        |
        v
Normalizer
        |
        v
JSONL Event Store
        |
        v
SQLite Aggregator
        |
        v
CLI Reports
```

### 2.4 Capability 作为核心分析维度

所有可观测能力统一抽象为 `capability`，类型限定为：

- `skill`
- `mcp_tool`
- `plugin`
- `builtin_tool`
- `shell_command`
- `unknown`

后续报表、ROI 和清理建议都围绕这个维度扩展。

### 2.5 采集失败不影响 Agent 执行

hook collector 必须 fail-open：

- 采集失败时记录本地错误日志。
- 不阻塞 Codex 或 Claude Code 的正常工作流。
- 不修改 agent 原有输入输出。

建议错误日志路径：

```text
~/.himan-tracker/errors/YYYY-MM-DD.jsonl
```

## 3. 推荐工程结构

当前仓库尚未建立代码目录。建议 MVP 采用 TypeScript + Node.js 实现 CLI 和 hook adapter，理由是 JSON 处理、CLI 分发、跨平台安装和本地 hook 脚本集成都较直接。

建议目录：

```text
src/
  adapters/
    codex/
      index.ts
      fixtures/
    claude-code/
      index.ts
      fixtures/
  aggregator/
    aggregateEvents.ts
    dailyStats.ts
  cli/
    index.ts
    commands/
      summary.ts
      agents.ts
      capabilities.ts
      unused.ts
      ingest.ts
      doctor.ts
  collector/
    hookCollector.ts
    jsonlWriter.ts
  config/
    paths.ts
    userConfig.ts
  normalizer/
    normalizeEvent.ts
    capabilityClassifier.ts
  reports/
    formatTable.ts
    summaryReport.ts
  storage/
    sqlite.ts
    migrations/
  types/
    events.ts
    storage.ts
tests/
  fixtures/
docs/
  blueprint.md
  technical-design.md
```

命令入口建议暴露为：

```text
himan-tracker
```

## 4. 数据契约

### 4.1 通用事件字段

所有进入 JSONL 的规范化事件都应包含以下基础字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema_version` | string | 事件 schema 版本，MVP 使用 `1.0` |
| `event_id` | string | 幂等 ID，建议由稳定字段 hash 得到 |
| `event_type` | string | 事件类型 |
| `occurred_at` | string | ISO 8601 时间 |
| `agent` | string | `codex` 或 `claude-code` |
| `source` | string | 原始来源，如 `codex-hook` |
| `session_id` | string | agent session ID |
| `turn_id` | string? | agent turn ID，可为空 |
| `repo_hash` | string? | 仓库路径 hash，不存明文路径 |
| `status` | string | `success`、`failure`、`cancelled`、`unknown` |

### 4.2 Turn Summary Event

用途：统计对话轮次、模型、token 和延迟。

```json
{
  "schema_version": "1.0",
  "event_id": "evt_...",
  "event_type": "turn_summary",
  "occurred_at": "2026-05-12T03:45:00.000Z",
  "agent": "codex",
  "source": "codex-hook",
  "model": "gpt-5.1-codex",
  "session_id": "s_001",
  "turn_id": "t_001",
  "duration_ms": 42000,
  "input_tokens": 12000,
  "output_tokens": 1800,
  "total_tokens": 13800,
  "status": "success"
}
```

字段规则：

- `total_tokens` 优先使用来源提供的总数。
- 若来源没有总数，则使用 `input_tokens + output_tokens`。
- token 缺失时允许为 `null`，聚合时不当作 0，避免误导成本统计。

### 4.3 Capability Usage Event

用途：统计 skill、tool、plugin 和 shell command 的调用情况。

```json
{
  "schema_version": "1.0",
  "event_id": "evt_...",
  "event_type": "capability_usage",
  "occurred_at": "2026-05-12T03:45:12.000Z",
  "agent": "claude-code",
  "source": "claude-code-hook",
  "session_id": "s_001",
  "turn_id": "t_001",
  "capability_type": "mcp_tool",
  "capability_name": "github.create_pull_request",
  "duration_ms": 3000,
  "input_tokens": 800,
  "output_tokens": 120,
  "total_tokens": 920,
  "status": "success",
  "adopted": "unknown",
  "attribution_confidence": "estimated"
}
```

`attribution_confidence` 用于标记 token 归因可信度：

- `exact`：agent 或 hook 明确提供 capability 级 token。
- `estimated`：按请求或工具调用上下文估算。
- `unknown`：无法归因。

MVP 报表应展示该字段，避免把估算值表达成精确值。

### 4.4 Session Event

建议在 v0.1 支持会话开始和结束事件，便于后续统计 session 数和异常结束。

```json
{
  "schema_version": "1.0",
  "event_id": "evt_...",
  "event_type": "session_summary",
  "occurred_at": "2026-05-12T04:10:00.000Z",
  "agent": "codex",
  "source": "codex-hook",
  "session_id": "s_001",
  "turn_count": 8,
  "duration_ms": 1500000,
  "status": "success"
}
```

## 5. Hook 与 Adapter 设计

### 5.1 Hook 映射

| Hook | 采集目的 | 产出事件 |
| --- | --- | --- |
| `UserPromptSubmit` | 检测显式 skill、repo/session 信息 | 可选 `capability_usage` |
| `PreToolUse` | 记录工具调用开始、准备计时 | 暂存上下文 |
| `PostToolUse` | 记录工具调用结果、耗时、状态 | `capability_usage` |
| `Stop` | 聚合 turn/session 摘要 | `turn_summary`、`session_summary` |

### 5.2 Adapter 接口

建议内部接口：

```ts
type AgentAdapter = {
  agent: "codex" | "claude-code";
  parseHookPayload(payload: unknown): NormalizedEvent[];
};
```

实现要求：

- Adapter 只负责解析来源格式和提取字段。
- Normalizer 负责补默认值、生成 `event_id`、校验 schema。
- Collector 负责落盘，不理解 agent 业务细节。

### 5.3 Capability 分类规则

建议从高置信到低置信依次分类：

1. 明确声明为 skill、MCP tool、plugin 的来源字段。
2. tool name 前缀或命名空间，例如 `mcp__github__create_pull_request`。
3. shell 命令执行事件映射为 `shell_command`。
4. 已知内置工具表映射为 `builtin_tool`。
5. 其他归为 `unknown`。

分类逻辑应集中在 `normalizer/capabilityClassifier.ts`，不要散落在各 adapter 中。

## 6. 存储设计

### 6.1 文件布局

```text
~/.himan-tracker/
  config.json
  events/
    YYYY-MM-DD.jsonl
  errors/
    YYYY-MM-DD.jsonl
  himan.sqlite
  locks/
```

写入要求：

- JSONL 使用 append-only。
- 单条事件必须是一行合法 JSON。
- 多进程写入时使用文件锁或 SQLite ingestion 队列，避免交错写。
- 文件权限建议为 `0600`，目录权限建议为 `0700`。

### 6.2 SQLite 表

#### `ingested_events`

用于幂等去重。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `event_id` | text primary key | 事件 ID |
| `event_type` | text | 事件类型 |
| `occurred_at` | text | 发生时间 |
| `ingested_at` | text | 入库时间 |

#### `sessions`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text primary key | session ID |
| `agent` | text | agent 名称 |
| `started_at` | text? | 开始时间 |
| `ended_at` | text? | 结束时间 |
| `duration_ms` | integer? | 总耗时 |
| `turn_count` | integer | turn 数 |
| `status` | text | 状态 |
| `repo_hash` | text? | 仓库 hash |

#### `turns`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text primary key | turn ID |
| `session_id` | text | session ID |
| `agent` | text | agent 名称 |
| `model` | text? | 模型名 |
| `occurred_at` | text | 发生时间 |
| `duration_ms` | integer? | 请求耗时 |
| `input_tokens` | integer? | 输入 token |
| `output_tokens` | integer? | 输出 token |
| `total_tokens` | integer? | 总 token |
| `status` | text | 状态 |

#### `capability_usages`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text primary key | usage event ID |
| `session_id` | text | session ID |
| `turn_id` | text? | turn ID |
| `agent` | text | agent 名称 |
| `capability_type` | text | capability 类型 |
| `capability_name` | text | capability 名称 |
| `occurred_at` | text | 发生时间 |
| `duration_ms` | integer? | 耗时 |
| `input_tokens` | integer? | 输入 token |
| `output_tokens` | integer? | 输出 token |
| `total_tokens` | integer? | 总 token |
| `status` | text | 状态 |
| `adopted` | text | `yes`、`no`、`unknown` |
| `attribution_confidence` | text | `exact`、`estimated`、`unknown` |

#### `daily_agent_stats`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | text | `YYYY-MM-DD` |
| `agent` | text | agent 名称 |
| `model` | text? | 模型名 |
| `session_count` | integer | session 数 |
| `turn_count` | integer | turn 数 |
| `input_tokens` | integer | 输入 token 总和 |
| `output_tokens` | integer | 输出 token 总和 |
| `total_tokens` | integer | 总 token |
| `duration_ms` | integer | 总耗时 |
| `success_count` | integer | 成功 turn 数 |
| `failure_count` | integer | 失败 turn 数 |

主键建议为 `(date, agent, model)`。

#### `daily_capability_stats`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | text | `YYYY-MM-DD` |
| `agent` | text | agent 名称 |
| `capability_type` | text | capability 类型 |
| `capability_name` | text | capability 名称 |
| `invocation_count` | integer | 调用次数 |
| `input_tokens` | integer | 输入 token 总和 |
| `output_tokens` | integer | 输出 token 总和 |
| `total_tokens` | integer | 总 token |
| `duration_ms` | integer | 总耗时 |
| `success_count` | integer | 成功次数 |
| `failure_count` | integer | 失败次数 |
| `estimated_token_count` | integer | 使用估算 token 的事件数 |

主键建议为 `(date, agent, capability_type, capability_name)`。

## 7. 聚合逻辑

### 7.1 入库流程

```text
read events/*.jsonl
  |
  v
validate schema
  |
  v
skip if event_id exists in ingested_events
  |
  v
upsert base tables
  |
  v
recompute affected daily stats
```

推荐以日期为重算粒度：新事件影响哪一天，就重算该天的 agent 和 capability stats。这样逻辑简单，避免复杂增量修正。

### 7.2 成功率

成功率计算：

```text
success_rate = success_count / (success_count + failure_count)
```

`cancelled` 和 `unknown` 不进入分母，但应在详情报表中单独显示。

### 7.3 使用占比

Capability 报表中建议计算：

```text
usage_share = invocation_count / all_invocations
token_share = capability_total_tokens / all_capability_tokens
time_share = capability_duration_ms / all_capability_duration_ms
```

当分母为 0 或全部缺失时，显示 `n/a`。

### 7.4 未使用 capability

`unused` 命令需要一个候选 capability 清单。MVP 可先支持两种来源：

- 从历史事件中出现过，但指定时间窗口内未出现。
- 从本地配置 `known_capabilities` 中声明，但指定时间窗口内未出现。

配置示例：

```json
{
  "known_capabilities": [
    {
      "type": "skill",
      "name": "common-dev-pattern"
    }
  ]
}
```

## 8. CLI 设计

### 8.1 `summary`

```bash
himan-tracker summary --since 7d
```

输出建议：

- session count
- turn count
- total tokens
- average latency
- success rate
- top agents
- top capabilities by token

### 8.2 `agents`

```bash
himan-tracker agents --date 2026-05-12
```

输出建议列：

```text
agent | model | sessions | turns | tokens | avg latency | success rate
```

### 8.3 `capabilities`

```bash
himan-tracker capabilities --since 30d
```

输出建议列：

```text
type | name | invocations | tokens | duration | token share | time share | success rate
```

默认按 `total_tokens` 降序。支持参数：

```text
--sort invocations|tokens|duration|failures
--type skill|mcp_tool|plugin|builtin_tool|shell_command|unknown
--agent codex|claude-code
```

### 8.4 `unused`

```bash
himan-tracker unused --since 30d
```

输出建议列：

```text
type | name | last_used_at | historical_invocations | historical_tokens
```

### 8.5 `ingest`

```bash
himan-tracker ingest
```

用途：

- 默认从 `events/*.jsonl` 重建或更新 SQLite。
- 支持 `--rebuild` 删除并重建投影数据库。
- 支持 `--from <path>` 从指定 JSONL 导入。

### 8.6 `doctor`

```bash
himan-tracker doctor
```

检查项：

- 数据目录是否存在。
- JSONL 分片目录是否可写。
- SQLite 是否可打开。
- hook 配置是否可用。
- schema version 是否兼容。

## 9. 配置设计

默认配置路径：

```text
~/.himan-tracker/config.json
```

建议 schema：

```json
{
  "schema_version": "1.0",
  "privacy": {
    "capture_content": false,
    "hash_repo_path": true
  },
  "agents": {
    "codex": {
      "enabled": true
    },
    "claude-code": {
      "enabled": true
    }
  },
  "known_capabilities": [],
  "cost": {
    "currency": "USD",
    "models": {}
  }
}
```

MVP 只需要读取必要字段。未知字段应保留并忽略，方便未来版本兼容。

## 10. 隐私与安全

默认禁止采集：

- prompt 原文
- response 原文
- 代码内容
- 明文 repo path
- 明文用户主目录

建议策略：

- `repo_hash = sha256(normalized_repo_path + local_salt)`。
- `local_salt` 存在本地 config 中，不上传。
- shell command 默认只记录命令名和退出状态，不记录完整参数；如需完整参数，必须显式开启。
- 所有未来 content capture 功能都必须经过 redaction，并默认关闭。

## 11. 测试策略

MVP 至少需要以下测试：

- Adapter fixture tests：给定 Codex / Claude Code hook 样例，输出稳定的 normalized events。
- Schema validation tests：非法字段、未知版本、缺失必填字段能被拒绝或降级处理。
- JSONL writer tests：多条事件写入后每行都是合法 JSON。
- Aggregator tests：重复导入同一事件不会重复计数。
- CLI snapshot tests：固定 SQLite fixture 输出稳定表格。
- Privacy tests：确保 prompt、response、code content 不会出现在事件 JSON 中。

## 12. MVP 开发顺序

### Phase 1：基础工程与数据契约

- 初始化 TypeScript CLI 工程。
- 定义 normalized event types。
- 实现配置和路径解析。
- 实现 JSONL writer。
- 实现 SQLite 连接和 migrations。
- 实现 `doctor`。

验收标准：

- `himan-tracker doctor` 可以检查本地数据目录。
- 手工构造事件可以写入 `events/YYYY-MM-DD.jsonl`。

### Phase 2：事件导入与聚合

- 实现 `ingest`。
- 实现 `turn_summary` 和 `capability_usage` 入库。
- 实现 daily stats 重算。
- 增加幂等去重。

验收标准：

- 同一 JSONL 重复导入不会重复计数。
- daily agent stats 和 daily capability stats 与 fixture 预期一致。

### Phase 3：CLI 报表

- 实现 `summary`。
- 实现 `agents`。
- 实现 `capabilities`。
- 实现 `unused` 的历史事件模式。

验收标准：

- 能用 fixture 数据生成 7 天和 30 天报表。
- 支持按 agent、type 和 sort 字段筛选。

### Phase 4：Codex Adapter

- 接入 Codex hook payload。
- 映射 tool 使用和 turn summary。
- 补齐 Codex fixture。

验收标准：

- Codex 本地执行后能生成规范化事件。
- 采集失败不影响 Codex 原流程。

### Phase 5：Claude Code Adapter

- 接入 Claude Code hook payload。
- 映射 tool 使用和 turn summary。
- 补齐 Claude Code fixture。

验收标准：

- Claude Code 本地执行后能生成规范化事件。
- 与 Codex 事件在报表层表现一致。

### Phase 6：成本与 ROI 扩展准备

- 加入 model cost 配置读取。
- 在报表中增加 cost estimate 字段。
- 保留 ROI 所需字段，但不在 v0.1 强行给出评分。

验收标准：

- 缺少价格配置时显示 `n/a`。
- 有价格配置时可估算 token cost。

## 13. 风险与处理

| 风险 | 影响 | MVP 处理 |
| --- | --- | --- |
| Agent hook 字段不稳定 | adapter 易失效 | 用 fixtures 固化样例，adapter 独立版本化 |
| Capability token 难以精确归因 | 成本分析误导 | 引入 `attribution_confidence` |
| 多进程同时写 JSONL | 文件损坏或行交错 | 文件锁、单行 append、写入测试 |
| 用户隐私顾虑 | 无法推广使用 | 默认只采元数据，content capture 关闭 |
| 未使用 capability 缺少全集 | unused 结果不完整 | 支持 `known_capabilities` 配置 |
| SQLite 聚合逻辑复杂 | 报表不可信 | 先按日期重算，减少增量错误 |

## 14. 后续可扩展点

- OpenTelemetry exporter。
- Langfuse / Phoenix 集成。
- Dashboard UI。
- 团队级聚合。
- capability recommendation engine。
- low-value capability 自动检测。
- prompt / response opt-in capture + redaction。

## 15. 开发约束

后续实现应遵守：

- JSONL schema 先行，任何新增事件必须更新文档和测试。
- Adapter 不直接写数据库。
- Aggregator 不依赖原始 agent hook 格式。
- CLI 报表只读 SQLite，不直接扫描 hook payload。
- 所有隐私敏感字段默认不采集。
- 估算值必须标记为估算，不能伪装成精确统计。
