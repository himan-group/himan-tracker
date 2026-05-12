# MVP Feature 列表

本文档定义 MVP 阶段需要交付的 feature、优先级、依赖关系和验收标准。

## Feature 优先级

| 优先级 | 含义 |
| --- | --- |
| `P0` | MVP 必须交付，没有它无法形成可用闭环 |
| `P1` | MVP 推荐交付，用于提升可用性和验证质量 |
| `P2` | MVP 可延后，只保留设计扩展点 |

## Feature 总览

| ID | Feature | 优先级 | 用户价值 | 主要模块 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| `MVP-F01` | CLI 工程与命令入口 | `P0` | 用户可以通过 `himan-tracker` 访问所有功能 | `src/cli` | 无 |
| `MVP-F02` | 本地配置与数据目录 | `P0` | 数据默认落在本机，支持隔离和迁移 | `src/config` | `MVP-F01` |
| `MVP-F03` | 统一事件契约与校验 | `P0` | Codex 和 Claude Code 事件可以进入统一分析管线 | `src/types`、`src/normalizer` | `MVP-F02` |
| `MVP-F04` | JSONL 原始事件日志 | `P0` | 原始事件可调试、可回放、可重建数据库 | `src/collector` | `MVP-F03` |
| `MVP-F05` | SQLite schema 与 migrations | `P0` | 报表查询有稳定的数据模型 | `src/storage` | `MVP-F03` |
| `MVP-F06` | 事件导入与聚合 | `P0` | JSONL 可以转换成日报统计和查询表 | `src/aggregator` | `MVP-F04`、`MVP-F05` |
| `MVP-F07` | CLI 报表 | `P0` | 用户可以查看 agent、模型、capability 使用情况 | `src/cli`、`src/reports` | `MVP-F06` |
| `MVP-F08` | Codex adapter | `P1` | Codex 使用数据可以自动进入事件管线 | `src/adapters/codex` | `MVP-F03`、`MVP-F04` |
| `MVP-F09` | Claude Code adapter | `P1` | Claude Code 使用数据可以自动进入事件管线 | `src/adapters/claude-code` | `MVP-F03`、`MVP-F04` |
| `MVP-F10` | 隐私与安全保护 | `P0` | 默认不采集敏感内容，降低本地落盘风险 | `src/config`、`src/normalizer`、`src/collector` | `MVP-F03` |
| `MVP-F11` | Fixture 测试与质量门禁 | `P1` | 防止 adapter、聚合和报表回归 | `tests` | `MVP-F03` 至 `MVP-F09` |

## MVP-F01：CLI 工程与命令入口

### 范围

- 初始化 TypeScript + Node.js CLI 工程。
- 暴露 `himan-tracker` 命令。
- 建立命令分发结构。
- 实现 `doctor` 基础检查。

### 命令

```bash
himan-tracker doctor
himan-tracker ingest
himan-tracker summary --since 7d
himan-tracker agents --date 2026-05-12
himan-tracker capabilities --since 30d
himan-tracker unused --since 30d
```

### 不包含

- 不做 TUI 或 Dashboard。
- 不做交互式配置向导。

### 验收标准

- `himan-tracker --help` 可以列出 MVP 命令。
- `himan-tracker doctor` 可以检查数据目录、配置文件、JSONL 和 SQLite 访问状态。
- 命令参数非法时返回非 0 exit code，并输出可读错误。

## MVP-F02：本地配置与数据目录

### 范围

- 默认使用 `~/.himan-tracker`。
- 支持 `HIMAN_TRACKER_HOME` 覆盖。
- 创建 `config.json`、`events/`、`errors/`、`himan.sqlite` 所需目录。
- 维护本地 salt，用于 repo path hash。

### 默认配置

```json
{
  "schema_version": "1.0",
  "privacy": {
    "capture_content": false,
    "hash_repo_path": true,
    "capture_shell_args": false
  },
  "agents": {
    "codex": {
      "enabled": true
    },
    "claude-code": {
      "enabled": true
    }
  },
  "known_capabilities": []
}
```

### 验收标准

- 未设置环境变量时使用用户 home 下的数据目录。
- 设置 `HIMAN_TRACKER_HOME` 后所有读写切换到指定目录。
- 默认配置不会开启内容采集。

## MVP-F03：统一事件契约与校验

### 范围

- 定义 normalized event TypeScript 类型。
- 支持 `turn_summary`、`capability_usage`、`session_summary`。
- 生成稳定 `event_id`。
- 校验 required fields、枚举字段和 schema version。
- 对缺失 token 字段保留 `null`，不隐式写成 0。

### 验收标准

- Codex 和 Claude Code adapter 输出相同事件类型。
- 非法事件不会写入 `events/YYYY-MM-DD.jsonl`，错误写入 `errors/YYYY-MM-DD.jsonl`。
- 重复输入相同稳定字段时生成相同 `event_id`。

