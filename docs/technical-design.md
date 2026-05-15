# himan-tracker 技术方案

本文档基于 [blueprint.md](./blueprint.md) 设计，用于指导 `himan-tracker` 的 MVP 开发。

## 1. 设计目标

`himan-tracker` 是一个本地优先的 AI coding agent 使用分析工具。MVP 需要稳定回答以下问题：

- Codex 和 Claude Code 分别被使用了多少次。
- 每个模型消耗了多少 token，带来了多少延迟。
- skill、MCP tool、plugin、内置工具、shell command 等 capability 的实际调用情况。
- 哪些 capability 有调用、成本和耗时，哪些长期未使用。
- Himan skill 的静态元数据、版本、依赖、静态 token 体量和 metadata 健康状态。

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
- hook 路径默认只做轻量解析、隐私脱敏和本地入队，真正写入事件日志由后台 worker 异步完成。
- hook 默认 exit code 必须保持为 `0`；人工验证才使用 `--strict`。
- hook 中建议使用 `--quiet`，避免 collector summary 写入 stdout 干扰 agent 流程。
- 对 Codex 来说，token 补数应放在后台 worker 中读取 `transcript_path`，hook 主路径只入队补数任务。

建议错误日志路径：

```text
~/.himan-tracker/errors/YYYY-MM-DD.jsonl
```

### 2.6 Skill 静态元数据与运行时指标分离

Himan skill 可通过 `himan.yaml` 提供静态分析元数据，例如版本、入口文件、content hash、静态 token 估算、依赖 skill、脚本和 MCP tool。`himan-tracker` 应把这些数据作为 capability definition metadata 使用，用于解释 skill 的规模、依赖、版本和维护质量。

`analysis.content.entryTokens` 和 `analysis.content.packageTokens` 是 skill 的静态值，不是某次 agent turn 的准确运行时 token。设计上必须保持两类口径分离：

- Runtime tokens：来自 agent hook、transcript 或结构化 telemetry 的实际运行时观测值，继续写入 `input_tokens`、`output_tokens`、`total_tokens`。
- Static tokens：来自 `himan.yaml` 的 `entryTokens`、`packageTokens`，只进入 `static_*` 或 `estimated_static_*` 字段，用于静态体量和潜在上下文压力分析。

所有报表和 API 文案都应使用 `Static`、`Estimated static` 或 `Instruction token estimate` 命名，避免把静态估算误读为真实消耗。

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
    himan/
      lockfile.ts
      metadata.ts
      skillManifest.ts
      dependencies.ts
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
      collect.ts
      setup.ts
      ingest.ts
      doctor.ts
  collector/
    eventQueue.ts
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
    skillInsightsReport.ts
  server/
    reportServer.ts
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
  "attribution_confidence": "estimated",
  "invocation_origin": "observed"
}
```

`attribution_confidence` 用于标记 capability 使用或指标归因的可信度：

- `exact`：agent、hook 或 transcript 结构化字段明确指向该 capability。
- `estimated`：按请求、路径或工具调用上下文推断。
- `unknown`：无法归因。

`invocation_origin` 用于标记 capability 使用是如何被识别出来的：

- `explicit`：用户或 hook 明确声明，例如 Codex prompt 中的 `$skill-name`。
- `inferred`：从 transcript 元数据推断，例如读取 `SKILL.md` 的 shell tool call。
- `observed`：由结构化 tool/MCP 事件直接观测。
- `unknown`：旧数据或无法判断。

MVP 报表应同时展示 `invocation_origin` 和 `attribution_confidence`，避免把“调用来源”和“归因置信度”混为同一口径。

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

### 4.5 Skill Definition Metadata

Skill definition metadata 来自 `himan.yaml`，用于描述 skill 的静态属性。它不是 append-only runtime event，而是 ingest / metadata sync 阶段写入 SQLite projection 的静态维表数据。

推荐支持的 `himan.yaml` 结构：

```yaml
name: common-dev-pattern
type: skill
version: 0.0.6
entry: SKILL.md
description: Follow existing repository patterns for code changes.
agents:
  - codex
analysis:
  content:
    tokenizer: approx-char-v1
    tokenEstimator: ceil(chars/4)
    entryTokens: 847
    packageTokens: 847
    contentHash: sha256:...
    measuredAt: 2026-05-14T07:52:32.527Z
    measuredBy: codex
  dependencies:
    skills:
      - common-project-changelog
    scripts: []
    mcpTools: []
  generation:
    generatedBy: codex
    generatedAt: 2026-05-14T07:52:32.527Z
    model: gpt-5
    promptRef: himan-skill-metadata
