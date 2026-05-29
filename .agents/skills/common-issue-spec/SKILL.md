---
name: common-issue-spec
description: Turn vague issues, product requests, bug reports, or engineering tasks into a concise implementation spec before coding. Use when the request is underspecified, business-heavy, cross-file, or likely to require scope, acceptance criteria, references, assumptions, or validation steps.
---

# common-issue-spec

Use this skill before implementation when coding directly would risk solving the wrong problem.

## Workflow

1. Identify the user's intent and expected user-visible outcome.
2. Inspect only the minimum local context needed to make the issue concrete, such as relevant routes, components, services, API clients, tests, logs, existing issue notes, or adjacent implementations.
3. Produce a short implementation spec before editing code.
4. If a key decision cannot be inferred safely, ask one concise question. Otherwise state the assumption and proceed.

## Output Shape

Use this structure when refining the issue:

```text
Goal:
- ...

Scope:
- In scope: ...
- Out of scope: ...

Existing references:
- ...

Implementation constraints:
- ...

Acceptance criteria:
- ...

Validation:
- ...
```

## Rules

- Keep the spec practical and short.
- Prefer concrete file paths, route names, API names, component names, commands, and test names over generic descriptions.
- Do not invent product behavior that is not implied by the request or existing code.
- Do not stop after writing the spec unless the user only asked for planning.
- After the spec is clear enough, continue with implementation in the same turn.
