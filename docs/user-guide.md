# himan-tracker 用户手册

本文档记录 `himan-tracker` 的完整用户命令、Codex 集成方式、数据文件、事件格式和常见问题。项目简介、核心特性和快速使用流程见 [README.md](../README.md)。

## 使用状态

当前项目处于早期 MVP，npm 包已发布为 `@hi-man/himan-tracker`。通过 npm 全局安装：

```bash
npm install -g @hi-man/himan-tracker
```

安装后 CLI 入口是：

```bash
himan-tracker <command>
```

当前 `collect` 只支持 Codex：

```bash
himan-tracker collect --agent codex
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

1. 运行 `himan-tracker doctor` 初始化本地数据目录。
2. 在需要采集的项目中运行 `himan-tracker setup` 安装当前项目 Codex hooks，或运行 `himan-tracker setup -g` 安装全局 Codex hooks。
3. Codex hook 会把 `UserPromptSubmit`、`PostToolUse` 和 `Stop` payload 通过 stdin 传给 `himan-tracker collect --agent codex --quiet`。
4. `collect` 立即入队并返回，后台 worker 异步写入 JSONL，并从 Codex `transcript_path` 补齐 turn token、turn duration、MCP tool 调用和可推断的 skill 使用。
5. 运行 `himan-tracker ingest`，把事件日志导入 SQLite 投影。
6. 使用 `summary`、`tokens`、`agents`、`turns`、`capabilities`、`capability-events` 和 `unused` 查看使用情况。
7. 运行 `himan-tracker server start`，启动本地报表页面，并让它按固定间隔增量导入事件。

## 与 Codex 集成

当前版本提供 `collect --agent codex` 作为 Codex 数据入口。它读取 Codex hook 或 wrapper 产生的 JSON payload，转换为 normalized events，先写入本地 `queue/`，再由后台 worker 写入 `events/YYYY-MM-DD.jsonl`。

Hook 或 wrapper 中推荐使用的命令：

```bash
himan-tracker collect --agent codex --quiet
```

`--quiet` 会关闭采集 summary 输出，避免 hook stdout 影响 Codex UI 或上游流程。`setup` 生成的 helper 会使用这种 `himan-tracker` 形式调用 collector。

本地验证某个 payload 文件：

```bash
himan-tracker collect --agent codex --from ./codex-hook-payload.json --sync --strict
himan-tracker ingest
himan-tracker summary --since 7d
```

`--sync` 会在前台 drain 队列，适合人工验证；不要把它放进 Codex hook。`--strict` 会在验证失败时返回非 0，也只建议人工调试时使用。

接入时不需要自己生成 `event_id`，`himan-tracker` 会用稳定字段生成幂等 ID。`session_id` 和 `turn_id` 应保持 Codex 会话内稳定；不知道 token 或耗时时可以省略字段。Codex hooks 提供 `transcript_path` 时，后台 worker 会只读取 token、耗时、MCP tool 结束事件，以及读取 `SKILL.md` 的工具调用元数据来补齐报表。若能从工具调用参数或 workdir 定位到项目 `himan.lock`，推断出的 skill 还会用 Himan lock 中安装到 Codex 的 skill 清单确认。不保存 prompt、response、代码内容、MCP 参数、stdout/stderr、shell 参数、`himan.lock` source URL 或明文仓库路径。

`UserPromptSubmit` 中显式写出的 `$skill-name` 会被提取为 `invocation_origin=explicit`、`attribution_confidence=exact` 的 skill 调用；从 `SKILL.md` 读取行为推断出的 skill 会标记为 `invocation_origin=inferred`、`attribution_confidence=estimated`。当项目存在可读取的 `himan.lock` 时，未安装到 Codex 的 skill 不会因为 transcript 中出现 `SKILL.md` 路径而被统计。MCP/tool 结构化事件会标记为 `invocation_origin=observed`。

项目级安装写入当前仓库的 `.codex/`，只有该项目被 Codex 信任后才会加载；全局安装写入 `~/.codex`，会在所有 Codex 项目中生效。

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
hooks = true
```

