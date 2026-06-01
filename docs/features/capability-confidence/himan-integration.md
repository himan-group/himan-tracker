# Himan Integration Notes

本文档专门说明 `capability 归因可信度提升` 与 `@hi-man/himan` 的结合方式。

依据：

- 本机本地 `@hi-man/himan` 仓库当前版本 `0.8.6`
- 当前 `himan.lock` 文件结构
- 当前 `himan.yaml` 元数据结构
- 当前 Codex 安装目录约定

重要边界：

- Himan 是 capability 归因的增强来源，不是唯一来源。
- tracker 必须继续支持非 Himan 来源的 skill、命令和其他 capability。
- 当项目没有 `himan.lock`、没有 `himan.yaml`，或 skill 来自第三方/手工目录时，tracker 不得报错或阻塞正常流程，只能降级归因置信度。

## 1. 当前可直接利用的 Himan 能力

### 1.1 `himan.lock`

当前已记录：

- `type`
- `name`
- `version`
- `source`
- `agents`
- `mode`
- 顶层 `source`
- 顶层 `sources`

对 tracker 的价值：

- 限定“当前项目真正安装到 Codex 的 skill 集合”
- 提供 source alias、mode、version 上下文
- 支持把 runtime skill usage 绑定到项目安装事实

### 1.2 `himan.yaml`

当前可提供：

- `name`
- `type`
- `version`
- `entry`
- `description`
- `agents`
- `comment.score`
- `comment.text`
- `analysis.dependencies.skills`
- `analysis.dependencies.mcpTools`
- 静态分析字段

对 tracker 的价值：

- 用于 definition 匹配
- 用于静态依赖解释
- 用于维护者主观评分与 runtime ROI 对照

### 1.3 Codex 安装目标约定

当前 Codex 相关安装目标：

- `skill` -> `.agents/skills/<name>`
- `command` -> `.agents/commands/<name>`
- `config` -> `.codex/configs/<name>`

对 tracker 的价值：

- 当 transcript 中出现 `.agents/skills/<name>/SKILL.md` 相关路径时，可以结合 lock/metadata 做更强确认

### 1.4 递归 skill 依赖安装

当前已支持：

```bash
himan install skill <name> -r --depth n
```

对 tracker 的价值：

- 说明项目里出现的某些 skill 可能是传递依赖，不一定是用户直接选择
- 后续可区分 direct skill 与 transitive skill 的 ROI

## 2. Tracker 建议如何使用 Himan

### 2.1 不直接依赖 Himan 内部 TS API

原因：

- Himan README 已明确 npm 包不承诺稳定 Node.js 程序化 API
- tracker 如果直接 import Himan 内部实现，会让两个仓库强耦合

建议：

- tracker 只依赖稳定文件契约
- 优先读取 `himan.lock`
- 其次读取 `himan.yaml`
- 如后续 Himan 提供稳定 manifest，再优先读取 manifest

### 2.2 优先级建议

tracker 解析顺序：

1. `himan` install manifest（若存在）
2. `himan.lock`
3. 项目 `himan.yaml`
4. 全局或候选 metadata

如果上述信息全部不存在：

- 继续保留 transcript / hook / classifier 路径
- 把结论标记为 transcript-only 或 unknown
- 不把它提升为 high-confidence Himan-confirmed skill

### 2.3 当前就能落地的结合点

不需要 Himan 新增功能，tracker 当前即可做：

- 基于 `himan.lock` 过滤 Codex 已安装 skill
- 基于 `agents` 只保留对 Codex 生效的资源
- 基于 `version/source/mode` 丰富 capability usage 上下文
- 基于 `comment.score` 做维护者评分对照
- 基于 `analysis.dependencies` 做静态依赖解释

同时要明确：

- 非 Himan skill 不是错误数据。
- 第三方 skill 或项目内自定义 skill 即使没有 `himan.yaml`，也应按弱证据路径继续进入 capability usage。
- 缺失 Himan 信息只影响 confidence / score，不影响 collect、ingest、report 的可用性。

## 3. 建议 Himan 补充的支持项

下面这些支持不是 tracker 启动此 feature 的前置条件，但会明显提高归因上限。

### 3.1 在 `himan.lock` 中记录 `contentHash`

为什么需要：

- `version` 不足以区分同版本内容漂移
- tracker 无法稳定绑定到 definition 快照

建议：

```json
{
  "type": "skill",
  "name": "common-dev-pattern",
  "version": "0.0.1",
  "contentHash": "sha256:..."
}
```

优先级：

- 高

### 3.2 生成项目级 install manifest

建议文件：

```text
.himan/install-manifest.json
```

建议字段：

- `type`
- `name`
- `version`
- `contentHash`
- `source`
- `agents`
- `mode`
- `installTarget`
- `definitionId`（可选）

为什么需要：

- tracker 现在要从 shell 文本路径反推 skill
- manifest 可以把“安装事实”和“文件位置”显式结构化
- 但 manifest 缺失时，tracker 仍必须回退到无 manifest 模式，不能把它当成运行前提

优先级：

- 最高

### 3.3 写入 resolved dependency edges

建议字段：

- `installedBy`
- `parents`
- `dependencyDepth`

为什么需要：

- tracker 现在只知道静态声明依赖，不知道实际安装链路
- direct skill 与 transitive skill 的 ROI 语义不同

优先级：

- 中高

### 3.4 提供稳定 JSON 文件契约或 CLI `--json`

建议二选一：

1. 维护 manifest 文件契约
2. 提供稳定的 `himan project list --json` 输出协议

为什么需要：

- 避免 tracker 读取 Himan 内部实现
- 降低两个仓库的升级耦合成本

优先级：

- 高

### 3.5 可选声明 runtime-facing capabilities

可选新增：

- `analysis.capabilities.skills`
- `analysis.capabilities.mcpTools`
- `analysis.capabilities.commands`

为什么有用：

- tracker 可以比较“声明能力集合”和“实际调用集合”
- 有利于做 capability drift / dead declaration 分析

优先级：

- 中

## 4. 建议的协作边界

### tracker 负责

- signal extraction
- attribution scoring
- evidence persistence
- strict / weighted aggregation
- ROI 视图与治理解释
- 非 Himan 来源 capability 的降级处理和 fail-open

### himan 负责

- 项目安装事实
- definition 快照
- source/version/contentHash 稳定输出
- dependency resolution 结果

## 5. 最小可行联动方案

如果只做最小一轮联动，建议：

1. tracker 先直接使用现有 `himan.lock` + `himan.yaml`
2. himan 补 `install-manifest.json`
3. himan 再补 `contentHash`

这样 tracker 就能从“文本推断为主”进入“安装事实确认为主”的归因模式。
