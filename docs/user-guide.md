# himan-tracker 用户手册

本文档记录 `himan-tracker` 的完整用户命令、Codex 集成方式、数据文件、事件格式和常见问题。项目简介、核心特性和快速使用流程见 [README.md](../README.md)。

## 使用状态

当前项目处于早期 MVP，尚未发布面向最终用户的 npm 包。当前可用方式是从源码运行：

```bash
pnpm cli <command>
```

发布包可用后，CLI 入口会是：

```bash
himan-tracker <command>
```

当前 `collect` 只支持 Codex：

```bash
pnpm cli collect --agent codex
```

Claude Code 相关配置和 adapter 属于后续工作。

## 核心概念

`himan-tracker` 使用以下几类本地数据：

- `queue/`：hook 调用的轻量投递队列。`collect` 会先把已脱敏的 normalized events 和必要的补数任务入队，再由后台 worker 写入最终 JSONL，避免阻塞 Codex。
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

## 推荐流程

1. 运行 `pnpm cli doctor` 初始化本地数据目录。
2. 在当前源码项目中运行 `pnpm cli setup` 安装当前项目 Codex hooks，或运行 `pnpm cli setup -g` 安装全局 Codex hooks。
3. Codex hook 会把 `UserPromptSubmit`、`PostToolUse` 和 `Stop` payload 通过 stdin 传给 `pnpm cli collect --agent codex --quiet`。
4. `collect` 立即入队并返回，后台 worker 异步写入 JSONL，并从 Codex `transcript_path` 补齐 turn token、turn duration、MCP tool 调用和可推断的 skill 使用。
5. 运行 `pnpm cli ingest`，把事件日志导入 SQLite 投影。
6. 使用 `summary`、`agents`、`turns`、`capabilities`、`capability-events` 和 `unused` 查看使用情况。

## 与 Codex 集成

当前版本提供 `collect --agent codex` 作为 Codex 数据入口。它读取 Codex hook 或 wrapper 产生的 JSON payload，转换为 normalized events，先写入本地 `queue/`，再由后台 worker 写入 `events/YYYY-MM-DD.jsonl`。

Hook 或 wrapper 中推荐使用的命令：

```bash
cd /path/to/himan-tracker && pnpm cli collect --agent codex --quiet
```

`--quiet` 会关闭采集 summary 输出，避免 hook stdout 影响 Codex UI 或上游流程。`setup` 生成的 helper 会自动写入当前源码项目路径，并使用这种 `pnpm cli` 形式调用 collector。

本地验证某个 payload 文件：

```bash
pnpm cli collect --agent codex --from ./codex-hook-payload.json --sync --strict
pnpm cli ingest
pnpm cli summary --since 7d
```

`--sync` 会在前台 drain 队列，适合人工验证；不要把它放进 Codex hook。`--strict` 会在验证失败时返回非 0，也只建议人工调试时使用。

接入时不需要自己生成 `event_id`，`himan-tracker` 会用稳定字段生成幂等 ID。`session_id` 和 `turn_id` 应保持 Codex 会话内稳定；不知道 token 或耗时时可以省略字段。Codex hooks 提供 `transcript_path` 时，后台 worker 会只读取 token、耗时、MCP tool 结束事件，以及读取 `SKILL.md` 的工具调用元数据来补齐报表，不保存 prompt、response、代码内容、MCP 参数、stdout/stderr、shell 参数或明文仓库路径。

`UserPromptSubmit` 中显式写出的 `$skill-name` 会被提取为精确 skill 调用；从 `SKILL.md` 读取行为推断出的 skill 会标记为 `attribution_confidence=estimated`。

项目级安装写入当前仓库的 `.codex/`，只有该项目被 Codex 信任后才会加载；全局安装写入 `~/.codex`，会在所有 Codex 项目中生效。

## 命令手册

### `doctor`

检查本地配置和存储是否可用。

```bash
pnpm cli doctor
```

它会检查：

- 数据目录和锁目录是否可创建。
- `config.json` 是否存在，不存在则创建默认配置。
- `events/`、`errors/` 和 `queue/` 目录是否可读写。
- SQLite 数据库是否可初始化并应用 migration。
- Codex hooks 是否配置。

### `setup`

安装 Codex hooks，让 Codex 自动把使用元数据投递给 `pnpm cli collect`。当前项目还没有发布 npm 包，所以 hooks helper 会从本源码项目目录运行 `pnpm cli`。

