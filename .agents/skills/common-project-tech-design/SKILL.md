---
name: common-project-tech-design
description: Create or update project technical design docs and bootstrap repository structure from a blueprint. Use when Codex is asked to design architecture, modules, data contracts, storage, CLI/API behavior, file layout, testing strategy, or initialize directories and file conventions for a project.
---

# Common Project Tech Design

## Purpose

Use this skill to convert a product blueprint into an implementation-oriented technical design. The output should guide future development without over-implementing code before requirements are stable.

## Inputs To Inspect

Read the smallest useful set of files:

- `docs/blueprint.md`
- Existing `docs/technical-design.md`
- Existing `README.md`
- Existing source tree, package manifests, config files, and tests
- Local guidance such as `AGENTS.md`, `.agents/skills/*`, or `docs/codex/repo-map.md`

If `docs/blueprint.md` does not exist, summarize assumptions and consider using `common-project-blueprint` first.

## Standard Outputs

Primary output:

- `docs/technical-design.md`

Optional output when asked to initialize the project:

- Source/test/docs directories from the technical design
- `.gitkeep` files in leaf directories that would otherwise be empty

Do not generate MVP feature plans from this skill. Use `common-project-mvp` for feature lists, milestones, and acceptance criteria.

## Technical Design Structure

Use this structure unless the repository already has a stronger local convention:

```markdown
# <project-name> 技术方案

## 1. 设计目标
## 2. 核心技术决策
## 3. 推荐工程结构
## 4. 数据契约 / Domain Model
## 5. Runtime / Integration 设计
## 6. 存储设计
## 7. 聚合 / Business Logic
## 8. CLI / API / UI 设计
## 9. 配置设计
## 10. 隐私与安全
## 11. 测试策略
## 12. 开发顺序
## 13. 风险与处理
## 14. 后续扩展点
## 15. 开发约束
```

Rename sections for the domain, but preserve clear module boundaries and validation strategy.

## Directory Bootstrap Rules

When initializing directories:

- Follow the directory tree documented in `docs/technical-design.md`.
- Create only directories that are part of the agreed design.
- Use `.gitkeep` for empty leaf directories.
- Do not create placeholder implementation files unless the user asks for code.
- Do not add package dependencies, build scripts, or migrations unless the request explicitly includes implementation.

## Workflow

1. Read blueprint and existing project structure.
2. Identify existing conventions before proposing new ones.
3. Define architecture, module boundaries, data contracts, and storage/API/CLI surfaces.
4. Document privacy, security, testing, and failure-mode expectations.
5. If requested, create the directory skeleton exactly matching the design.
6. Validate by checking generated docs, file list, and `git status`.

## Quality Bar

- Every major module must have a clear owner and responsibility.
- Data contracts must define required fields, optional fields, and unknown/null handling.
- Persistence must distinguish facts/source-of-truth from projections/cache when applicable.
- Testing strategy must match risk and module boundaries.
- The design must avoid implementation claims that are not yet decided.
