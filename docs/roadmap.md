# Product Roadmap

本文档基于当前仓库实际实现状态整理 `himan-tracker` 的后续产品路线图。

当前阶段的产品策略不是“尽快覆盖更多 agent”，而是：

- 先把 Codex 采集和分析做深。
- 先把 capability ROI 评估做成真实可用的决策工具。
- 在 Codex 主链路足够可信、足够可解释之后，再扩展到更广的多 agent 场景。

## 当前基线

截至当前版本，`himan-tracker` 已经具备以下能力：

- 本地优先的数据链路：queue -> JSONL -> SQLite。
- Codex 的 `setup`、`collect`、`backfill`、`ingest` 闭环。
- Codex transcript 补数、MCP/tool 补全、显式/推断 skill 识别。
- Copilot 的 `setup`、hook collect、session-store/transcript backfill。
- CLI 报表：`summary`、`tokens`、`agents`、`turns`、`capabilities`、`capability-events`、`unused`。
- 本地 dashboard 与 metrics 页面：`/`、`/dashboard.json`、`/metrics`、`/metrics.json`。
- 月归档、数据清理、后台 server、基础指标预警。

当前阶段最核心的问题不是“还能接多少 agent”，而是下面三件事仍未彻底解决：

- Codex capability 级归因仍有不少 `estimated` 和 `unknown`，ROI 结论可信度不够高。
- 报表更擅长展示“发生了什么”，还不够擅长回答“哪些 capability 值得保留、优化或删除”。
- 项目虽然强调 ROI，但还缺少把 capability 成本、成功率、时延和工程产出串起来的分析模型。

## 当前阶段产品策略

当前阶段默认采用以下取舍：

1. 先做 Codex-first，而不是多 agent-first。
2. 先做 capability ROI 判断质量，而不是先扩报表数量。
3. 先做可解释的建议和证据链，再做自动化评分或推荐。
4. 先保证本地优先和保守隐私，不为了分析深度牺牲默认数据边界。

这意味着：

- Claude Code 端到端支持不是当前 `P0`。
- Copilot 会继续保持已支持状态，但不是当前主打的产品深化方向。
- 接下来几个版本的重点应围绕 Codex 的采集质量、归因质量、ROI 分析和治理建议展开。

## 优先级定义

| 优先级 | 含义 |
| --- | --- |
| `P0` | 当前阶段最应投入的能力；不补齐会直接影响 Codex ROI 评估是否可信、是否可用 |
| `P1` | 在 Codex ROI 主链路稳定后应尽快补齐的能力；用于提升决策深度和团队使用价值 |
| `P2` | 中长期扩展能力；有价值，但不应先于 `P0` / `P1` 抢占资源 |

## P0

### P0-1：Codex capability 归因可信度提升

目标：

- 提升 Codex capability 使用识别和统计归因的可信度，让 ROI 分析尽量基于 `observed` 或高质量 `estimated` 证据，而不是大量模糊推断。

为什么是 `P0`：

- capability ROI 的前提不是报表，而是“你统计的 capability 到底是不是它”。
- 当前 skill 使用、duration basis、capability-level token 仍有较多估算成分。

建议范围：

- 增强 transcript enrichment 的证据提取和去重逻辑
- 更清晰地区分 `explicit`、`observed`、`inferred`、`unknown`
- 提升 skill / MCP / builtin / shell 的分类准确率
- 为 capability event 增加更可审计的 attribution basis / evidence summary
- 对低置信度统计增加单独标记和过滤能力

完成标准：

- 用户能区分“精确观测到的 capability”和“推断得到的 capability”。
- capability 报表可按归因来源和可信度筛选。
- 低质量归因不会被误当作精确 ROI 证据。

### P0-2：Codex session / turn / capability 时间线下钻

目标：

- 从聚合报表一路下钻到单次 Codex session、单个 turn、单次 capability event，形成完整证据链。

为什么是 `P0`：

- 真实 ROI 评估不能只看排行，必须能回答“为什么这个 capability 看起来低效”。
- 当前已有 `turns` 和 `capability-events`，但还缺少按一次执行路径串起来的上下文视图。

