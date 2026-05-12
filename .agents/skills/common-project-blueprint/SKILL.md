---
name: common-project-blueprint
description: Create or update project blueprint and user-facing README content for early-stage repositories. Use when Codex is asked to define project positioning, target users, goals, scope, non-goals, long-term vision, product description, or user-focused README/manual content from a project idea or rough notes.
---

# Common Project Blueprint

## Purpose

Use this skill to turn a rough project idea into product-facing project documentation. Keep the output focused on what the project is, who it serves, what problems it solves, and how users should understand it.

## Inputs To Inspect

Read the smallest useful set of files:

- Existing `README.md`
- Existing `docs/blueprint.md`
- Product notes, issue descriptions, or user-provided requirements
- Existing `docs/` files that describe scope or users

If there is no existing project context, proceed from the user prompt and clearly mark assumptions.

## Standard Outputs

Primary output:

- `docs/blueprint.md`

Optional output when the user asks for user-facing project information:

- `README.md`

Do not create engineering implementation docs from this skill. Use `common-project-tech-design` for architecture and implementation planning.

## Blueprint Structure

Use this structure unless the repository already has a stronger local convention:

```markdown
# <project-name> Blueprint

## 1. Overview
## 2. Core Objectives
## 3. Target Users
## 4. Core Use Cases
## 5. MVP Scope
## 6. Key Concepts
## 7. User Workflows
## 8. Data Or Behavior Scope
## 9. Non-Goals
## 10. Privacy / Security Principles
## 11. Long-Term Vision
## 12. Project Description
```

Adjust section names for the domain, but keep the document explicit about scope and non-goals.

## README Rules

When updating `README.md`, make it user-facing:

- Explain what the product does.
- Explain who should use it.
- Show installation status or installation commands.
- Show quick start and command usage only when truthful.
- Explain data location, privacy behavior, and common questions when relevant.

Avoid README content about:

- Internal development milestones
- Source directory structure
- Engineering task order
- Technical design references
- Contributor-only implementation details

If the product is not yet installable, say that plainly instead of inventing commands.

## Workflow

1. Inspect existing docs and README.
2. Identify the product category, user group, core problem, and MVP boundary.
3. Separate user-visible behavior from implementation details.
4. Write or update `docs/blueprint.md`.
5. Update `README.md` only when requested or when project introduction/user manual content is part of the task.
6. Check links and ensure claims match the repository's actual state.

## Quality Bar

- The blueprint must be specific enough to drive a technical design.
- MVP scope and non-goals must be explicit.
- Long-term vision must not blur what is actually in MVP.
- README must not imply unimplemented functionality is already available.
- Prefer concrete examples, command names, data paths, or workflows over vague positioning.
