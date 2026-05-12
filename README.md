# himan-tracker

`himan-tracker` 是一个本地优先的 AI coding agent 使用分析工具，用于统计 Codex、Claude Code 等 agent 的对话次数、模型消耗、token 成本、执行耗时和 capability 使用情况，帮助开发者理解 AI 辅助研发流程的真实投入与产出。

## 适用场景

- 了解 Codex 和 Claude Code 的实际使用频率。
- 分析不同模型的 token 消耗和响应耗时。
- 统计 skill、MCP tool、plugin、内置工具和 shell command 的调用情况。
- 发现长期未使用或成本偏高的 capability。
- 为 AI workflow ROI 分析提供本地数据基础。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| Agent 使用统计 | 统计 session、turn、成功率和使用趋势 |
| 模型消耗统计 | 统计 input tokens、output tokens 和 total tokens |
| 延迟分析 | 记录请求耗时，支持按 agent、模型和 capability 聚合 |
| Capability 分析 | 统一统计 skill、MCP tool、plugin、内置工具和 shell command |
| 本地事件日志 | 使用 JSONL 保存可回放的原始事件 |
| 本地聚合数据库 | 使用 SQLite 保存报表查询所需的聚合数据 |
| 隐私优先 | 默认不采集 prompt、response 和代码内容 |

## 支持的 Agent

| Agent | 支持方式 |
| --- | --- |
| Codex | Hooks、wrapper 或本地日志适配 |
| Claude Code | Hooks 适配 |

## 安装

当前尚未发布可安装版本。正式发布后，本节会提供对应的安装命令。

## 快速开始

发布后，典型使用流程如下：

1. 安装 `himan-tracker` CLI。
2. 为 Codex 或 Claude Code 启用本地采集适配。
3. 使用 `doctor` 检查本地配置和数据目录。
4. 正常使用 AI coding agent。
5. 使用 `ingest` 将原始事件聚合到 SQLite。
6. 使用报表命令查看 agent、模型和 capability 使用情况。

```bash
himan-tracker doctor
himan-tracker ingest
himan-tracker summary --since 7d
```

## 命令手册

### `doctor`

检查本地配置、数据目录、事件日志、SQLite 数据库和 hook 状态。

```bash
himan-tracker doctor
```

### `ingest`

将 JSONL 原始事件导入 SQLite 聚合数据库。

```bash
himan-tracker ingest
```

从指定 JSONL 文件导入：

```bash
himan-tracker ingest --from ./events.jsonl
```

重建本地聚合数据库：

```bash
himan-tracker ingest --rebuild
```

### `summary`

查看指定时间范围内的总体使用情况。

```bash
himan-tracker summary --since 7d
```

典型输出包含：

- session 数
- turn 数
- token 总量
- 平均耗时
- 成功率
- 使用最多的 agent
- token 消耗最高的 capability

### `agents`

按 agent 和模型查看使用统计。

```bash
himan-tracker agents --date 2026-05-12
```

典型输出字段：

```text
agent | model | sessions | turns | tokens | avg latency | success rate
```

### `capabilities`

查看 capability 使用排行。

```bash
himan-tracker capabilities --since 30d
```

支持按类型、agent 和排序字段筛选：

```bash
himan-tracker capabilities --since 30d --type mcp_tool
himan-tracker capabilities --since 30d --agent codex
himan-tracker capabilities --since 30d --sort duration
```

支持的 capability 类型：

- `skill`
- `mcp_tool`
- `plugin`
- `builtin_tool`
- `shell_command`
- `unknown`

### `unused`

查看指定时间范围内未使用的 capability。

```bash
himan-tracker unused --since 30d
```

典型输出字段：

```text
type | name | last_used_at | historical_invocations | historical_tokens
```

## 数据目录

默认数据目录：

```text
~/.himan-tracker
```

默认文件：

```text
~/.himan-tracker/events.jsonl
~/.himan-tracker/errors.jsonl
~/.himan-tracker/himan.sqlite
```

可以通过环境变量指定其他数据目录：

```bash
HIMAN_TRACKER_HOME=/custom/path
```

## 隐私说明

`himan-tracker` 默认只采集元数据。

默认不会采集：

- prompt 原文
- response 原文
- 代码内容
- 明文仓库路径
- 远程 telemetry

默认采集：

- agent 名称
- 模型名称
- session 和 turn 标识
- token 数量
- 请求耗时
- capability 名称和类型
- 成功或失败状态
- 仓库路径 hash

所有数据默认保存在本机。远程同步、内容采集和团队级分析都应作为显式开启的能力。

## 常见问题

### himan-tracker 会上传我的代码或 prompt 吗？

不会。默认设计只采集使用元数据，不上传 prompt、response 或代码内容。

### JSONL 和 SQLite 分别做什么？

`events.jsonl` 是原始事件日志，用于调试、回放和重新聚合。`himan.sqlite` 是本地查询数据库，用于生成 CLI 报表。

### capability 是什么？

capability 是对 agent 执行能力的统一抽象，包括 skill、MCP tool、plugin、内置工具和 shell command。

### token 归因一定准确吗？

不一定。agent 或 hook 明确提供的数据会被视为精确值；无法精确归因的数据会标记为估算或未知。

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
