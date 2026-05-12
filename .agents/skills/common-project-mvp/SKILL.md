---
name: common-project-mvp
description: Create or update MVP planning docs from a blueprint and technical design. Use when Codex is asked to split MVP features, define priorities, dependencies, milestones, acceptance criteria, detailed implementation plans, delivery phases, or MVP definition of done.
---

# Common Project MVP

## Purpose

Use this skill to convert product and technical design context into an executable MVP plan. The output should help future development proceed feature by feature with clear priorities and acceptance criteria.

## Inputs To Inspect

Read the smallest useful set of files:

- `docs/blueprint.md`
- `docs/technical-design.md`
- Existing `docs/mvp/` files
- Existing README only for user-facing scope consistency

If blueprint or technical design is missing, summarize assumptions and consider using `common-project-blueprint` or `common-project-tech-design` first.

## Standard Outputs

Create or update:

- `docs/mvp/README.md`
- `docs/mvp/features.md`
- `docs/mvp/technical-plan.md`

Keep MVP planning separate from broad architecture docs. Do not move detailed technical design into `docs/mvp` unless it is directly tied to MVP execution.

## MVP README Structure

Use `docs/mvp/README.md` for scope and navigation:

```markdown
# MVP 规划

## MVP 定义
## MVP 必须交付
## MVP 不交付
## 文档索引
## 交付原则
```

## Feature List Structure

Use `docs/mvp/features.md` for feature inventory:

```markdown
# MVP Feature 列表

## Feature 优先级
## Feature 总览
## MVP-F01：<feature name>
## MVP-F02：<feature name>
## Feature 依赖顺序
```

Priority definitions:

- `P0`: required for MVP usability or correctness.
- `P1`: recommended for MVP quality, integration, or validation.
- `P2`: defer unless explicitly requested; keep as extension point.

Each feature should include:

- Scope
- User value
- Main modules or files
- Dependencies
- Non-scope when useful
- Acceptance criteria

## Technical Plan Structure

Use `docs/mvp/technical-plan.md` for implementation-level planning:

```markdown
# MVP 详细技术方案

## 1. 技术栈建议
## 2. 模块边界
## 3. 数据流
## 4. Core Contract 实现
## 5. Config / Path 实现
## 6. Runtime / Collector 实现
## 7. Storage / Migration 实现
## 8. Aggregator / Business Logic 实现
## 9. CLI / API / UI 实现
## 10. Adapter / Integration 实现
## 11. Privacy / Security 实现
## 12. 测试方案
## 13. 开发顺序
## 14. MVP Definition of Done
```

Adapt section names to the project domain.

## Workflow

1. Read blueprint to identify MVP boundaries and non-goals.
2. Read technical design to identify modules, data contracts, and dependencies.
3. Define MVP features with stable IDs such as `MVP-F01`.
4. Assign priorities and dependencies.
5. Write acceptance criteria that can be tested or inspected.
6. Write a milestone-based technical execution plan.
7. Validate that MVP scope does not include long-term vision items unless explicitly requested.

## Quality Bar

- MVP must be small enough to ship but complete enough to validate the core product loop.
- Every `P0` feature must have acceptance criteria.
- Milestones must produce working increments, not only documents.
- MVP docs must not contradict `docs/blueprint.md` or `docs/technical-design.md`.
- Cost, ROI, dashboard, remote sync, or AI recommendations should stay out of MVP unless the blueprint explicitly makes them required.