建议范围：

- `session <id>` 和 `turn <id>` 详情命令
- dashboard / JSON endpoint 详情视图
- 单次 turn 内 capability 顺序、duration、status、token、origin、confidence 展示
- 从 `capabilities` 和 `capability-events` 跳转或反查 session/turn

完成标准：

- 用户可以从异常 capability 一路定位到具体 session/turn。
- 用户可以解释某个高成本 capability 为何高成本，而不必手工查 JSONL。

### P0-3：Codex capability ROI 基础模型

目标：

- 建立第一版明确、可解释、不过度承诺的 capability ROI 评估模型。

为什么是 `P0`：

- 当前项目已经能回答“调用了多少次、花了多少 token”，但还不能稳定回答“值不值得”。
- 如果没有明确模型，后续建议和排名都只能停留在经验判断。

建议范围：

- 定义 capability ROI 输入指标：
  - invocation count
  - success rate
  - total / avg duration
  - total / avg runtime tokens
  - invocation origin / confidence
  - adoption / repetition / recency
- 定义第一版非黑盒规则：
  - 高频高成功低成本
  - 高频高失败
  - 低频高成本
  - 长期未使用
  - 成本高但缺少高置信度证据
- 输出明确的原因文案，而不是只给一个神秘分数

完成标准：

- 用户能在 capability 层看到“保留 / 观察 / 优化 / 清理候选”等分组。
- 每个结论都有可解释指标支撑，而不是单一分数。

### P0-4：Codex 采集健康度与数据可信度

目标：

- 让用户知道当前 Codex 数据是否完整可靠，避免基于坏数据做 ROI 决策。

为什么是 `P0`：

- 没有健康度与覆盖率视图，任何 ROI 结论都可能是采集缺失导致的假象。

建议范围：

- queue backlog / pending batches
- drain failures / enrichment errors
- skipped / dropped / duplicate events
- transcript fallback 覆盖率
- 某时间范围内 live collect 与 backfill 占比
- hook install status / config drift

完成标准：

- `doctor` 或 server 能明确显示 Codex 采集健康状态。
- 用户能区分“真的没用过某 capability”和“这段数据采集不完整”。

### P0-5：文档与产品状态对齐

目标：

- 让文档清楚反映当前的 Codex-first 路线和 capability ROI 目标。

为什么是 `P0`：

- 当前 README、MVP 规划和实际实现状态之间还有旧阶段残留。
- 如果路线切成 Codex-first，文档也必须同步，不然团队执行会跑偏。

建议范围：

- README 支持矩阵和产品定位文案
- `docs/mvp/*` 与当前实现状态的关系说明
- user guide 中 ROI 口径和限制说明
- roadmap 与技术设计的优先级对齐

完成标准：

- 团队成员能明确知道当前阶段“不追求多 agent 覆盖最大化，而追求 Codex ROI 评估可用化”。

## P1

### P1-1：Capability 治理建议

目标：

- 从 capability 使用统计升级为面向治理的建议系统。

为什么值得做：

- `unused` 只解决了“近期没用”的子问题。
- 团队真正需要的是“哪些 capability 应该继续投入，哪些应降级或移除”。

建议范围：

- 低频高成本 capability
- 高失败率 capability
- 高 token 低成功 capability
- 长期无使用但仍安装的 skill / plugin
- 归因低可信度导致无法稳定评估的 capability

完成标准：

- capability 报表能直接给出候选动作和原因。
- 团队可以把它作为 capability 治理输入，而不是只看原始统计表。

### P1-2：项目维度 ROI 对比

目标：

- 支持按项目比较 Codex capability 的投入结构和回报结构。

为什么值得做：

- 同一个 capability 在不同项目上的 ROI 可能差异很大。
- 团队级决策不能只看全局汇总。

建议范围：

- `projects` 报表
- 单项目 capability 结构
- 项目间 token / duration / success / adoption 对比
- 项目下 top ROI risks 与 top ROI wins

完成标准：

- 用户能回答“哪个项目最依赖哪些 capability”“哪些 capability 只在某些项目里有效”。