## MVP-F04：JSONL 原始事件日志

### 范围

- 实现 append-only JSONL writer。
- 每条事件一行 JSON。
- 写入失败时 fail-open，不影响 agent 执行。
- 记录 collector 错误到 `errors/YYYY-MM-DD.jsonl`。

### 验收标准

- 连续写入多条事件后，每行都可以独立 `JSON.parse`。
- 写入事件时不写入 prompt、response、代码内容。
- collector 失败返回非阻塞结果，并产生错误记录。

## MVP-F05：SQLite Schema 与 Migrations

### 范围

建立以下表：

- `ingested_events`
- `sessions`
- `turns`
- `capability_usages`
- `daily_agent_stats`
- `daily_capability_stats`

### 验收标准

- 首次运行可以自动创建数据库和表。
- migration 可重复执行且幂等。
- 表结构支持 `technical-design.md` 中定义的字段。

## MVP-F06：事件导入与聚合

### 范围

- 实现 `himan-tracker ingest`。
- 从 JSONL 读取事件并写入 SQLite。
- 使用 `ingested_events` 去重。
- 以日期为粒度重算 `daily_agent_stats` 和 `daily_capability_stats`。
- 支持 `--from <path>` 和 `--rebuild`。

### 验收标准

- 同一个 JSONL 文件重复导入不会重复计数。
- `--rebuild` 可以删除投影数据库并从 JSONL 重建。
- fixture 中的 agent stats 和 capability stats 与预期一致。

## MVP-F07：CLI 报表

### 范围

实现四类查询：

- `summary`
- `agents`
- `capabilities`
- `unused`

### 报表行为

- 默认输出表格。
- 没有数据时输出明确空状态。
- token 或耗时缺失时显示 `n/a`。
- success rate 只以 `success` 和 `failure` 为分母。

### 验收标准

- `summary --since 7d` 显示 session、turn、token、latency、success rate 和 top capabilities。
- `agents --date <date>` 按 agent/model 展示聚合数据。
- `capabilities --since 30d` 支持 `--sort`、`--type`、`--agent`。
- `unused --since 30d` 支持历史事件和 `known_capabilities` 两种来源。

## MVP-F08：Codex Adapter

### 范围

- 解析 Codex hook 或 wrapper payload。
- 提供 `pnpm cli collect --agent codex` 作为源码阶段默认非阻塞数据入口。
- 提供 `pnpm cli setup --agent codex` 安装项目级或全局 Codex hooks。
- 映射 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。
- 输出 normalized events。
- 提供 Codex fixtures。

### 验收标准

- 给定 Codex fixture，可以产出稳定 `turn_summary` 和 `capability_usage`。
- 用户可以通过 `setup` 将 Codex hooks 安装到当前项目 `.codex/`，或通过 `setup -g` 安装到 `~/.codex`。
- Codex collect 默认异步入队并返回 0，采集失败不影响 Codex 流程。
- 未识别字段不会导致 adapter 崩溃。
- adapter 不直接访问 SQLite。

## MVP-F09：Claude Code Adapter

### 范围

- 解析 Claude Code hook payload。
- 映射工具调用和 session/turn summary。
- 输出 normalized events。
- 提供 Claude Code fixtures。

### 验收标准

- 给定 Claude Code fixture，可以产出与 Codex 同结构的 normalized events。
- adapter 失败不影响 Claude Code 原始工作流。
- adapter 不直接访问 SQLite。

## MVP-F10：隐私与安全保护

### 范围

- 默认不采集 prompt、response 和代码内容。
- repo path 只存 hash。
- shell command 默认只记录命令名，不记录完整参数。
- 文件权限尽量收紧。

### 验收标准

- privacy tests 确认敏感字段不会出现在 JSONL。
- 默认配置中 `capture_content=false`。
- 明文用户 home path 不出现在事件 JSON 中。

## MVP-F11：Fixture 测试与质量门禁

### 范围

- adapter fixture tests。
- schema validation tests。
- JSONL writer tests。
- aggregator idempotency tests。
- CLI report snapshot tests。
- privacy tests。

### 验收标准

- MVP 核心行为都有 fixture 覆盖。
- CI 或本地 test 命令可以一次性执行。
- 新增事件字段时必须更新 fixture 和测试。

## Feature 依赖顺序

```text
MVP-F01
  -> MVP-F02
  -> MVP-F03
  -> MVP-F04
  -> MVP-F05
  -> MVP-F06
  -> MVP-F07
  -> MVP-F08 / MVP-F09
  -> MVP-F10 / MVP-F11
```

实际开发中，`MVP-F10` 应贯穿所有阶段，不应等到最后补。
