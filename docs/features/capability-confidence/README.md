# Capability Attribution Confidence

本目录收敛 `capability 归因可信度提升` 这个 feature 的设计内容，不修改现有全局技术设计文档。

目标：

- 提升 Codex capability 归因的可信度和可解释性。
- 为 capability ROI 评估提供可审计的证据链。
- 明确 `himan-tracker` 自身改造项，以及 `@hi-man/himan` 侧可直接复用或建议补充的能力。

文档索引：

- [technical-design.md](./technical-design.md)：feature 级技术方案
- [himan-integration.md](./himan-integration.md)：与 `@hi-man/himan` 的集成方式、现有可用能力和建议补充项
- [implementation-record.md](./implementation-record.md)：当前实现记录、阶段拆分、依赖边界和执行注意事项
- [stage-plan.md](./stage-plan.md)：分阶段实施计划与验收标准

当前方案基于以下事实源：

- 当前仓库 `himan-tracker` 的现有实现
- 本机本地 `@hi-man/himan` 仓库当前版本 `0.8.6`
- 当前本地 `himan.lock` / `himan.yaml` / Codex 安装目录约定

不在本 feature 中解决的问题：

- Claude Code 端到端支持
- 远程同步或团队级集中存储
- prompt / response 内容采集
- 精确 capability-level token attribution 保证
