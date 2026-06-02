# Capability Attribution Confidence 技术方案

## 1. 设计目标

`himan-tracker` 当前已经能记录 Codex 的 capability 使用，但在 skill 推断、分类和 ROI 解释上仍有较多 `estimated` 与 `unknown`。

本 feature 的目标不是“多收集一些 capability 事件”，而是让 tracker 更准确地回答：

- 这次 capability 到底是什么？
- 我们为什么认为它是这个 capability？
- 这个判断应该信几分？
- 这条 capability usage 能不能进入严格 ROI 视图？

最终目标：

- 为 capability usage 建立稳定、可解释、可筛选的归因口径
- 为后续 capability ROI、治理建议、时间线下钻和预算告警提供可信输入

## 2. 非目标

本 feature 不解决以下问题：

- 不承诺精确 capability-level runtime token attribution
- 不采集 prompt、response、代码正文、stdout/stderr 或 shell 参数原文
- 不依赖 Himan 的不稳定 Node.js API
- 不先做多 agent 通用方案；当前默认聚焦 Codex-first
- 不要求所有 skill 都必须来自 Himan；非 Himan 来源必须继续被安全处理

## 3. 当前问题

结合当前实现，归因问题主要集中在四类：

1. skill 归因依赖弱信号
- Codex 没有官方结构化 skill 执行事件
- 当前更多依赖 `$skill-name` 或 shell 读取 `SKILL.md` 的推断

2. 归因强弱没有细粒度表达
- 当前只有 `attribution_confidence=exact|estimated|unknown`
- 不足以区分“强 estimated”和“弱 estimated”

3. 解释层不足
- 当前报表能看到 `Origin` 和 `Confidence`
- 但仍难回答“为什么这条 capability 被算成这个 skill”

4. 归因结果尚未和 ROI 口径打通
- 当前 capability 聚合主要是 raw usage
- 尚未形成 strict / weighted 两套更适合 ROI 的视图

## 4. 核心技术决策

### 4.1 归因是独立层，不混入 parser 或 report

引入独立的 Capability Attribution Resolver。

职责边界：

- Adapter：只解析 hook/transcript 原始结构
- Attribution Resolver：把信号解析成 capability 归因结论
- Aggregator：只入库和聚合归因结果
- Report：只展示与筛选，不重复归因

### 4.2 区分 Runtime Fact、Attribution Evidence、Static Metadata

设计上必须拆开三层：

- Runtime fact：runtime token、duration、status、tool/MCP 发生事实
- Attribution evidence：显式 skill、结构化 MCP、shell skill path、Himan 安装匹配等证据
- Static metadata：`himan.yaml` 的 version、content hash、dependencies、comment、static token

约束：

- 静态依赖不是 runtime 调用
- metadata 命中不是 skill 执行事实
- 弱推断不能伪装成 `exact`

补充约束：

- Himan 相关信息是增强证据，不是 capability 归因的前置条件。
- 当 skill 来自非 Himan 来源，或当前项目没有 `himan.lock` / `himan.yaml` / install manifest 时，归因流程必须 fail-open。
- fail-open 的含义是：继续产出 capability usage，必要时降级为 `estimated` 或 `unknown`，但不得报错、阻塞 collect、阻塞 ingest、或导致 report/server 失败。

### 4.3 归因提供三种分析口径

- Raw：保留全部 capability usage
- Strict：仅使用高可信度事件
- Weighted：按归因分数加权

推荐默认：

- `strict_score_threshold = 80`

## 5. Runtime / Integration 设计

### 5.1 总体流程

```text
Codex hook/transcript
  -> signal extraction
  -> Himan project context resolution
  -> candidate scoring
  -> capability usage synthesis
  -> SQLite projection
  -> raw / strict / weighted reports
```

### 5.2 Signal Extraction

从 Codex 现有数据源中提取这些信号：

- `UserPromptSubmit` 中显式 `$skill-name`
- transcript 中的结构化 MCP tool end
- transcript 中的 tool start/end
- shell / exec tool 调用中的 `SKILL.md` 路径证据
- hook/transcript 中的 tool name

信号提取只保留安全元数据，不保存原始 prompt 和 shell 参数。

### 5.3 Himan Project Context Resolution

为提升 Codex 归因质量，引入 `HimanProjectContext`：

```ts
type HimanInstalledResource = {
  type: "skill" | "command" | "rule" | "config";
  name: string;
  version: string | null;
  sourceName: string | null;
  agents: string[];
  mode: "copy" | "link" | null;
  contentHash: string | null;
  installTarget: string | null;
};

type HimanSkillDefinition = {
  definitionId: string;
  name: string;
  version: string | null;
  entry: string;
  agents: string[];
  contentHash: string | null;
  dependencySkills: string[];
  dependencyMcpTools: string[];
  commentScore: number | null;
  commentText: string | null;
};

type HimanProjectContext = {
  projectRoot: string;
  installedResources: HimanInstalledResource[];
  skillDefinitions: HimanSkillDefinition[];
};
```

