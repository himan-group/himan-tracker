# Capability Confidence Stage Plan

This document breaks the feature into implementation phases and acceptance criteria.

## Phase 1 - Attribution Foundation (Implemented)

Goal:

- Add attribution detail fields (`basis`, `score`, `reason`, `context source`) end to end.
- Keep collect/ingest/report fail-open when Himan context is missing.

Scope:

- Event contract extension for `capability_usage`.
- Codex hook/transcript mapping:
  - explicit prompt skill -> high confidence detail
  - transcript mcp_tool_call_end -> exact observed detail
  - transcript shell SKILL path -> inferred detail with lock-aware score
- SQLite migration for new attribution detail columns.
- `capability-events` report enhancement:
  - show score/basis/context
  - support `--min-score`.

Acceptance criteria:

- Existing `collect` flow stays non-blocking on missing `himan.lock`/metadata.
- Non-Himan skill evidence continues to be ingested with downgraded confidence.
- New columns are present and backfilled for historical rows after migration.

## Phase 2 - Evidence Persistence and Strict View (Implemented)

Goal:

- Make attribution decisions auditable and queryable beyond a single synthesized row.

Scope:

- Add `capability_usage_evidence` projection table.
- Persist sanitized evidence records per usage (no prompt text, no shell args, no absolute paths).
- Add strict threshold query mode for capability reports.

Acceptance criteria:

- Each strict capability usage can be traced to evidence records.
- CLI can filter by strict threshold without recomputing attribution at read time.

## Phase 3 - Weighted ROI Inputs (Implemented)

Goal:

- Provide stable weighted signals for ROI ranking and governance recommendations.

Scope:

- Extend daily/monthly capability stats with weighted counts/tokens/duration.
- Add raw vs strict vs weighted view options to capability reports.
- Add quality checks for attribution drift (high unknown ratio, sudden score collapse).

Acceptance criteria:

- Capability ROI queries can switch view without recomputing historical rows.
- Drift checks surface anomalies without breaking report availability.

## Execution Order

1. Phase 1 foundation and migrations.
2. Phase 2 evidence persistence and strict querying.
3. Phase 3 weighted ROI aggregation and drift checks.