安装到当前项目的 `.codex/`：

```bash
pnpm cli setup
```

显式指定 agent：

```bash
pnpm cli setup --agent codex
```

全局安装到 `~/.codex`：

```bash
pnpm cli setup -g
pnpm cli setup --global
```

预览将要写入的文件：

```bash
pnpm cli setup --dry-run
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
hooks = true
```

并写入 `UserPromptSubmit`、`PostToolUse` 和 `Stop` hooks。helper 脚本内部会进入当前源码项目目录并调用 `pnpm cli collect --agent codex --quiet`，并且无论采集是否成功都会 `exit 0`，避免影响 Codex 正常流程。

### `collect`

采集 agent hook 或 wrapper JSON payload。当前 `--agent` 默认是 `codex`，也只支持 `codex`。

```bash
pnpm cli collect --agent codex
```

默认从 stdin 读取 payload，适合放在 Codex hook 或 wrapper 中。也可以从文件读取：

```bash
pnpm cli collect --agent codex --from ./codex-hook-payload.json
```

默认模式是 hook-safe 的非阻塞模式：命令会把已脱敏的 normalized events 写入本地队列，启动后台 worker，然后返回 0。采集失败只会记录到 `errors/YYYY-MM-DD.jsonl`，不会阻塞 Codex。放进 hook 时建议加 `--quiet`，避免向 stdout 写入 summary。

```bash
cd /path/to/himan-tracker && pnpm cli collect --agent codex --quiet
```

人工验证时可以使用：

```bash
pnpm cli collect --agent codex --from ./codex-hook-payload.json --sync --strict
```

`--sync` 会在前台 drain 队列，`--strict` 会把采集失败转换成非 0 exit code。不要在 Codex hook 中使用这两个参数。

### `ingest`

把 normalized JSONL 事件导入本地 SQLite 投影。

```bash
pnpm cli ingest
```

默认读取当前 tracker home 下的 `events/*.jsonl`。也可以指定输入文件：

```bash
pnpm cli ingest --from ./events.jsonl
```

重建 SQLite 投影：

```bash
pnpm cli ingest --rebuild
```

`--rebuild` 会删除并重新生成 `himan.sqlite`、`himan.sqlite-shm` 和 `himan.sqlite-wal`，再从 JSONL 重新导入。

### `cleanup`

清理本地 JSONL 原始日志，保留已经导入 SQLite 的统计结果。这个命令只删除 `events/*.jsonl`、`errors/*.jsonl` 和旧版单文件原始日志，不删除 `himan.sqlite`，也不清理尚未 drain 的 `queue/`。

预览全部可删除的原始日志：

```bash
pnpm cli cleanup --all --dry-run
```

清理全部原始日志：

```bash
pnpm cli cleanup --all
```

清理某个日期区间，包含起止日期：

```bash
pnpm cli cleanup --from 2026-05-01 --to 2026-05-07
```

清理某天之前的日志，不包含当天：

```bash
pnpm cli cleanup --before 2026-05-01
```

清理指定保留窗口之前的日志，例如保留最近 30 天，删除更早的原始分片：

```bash
pnpm cli cleanup --older-than 30d
```

`--before` 是开区间截止日期，`--from/--to` 是包含边界的日期区间。`--older-than` 支持 `d`、`w`、`m`，按天、周、30 天月计算。清理后现有报表仍可读取 SQLite 中的统计结果；但如果之后运行 `ingest --rebuild`，被删除的原始 JSONL 无法再用于重建历史统计。

### `summary`

查看时间范围内的总体使用情况。

```bash
pnpm cli summary --since 7d
```

输出包含 session 数、turn 数、token 总量、平均延迟、成功率、Top agents 和 Top capabilities。Top capabilities 会展示调用次数、token 和平均耗时。报表中的 token 总量使用 1000 进制的紧凑单位显示，例如 `1.25K`、`3.56M`、`1.2G`。

### `agents`

查看指定日期内按 agent 和 model 聚合的使用情况。

```bash
pnpm cli agents --date 2026-05-12
```

如果不传 `--date`，命令会使用当天日期。

### `turns`

查看最近一段时间内的逐轮对话耗时、token 和状态。

```bash
pnpm cli turns --since 7d
```

可按 agent 过滤，并限制输出行数：

