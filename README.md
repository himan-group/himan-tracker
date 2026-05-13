# himan-tracker

`himan-tracker` 是一个本地优先的 AI coding agent 观测 CLI，用来记录和分析 Codex、Claude Code 等 AI 编程工具的使用元数据。它关注 agent 使用量、模型 token、turn 耗时、成功状态，以及 skill、MCP tool、plugin、shell command 等 capability 的调用情况。

项目当前处于早期 MVP。Codex 数据采集入口、Codex hooks 安装、JSONL 本地日志、SQLite 投影、报表命令和原始日志清理已经可用；Claude Code 采集和正式发布包仍在规划中。当前推荐从源码运行 CLI。

## 核心特性

- 本地优先存储：默认数据目录为 `~/.himan-tracker`，可通过 `HIMAN_TRACKER_HOME` 覆盖。
- 隐私默认保护：默认不采集 prompt、response、代码内容、stdout/stderr、明文仓库路径或 shell 参数。
- Codex 自动采集：`setup --agent codex` 可安装 Codex hooks，`collect --agent codex` 默认异步入队，避免阻塞 Codex 工作流。
- 可回放数据源：normalized events 按天写入 `events/YYYY-MM-DD.jsonl`，采集错误写入 `errors/YYYY-MM-DD.jsonl`。
- SQLite 查询投影：`ingest` 将 JSONL 导入 `himan.sqlite`，用于生成稳定的本地报表。
- 使用分析报表：支持 summary、agents、turns、capabilities、capability-events 和 unused 报表。
- 原始日志清理：`cleanup` 可删除 JSONL 原始日志，同时保留已导入 SQLite 的统计结果。

## 快速使用手册

### 1. 准备环境

`himan-tracker` 当前尚未发布 npm 包，计划发布包名为 `@hi-man/himan-tracker`。发布前请先从源码仓库运行：

```bash
pnpm install
```

发布后可通过 npm 全局安装：

```bash
npm install -g @hi-man/himan-tracker
```

要求：

- Node.js `>=20.11`
- pnpm `10.33.4` 或兼容版本

### 2. 检查本地配置

```bash
pnpm cli doctor
```

`doctor` 会创建或检查本地数据目录、默认配置、JSONL 目录、队列目录和 SQLite 数据库。首次运行且尚未安装 Codex hooks 时，看到 `codex hooks: not configured yet` 是预期结果。

### 3. 安装 Codex hooks

安装到当前项目：

```bash
pnpm cli setup
```

安装到全局 `~/.codex`：

```bash
pnpm cli setup -g
```

预览将写入的 Codex 配置：

```bash
pnpm cli setup --dry-run
```

安装后，Codex hooks 会把使用元数据投递给 `pnpm cli collect --agent codex --quiet`。默认采集流程失败时仍保持开放，采集错误不会阻塞 Codex。

### 4. 导入查询数据

当 Codex 已产生事件日志后，将 JSONL 导入 SQLite：

```bash
pnpm cli ingest
```

如果需要从指定 JSONL 文件导入：

```bash
pnpm cli ingest --from ./events.jsonl
```

### 5. 查看报表

查看最近 7 天总览：

```bash
pnpm cli summary --since 7d
```

查看某天的 agent 和 model 使用情况：

```bash
pnpm cli agents --date 2026-05-12
```

查看最近一段时间的逐 turn 明细：

```bash
pnpm cli turns --since 7d --limit 50
```

查看 capability 排行：

```bash
pnpm cli capabilities --since 30d
```

查看某个 capability 的逐次调用记录：

```bash
pnpm cli capability-events --type skill --name common-git-commit --since 30d
```

查看近期未使用的 capability 候选：

```bash
pnpm cli unused --since 30d
```

### 6. 清理原始日志

预览可删除的 JSONL 原始日志：

```bash
pnpm cli cleanup --all --dry-run
```

保留最近 30 天原始日志，删除更早的 JSONL 分片：

```bash
pnpm cli cleanup --older-than 30d
```

清理命令不会删除 `himan.sqlite`，已有报表统计仍可查询。删除 JSONL 后，如果再执行 `ingest --rebuild`，被删除的历史事件无法重新导入。

### 7. 常用路径和隐私默认值

默认数据目录：

```text
~/.himan-tracker
```

常用文件：

```text
~/.himan-tracker/config.json
~/.himan-tracker/events/YYYY-MM-DD.jsonl
~/.himan-tracker/errors/YYYY-MM-DD.jsonl
~/.himan-tracker/queue/
~/.himan-tracker/himan.sqlite
```

默认隐私配置：

```json
{
  "capture_content": false,
  "hash_repo_path": true,
  "capture_shell_args": false
}
```

完整命令说明、Codex 集成细节、事件 JSONL 格式和 FAQ 见 [docs/user-guide.md](docs/user-guide.md)。