### P1-3：预算、阈值与主动预警

目标：

- 把静态报表升级为对 Codex 使用成本和风险的主动监控。

为什么值得做：

- 团队要做 ROI 评估，最终一定会进入预算管理和异常治理。

建议范围：

- token budget
- duration budget
- failure-rate threshold
- capability usage spike threshold
- capability ROI 退化告警

完成标准：

- 用户可以按项目或全局设置阈值。
- 预算超限和 ROI 明显退化可以被主动发现。

### P1-4：Codex capability 静态元数据整合

目标：

- 把 `himan.yaml`、`himan.lock` 等静态信息更系统地纳入 capability 评估。

为什么值得做：

- 只看 runtime 使用不够，skill 的静态体量、版本、依赖和 metadata 健康度也会影响 ROI。

建议范围：

- capability definition 和 dependency 维表完善
- static token / package size / dependency depth 展示
- metadata issue 与 runtime 表现关联
- 区分 runtime 成本与 static load 成本

完成标准：

- 用户可以判断某个 skill 是“运行时低效”还是“静态负担过重”。

## P2

### P2-1：ROI 与工程产出关联

目标：

- 让 capability ROI 不只停留在“成本与使用行为”，还能关联工程结果。

为什么放在 `P2`：

- 这很重要，但依赖前面的归因质量、健康度和 capability 治理模型。

建议范围：

- commit / PR / issue 完成量关联
- session 后代码变更量
- 测试通过率或失败恢复成本
- capability 使用与工程结果的相关性分析

完成标准：

- 至少形成一套明确区分“运行时消耗”和“工程产出”的分析口径。

### P2-2：数据导出与外部分析接口

目标：

- 让团队可以把 Codex 相关数据继续接入 BI、脚本或 notebook。

建议范围：

- `export json`
- `export csv`
- 稳定的 dashboard / metrics JSON schema

完成标准：

- 用户无需直接读取 SQLite 或 JSONL，就能拿到可复用数据集。

### P2-3：Claude Code 端到端支持

目标：

- 在 Codex ROI 主链路稳定后，再补齐 Claude Code 的完整产品接入。

为什么放在 `P2`：

- Claude Code 仍有价值，但当前团队主工作流不在这里。
- 当前阶段优先投入多 agent 覆盖，会稀释 Codex ROI 产品深度。

建议范围：

- `setup claude-code`
- `collect --agent claude-code`
- `backfill claude-code`
- 与现有报表、server、archive、cleanup 的兼容验证

完成标准：

- Claude Code 可以复用 Codex 已成熟的 ROI 评估框架接入。

### P2-4：远程同步或团队视图

目标：

- 在保持本地优先原则的前提下，探索团队级汇总能力。

为什么放在 `P2`：

- 会显著增加隐私、部署、权限和数据模型复杂度。
- 当前阶段更重要的是把单机 Codex ROI 价值做扎实。

建议范围：

- 显式 opt-in 的导出/同步
- 团队聚合只上传元数据
- 团队 dashboard 或 shared snapshot

完成标准：

- 不破坏当前本地优先与保守隐私定位。

## 建议执行顺序

```text
P0-1 Codex capability 归因可信度提升
  -> P0-2 Codex session / turn / capability 时间线下钻
  -> P0-3 Codex capability ROI 基础模型
  -> P0-4 Codex 采集健康度与数据可信度
  -> P0-5 文档与产品状态对齐
  -> P1-1 Capability 治理建议
  -> P1-2 项目维度 ROI 对比
  -> P1-3 预算、阈值与主动预警
  -> P1-4 Codex capability 静态元数据整合
  -> P2-* 中长期扩展
```

## 本阶段建议

如果只做一轮短周期迭代，建议优先完成这三项：

1. Codex capability 归因可信度提升
2. Codex session / turn / capability 时间线下钻
3. Codex capability ROI 基础模型

这三项完成后，`himan-tracker` 才会从“Codex 使用观测工具”进入“Codex capability ROI 评估工具”的阶段。后续再做治理建议、预算预警和工程产出关联，才会有稳定基础。
