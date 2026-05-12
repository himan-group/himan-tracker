# himan-tracker

`himan-tracker` 是一个本地优先的 AI coding agent 观测与分析 CLI，用来记录和分析 Codex、Claude Code 等 AI 编程工具的使用元数据。它关注的是研发过程中真实发生了什么：用了哪些 agent、哪些模型消耗了 token、一次会话花了多久、哪些 skill / MCP tool / plugin / shell command 被频繁调用，以及哪些 capability 长期没有价值信号。

项目当前处于早期 MVP：本地数据目录、隐私默认值、JSONL 事件日志、SQLite 投影、幂等 ingest、CLI 报表，以及 Codex / Claude Code 事件输入解析能力已经具备；发布包和一键 hook 安装还没有提供。

## 适合谁使用

- 经常使用 Codex、Claude Code 等 AI 编程工具，希望了解真实使用频率的开发者。
- 想比较不同模型 token 消耗、延迟和成功率的个人或小团队。
- 想清理长期未使用 skill、MCP tool、plugin 或 shell command 的 agent 工作流维护者。
- 想先在本机沉淀 AI workflow ROI 数据，而不把 prompt、response 或代码内容上传到远端的用户。

## 当前能做什么

| 能力 | 当前状态 |
| --- | --- |
| 本地配置和数据目录 | 已实现，默认使用 `~/.himan-tracker`，支持 `HIMAN_TRACKER_HOME` 覆盖 |
| 隐私默认值 | 已实现，默认不采集内容，仓库路径默认 hash，shell command 默认不保存参数 |
| JSONL 事件日志 | 已实现，`events.jsonl` 保存 normalized events，`errors.jsonl` 保存采集错误 |
| SQLite 投影 | 已实现，`ingest` 可把 JSONL 导入 `himan.sqlite` 并重算每日统计 |
| CLI 报表 | 已实现 `summary`、`agents`、`capabilities`、`unused` |
| Agent 事件解析 | 已实现 Codex / Claude Code 基础事件输入解析 |
| 自动 hook 安装 | 尚未实现，`doctor` 会提示 hooks 还未配置 |
| 发布版安装 | 尚未发布，安装方式发布后补充 |

## 核心概念

`himan-tracker` 使用两层本地数据：

- `events.jsonl`：append-only 原始事件日志，一行一个 normalized event，适合调试、回放和重新聚合。
- `himan.sqlite`：由 JSONL 投影出的本地查询数据库，服务 CLI 报表。

事件分为三类：

- `turn_summary`：一次 agent turn 的模型、token、耗时和状态。
- `capability_usage`：一次 capability 调用，例如 skill、MCP tool、plugin、内置工具或 shell command。
- `session_summary`：一次 agent session 的总览。

capability 类型目前包括：

- `skill`
- `mcp_tool`
- `plugin`
- `builtin_tool`
- `shell_command`
- `unknown`

## 安装状态

当前尚未发布面向最终用户的安装包。发布后 CLI 入口会是：

```bash
himan-tracker
```

## 快速开始

检查本地配置和数据目录：

```bash
himan-tracker doctor
```

`doctor` 会创建或检查数据目录、`config.json`、`events.jsonl`、`errors.jsonl` 和 `himan.sqlite`。当前阶段看到 `hooks: not configured yet` 是预期结果，因为一键 hook 安装还没有实现。

准备 normalized JSONL 事件后，导入 SQLite 投影：

```bash
himan-tracker ingest --from ./events.jsonl
```

查看最近 7 天总览：

```bash
himan-tracker summary --since 7d
```

查看某天的 agent / model 使用情况：

```bash
himan-tracker agents --date 2026-05-12
```

查看最近 30 天 capability 排行：

```bash
himan-tracker capabilities --since 30d
```

查看最近 30 天未使用的 capability 候选：

```bash
himan-tracker unused --since 30d
```

如果报表显示没有数据，说明 SQLite 中还没有 ingested events。先确认 JSONL 文件存在有效事件，再运行 `ingest`。

## 与 Codex 集成

当前版本还没有提供一键 Codex hook 安装命令。现阶段与 Codex 集成的可用方式是：把 Codex 使用过程中产生的元数据写成 `himan-tracker` normalized JSONL，然后导入 SQLite 报表库。

