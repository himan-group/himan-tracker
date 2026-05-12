# himan-tracker Blueprint

## 1. Overview

`himan-tracker` is a local-first observability and analytics tool for AI coding agents.

The MVP focuses on:

- Codex
- Claude Code

The goal is to help developers and teams understand:

- Which agents are used most
- Which models consume the most tokens
- Which skills, MCP tools, and plugins are actually valuable
- Which capabilities increase latency and token cost without meaningful ROI

Core direction:

```text
AI Workflow ROI Analytics
```

---

## 2. Core Objectives

`himan-tracker` aims to measure the real effectiveness of AI workflows.

Key questions:

- Which skills are actually used?
- Which tools increase token cost?
- Which capabilities improve productivity?
- Which plugins should be removed?
- What is the real ROI of AI-assisted development workflows?

---

## 3. MVP Scope

### Supported Agents

| Agent       | Support Strategy                    |
| ----------- | ----------------------------------- |
| Codex       | Hooks / wrapper / local log adapter |
| Claude Code | Hooks adapter                       |

---

## 4. Agent Conversation Tracking

Track every session and turn executed by supported agents.

### Metrics

- Agent name
- Model name
- Session count
- Turn count
- Input tokens
- Output tokens
- Total tokens
- Request latency
- Success rate
- Daily / weekly / monthly summaries

### Example Event

```json
{
  "event_type": "turn_summary",
  "agent": "codex",
  "model": "gpt-5.1-codex",
  "session_id": "s_001",
  "turn_id": "t_001",
  "duration_ms": 42000,
  "input_tokens": 12000,
  "output_tokens": 1800,
  "total_tokens": 13800,
  "status": "success"
}
```

---

## 5. Capability Tracking

Track all capabilities used during agent execution.

Unified abstraction:

```text
capability
```

### Capability Types

- skill
- mcp_tool
- plugin
- builtin_tool
- shell_command
- unknown

### Tracked Metrics

- Capability name
- Capability type
- Invocation count
- Token usage
- Duration
- Success / failure
- Adoption status
- Usage share
- Token share
- Time share

### Example Event

```json
{
  "event_type": "capability_usage",
  "agent": "claude-code",
  "session_id": "s_001",
  "turn_id": "t_001",
  "capability_type": "mcp_tool",
  "capability_name": "github.create_pull_request",
  "duration_ms": 3000,
  "input_tokens": 800,
  "output_tokens": 120,
  "status": "success",
  "adopted": "unknown"
}
```

---

## 6. Runtime Architecture

```text
Codex / Claude Code
        ↓
Agent Adapter
        ↓
Hook Event Collector
        ↓
Normalizer
        ↓
Local Storage
        ↓
Aggregator
        ↓
CLI Report
```

---

## 7. Hooks Strategy

### Planned Hook Usage

| Hook             | Purpose                     |
| ---------------- | --------------------------- |
| UserPromptSubmit | Detect explicit skills      |
| PreToolUse       | Tool execution tracing      |
| PostToolUse      | Tool execution metrics      |
| Stop             | Session summary aggregation |

---

## 8. Data Storage

### Raw Events

```text
~/.himan-tracker/events/YYYY-MM-DD.jsonl
```

Purpose:

- Daily sharded raw event logging
- Replayable event source
- Easy debugging
- Portable analytics source

### Aggregated Database

```text
~/.himan-tracker/himan.sqlite
```

Planned tables:

- sessions
- turns
- capability_usages
- daily_agent_stats
- daily_capability_stats

---

## 9. CLI Design

### Summary Report

```bash
himan-tracker summary --since 7d
```

### Agent Report

```bash
himan-tracker agents --date 2026-05-12
```

### Capability Ranking

```bash
himan-tracker capabilities --since 30d
```

### Unused Capability Detection

```bash
himan-tracker unused --since 30d
```

---

## 10. ROI Metrics

The long-term goal is evaluating workflow ROI.

### Planned Metrics

- Quality lift
- Token overhead
- Latency overhead
- Human time saved
- Invocation frequency
- Adoption rate

### Example ROI Formula

```text
ROI =
  quality_gain
+ time_saved
- token_cost
- latency_cost
- maintenance_cost
```

---

## 11. MVP Priorities

### v0.1 — Usage Tracker

Focus:

```text
Understand what is being used and how often.
```

Features:

- Codex adapter
- Claude Code adapter
- JSONL event logging
- SQLite aggregation
- Agent summary
- Capability ranking
- Daily / weekly / monthly reports

### v0.2 — Cost Tracker

Additional features:

- Token attribution
- Cost estimation
- Latency analysis
- Repo-level analytics

### v0.3 — ROI Tracker

Additional features:

- Adoption analysis
- Quality scoring
- ROI ranking
- Low-value capability recommendations

---

## 12. Privacy and Security

MVP strategy:

```text
Local-first by default.
```

Default behavior:

- Do NOT upload prompts
- Do NOT upload responses
- Do NOT upload code content
- Store metadata locally only

Default stored fields:

- token counts
- latency
- capability metadata
- hashes
- session metadata

Optional future support:

- content capture
- redaction
- ignore patterns
- remote telemetry export

---

## 13. Non-Goals

The MVP does NOT:

- Execute skills
- Modify Codex or Claude Code runtime behavior
- Manage skill lifecycle
- Replace existing observability platforms
- Provide a full dashboard platform
- Guarantee accurate capability-level token attribution
- Guarantee accurate adoption detection

---

## 14. Long-Term Vision

`himan-tracker` is not only a usage tracker.

The long-term direction is:

```text
AI workflow observability and ROI analytics.
```

Future possibilities:

- OpenTelemetry integration
- Langfuse integration
- Phoenix integration
- Team analytics
- Dashboard UI
- AI workflow optimization
- Capability recommendation engine
- Automated low-value capability detection

---

## 15. Project Description

### English

> himan-tracker is a local-first usage analytics tool for Codex and Claude Code, tracking agent conversations, token cost, latency, and skill / MCP / plugin usage to help teams evaluate AI workflow ROI.

### Chinese

> himan-tracker 是一个面向 Codex 和 Claude Code 的本地优先使用分析工具，用于统计 agent 对话、token 成本、执行耗时，以及 skill / MCP tool / plugin 的使用情况，帮助团队评估 AI 工作流 ROI。