```bash
pnpm cli turns --since 30d --agent codex --limit 50
```

### `capabilities`

查看指定时间范围内 capability 使用排行。

```bash
pnpm cli capabilities --since 30d
```

可用筛选和排序：

```bash
pnpm cli capabilities --since 30d --type mcp_tool
pnpm cli capabilities --since 30d --agent codex
pnpm cli capabilities --since 30d --sort duration
```

`--sort` 支持：

- `invocations`
- `tokens`
- `duration`
- `failures`

Codex hooks 不直接提供耗时字段。himan-tracker 会在后台从 Codex transcript 的 `task_complete`、`mcp_tool_call_end` 和 tool end 事件补齐 turn 或 tool duration；Codex 暂无官方结构化 skill 执行事件，因此从显式 `$skill-name` 或读取 `SKILL.md` 的工具调用推断 skill 使用。报表中的 skill duration 使用该 skill 所在 turn 的耗时作为估算。

### `capability-events`

查看某个 capability 的逐次调用记录，适合观察某个 skill 或 MCP tool 优化后的耗时、状态和 token 变化。

```bash
pnpm cli capability-events --type skill --name common-git-commit --since 30d
pnpm cli capability-events --type mcp_tool --name openaiDeveloperDocs.search_openai_docs --since 30d
```

`--type` 和 `--name` 必填，`--type` 支持：

- `skill`
- `mcp_tool`
- `plugin`
- `builtin_tool`
- `shell_command`
- `unknown`

可选参数：

```bash
pnpm cli capability-events --type skill --name common-git-commit --agent codex --limit 50
```

输出包含调用时间、agent、model、turn、耗时、token、状态、采纳状态和归因置信度。`Basis` 表示耗时来源：`event` 是 capability 事件自身提供的耗时，`turn` 是使用同一 turn 耗时估算，`n/a` 表示未知。

### `unused`

查看指定时间范围内没有使用记录的 capability 候选。

```bash
pnpm cli unused --since 30d
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
HIMAN_TRACKER_HOME=/custom/path pnpm cli doctor
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
      "transcript_path": "/path/to/codex-rollout.jsonl",
      "duration_ms": 10000,
      "input_tokens": 100,
      "output_tokens": 20,
      "status": "success"
    }
  ]
}
```

## 隐私说明

`himan-tracker` 默认只处理使用元数据，不处理对话内容。

默认不会采集：

- prompt 原文
- response 原文
- 代码内容
- stdout 或 stderr 原文
- 明文仓库路径
- shell command 参数
- 远程 telemetry

默认会处理：

- agent 名称
- 模型名称
- session 和 turn 标识
- token 数量
- Codex transcript 中的 token 计数字段
- 请求耗时
- capability 类型和名称
- 成功、失败、取消或未知状态
- 仓库路径 hash

当 `capture_shell_args=false` 时，shell command capability 会只保留命令名，不保留参数。远程同步、内容采集和团队级分析都不属于当前默认行为，未来如加入也应作为显式 opt-in 能力。

## 常见问题

### 为什么 `doctor` 显示 Codex hooks 还未配置？

先运行 `pnpm cli setup`。如果想在所有 Codex 项目中启用，运行 `pnpm cli setup -g`，然后重启 Codex 让它重新加载 hooks。

### 为什么 `summary` 显示没有数据？

报表读取的是 SQLite 投影。先确认 `events/*.jsonl` 中有合法 normalized events，然后运行 `pnpm cli ingest`；如果事件在外部文件中，运行 `pnpm cli ingest --from ./events.jsonl`。

### JSONL 和 SQLite 分别有什么用？

JSONL 是事实源，按天保存在 `events/YYYY-MM-DD.jsonl` 中，保留可回放的原始 normalized events。SQLite 是查询投影，用来快速生成报表。需要重算时可以用 `ingest --rebuild` 从 JSONL 分片重建 SQLite。

### token 归因一定准确吗？

不一定。Codex hook payload 本身通常不直接提供 token，当前实现会在后台从 Codex transcript 的 token 计数字段补齐 turn 级 token。capability 级 token 仍可能无法精确归因，无法精确归因的数据会保持为 `null`、`estimated` 或 `unknown`，避免把估算值当作精确事实。

### 会上传我的代码或 prompt 吗？

不会。当前实现没有远程上传逻辑，默认也不采集 prompt、response 或代码内容。
