# himan-tracker

`himan-tracker` 是一个本地优先的 AI coding agent 观测与分析 CLI，用来记录和分析 Codex、Claude Code 等 AI 编程工具的使用元数据。它关注的是研发过程中真实发生了什么：用了哪些 agent、哪些模型消耗了 token、一次会话花了多久、哪些 skill / MCP tool / plugin / shell command 被频繁调用，以及哪些 capability 长期没有价值信号。

项目当前处于早期 MVP：本地数据目录、隐私默认值、异步采集队列、JSONL 事件日志、SQLite 投影、幂等 ingest、CLI 报表、Codex 事件采集入口，以及 Codex hooks 快速安装命令已经具备；发布包还没有提供。

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
| JSONL 事件日志 | 已实现，`events/YYYY-MM-DD.jsonl` 保存 normalized events，`errors/YYYY-MM-DD.jsonl` 保存采集错误 |
| SQLite 投影 | 已实现，`ingest` 可把 JSONL 导入 `himan.sqlite` 并重算每日统计 |
| CLI 报表 | 已实现 `summary`、`agents`、`capabilities`、`unused` |
| Agent 事件采集 | 已实现 `collect --agent codex`，默认异步入队并后台写入事件日志 |
| Codex hooks 安装 | 已实现 `setup --agent codex`，默认安装到当前项目，支持 `-g, --global` 全局安装 |
| 发布版安装 | 尚未发布，安装方式发布后补充 |

## 核心概念

`himan-tracker` 使用两层本地数据：

- `queue/`：hook 调用的轻量投递队列。`collect` 会先把已脱敏的 normalized events 入队，再由后台 worker 写入最终 JSONL，避免阻塞 Codex。
- `events/YYYY-MM-DD.jsonl`：按天分片的 append-only 原始事件日志，一行一个 normalized event，适合调试、回放和重新聚合。
- `errors/YYYY-MM-DD.jsonl`：按天分片的 collector 错误日志。
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

`doctor` 会创建或检查数据目录、`config.json`、`events/`、`errors/`、`queue/`、`locks/` 和 `himan.sqlite`。如果还没运行 `setup`，看到 `codex hooks: not configured yet` 是预期结果。

把 `himan-tracker` 接到 Codex hooks：

```bash
himan-tracker setup
```

`--agent` 默认是 `codex`，等价于：

```bash
himan-tracker setup --agent codex
```

默认安装到当前项目的 `.codex/`。想在所有 Codex 项目中启用时使用：

```bash
himan-tracker setup -g
```

把 Codex hook 或 wrapper 产生的 JSON payload 投递给采集入口：

```bash
himan-tracker collect --agent codex
```

`--agent` 默认就是 `codex`，所以也可以写成：

```bash
himan-tracker collect
```

`collect` 默认是非阻塞模式：它只做轻量解析、隐私脱敏和本地入队，然后启动后台 worker 写入 `events/YYYY-MM-DD.jsonl`。采集报错不会让命令返回非 0，也不会影响 Codex 正常流程。

导入 SQLite 投影：

```bash
himan-tracker ingest
```

默认会扫描 tracker home 下的 `events/*.jsonl`。如果事件文件在其他位置，可以指定单个 JSONL 文件：

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

当前版本提供 `collect --agent codex` 作为 Codex 数据入口。它读取 Codex hook 或 wrapper 产生的 JSON payload，转换为 normalized events，先写入本地 `queue/`，再由后台 worker 写入 `events/YYYY-MM-DD.jsonl`。

推荐流程：

1. 运行 `himan-tracker doctor` 初始化本地数据目录。
2. 运行 `himan-tracker setup` 安装当前项目 Codex hooks，或运行 `himan-tracker setup -g` 安装全局 Codex hooks。
3. Codex hook 会把 JSON payload 通过 stdin 传给 `himan-tracker collect --agent codex --quiet`。
4. `collect` 立即入队并返回，后台 worker 异步写入 JSONL；即使采集失败，默认也返回 0，不影响 Codex 原流程。
5. 运行 `himan-tracker ingest`，把事件日志导入 SQLite 投影。
6. 使用 `summary`、`agents` 和 `capabilities` 查看 Codex 使用情况。

Hook / wrapper 中推荐使用的命令：

```bash
himan-tracker collect --agent codex --quiet
```

`--quiet` 会关闭采集 summary 输出，避免 hook stdout 影响 Codex UI 或上游流程。因为 `--agent` 默认是 `codex`，最短也可以写成：

```bash
himan-tracker collect --quiet
```

本地验证某个 payload 文件：

```bash
himan-tracker collect --agent codex --from ./codex-hook-payload.json --sync --strict
himan-tracker ingest
himan-tracker summary --since 7d
```

`--sync` 会在前台 drain 队列，适合人工验证；不要把它放进 Codex hook。`--strict` 会在验证失败时返回非 0，也只建议人工调试时使用。

最小 Codex payload 示例：