```

内部 DTO 建议：

```ts
type SkillDefinitionMetadata = {
  name: string;
  type: "skill";
  version: string | null;
  entry: string;
  description: string | null;
  agents: string[];
  static_entry_tokens: number | null;
  static_package_tokens: number | null;
  tokenizer: string | null;
  token_estimator: string | null;
  content_hash: string | null;
  measured_at: string | null;
  measured_by: string | null;
  generated_at: string | null;
  generated_by: string | null;
  dependencies: {
    skills: string[];
    scripts: Array<{ path: string }>;
    mcp_tools: string[];
  };
};
```

字段规则：

- `name` 必须与 skill folder 和 `SKILL.md` front matter 一致；不一致时记录 metadata issue。
- `type` 第一版只接受 `skill`。
- `entry` 默认是 `SKILL.md`，但仍按 metadata 保存，便于未来支持其他入口。
- `entryTokens`、`packageTokens` 只映射到 `static_entry_tokens`、`static_package_tokens`。
- `contentHash` 作为版本外的内容身份，用于检测同版本内容漂移。
- 依赖只记录名称和相对路径，不保存脚本内容或 skill 正文。

### 4.6 Skill Insights Page DTO

Skill 指标页面使用页面专用 DTO，不直接暴露 SQLite 表结构。

```ts
type SkillInsightsData = {
  generatedAt: string;
  range: {
    startDate: string;
    endDate: string;
  };
  summary: {
    installedSkillCount: number;
    activeSkillCount: number;
    unusedSkillCount: number;
    adoptionRate: number | null;
    estimatedStaticEntryLoad: number | null;
    estimatedStaticPackageLoad: number | null;
    metadataIssueCount: number;
  };
  skills: SkillInsightRow[];
  lowValueCandidates: SkillCandidateRow[];
  dependencyRows: SkillDependencyRow[];
  metadataIssues: SkillMetadataIssueRow[];
};
```

核心 skill row：

```ts
type SkillInsightRow = {
  name: string;
  version: string | null;
  contentHash: string | null;
  invocationCount: number;
  lastUsedAt: string | null;
  runtimeTokens: number | null;
  staticEntryTokens: number | null;
  staticPackageTokens: number | null;
  estimatedStaticEntryLoad: number | null;
  estimatedStaticPackageLoad: number | null;
  successRate: number | null;
  explicitCount: number;
  inferredCount: number;
  metadataConfidence: "exact" | "estimated" | "unknown";
};
```

命名规则：

- `runtimeTokens` 对应真实运行时 token。
- `staticEntryTokens` 和 `staticPackageTokens` 对应 `himan.yaml` 静态值。
- `estimatedStaticEntryLoad = invocationCount * staticEntryTokens`。
- `estimatedStaticPackageLoad = invocationCount * staticPackageTokens`。

## 5. Hook 与 Adapter 设计

### 5.1 Hook 映射

| Hook | 采集目的 | 产出事件 |
| --- | --- | --- |
| `UserPromptSubmit` | 检测显式 skill、repo/session 信息 | 可选 `capability_usage` |
| `PreToolUse` | 记录工具调用开始、准备计时 | 暂存上下文 |
| `PostToolUse` | 记录工具调用结果、耗时、状态 | `capability_usage` |
| `Stop` | 聚合 turn/session 摘要 | `turn_summary`、`session_summary` |

### 5.2 Codex Token、耗时与 Skill 补数

Codex hooks 的 `PostToolUse` 和 `Stop` payload 不保证直接提供 token 或耗时字段。MVP 的 Codex adapter 采用两段式处理：

1. hook 主路径只解析轻量字段、生成 normalized events，并把 `Stop` 和 `PostToolUse` 对应的 transcript 补数任务放入本地 queue。
2. 后台 worker drain queue 时读取 Codex `transcript_path` 指向的 rollout JSONL，只解析 `token_count`、`turn_context`、`task_complete`、`mcp_tool_call_end`、tool call start 和读取 `SKILL.md` 的工具调用等元数据字段，通过会话累计 token 的前后差值补齐 turn 级 token，并补齐 turn / tool duration、transcript-derived MCP tool 调用和可推断的 skill 使用。若工具调用参数或 workdir 能定位到项目 `himan.lock`，则用 lock 中安装到 Codex 的 skill 清单确认 transcript 里的 skill 名称；未出现在 lock 中或仅属于其他 agent 的 skill 不计入 Codex inferred skill 调用。

如果 hook payload 缺少 `transcript_path`，后台 worker 可只读 Codex 本地 state SQLite，按 `session_id` 查询 `rollout_path` 作为 transcript 定位兜底。该 SQLite 只作为 Codex 内部状态的只读辅助来源，不作为 `himan-tracker` 事实源。

Codex 当前没有官方结构化 skill 调用事件。MVP 统计两类 skill 信号：`UserPromptSubmit.prompt` 中显式出现的 `$skill-name` 标记为 `invocation_origin=explicit`、`attribution_confidence=exact`；transcript 中读取 `SKILL.md` 的 shell tool call 只提取 skill 名称并标记为 `invocation_origin=inferred`、`attribution_confidence=estimated`。当可读取 `himan.lock` 时，`inferred` skill 还必须同时满足 lock 中存在 `type=skill` 且 agent 包含 `codex`；没有 lock 或无法定位项目时保留 transcript-only fallback。结构化 MCP/tool 事件标记为 `invocation_origin=observed`。这些路径都不得把原始 prompt、shell 参数、`himan.lock` source URL 或 `SKILL.md` 内容写入事件日志。

### 5.3 Adapter 接口

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

### 5.4 Capability 分类规则

建议从高置信到低置信依次分类：

1. 明确声明为 skill、MCP tool、plugin 的来源字段。
2. tool name 前缀或命名空间，例如 `mcp__github__create_pull_request`。
3. shell 命令执行事件映射为 `shell_command`。
4. 已知内置工具表映射为 `builtin_tool`。
5. 其他归为 `unknown`。

分类逻辑应集中在 `normalizer/capabilityClassifier.ts`，不要散落在各 adapter 中。

### 5.5 Himan Metadata Resolver

`himan.yaml` 读取应放在 Himan adapter / metadata resolver 中，不放进 normalizer。Normalizer 只处理事件字段和 schema 校验，不理解 skill package 布局。

建议职责：

- 从项目 `.agents/skills/*/himan.yaml`、全局 `~/.agents/skills/*/himan.yaml`、Himan store 路径读取 metadata。
- 结合最近的 `himan.lock` 判断当前项目安装了哪些 skill。
- 以 `name + agent + version + contentHash` 建立 skill definition。
- 在 ingest 或 metadata sync 阶段写入静态 definition 和 dependency projection。
- 对 skill usage 事件补充静态 metadata 快照，例如 version、content hash、static token estimates 和 metadata confidence。

Skill metadata 匹配优先级：

1. transcript 中明确 `SKILL.md` 路径旁边的 `himan.yaml`。
2. 项目 `.agents/skills/<name>/himan.yaml`。
3. 最近 `himan.lock` 指向的 installed skill。
4. 全局 `~/.agents/skills/<name>/himan.yaml`。
5. Himan store 中同名 skill 的最新版本。
6. 未匹配时 `metadata_confidence = unknown`。

读取规则：

- 允许读取 `himan.yaml` 和 `himan.lock` 中的资源清单字段。
- 不读取或保存 `SKILL.md` 正文。
- 不保存 `himan.lock` 的 source repo URL。
- 明文路径只用于本地解析，落库时使用本地 salt hash 或仅保存相对路径。

## 6. 存储设计

### 6.1 文件布局

```text
~/.himan-tracker/
  config.json
  events/
    YYYY-MM-DD.jsonl
  errors/
    YYYY-MM-DD.jsonl
  queue/
    events/
      codex/
  himan.sqlite
  locks/