推荐流程：

1. 运行 `himan-tracker doctor` 初始化本地数据目录。
2. 从 Codex 会话中提取元数据，不要写入 prompt、response、代码内容、stdout/stderr 或明文仓库路径。
3. 将元数据转换成 normalized events，一行一个 JSON 对象。
4. 运行 `himan-tracker ingest --from ./codex-events.jsonl`。
5. 使用 `summary`、`agents` 和 `capabilities` 查看 Codex 使用情况。

最小 Codex JSONL 示例：

```jsonl
{"schema_version":"1.0","event_id":"codex_turn_001","event_type":"turn_summary","occurred_at":"2026-05-12T12:00:00.000Z","agent":"codex","source":"codex-manual","session_id":"codex_s_001","turn_id":"codex_t_001","status":"success","model":"codex-model","duration_ms":10000,"input_tokens":100,"output_tokens":20,"total_tokens":120}
{"schema_version":"1.0","event_id":"codex_tool_001","event_type":"capability_usage","occurred_at":"2026-05-12T12:00:02.000Z","agent":"codex","source":"codex-manual","session_id":"codex_s_001","turn_id":"codex_t_001","status":"success","capability_type":"mcp_tool","capability_name":"github.create_pull_request","duration_ms":250,"input_tokens":null,"output_tokens":null,"total_tokens":null,"adopted":"unknown","attribution_confidence":"unknown"}
```

导入并查看 Codex 报表：

```bash
himan-tracker ingest --from ./codex-events.jsonl
himan-tracker summary --since 7d
himan-tracker agents --date 2026-05-12
himan-tracker capabilities --since 30d --agent codex
```

实际接入时，`event_id` 应该由稳定字段生成，避免同一事件重复导入；`session_id` 和 `turn_id` 应保持 Codex 会话内稳定；`capability_name` 建议使用归一化后的名称，例如 `github.create_pull_request`。如果暂时不知道 token 或耗时，可以填 `null`。

后续版本提供 Codex hook 自动安装后，会把上述 JSONL 写入和 ingest 流程自动化；在此之前，`doctor` 中的 `hooks: not configured yet` 是预期状态。

## 事件 JSONL 格式

`ingest` 读取的是 normalized event，不是原始 prompt 或 response。每一行必须是一个完整 JSON 对象，并包含 `schema_version`、`event_id`、`event_type`、`occurred_at`、`agent`、`source`、`session_id` 和 `status` 等基础字段。

示例 `turn_summary`：

```json
{"schema_version":"1.0","event_id":"evt_turn_001","event_type":"turn_summary","occurred_at":"2026-05-12T12:00:00.000Z","agent":"codex","source":"manual-import","session_id":"s_001","turn_id":"t_001","repo_hash":"repo_hash_001","status":"success","model":"gpt-5.1-codex","duration_ms":1000,"input_tokens":10,"output_tokens":5,"total_tokens":15}
```

示例 `capability_usage`：

```json
{"schema_version":"1.0","event_id":"evt_capability_001","event_type":"capability_usage","occurred_at":"2026-05-12T12:00:02.000Z","agent":"codex","source":"manual-import","session_id":"s_001","turn_id":"t_001","repo_hash":"repo_hash_001","status":"failure","capability_type":"mcp_tool","capability_name":"github.create_pull_request","duration_ms":200,"input_tokens":4,"output_tokens":1,"total_tokens":5,"adopted":"unknown","attribution_confidence":"estimated"}
```

`event_id` 用于幂等导入。同一个 `event_id` 重复导入时会被跳过，不会重复计数。token 或耗时未知时可以使用 `null`，报表会显示为未知，而不是强行当作 `0`。

## 命令手册

### `doctor`

检查本地配置和存储是否可用。

```bash
himan-tracker doctor
```

它会检查：

- 数据目录和锁目录是否可创建。
- `config.json` 是否存在，不存在则创建默认配置。
- `events.jsonl` 和 `errors.jsonl` 是否可读写。
- SQLite 数据库是否可初始化并应用 migration。
- hook 是否配置。当前 MVP 会显示 warning。

### `ingest`

把 normalized JSONL 事件导入本地 SQLite 投影。

```bash
himan-tracker ingest
```

