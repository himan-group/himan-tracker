# MVP 规划

本目录记录 `himan-tracker` MVP 阶段的 feature 列表、实现边界和详细技术方案。

输入文档：

- [Blueprint](../blueprint.md)
- [技术方案](../technical-design.md)

## MVP 定义

MVP 对应 blueprint 中的 `v0.1 — Usage Tracker`。目标是让本地开发者可以开始观测 Codex 和 Claude Code 的真实使用情况，包括 agent 使用量、模型 token、请求耗时、capability 调用和基础报表。

MVP 必须交付：

- 本地配置和数据目录。
- 统一事件契约。
- JSONL 原始事件日志。
- SQLite 聚合数据库。
- Codex adapter。
- Claude Code adapter。
- CLI 报表。
- 隐私保护默认策略。
- 基于 fixtures 的测试闭环。

MVP 不交付：

- Dashboard UI。
- 团队远程同步。
- prompt、response、代码内容采集。
- 精确 capability 级 token 归因保证。
- 完整 ROI 评分。
- 自动 capability 清理或推荐引擎。

## 文档索引

- [Feature 列表](./features.md)：MVP feature、优先级、依赖和验收标准。
- [详细技术方案](./technical-plan.md)：模块设计、数据流、实现细节、测试策略和开发顺序。
- [开发计划](./development-plan.md)：按步骤推进 MVP 开发的任务清单和验收标准。

## 交付原则

- JSONL 是事实源，SQLite 是可重建投影。
- 所有 agent 差异收敛在 adapter 中。
- CLI 只读取 SQLite，不直接读取原始 hook payload。
- 默认只采集元数据，不采集用户内容。
- 任何估算值必须显式标记为估算。
