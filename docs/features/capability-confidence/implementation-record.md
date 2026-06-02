# Capability Confidence 实现记录

本文档记录 `capability-confidence` feature 当前已经达成的设计结论、实现边界、推荐实施顺序，以及与 `@hi-man/himan` 的协作依赖。

它不是全局技术设计，也不是 roadmap。它的目的更直接：

- 给后续实现这个 feature 的人一个稳定的执行上下文
- 避免设计意图在多轮实现中丢失
- 明确哪些内容属于 tracker 自己改，哪些需要 Himan 配合

## 1. 背景

当前 `himan-tracker` 已经可以：

- 采集 Codex capability usage
- 识别 `explicit / inferred / observed / unknown`
- 标记 `exact / estimated / unknown`
- 利用 `himan.lock` 过滤部分 Codex inferred skill
- 利用 `himan.yaml` 做 skill metadata 匹配

但仍然存在这些问题：

- skill 归因强依赖 transcript 和 shell path 推断
- `estimated` 过于粗糙，难以区分强弱
- 报表能看见 `Origin` / `Confidence`，但还不够解释“为什么这样判”
- ROI 视图尚未区分 raw / strict / weighted

因此，本 feature 的方向已经确定为：

```text
signal -> Himan context -> scoring -> synthesized usage -> strict/weighted ROI
```

## 2. 已确认的设计结论

### 2.1 归因是独立层

不把归因逻辑散落在 parser、normalizer 和 report 里，而是引入单独的 Capability Attribution Resolver。

### 2.2 Himan 是增强证据，不是前置条件

这条约束已经明确：

- 非 Himan 来源 skill 不是异常情况
- 缺少 `himan.lock` / `himan.yaml` / manifest 不能报错阻塞
- 缺少 Himan 信息时只能降级 confidence / score

### 2.3 只保存脱敏证据摘要

实现时不得保存：

- prompt 原文
- shell 参数原文
- 绝对路径
- `SKILL.md` 正文
- `himan.lock` source repo URL

### 2.4 必须支持三种分析口径

- `raw`
- `strict`
- `weighted`

后续 capability ROI、治理建议、告警等能力都应基于这三种口径，而不是只使用 raw usage。

## 3. 当前建议的实现范围

### Phase A：归因模型与字段扩展

目标：

- 把归因从枚举标签升级为带 score 和 basis 的结果

建议实现：

- Capability Attribution Resolver
- `capability_usage` 扩展字段：
  - `attribution_basis`
  - `attribution_score`
  - `attribution_reason`
  - `definition_id`
  - `install_source_name`
  - `install_mode`

### Phase B：Himan Project Context

目标：

- 给 Codex capability 归因补充项目安装事实

建议实现：

- 读取最近的 `himan.lock`
- 扫描项目 `himan.yaml`
- 建立 project context cache
- 允许 context 缺失时回退到 transcript-only

### Phase C：Evidence 与报表增强

目标：

- 让归因结果可解释、可筛选

建议实现：

- `capability_usage_evidence` 表
- `capability-events` 支持：
  - `--origin`
  - `--confidence`
  - `--min-score`
  - `--show-evidence`
- `capabilities --view raw|strict|weighted`

### Phase D：ROI 输入接入

目标：

- 为后续 capability ROI 排名与治理建议提供稳定输入

建议实现：

- `daily_capability_stats` 增加：
  - `strict_attribution_count`
  - `weighted_invocation_count`
  - `weighted_total_tokens`
  - `weighted_duration_ms`

## 4. 推荐实施顺序

推荐顺序不是按“页面先后”，而是按“证据链完整度”：

1. Resolver 与 score
2. Himan project context
3. evidence persistence
4. strict / weighted aggregation
5. CLI/report 增强
6. 再接 capability ROI / 治理建议

原因：

- 没有 resolver，后面都是原始推断的包装
- 没有 context，score 上限不够高
- 没有 evidence，团队很难信任 ROI 结论

## 5. 对 Himan 的依赖现状

当前本机 `@hi-man/himan` 版本：`0.8.6`

已可直接利用：

- `himan.lock`
- `himan.yaml`
- Codex 安装目标约定
- 递归 skill 依赖安装
- `comment.score` / `comment.text`

建议 Himan 补充：

1. `himan.lock` 增加 `contentHash`
2. 项目级 `.himan/install-manifest.json`
3. resolved dependency edges
4. 稳定 JSON 契约或稳定 `--json` 输出

这些都不是 tracker 启动实现的前置条件，但会显著提升 capability 归因的可信度上限。

## 6. 实施时必须遵守的稳定性要求

### 6.1 Collect 仍然 fail-open

无论发生以下哪种情况：

- 没有 `himan.lock`
- `himan.lock` 损坏
- 没有 `himan.yaml`
- 没有 install manifest
- skill 不是 Himan 管理的资源

都不能：

- 让 `collect` 返回失败
- 阻塞后台 drain
- 阻塞 `ingest`
- 导致 report / server 失败

### 6.2 降级优先于报错

优先级必须是：

```text
high-confidence attribution
  -> weak-confidence attribution
  -> unknown
```

而不是：

```text
missing Himan context
  -> throw error
```

### 6.3 非 Himan skill 必须可见

即使没有 Himan 元数据，非 Himan skill 也应：

- 进入 capability usage
- 进入 raw 报表
- 获得正确的低置信度标识

但默认不应进入高置信 strict 视图，除非有其他强证据支持。

## 7. 推荐测试矩阵

实现时至少覆盖这些场景：

1. explicit skill + lock match
2. explicit skill + no lock
3. MCP tool observed
4. shell skill path + lock match
5. shell skill path + metadata-only match
6. shell skill path + no Himan context
7. third-party / non-Himan skill source
8. corrupted `himan.lock`
9. missing manifest
10. duplicate evidence merge
11. raw / strict / weighted aggregation
12. evidence redaction

## 8. 当前文档关系

本 feature 目录内当前文档职责：

- [README.md](./README.md)
  - feature 目录入口
- [technical-design.md](./technical-design.md)
  - tracker 侧技术方案
- [himan-integration.md](./himan-integration.md)
  - Himan 结合方式和建议补充项
- `implementation-record.md`
  - 本文档，记录已确认的实现决策和执行要求

## 9. 当前状态

截至当前记录时点：

- 已完成 Phase 1 基础实现：
  - capability attribution detail 字段（basis/score/reason/context source）
  - Codex hook + transcript 的基础归因评分落地
  - SQLite 迁移 `006_capability_attribution_details`
  - `capability-events` 新增 score 维度与 `--min-score` 过滤
- 已完成 Phase 2 核心实现：
  - `capability_usage_evidence` 持久化表与 ingest 写入
  - `capabilities --view strict` 与 `--strict-score-threshold` 口径
  - strict 视图默认阈值 80，支持通过 CLI 覆盖
- 已完成 Phase 3 核心实现：
  - `daily_capability_stats` 与 `monthly_capability_stats` 加权字段与聚合
  - `capabilities --view weighted` 口径
  - attribution drift 告警（unknown origin ratio、attribution score drop）
- 非 Himan 来源 skill 在缺少 `himan.lock` 时继续 fail-open，按低分 inferred 归因
- 全局 `docs/technical-design.md` 未因本 feature 被改动
- 本 feature 的内容全部收敛在 `docs/features/capability-confidence/`

后续如果开始实现，建议在本文档末尾追加“实现进度记录”小节，而不是把实现笔记散落到多个文档里。