并写入 `UserPromptSubmit`、`PostToolUse` 和 `Stop` hooks。helper 脚本内部会调用 `himan-tracker collect --agent codex --quiet`，并且无论采集是否成功都会 `exit 0`，避免影响 Codex 正常流程。

### `backfill codex`

从 Codex 本地 transcript JSONL 补写缺失的 normalized events。适合 hook 暂时失效、但 Codex transcript 仍在的场景。

```bash
himan-tracker backfill codex --date 2026-05-15
```

默认读取 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`。也可以指定 transcript 目录：

```bash
himan-tracker backfill codex --date 2026-05-15 --from ~/.codex/sessions/2026/05/15
```

backfill 会写入 `events/YYYY-MM-DD.jsonl`，并在写入前读取现有分片中的 `event_id` 和相似事件，跳过已经存在的事件；同一 session/turn/name 的 skill 也只补写一次。后续 `ingest` 也会通过 SQLite 的 `ingested_events` 表跳过已导入事件。因此重复运行 backfill 或 ingest 不会重复入库。backfill 会从 transcript 的 `event_msg.user_message` 识别显式 `$skill-name`，也会从实际 shell 工具调用中读取 `SKILL.md` 的路径推断 skill；它不会从系统提示或完整 prompt context 的技能列表里推断 skill。backfill 只持久化 normalized metadata，不保存 prompt、response、stdout/stderr、tool 参数或明文 repo path。

### `collect`

采集 agent hook 或 wrapper JSON payload。当前 `--agent` 默认是 `codex`，也只支持 `codex`。

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

### `archive monthly`

把最近 6 个自然月之前的完整月份归档为月度统计，并清理对应的日级原始分片和日统计。

```bash
himan-tracker archive monthly --dry-run
himan-tracker archive monthly
```

归档窗口按自然月计算，包含当前月在内保留最近 6 个自然月。例如当前日期是 `2026-05-15` 时，保留 `2025-12` 到 `2026-05`，只归档 `2025-11` 及更早月份。命令会：

- 从 `daily_agent_stats` 汇总到 `monthly_agent_stats`。
- 从 `daily_capability_stats` 汇总到 `monthly_capability_stats`。
- 删除已归档月份对应的 `events/YYYY-MM-DD.jsonl` 和 `errors/YYYY-MM-DD.jsonl`。
- 删除已归档月份对应的 `daily_agent_stats` 和 `daily_capability_stats` 行。

当前版本没有持久化周统计表，周报是从日统计临时聚合的；因此清理对应日统计后，也不会再保留这些月份的周级明细。`--dry-run` 只预览将归档的月份、月度行数和将删除的文件数量，不写入归档表、不删除日统计，也不删除文件。

### `server`

启动、停止和查看本地报表 Web server。server 默认只监听 `127.0.0.1`，启动后会立即执行一次增量 `ingest`，之后按固定间隔继续导入 `events/*.jsonl`。页面默认会以 HTML 表格展示总览、一个可切换日/周/月的 runtime token 用量卡片、agent、capability、一个可切换 skill/MCP tool 的调用列表卡片和近期 turn；也可以通过 `--display text` 切换为命令行风格文本块，并提供 `/dashboard.json` 结构化数据端点。

```bash
himan-tracker server start
```

默认地址是：

```text
http://127.0.0.1:5127
```

如果希望启动后直接打开默认浏览器：

```bash
himan-tracker server start --open
```

可调整监听地址、端口、报表范围、导入间隔和页面展示模式：

```bash
himan-tracker server start --host 127.0.0.1 --port 5127 --since 7d --interval 300 --display table
himan-tracker server start --display text
```

查看状态和停止：

```bash
himan-tracker server status
himan-tracker server stop
```

server 状态和日志写在 tracker home 下：

```text
~/.himan-tracker/server-state.json
~/.himan-tracker/server.log
```

### `cleanup`

清理本地 JSONL 原始日志，保留已经导入 SQLite 的统计结果。这个命令只删除 `events/*.jsonl`、`errors/*.jsonl` 和旧版单文件原始日志，不删除 `himan.sqlite`，也不清理尚未 drain 的 `queue/`。

预览全部可删除的原始日志：

```bash
himan-tracker cleanup --all --dry-run
```

清理全部原始日志：

```bash
himan-tracker cleanup --all
```

清理某个日期区间，包含起止日期：

```bash
himan-tracker cleanup --from 2026-05-01 --to 2026-05-07
```

清理某天之前的日志，不包含当天：

```bash
himan-tracker cleanup --before 2026-05-01
```

清理指定保留窗口之前的日志，例如保留最近 30 天，删除更早的原始分片：

```bash
himan-tracker cleanup --older-than 30d
```

`--before` 是开区间截止日期，`--from/--to` 是包含边界的日期区间。`--older-than` 支持 `d`、`w`、`m`，按天、周、30 天月计算。清理后现有报表仍可读取 SQLite 中的统计结果；但如果之后运行 `ingest --rebuild`，被删除的原始 JSONL 无法再用于重建历史统计。

### `summary`

查看时间范围内的总体使用情况。

```bash
himan-tracker summary --since 7d
himan-tracker summary --since 7d --limit 20
himan-tracker summary --since 7d --exclude-system
```

输出包含 session 数、turn 数、runtime token 总量、平均延迟、成功率、Top agents 和 `Top N capabilities`。`Top N capabilities` 默认展示 10 个，可用 `--limit` 调整为 1 到 200；可用 `--exclude-system` 排除 `Bash`、`apply_patch` 等系统自带 capability。Top capabilities 会展示调用次数、runtime token 和平均耗时。报表中的 runtime token 总量使用 1000 进制的紧凑单位显示，例如 `1.25K`、`3.56M`、`1.2G`。

### `tokens`

查看指定时间范围内按日、自然周或自然月聚合的 runtime token 用量。

```bash
himan-tracker tokens --period day --since 30d
himan-tracker tokens --period week --since 12w
himan-tracker tokens --period month --since 12m
```

`--period` 支持 `day`、`week`、`month`，也支持 `daily`、`weekly`、`monthly`。自然周按本地时间的周一到周日聚合。输出包含 turns、input tokens、output tokens、total tokens 和平均每 turn token；这些 token 只使用观测到的 runtime token 字段，不包含 `himan.yaml` 的静态 token estimate。

### `agents`

查看指定日期内按 agent 和 model 聚合的使用情况。

```bash
himan-tracker agents --date 2026-05-12
```

如果不传 `--date`，命令会使用当天日期。

### `turns`

查看最近一段时间内的逐轮对话耗时、runtime token 和状态。

```bash
himan-tracker turns --since 7d
```

可按 agent 过滤，并限制输出行数：

```bash
himan-tracker turns --since 30d --agent codex --limit 50
```

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
himan-tracker capabilities --since 30d --exclude-system
```

`--sort` 支持：

- `invocations`
- `tokens`
- `duration`
- `failures`

Codex hooks 不直接提供耗时字段。himan-tracker 会在后台从 Codex transcript 的 `task_complete`、`mcp_tool_call_end` 和 tool end 事件补齐 turn 或 tool duration；Codex 暂无官方结构化 skill 执行事件，因此从显式 `$skill-name` 或读取 `SKILL.md` 的工具调用推断 skill 使用。若能读取当前项目 `himan.lock`，读取 `SKILL.md` 推断出的 skill 会先按 lock 中的 Codex 安装记录过滤。`capabilities` 报表会用 `Explicit`、`Inferred`、`Observed` 和 `Unknown` 列拆分调用来源；报表中的 skill duration 使用该 skill 所在 turn 的耗时作为估算。

`capabilities` 报表会用 `Avg duration`、`Min duration` 和 `Max duration` 分开展示已知耗时的平均值、最小值和最大值；`--sort duration` 仍按平均耗时排序。

### `capability-events`

查看某个 capability 的逐次调用记录，适合观察某个 skill 或 MCP tool 优化后的耗时、状态和 token 变化。

```bash
himan-tracker capability-events --type skill --name common-git-commit --since 30d
himan-tracker capability-events --type mcp_tool --name openaiDeveloperDocs.search_openai_docs --since 30d
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
himan-tracker capability-events --type skill --name common-git-commit --agent codex --limit 50
```

输出包含调用时间、agent、source、model、turn、耗时、runtime token、状态、采纳状态、调用来源和归因置信度。`Origin` 表示 `explicit`、`inferred`、`observed` 或 `unknown`；`Confidence` 表示 `exact`、`estimated` 或 `unknown`。`Basis` 表示耗时来源：`event` 是 capability 事件自身提供的耗时，`turn` 是使用同一 turn 耗时估算，`n/a` 表示未知。

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
~/.himan-tracker/server-state.json
~/.himan-tracker/server.log
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

## 事件 JSONL 格式

`ingest` 读取的是 normalized event，不是原始 prompt 或 response。每一行必须是一个完整 JSON 对象，并包含 `schema_version`、`event_id`、`event_type`、`occurred_at`、`agent`、`source`、`session_id` 和 `status` 等基础字段。

示例 `turn_summary`：

```json
{"schema_version":"1.0","event_id":"evt_turn_001","event_type":"turn_summary","occurred_at":"2026-05-12T12:00:00.000Z","agent":"codex","source":"manual-import","session_id":"s_001","turn_id":"t_001","repo_hash":"repo_hash_001","status":"success","model":"gpt-5.1-codex","duration_ms":1000,"input_tokens":10,"output_tokens":5,"total_tokens":15}
```

示例 `capability_usage`：

```json
{"schema_version":"1.0","event_id":"evt_capability_001","event_type":"capability_usage","occurred_at":"2026-05-12T12:00:02.000Z","agent":"codex","source":"manual-import","session_id":"s_001","turn_id":"t_001","repo_hash":"repo_hash_001","status":"failure","capability_type":"mcp_tool","capability_name":"github.create_pull_request","duration_ms":200,"input_tokens":4,"output_tokens":1,"total_tokens":5,"adopted":"unknown","attribution_confidence":"estimated","invocation_origin":"observed"}
```

`event_id` 用于幂等导入。同一个 `event_id` 重复导入时会被跳过，不会重复计数。runtime token 或耗时未知时可以使用 `null`，报表会显示为未知，而不是强行当作 `0`。

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

先运行 `himan-tracker setup`。如果想在所有 Codex 项目中启用，运行 `himan-tracker setup -g`，然后重启 Codex 让它重新加载 hooks。

### 为什么 `summary` 显示没有数据？

报表读取的是 SQLite 投影。先确认 `events/*.jsonl` 中有合法 normalized events，然后运行 `himan-tracker ingest`；如果事件在外部文件中，运行 `himan-tracker ingest --from ./events.jsonl`。

如果使用本地页面，运行 `himan-tracker server start` 后 server 会先执行一次增量导入，并在后台按 `--interval` 周期继续导入。

### JSONL 和 SQLite 分别有什么用？

JSONL 是事实源，按天保存在 `events/YYYY-MM-DD.jsonl` 中，保留可回放的原始 normalized events。SQLite 是查询投影，用来快速生成报表。需要重算时可以用 `ingest --rebuild` 从 JSONL 分片重建 SQLite。

### token 归因一定准确吗？

不一定。Codex hook payload 本身通常不直接提供 token，当前实现会在后台从 Codex transcript 的 token 计数字段补齐 turn 级 token。capability 级 token 仍可能无法精确归因，无法精确归因的数据会保持为 `null`、`estimated` 或 `unknown`，避免把估算值当作精确事实。

### 会上传我的代码或 prompt 吗？

不会。当前实现没有远程上传逻辑，默认也不采集 prompt、response 或代码内容。
