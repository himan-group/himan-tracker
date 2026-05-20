# himan-tracker

`himan-tracker` 是一个面向 Codex 和 Claude Code 的本地优先使用分析工具，用于统计 agent 对话、runtime token 用量、执行耗时，以及 skill / MCP tool / plugin 的使用情况，帮助团队评估 AI 工作流 ROI。

## 当前进度

- [x] Codex 数据采集入口
- [x] Codex hooks 安装
- [x] JSONL 本地日志
- [x] SQLite 查询投影
- [x] summary、tokens、agents、turns、capabilities、capability-events 和 unused 报表
- [x] 本地报表 Web server
- [x] 原始日志清理
- [ ] Claude Code 采集

## 安装

```bash
npm install -g @hi-man/himan-tracker
```

要求 Node.js `>=20.11`。

## 快速开始

```bash
himan-tracker doctor
himan-tracker setup
himan-tracker backfill codex --date YYYY-MM-DD
himan-tracker ingest
himan-tracker archive monthly --dry-run
himan-tracker summary --since 7d
himan-tracker tokens --period week --since 12w
himan-tracker server start --open
```

- `doctor` 检查并初始化本地数据目录。
- `setup` 为当前项目安装 Codex hooks。
- `backfill codex` 从 Codex 本地 transcript 补写缺失的 normalized events，包含显式 `$skill-name` 和读取 `SKILL.md` 推断的 skill，并按重复事件规则跳过已存在数据。
- `ingest` 将本地 JSONL 事件导入 SQLite。
- `archive monthly` 把最近 6 个自然月之前的日统计汇总到月度归档表，并清理对应日分片。
- `summary` 查看最近使用总览。
- `tokens` 查看每日、每周或每月 runtime token 用量。
- `server start` 启动本地报表页面，并定时增量导入事件；加 `--open` 会自动打开浏览器，`--display text` 可切换为命令行风格文本展示。

安装全局 Codex hooks：

```bash
himan-tracker setup -g
```

预览 hook 配置但不写入文件：

```bash
himan-tracker setup --dry-run
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `himan-tracker doctor` | 检查本地配置、数据目录和 SQLite 状态 |
| `himan-tracker setup` | 为当前项目安装 Codex hooks |
| `himan-tracker setup -g` | 安装全局 Codex hooks |
| `himan-tracker backfill codex --date YYYY-MM-DD` | 从 Codex 本地 transcript 补写指定日期事件 |
| `himan-tracker ingest` | 将 `events/*.jsonl` 导入 SQLite |
| `himan-tracker archive monthly --dry-run` | 预览半年前完整月份的月度归档和原始分片清理 |
| `himan-tracker server start` | 启动本地报表 Web server |
| `himan-tracker server start --open` | 启动并用默认浏览器打开报表页面 |
| `himan-tracker server start --display text` | 用命令行风格文本展示报表页面 |
| `himan-tracker server status` | 查看本地报表 Web server 状态 |
| `himan-tracker server stop` | 停止本地报表 Web server |
| `himan-tracker summary --since 7d` | 查看最近 7 天总览 |
| `himan-tracker tokens --period day --since 30d` | 查看每日 runtime token 用量 |
| `himan-tracker tokens --period week --since 12w` | 查看每周 runtime token 用量 |
| `himan-tracker tokens --period month --since 12m` | 查看每月 runtime token 用量 |
| `himan-tracker agents --date 2026-05-12` | 查看某天的 agent / model 使用 |
| `himan-tracker turns --since 7d --limit 50` | 查看逐 turn 明细 |
| `himan-tracker capabilities --since 30d` | 查看 capability 使用排行 |
| `himan-tracker capability-events --type skill --name common-git-commit --since 30d` | 查看某个 capability 的调用记录 |
| `himan-tracker unused --since 30d` | 查看近期未使用的 capability 候选 |
| `himan-tracker cleanup --older-than 30d` | 清理较早的原始 JSONL 日志 |

## 数据与隐私

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
~/.himan-tracker/server-state.json
~/.himan-tracker/server.log
```

默认隐私行为：

- 不采集 prompt、response、代码内容、stdout/stderr 或 shell 参数。
- 默认 hash 仓库路径，不保存明文 repo path。
- 采集失败默认不阻塞 Codex workflow。

完整命令说明、Codex 集成细节、事件 JSONL 格式和 FAQ 见 [docs/user-guide.md](docs/user-guide.md)。
