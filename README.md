# himan-tracker

`himan-tracker` 是一个面向 AI coding agent 的本地优先观测 CLI，用来持续记录会话、turn、runtime token、耗时、成功状态，以及 skill / MCP tool / plugin 等 capability 使用情况。

它适合已经在团队或个人工作流中使用 Codex 的开发者：你想知道 agent 实际做了多少事、花了多少 token、调用了哪些能力、哪些能力值得保留或优化，同时又不想把 prompt、response、代码内容和明文仓库路径上传到远端服务。

## 适合谁

- 想评估 Codex 使用 ROI 的个人开发者或团队
- 想长期观察 token、turn、duration 和 capability 使用趋势的维护者
- 希望把采集、存储、报表都留在本机的用户

## 为什么用它

- 本地优先：原始事件写入本地 JSONL，再投影到本地 SQLite，方便重建和查询
- 隐私默认保守：默认不保存 prompt、response、代码内容、stdout/stderr 或 shell 参数
- Hook-safe：`collect` 默认异步入队并 fail-open，不会因为采集失败阻塞 Codex
- 对分析友好：既能看总览，也能追到 agent、turn、capability 和单次 capability event
- 支持补数：hook 临时失效时，可以从 Codex transcript 回填缺失事件

## 当前支持状态

| 能力                      | 状态   |
| ------------------------- | ------ |
| Codex hooks 采集          | 已支持 |
| Codex transcript backfill | 已支持 |
| 本地 JSONL + SQLite 投影  | 已支持 |
| CLI 报表与本地 dashboard  | 已支持 |
| Claude Code 采集          | 规划中 |

## 安装

要求 Node.js `>=20`。

```bash
npm install -g @hi-man/himan-tracker
```

安装完成后使用：

```bash
himan-tracker --help
```

## 快速开始

首次使用，先检查本地数据目录和 SQLite 是否可用：

```bash
himan-tracker doctor
```

如果你想让当前仓库开始自动采集 Codex 使用数据：

```bash
himan-tracker setup codex
```

建议全局安装，让 hooks 在所有项目中生效：

```bash
himan-tracker setup codex -g
```

如果你想先预览将写入的 Codex hook 配置：

```bash
himan-tracker setup codex --dry-run
```

接下来正常使用 Codex 即可。hook 会把脱敏后的事件交给 `himan-tracker collect --agent codex --quiet`，并由后台 worker 写入本地事件日志。

把已采集事件导入 SQLite，并查看最近 7 天总览：

```bash
himan-tracker ingest
himan-tracker summary --since 7d
```

如果你想直接看本地报表页面：

```bash
himan-tracker server start --open
```

## 常见工作流

### 1. 给当前项目接入 Codex 采集

```bash
himan-tracker doctor
himan-tracker setup codex
himan-tracker ingest
himan-tracker summary --since 7d
```

如果想在所有项目中生效，用全局安装代替：

```bash
himan-tracker setup codex -g
```

### 2. 从已有 Codex transcript 回填历史数据

```bash
himan-tracker backfill codex --date YYYY-MM-DD
himan-tracker ingest
himan-tracker tokens --period week --since 12w
```

### 3. 看本地 dashboard 而不是纯 CLI 输出

```bash
himan-tracker server start --open
```

默认地址是 `http://127.0.0.1:5127`。

## 核心概念

| 概念                      | 说明                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `events/YYYY-MM-DD.jsonl` | 按天分片的 append-only 原始事件日志                         |
| `errors/YYYY-MM-DD.jsonl` | 采集或处理失败时的本地错误日志                              |
| `queue/`                  | hook 先写入的轻量队列，避免阻塞 Codex                       |
| `himan.sqlite`            | 用于报表和查询的本地 SQLite 投影                            |
| capability                | 一次 skill、MCP tool、plugin、内置工具或 shell command 调用 |

默认 tracker home：

```text
~/.himan-tracker
```

你也可以通过 `HIMAN_TRACKER_HOME` 指向隔离目录。

## 你可以看到哪些报表

- `summary`：最近一段时间的总览
- `tokens`：按天、周、月查看 runtime token 趋势
- `agents`：查看 agent / model 使用情况
- `turns`：查看逐 turn 明细
- `capabilities`：查看 capability 使用排行
- `capability-events`：查看某个 skill / MCP tool / plugin 的调用记录
- `unused`：找出近期未使用的 capability 候选

README 只保留上手路径。完整命令参数、Codex 集成细节、事件格式和 FAQ 请看下方文档。

## 文档

- [用户手册](docs/user-guide.md)
- [产品路线图](docs/roadmap.md)
- [开发与验证](docs/development.md)
- [技术设计](docs/technical-design.md)
- [MVP 功能清单](docs/mvp/features.md)
- [开发计划](docs/mvp/development-plan.md)
- [变更记录](CHANGELOG.md)

## 说明

- 当前项目仍处于早期 MVP 阶段。
- 当前 `collect` 入口只支持 `--agent codex`。
- 默认隐私策略下，不会持久化 prompt、response、代码内容、stdout/stderr、shell 参数或明文 repo path。