```

写入要求：

- JSONL 使用 append-only。
- 单条事件必须是一行合法 JSON。
- `queue/` 只保存已经 normalized 的事件批次，不保存 prompt、response、代码内容、stdout/stderr、shell args 或明文仓库路径。
- Codex 补数任务可以暂存 `transcript_path`、`session_id`、`turn_id`、`tool_use_id`、`tool_name` 和发生时间，用于后台读取 token 与耗时元数据字段；队列仍不得保存 prompt、response、代码内容或 stdout/stderr。
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
| `source` | text | 事件来源，例如 `codex-hook`、`codex-transcript` |
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
| `invocation_origin` | text | `explicit`、`inferred`、`observed`、`unknown` |
| `capability_version` | text? | skill metadata 匹配到的版本快照 |
| `capability_content_hash` | text? | skill metadata 匹配到的内容 hash 快照 |
| `static_entry_tokens` | integer? | `himan.yaml` 静态 entry token 估算 |
| `static_package_tokens` | integer? | `himan.yaml` 静态 package token 估算 |
| `static_metadata_confidence` | text | `exact`、`estimated`、`unknown` |

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
| `estimated_token_count` | integer | 兼容旧 schema 的估算归因事件数 |
| `estimated_attribution_count` | integer | `attribution_confidence=estimated` 的事件数 |
| `explicit_invocation_count` | integer | `invocation_origin=explicit` 的事件数 |
| `inferred_invocation_count` | integer | `invocation_origin=inferred` 的事件数 |
| `observed_invocation_count` | integer | `invocation_origin=observed` 的事件数 |
| `unknown_origin_count` | integer | `invocation_origin=unknown` 的事件数 |
| `static_entry_tokens` | integer? | 当日匹配到的静态 entry token 总和 |
| `static_package_tokens` | integer? | 当日匹配到的静态 package token 总和 |
| `estimated_static_entry_load` | integer? | `sum(static_entry_tokens)`，按调用次数累加 |
| `estimated_static_package_load` | integer? | `sum(static_package_tokens)`，按调用次数累加 |
| `metadata_exact_count` | integer | `static_metadata_confidence=exact` 的事件数 |
| `metadata_estimated_count` | integer | `static_metadata_confidence=estimated` 的事件数 |
| `metadata_unknown_count` | integer | `static_metadata_confidence=unknown` 的事件数 |

主键建议为 `(date, agent, capability_type, capability_name)`。

#### `capability_definitions`

静态 capability 定义维表。第一版主要保存 `himan.yaml` 中的 skill metadata。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text primary key | definition ID，建议由 type、name、version、content hash 生成 |
| `capability_type` | text | 第一版为 `skill` |
| `capability_name` | text | skill 名称 |
| `version` | text? | skill 版本 |
| `content_hash` | text? | package text content hash |
| `entry` | text | 入口文件，例如 `SKILL.md` |
| `description` | text? | skill 描述 |
| `agents_json` | text | JSON array，例如 `["codex"]` |
| `static_entry_tokens` | integer? | `analysis.content.entryTokens` |
| `static_package_tokens` | integer? | `analysis.content.packageTokens` |
| `tokenizer` | text? | tokenizer 或 estimator 名称 |
| `token_estimator` | text? | 估算公式，例如 `ceil(chars/4)` |
| `measured_at` | text? | metadata 测量时间 |
| `measured_by` | text? | metadata 测量者 |
| `generated_at` | text? | metadata 生成时间 |
| `generated_by` | text? | metadata 生成者 |
| `source_path_hash` | text? | metadata 来源路径 hash，不保存明文路径 |
| `discovered_at` | text | tracker 发现该 definition 的时间 |

推荐唯一约束：

```text
(capability_type, capability_name, version, content_hash, source_path_hash)
```

如果同名同版本但 `content_hash` 不同，应视为不同 definition，并在 metadata health 中报告 drift 或冲突。

#### `capability_definition_dependencies`

静态依赖边表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `definition_id` | text | 所属 definition |
| `dependency_type` | text | `skill`、`mcp_tool`、`script` |
| `dependency_name` | text? | skill 或 MCP tool 名称 |
| `dependency_path` | text? | script 相对路径 |

主键建议为：

```text
(definition_id, dependency_type, dependency_name, dependency_path)
```

依赖边只表达静态声明，不代表运行时一定触发。

#### `capability_metadata_issues`

用于记录 metadata sync 或 ingest 时发现的静态元数据问题。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text primary key | issue ID |
| `capability_type` | text | capability 类型 |
| `capability_name` | text | capability 名称 |
| `version` | text? | 关联版本 |
| `content_hash` | text? | 关联 hash |
| `issue_type` | text | `missing_yaml`、`hash_drift`、`lock_version_mismatch`、`old_measurement`、`invalid_shape` 等 |
| `severity` | text | `info`、`warning`、`error` |
| `message` | text | 简短说明，不包含正文或明文路径 |
| `detected_at` | text | 检测时间 |

#### `monthly_agent_stats`

月度归档表，用于保留最近 6 个自然月之前的汇总统计。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `month` | text | `YYYY-MM` |
| `agent` | text | agent 名称 |
| `model` | text | 模型名 |
| `session_count` | integer | session 数，来自日统计求和 |
| `turn_count` | integer | turn 数 |
| `input_tokens` | integer? | 输入 token 总和 |
| `output_tokens` | integer? | 输出 token 总和 |
| `total_tokens` | integer? | 总 token |
| `duration_ms` | integer? | 总耗时 |
| `success_count` | integer | 成功 turn 数 |
| `failure_count` | integer | 失败 turn 数 |
| `source_start_date` | text | 归档来源最早日期 |
| `source_end_date` | text | 归档来源最晚日期 |
| `archived_at` | text | 归档执行时间 |

主键为 `(month, agent, model)`。

#### `monthly_capability_stats`

月度 capability 归档表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `month` | text | `YYYY-MM` |
| `agent` | text | agent 名称 |
| `capability_type` | text | capability 类型 |
| `capability_name` | text | capability 名称 |
| `invocation_count` | integer | 调用次数 |
| `input_tokens` | integer? | 输入 token 总和 |
| `output_tokens` | integer? | 输出 token 总和 |
| `total_tokens` | integer? | 总 token |
| `duration_ms` | integer? | 总耗时 |
| `success_count` | integer | 成功次数 |
| `failure_count` | integer | 失败次数 |
| `estimated_token_count` | integer | 兼容旧 schema 的估算归因事件数 |
| `estimated_attribution_count` | integer | `attribution_confidence=estimated` 的事件数 |
| `explicit_invocation_count` | integer | `invocation_origin=explicit` 的事件数 |
| `inferred_invocation_count` | integer | `invocation_origin=inferred` 的事件数 |
| `observed_invocation_count` | integer | `invocation_origin=observed` 的事件数 |
| `unknown_origin_count` | integer | `invocation_origin=unknown` 的事件数 |
| `estimated_static_entry_load` | integer? | 静态 entry token 估算，按调用次数累加 |
| `estimated_static_package_load` | integer? | 静态 package token 估算，按调用次数累加 |
| `metadata_exact_count` | integer | exact metadata 匹配事件数 |
| `metadata_estimated_count` | integer | estimated metadata 匹配事件数 |
| `metadata_unknown_count` | integer | unknown metadata 匹配事件数 |
| `source_start_date` | text | 归档来源最早日期 |
| `source_end_date` | text | 归档来源最晚日期 |
| `archived_at` | text | 归档执行时间 |

主键为 `(month, agent, capability_type, capability_name)`。

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
- 从 `himan.lock` 和 `himan.yaml` 发现的已安装 skill。

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

### 7.5 Skill 静态指标

`himan.yaml` 支撑的指标分为四类。

安装与使用：

```text
installed_skill_count = count(capability_definitions where type = skill and agent matches)
active_skill_count = count(distinct skill with invocation_count > 0 in range)
unused_skill_count = installed_skill_count - active_skill_count
skill_adoption_rate = active_skill_count / installed_skill_count
```

静态成本：

```text
estimated_static_entry_load = sum(static_entry_tokens per skill invocation)
estimated_static_package_load = sum(static_package_tokens per skill invocation)
static_cost_per_success = estimated_static_entry_load / success_count
```

依赖复杂度：

```text
direct_dependency_count = count(dependencies where definition_id = skill)
reverse_dependency_count = count(dependencies where dependency_name = skill)
transitive_static_tokens = skill.static_package_tokens + recursive dependency static_package_tokens
```

元数据健康：

```text
metadata_coverage = skills_with_himan_yaml / installed_skill_count
metadata_issue_count = count(capability_metadata_issues)
measured_age_days = today - measured_at
```

所有静态成本指标都必须在字段名和展示文案中保留 `static` 或 `estimated static`，不能计入 runtime `total_tokens`。

### 7.6 Skill 版本与历史准确性

Skill usage 入库时应尽量保存 metadata 快照：

- `capability_version`
- `capability_content_hash`
- `static_entry_tokens`
- `static_package_tokens`
- `static_metadata_confidence`

这样历史事件可以按当时匹配到的版本和 content hash 分析。如果只在报表时 join 当前 `himan.yaml`，同名 skill 升级后会污染历史分析。

当同一天同一个 skill 出现多个版本或多个 content hash 时，底层聚合应保留 version/hash 维度，页面可默认按 skill name 合并，并在详情中展开版本分布。

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
- top capabilities by token, invocation, and average duration

### 8.2 `agents`

```bash
himan-tracker agents --date 2026-05-12
```

输出建议列：

```text
agent | model | sessions | turns | tokens | avg latency | success rate
```

### 8.3 `turns`

```bash
himan-tracker turns --since 7d
```

输出建议列：

```text
time | agent | model | turn | duration | tokens | status
```

支持参数：

```text
--since 7d
--agent codex
--limit 20
```

### 8.4 `capabilities`

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

Codex hook input 不直接提供耗时字段。Codex adapter 在后台 enrichment 阶段从 transcript 的 `task_complete.duration_ms` 补齐 turn 耗时，从 `mcp_tool_call_end` 和其他 tool end 事件补齐 capability 耗时；如果 hook 没有发出对应 `PostToolUse`，会从 transcript 的 `mcp_tool_call_end` 合成 MCP tool capability usage。skill 没有 Codex 结构化执行事件，默认用同一 turn 的 duration 作为估算。

### 8.5 `capability-events`

```bash
himan-tracker capability-events --type skill --name common-git-commit --since 30d
```

输出建议列：

```text
time | agent | model | turn | duration | basis | tokens | status | adopted | confidence
```

用途：查看某个 capability 的逐次调用记录，便于对比 skill、MCP tool、plugin、内置工具或 shell command 优化前后的耗时、token 和状态变化。

支持参数：

```text
--since 30d
--type skill|mcp_tool|plugin|builtin_tool|shell_command|unknown
--name <capability-name>
--agent codex|claude-code
--limit 50
```

`--type` 和 `--name` 必填。`basis` 用于标记耗时来源：`event` 表示 capability 事件直接提供，`turn` 表示使用同一 turn 的耗时估算，`n/a` 表示未知。

### 8.6 `unused`

```bash
himan-tracker unused --since 30d
```

输出建议列：

```text
type | name | last_used_at | historical_invocations | historical_tokens
```

### 8.6 `ingest`

```bash
himan-tracker ingest
```

用途：

- 默认从 `events/*.jsonl` 重建或更新 SQLite。
- 支持 `--rebuild` 删除并重建投影数据库。
- 支持 `--from <path>` 从指定 JSONL 导入。

### 8.7 `collect`

```bash
himan-tracker collect --agent codex
```

用途：

- 从 stdin 或 `--from <path>` 读取 Codex hook / wrapper JSON payload。
- `--agent` 默认是 `codex`，当前只支持 `codex`。
- 默认只做轻量解析、隐私脱敏和本地入队，然后启动后台 worker drain 队列。
- 默认 fail-open，采集失败也返回 `0`，不阻塞 Codex。
- hook 场景使用 `--quiet` 关闭 stdout summary。
- `--sync --strict` 只用于人工验证，不能用于 Codex hook。

### 8.8 `setup`

```bash
himan-tracker setup
himan-tracker setup --agent codex
himan-tracker setup -g
```

用途：

- `--agent` 默认是 `codex`，当前只支持 `codex`。
- 默认把 Codex hooks 安装到当前项目 `.codex/`。
- `-g, --global` 把 Codex hooks 安装到全局 `~/.codex`。
- 写入或合并 `config.toml` 和 `hooks.json`，并生成 `hooks/himan-tracker-collect.sh` helper。
- helper 调用 `himan-tracker collect --agent codex --quiet`，吞掉 stdout/stderr 并始终 `exit 0`。
- 默认配置 `UserPromptSubmit`、`PostToolUse` 和 `Stop`，用于显式 skill、capability 使用和 turn summary。

### 8.9 `cleanup`

```bash
himan-tracker cleanup --all
himan-tracker cleanup --before 2026-05-01
himan-tracker cleanup --from 2026-05-01 --to 2026-05-07
himan-tracker cleanup --older-than 30d
```

用途：

- 删除 `events/*.jsonl` 和 `errors/*.jsonl` 原始日志分片。
- 支持 `--all`、`--before <date>`、`--from/--to`、`--older-than <period>` 四种清理范围。
- `--before` 删除指定日期之前的分片，不包含当天；`--from/--to` 使用包含边界的日期区间。
- 支持 `--dry-run` 预览删除范围。
- 不删除 `himan.sqlite`，保留已经导入的统计结果。
- 不删除 `queue/`，避免丢弃尚未落入 JSONL 和 SQLite 的待处理事件。

### 8.10 `archive monthly`

```bash
himan-tracker archive monthly --dry-run
himan-tracker archive monthly
```

用途：

- 只处理最近 6 个自然月之前的完整月份，当前月计入保留窗口。例如 `2026-05-15` 执行时保留 `2025-12` 到 `2026-05`，归档 `2025-11` 及更早月份。
- 将 `daily_agent_stats` 汇总写入 `monthly_agent_stats`。
- 将 `daily_capability_stats` 汇总写入 `monthly_capability_stats`。
- 删除已归档月份的 `events/YYYY-MM-DD.jsonl`、`errors/YYYY-MM-DD.jsonl`、`daily_agent_stats` 和 `daily_capability_stats`。
- 当前版本没有持久化周统计表，周统计由日报表临时聚合；删除对应日统计即可移除这些月份的周级明细来源。
- 支持 `--dry-run` 预览归档月份、月度行数和删除文件数量，不写入归档表、不删除日统计，也不删除文件。

### 8.11 `doctor`

```bash
himan-tracker doctor
```

检查项：

- 数据目录是否存在。
- JSONL 分片目录是否可写。
- SQLite 是否可打开。
- hook 配置是否可用。
- schema version 是否兼容。

### 8.12 Server Dashboard 与 Skill Insights 页面

`himan-tracker server` 提供本地 HTTP dashboard。现有 `/` 页面保留为 Overview，展示 agent、token、capability 和 recent turns 的运行时总览。Skill 静态治理指标应提供独立页面，避免和运行时 token 总览混淆。

建议路由：

```text
GET /
GET /dashboard.json
GET /skills
GET /skills.json
GET /healthz
```

页面导航：

```text
Overview | Skill Insights
```

#### `/skills` 页面定位

Skill Insights 页面用于回答：

- 哪些 skill 已安装但没有被使用。
- 哪些 skill 静态 token 体量过大。
- 哪些 skill 高频但静态成本偏高。
- 哪些 skill 版本、content hash 或 metadata 已过期。
- 哪些 skill 是依赖核心，修改风险较高。

#### `/skills` 页面结构

顶部指标卡：

```text
Installed skills
Active skills
Unused skills
Adoption rate
Estimated static entry load
Metadata issues
```

Skill 使用矩阵：

```text
Skill | Version | Invocations | Last used | Runtime tokens | Static entry tokens | Static package tokens | Estimated static load | Success rate | Origin mix | Metadata
```

高成本 / 低使用候选：

```text
Skill | Invocations | Static package tokens | Estimated static load | Days since last use | Reason
```

`Reason` 可取：

```text
unused | large package | stale metadata | low success rate | high static cost per success
```

依赖复杂度：

```text
Skill | Direct deps | Reverse deps | Declared MCP tools | Scripts | Transitive static tokens | Risk
```

Metadata 健康检查：

```text
Skill | Version | Hash | Measured at | Tokenizer | Issue
```

`Issue` 可取：

```text
missing_yaml | hash_drift | lock_version_mismatch | old_measurement | unsupported_tokenizer | invalid_shape
```

#### `/skills.json` API

`/skills.json` 返回 `SkillInsightsData`，用于页面渲染和后续外部集成。该 JSON 应保持页面所需的聚合 DTO，不直接暴露 SQLite 表结构。

页面展示口径：

- `Runtime tokens`：真实运行时观测 token。
- `Static entry tokens`：`himan.yaml.analysis.content.entryTokens`。
- `Static package tokens`：`himan.yaml.analysis.content.packageTokens`。
- `Estimated static load`：静态 token 与调用次数的乘积，不是真实消耗。

#### 后续 CLI

第一版优先做页面。CLI 可后续补充：

```bash
himan-tracker skills
himan-tracker skills --issues
himan-tracker skills --unused --since 30d
```

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
  "skill_metadata": {
    "enabled": true,
    "scan_project_skills": true,
    "scan_global_skills": true
  },
  "cost": {
    "currency": "USD",
    "models": {}
  }
}
```

MVP 只需要读取必要字段。未知字段应保留并忽略，方便未来版本兼容。

`skill_metadata` 用于控制是否扫描 `himan.yaml`。默认只做本地扫描，不访问网络，不写入远程服务。

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
- `himan.yaml` 只保存 skill 名称、版本、content hash、静态 token 估算、依赖名称、脚本相对路径和 MCP tool 名称。
- 不保存 `SKILL.md` 正文、脚本内容、`himan.lock` source repo URL 或明文 skill 文件路径。
- skill metadata 来源路径如需落库，只保存 `source_path_hash`。

## 11. 测试策略

MVP 至少需要以下测试：

- Adapter fixture tests：给定 Codex / Claude Code hook 样例，输出稳定的 normalized events。
- Schema validation tests：非法字段、未知版本、缺失必填字段能被拒绝或降级处理。
- JSONL writer tests：多条事件写入后每行都是合法 JSON。
- Aggregator tests：重复导入同一事件不会重复计数。
- CLI snapshot tests：固定 SQLite fixture 输出稳定表格。
- Privacy tests：确保 prompt、response、code content 不会出现在事件 JSON 中。
- Himan metadata tests：合法 `himan.yaml` 能解析为稳定 definition，缺失字段、版本不一致和 hash drift 能生成 metadata issue。
- Skill Insights tests：`/skills.json` 对 installed、active、unused、static load、metadata issue 的计算稳定，且 `entryTokens`、`packageTokens` 不进入 runtime `total_tokens`。
- Server rendering tests：`/skills` 页面能展示静态 token 口径说明，空数据时有明确 empty state。

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

### Phase 7：Himan Skill Metadata 与 Skill Insights

- 实现 `himan.yaml` metadata resolver。
- 新增 capability definition、dependency 和 metadata issue projection。
- 在 skill usage 入库时补充 version、content hash 和 static token 快照。
- 增强 `unused` 候选来源，支持从 `himan.lock` 和 `himan.yaml` 发现已安装 skill。
- 新增 server `/skills` 和 `/skills.json` 页面。

验收标准：

- `entryTokens`、`packageTokens` 只出现在 `static_*` 和 `estimated_static_*` 字段中。
- Skill Insights 页面能展示 installed、active、unused、adoption rate、estimated static load 和 metadata issues。
- 同名 skill 不同版本或不同 content hash 可以被区分。

## 13. 风险与处理

| 风险 | 影响 | MVP 处理 |
| --- | --- | --- |
| Agent hook 字段不稳定 | adapter 易失效 | 用 fixtures 固化样例，adapter 独立版本化 |
| Capability token 难以精确归因 | 成本分析误导 | 引入 `attribution_confidence` |
| 多进程同时写 JSONL | 文件损坏或行交错 | 文件锁、单行 append、写入测试 |
| 用户隐私顾虑 | 无法推广使用 | 默认只采元数据，content capture 关闭 |
| 未使用 capability 缺少全集 | unused 结果不完整 | 支持 `known_capabilities` 配置 |
| 静态 token 被误读为真实消耗 | ROI 分析误导 | 所有字段和页面文案使用 `static` / `estimated static`，不写入 `total_tokens` |
| Skill 升级污染历史分析 | 历史趋势失真 | usage 入库保存 version、content hash 和 static token 快照 |
| `himan.yaml` 与 `SKILL.md` 漂移 | metadata 不可信 | 用 content hash、measured_at 和 metadata issue 暴露健康状态 |
| SQLite 聚合逻辑复杂 | 报表不可信 | 先按日期重算，减少增量错误 |

## 14. 后续可扩展点

- Codex OpenTelemetry 指标接入：官方指标包含 turn token、tool call、MCP call 和 hooks run。后续可评估提供本地 OTLP receiver 或配置生成器，作为比 transcript 解析更稳定的 token/tool 数据源。
- Langfuse / Phoenix 集成。
- Dashboard UI。
- Skill Insights 页面：围绕 `himan.yaml` 展示 skill adoption、静态成本、依赖复杂度和 metadata health。
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
- Server 页面只读 SQLite projection，不在请求路径中重新扫描全部 skill 文件。
- 所有隐私敏感字段默认不采集。
- 估算值必须标记为估算，不能伪装成精确统计。
- `entryTokens`、`packageTokens` 是静态 metadata，不能并入 runtime token 字段。