解析顺序：

1. 通过 workdir 或 transcript 相关路径向上找最近的 `himan.lock`
2. 对 `agent=codex` 过滤出当前项目实际安装资源
3. 扫描项目 `.agents/skills/*/himan.yaml`
4. 必要时补扫 `.codex/skills/*/himan.yaml` 与全局目录
5. 建立缓存，按 `projectRoot + lock updatedAt + metadata hash` 失效

失败与缺失处理：

- 未找到 `himan.lock`：返回空的 Himan project context，不报错。
- 找到 `himan.lock` 但解析失败：记录非阻塞错误日志，当前 turn 退回无 lock 模式。
- 未找到 `himan.yaml`：允许 skill 继续以 transcript / classifier 证据归因。
- skill 不在 Himan 管理目录中：允许继续归因为非 Himan skill，不视为异常。
- install manifest 缺失：回退到 `himan.lock` 和 metadata 扫描，不视为错误。

建议为 resolver 引入显式来源标识：

```ts
type AttributionContextSource =
  | "himan_install_manifest"
  | "himan_lock"
  | "himan_metadata"
  | "transcript_only"
  | "none";
```

这样 report 层可以区分“被 Himan 上下文确认过的 skill”和“仅靠 transcript 推断的 skill”。

### 5.4 Candidate Scoring

同一条 capability usage 允许收集多个 evidence，但最终只产出一个主结论。

推荐评分：

| 场景 | origin | confidence | score |
| --- | --- | --- | --- |
| prompt 显式 `$skill-name`，且命中当前项目已安装 skill | `explicit` | `exact` | 100 |
| 结构化 MCP tool end | `observed` | `exact` | 100 |
| hook/transcript 明确给出 capability type/name | `observed` | `exact` | 100 |
| shell 读取 `SKILL.md`，且命中当前项目 lock/manifest | `inferred` | `estimated` | 80 |
| shell 读取 `SKILL.md`，命中项目 metadata 但未命中 lock | `inferred` | `estimated` | 65 |
| shell 读取 `SKILL.md`，但没有任何 Himan 上下文，仅 transcript 命中 | `inferred` | `estimated` | 50 |
| 仅凭名称分类为 builtin/shell | `observed` 或 `unknown` | `estimated` | 40-60 |
| 无法确认 | `unknown` | `unknown` | 0 |

关键原则：

- 允许降级到 `unknown`
- 不为了“让报表更好看”硬做归因
- prompt 显式 skill 和 shell path 推断命中同一 skill 时必须去重
- 非 Himan skill 允许进入报表，但默认不进入高可信 strict 视图，除非有其他强证据

### 5.5 Event Synthesis

建议扩展 `capability_usage`：

- `attribution_basis`
- `attribution_score`
- `attribution_reason`
- `definition_id`
- `install_source_name`
- `install_mode`

并引入轻量 evidence 投影：

```ts
type CapabilityAttributionEvidence = {
  type:
    | "prompt_explicit_skill"
    | "transcript_mcp_tool_end"
    | "transcript_tool_name"
    | "transcript_shell_skill_path"
    | "himan_lock_match"
    | "himan_manifest_match"
    | "himan_dependency_match"
    | "classifier_builtin"
    | "classifier_shell"
    | "fallback_unknown";
  confidence: "exact" | "estimated";
  score: number;
  summary: string;
};
```

`summary` 只允许保存安全结论，例如：

- `matched installed skill common-dev-pattern from himan.lock`
- `observed structured MCP tool github.create_pull_request`
- `inferred skill api-review from transcript shell path without Himan confirmation`

### 5.6 与 ROI 的关系

本 feature 不直接产出最终 ROI 分数，但它决定 ROI 输入是否可信。

基于此 feature，后续可直接支持：

- strict capability ranking
- confidence-weighted cost / duration
- low-value capability detection
- cleanup candidate explanation

## 6. 存储设计

### 6.1 `capability_usages` 扩展字段

建议新增：

- `attribution_basis text`
- `attribution_score integer`
- `attribution_reason text`
- `definition_id text null`
- `install_source_name text null`
- `install_mode text null`

### 6.2 `capability_usage_evidence`

建议新增证据表：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text primary key | evidence ID |
| `usage_id` | text | 关联 usage |
| `position` | integer | 证据优先级，`0` 为主证据 |
| `evidence_type` | text | 证据类型 |
| `confidence` | text | `exact` 或 `estimated` |
| `score` | integer | `0-100` |
| `summary` | text | 脱敏摘要 |

### 6.3 `daily_capability_stats` 扩展字段

建议新增：

- `exact_attribution_count`
- `unknown_attribution_count`
- `strict_attribution_count`
- `weighted_invocation_count`
- `weighted_total_tokens`
- `weighted_duration_ms`

这样可以同时支持 raw、strict、weighted 三种视图，而不需要每次全表扫描。

## 7. 聚合与业务逻辑

### 7.1 聚合口径