默认读取当前 tracker home 下的 `events.jsonl`。也可以指定输入文件：

```bash
himan-tracker ingest --from ./events.jsonl
```

重建 SQLite 投影：

```bash
himan-tracker ingest --rebuild
```

`--rebuild` 会删除并重新生成 `himan.sqlite`、`himan.sqlite-shm` 和 `himan.sqlite-wal`，再从 JSONL 重新导入。

### `summary`

查看时间范围内的总体使用情况。

```bash
himan-tracker summary --since 7d
```

输出包含 session 数、turn 数、token 总量、平均延迟、成功率、Top agents 和 Top capabilities。

### `agents`

查看指定日期内按 agent 和 model 聚合的使用情况。

```bash
himan-tracker agents --date 2026-05-12
```

如果不传 `--date`，命令会使用当天日期。

### `capabilities`

查看指定时间范围内 capability 使用排行。

```bash
himan-tracker capabilities --since 30d
```

可用筛选和排序：

```bash
himan-tracker capabilities --since 30d --type mcp_tool
himan-tracker capabilities --since 30d --agent codex
himan-tracker capabilities --since 30d --sort duration
```

`--sort` 支持：

- `invocations`
- `tokens`
- `duration`
- `failures`

### `unused`

查看指定时间范围内没有使用记录的 capability 候选。

```bash
himan-tracker unused --since 30d
```

候选来源包括历史已 ingested capability，以及 `config.json` 里的 `known_capabilities`。如果没有历史数据，也没有配置 known capabilities，命令会提示没有候选。

## 数据目录和配置

默认数据目录：

```text
~/.himan-tracker
```

默认文件：

```text
~/.himan-tracker/config.json
~/.himan-tracker/events.jsonl
~/.himan-tracker/errors.jsonl
~/.himan-tracker/himan.sqlite
~/.himan-tracker/locks/
```

使用其他目录：

```bash
HIMAN_TRACKER_HOME=/custom/path himan-tracker doctor
```

默认配置会写入 `config.json`：

```json
{
  "schema_version": "1.0",
  "privacy": {
    "capture_content": false,
    "hash_repo_path": true,
    "capture_shell_args": false
  },
  "agents": {
    "codex": { "enabled": true },
    "claude-code": { "enabled": true }
  },
  "known_capabilities": [],
  "local_salt": "..."
}
```

可以把希望追踪但近期未必有调用记录的 capability 加到 `known_capabilities`，这样 `unused` 才能把它们纳入候选。

## 隐私说明

`himan-tracker` 默认只处理使用元数据，不处理对话内容。

默认不会采集：

- prompt 原文
- response 原文
- 代码内容
- stdout / stderr 原文
- 明文仓库路径
- shell command 参数
- 远程 telemetry

默认会处理：

- agent 名称
- 模型名称
- session / turn 标识
- token 数量
- 请求耗时
- capability 类型和名称
- 成功、失败、取消或未知状态
- 仓库路径 hash

当 `capture_shell_args=false` 时，shell command capability 会只保留命令名，不保留参数。远程同步、内容采集和团队级分析都不属于当前默认行为，未来如加入也应作为显式 opt-in 能力。

## 常见问题

### 为什么 `doctor` 显示 hooks 还未配置？

这是当前 MVP 的预期状态。Codex / Claude Code 事件输入解析能力已经具备，但还没有面向用户的一键 hook 安装流程。

### 为什么 `summary` 显示没有数据？

报表读取的是 SQLite 投影。先确认 `events.jsonl` 中有合法 normalized events，然后运行 `himan-tracker ingest` 或 `himan-tracker ingest --from ./events.jsonl`。

### JSONL 和 SQLite 分别有什么用？

JSONL 是事实源，保留可回放的原始 normalized events。SQLite 是查询投影，用来快速生成报表。需要重算时可以用 `ingest --rebuild` 从 JSONL 重建 SQLite。

### token 归因一定准确吗？

不一定。agent 或 hook 明确提供的数据会被标记为精确值；无法精确归因的数据应标记为 `estimated` 或 `unknown`。报表会展示 estimated token 计数，避免把估算值当作精确事实。

### 会上传我的代码或 prompt 吗？

不会。当前实现没有远程上传逻辑，默认也不采集 prompt、response 或代码内容。

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