```json
{
  "events": [
    {
      "hook": "PostToolUse",
      "occurred_at": "2026-05-12T12:00:02.000Z",
      "session_id": "codex_s_001",
      "turn_id": "codex_t_001",
      "repo_path": "/Users/example/project",
      "tool_name": "mcp__github__create_pull_request",
      "duration_ms": 250,
      "status": "success"
    },
    {
      "hook": "Stop",
      "occurred_at": "2026-05-12T12:00:10.000Z",
      "session_id": "codex_s_001",
      "turn_id": "codex_t_001",
      "repo_path": "/Users/example/project",
      "model": "gpt-5.1-codex",
      "duration_ms": 10000,
      "input_tokens": 100,
      "output_tokens": 20,
      "status": "success"
    }
  ]
}
```

接入时不需要自己生成 `event_id`，`himan-tracker` 会用稳定字段生成幂等 ID。`session_id` 和 `turn_id` 应保持 Codex 会话内稳定；不知道 token 或耗时时可以省略字段。默认隐私策略会丢弃 prompt、response、代码内容、stdout/stderr、shell 参数和明文仓库路径，只保留用于报表的元数据和仓库 hash。

项目级安装写入当前仓库的 `.codex/`，只有该项目被 Codex 信任后才会加载；全局安装写入 `~/.codex`，会在所有 Codex 项目中生效。

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
- `events/`、`errors/` 和 `queue/` 目录是否可读写。
- SQLite 数据库是否可初始化并应用 migration。
- Codex hooks 是否配置。

### `setup`

安装 Codex hooks，让 Codex 自动把使用元数据投递给 `himan-tracker collect`。

安装到当前项目的 `.codex/`：

```bash
himan-tracker setup
```

显式指定 agent：

```bash
himan-tracker setup --agent codex
```

全局安装到 `~/.codex`：

```bash
himan-tracker setup -g
himan-tracker setup --global
```

预览将要写入的文件：

```bash
himan-tracker setup --dry-run
```

命令会写入或合并这些文件：

```text
<repo>/.codex/config.toml
<repo>/.codex/hooks.json
<repo>/.codex/hooks/himan-tracker-collect.sh
```

全局安装时路径对应为：

```text
~/.codex/config.toml
~/.codex/hooks.json
~/.codex/hooks/himan-tracker-collect.sh
```

`setup` 会打开 Codex hooks feature flag：

```toml
[features]
codex_hooks = true
```

并写入 `PostToolUse` 和 `Stop` hooks。配置形态类似：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "'/absolute/path/.codex/hooks/himan-tracker-collect.sh'",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/absolute/path/.codex/hooks/himan-tracker-collect.sh'",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

helper 脚本内部调用 `himan-tracker collect --agent codex --quiet`，并且无论采集是否成功都会 `exit 0`，避免影响 Codex 正常流程。

### `collect`

采集 agent hook / wrapper JSON payload。当前 `--agent` 默认是 `codex`，也只支持 `codex`。

```bash
himan-tracker collect --agent codex
```

默认从 stdin 读取 payload，适合放在 Codex hook 或 wrapper 中。也可以从文件读取：

```bash
himan-tracker collect --agent codex --from ./codex-hook-payload.json
```

默认模式是 hook-safe 的非阻塞模式：命令会把已脱敏的 normalized events 写入本地队列，启动后台 worker，然后返回 0。采集失败只会记录到 `errors/YYYY-MM-DD.jsonl`，不会阻塞 Codex。放进 hook 时建议加 `--quiet`，避免向 stdout 写入 summary。

```bash
himan-tracker collect --agent codex --quiet
```

人工验证时可以使用：

```bash
himan-tracker collect --agent codex --from ./codex-hook-payload.json --sync --strict
```

`--sync` 会在前台 drain 队列，`--strict` 会把采集失败转换成非 0 exit code。不要在 Codex hook 中使用这两个参数。

### `ingest`

把 normalized JSONL 事件导入本地 SQLite 投影。

```bash
himan-tracker ingest
```

默认读取当前 tracker home 下的 `events/*.jsonl`。也可以指定输入文件：

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
~/.himan-tracker/events/YYYY-MM-DD.jsonl
~/.himan-tracker/errors/YYYY-MM-DD.jsonl
~/.himan-tracker/queue/
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

### 为什么 `doctor` 显示 Codex hooks 还未配置？

先运行 `himan-tracker setup`。如果想在所有 Codex 项目中启用，运行 `himan-tracker setup -g`，然后重启 Codex 让它重新加载 hooks。

### 为什么 `summary` 显示没有数据？

报表读取的是 SQLite 投影。先确认 `events/*.jsonl` 中有合法 normalized events，然后运行 `himan-tracker ingest`；如果事件在外部文件中，运行 `himan-tracker ingest --from ./events.jsonl`。

### JSONL 和 SQLite 分别有什么用？

JSONL 是事实源，按天保存在 `events/YYYY-MM-DD.jsonl` 中，保留可回放的原始 normalized events。SQLite 是查询投影，用来快速生成报表。需要重算时可以用 `ingest --rebuild` 从 JSONL 分片重建 SQLite。

### token 归因一定准确吗？

不一定。agent 或 hook 明确提供的数据会被标记为精确值；无法精确归因的数据应标记为 `estimated` 或 `unknown`。报表会展示 estimated token 计数，避免把估算值当作精确事实。

### 会上传我的代码或 prompt 吗？

不会。当前实现没有远程上传逻辑，默认也不采集 prompt、response 或代码内容。

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