```text
raw_invocations = count(all usages)
strict_invocations = count(usages where attribution_score >= threshold)
weighted_invocations = sum(attribution_score / 100)
weighted_total_tokens = sum(total_tokens * attribution_score / 100)
weighted_duration_ms = sum(duration_ms * attribution_score / 100)
```

### 7.2 Himan 主观评价与 Runtime ROI 对照

Himan 当前 `himan.yaml` 已支持 `comment.score` / `comment.text`。

这些字段不参与 runtime 归因，但应被纳入后续治理解释：

```text
maintainer_score = himan.yaml.comment.score
runtime_state = keep | watch | optimize | cleanup_candidate
score_gap = maintainer_score - runtime_rank_normalized
```

用途：

- 维护者评分高但 runtime ROI 低：可能是用法问题，或归因质量不足
- 维护者评分低但 runtime ROI 高：资源可能值得上调推荐等级

## 8. CLI / API / UI 设计

### 8.1 `capability-events` 增强

建议新增筛选：

```text
--origin explicit|inferred|observed|unknown
--confidence exact|estimated|unknown
--min-score 80
--show-evidence
```

建议新增列：

```text
origin | confidence | score | attribution basis | attribution reason
```

### 8.2 `capabilities` 增强

建议增加视图模式：

```text
--view raw|strict|weighted
```

语义：

- `raw`：完整观测
- `strict`：用于治理和 ROI 决策
- `weighted`：用于趋势和排序

### 8.3 `doctor` 增强

建议增加检查项：

- Codex queue backlog
- enrichment errors
- transcript fallback 占比
- `himan.lock` 可读性
- `himan.yaml` 扫描状态
- install manifest 可用性

## 9. 配置设计

建议新增：

```json
{
  "attribution": {
    "strict_score_threshold": 80,
    "record_evidence": true,
    "scan_himan_lock": true,
    "scan_himan_metadata": true,
    "prefer_install_manifest": true
  }
}
```

语义：

- `strict_score_threshold`：strict 视图阈值
- `record_evidence`：是否持久化轻量 evidence
- `scan_himan_lock`：是否读取项目 lock
- `scan_himan_metadata`：是否扫描 metadata
- `prefer_install_manifest`：若 Himan 后续提供 manifest，优先用 manifest

## 10. 隐私与安全

必须继续遵守现有边界：

- 不保存 prompt 原文
- 不保存 shell 参数原文
- 不保存绝对路径
- 不保存 `SKILL.md` 正文
- 不保存 `himan.lock` source repo URL

evidence 只允许保存脱敏摘要。

同时必须满足稳定性要求：

- 缺少 Himan 信息时不抛致命错误。
- 任何 Himan 解析失败都只能产生日志或 error record，不能改变 collect 默认 fail-open 行为。
- strict / weighted 视图不能因为部分 capability 没有 Himan 元数据就中断；只能降低这些 capability 的可信度和排名权重。

## 11. 测试策略

至少新增这些测试：

- explicit skill 命中当前项目 lock
- explicit skill 未命中当前项目 lock
- transcript MCP tool observed
- shell skill path + lock match
- shell skill path + metadata-only match
- shell skill path + no Himan context
- non-Himan skill directory / third-party skill source
- shell skill path 弱证据降级到 `unknown`
- prompt signal 与 transcript signal 去重
- raw / strict / weighted 聚合口径稳定
- evidence 不包含敏感原文
- Himan lock 缺失、损坏、manifest 缺失时 collect / ingest / report 仍可正常执行

## 12. 开发顺序

### Phase A：归因模型落地

- 抽离 Capability Attribution Resolver
- 扩展 `capability_usage` 字段
- 引入 scoring 和 strict threshold

### Phase B：Himan Project Context

- 读取 `himan.lock`
- 扫描 `himan.yaml`
- 建立项目级缓存

### Phase C：Evidence 与报表

- evidence 表
- `capability-events` 增强
- `capabilities --view strict|weighted`

### Phase D：ROI 接入

- 为后续 capability ROI 模型提供 strict / weighted 聚合输入

## 13. 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 过度依赖 shell 文本推断 | 误判 skill 使用 | 引入 score、strict 视图和 Himan 上下文确认 |
| 同一 capability 多信号重复计数 | capability 成本被放大 | 先 candidate merge，再产出主事件 |
| Himan 侧信息不完整 | 归因上限受限 | 读取 lock/metadata 现有字段，并定义 manifest 扩展点 |
| 非 Himan skill 被当成异常路径 | 采集或报表稳定性受损 | Himan 信息只作为增强证据，缺失时 fail-open 并降级 confidence |
| 证据记录越界到敏感内容 | 隐私风险 | evidence 仅存脱敏摘要 |

## 14. 结论

这个 feature 的核心不是“再加一个字段”，而是建立一条完整的归因证据链：

```text
signal -> Himan context -> scoring -> synthesized usage -> strict/weighted ROI
```

如果这条链路不做扎实，后续 capability ROI、治理建议和时间线下钻都会缺少可信基础。
