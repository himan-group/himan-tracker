import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { readMetricsInsightData } from "../../src/reports/metricsInsights.js";
import { initializeTrackerDatabase } from "../../src/storage/sqlite.js";
import type { SqliteDatabase } from "../../src/storage/sqlite.js";

describe("readMetricsInsightData", () => {
  it("computes overall, project, capability metrics and alerts", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-metrics-test-"));

    try {
      const { db } = initializeTrackerDatabase(path.join(homeDir, "himan.sqlite"));
      try {
        insertTurn(db, {
          id: "turn_prev",
          eventId: "evt_turn_prev",
          sessionId: "session_prev",
          occurredAt: "2026-05-14T12:00:00.000Z",
          repoHash: "repo_a",
          durationMs: 1_000,
          totalTokens: 100,
        });
        insertTurn(db, {
          id: "turn_current_a",
          eventId: "evt_turn_current_a",
          sessionId: "session_current_a",
          occurredAt: "2026-05-15T12:00:00.000Z",
          repoHash: "repo_a",
          durationMs: 2_000,
          totalTokens: 150,
        });
        insertTurn(db, {
          id: "turn_current_b",
          eventId: "evt_turn_current_b",
          sessionId: "session_current_b",
          occurredAt: "2026-05-15T12:30:00.000Z",
          repoHash: "repo_b",
          durationMs: 1_000,
          totalTokens: 50,
        });

        insertCapability(db, {
          id: "cap_prev",
          sessionId: "session_prev",
          turnId: "turn_prev",
          occurredAt: "2026-05-14T12:00:10.000Z",
          repoHash: "repo_a",
          type: "mcp_tool",
          name: "github.create_pull_request",
          durationMs: 100,
          totalTokens: 10,
          status: "success",
        });
        insertCapability(db, {
          id: "cap_current_1",
          sessionId: "session_current_a",
          turnId: "turn_current_a",
          occurredAt: "2026-05-15T12:00:10.000Z",
          repoHash: "repo_a",
          type: "mcp_tool",
          name: "github.create_pull_request",
          durationMs: 100,
          totalTokens: 10,
          status: "success",
        });
        insertCapability(db, {
          id: "cap_current_2",
          sessionId: "session_current_a",
          turnId: "turn_current_a",
          occurredAt: "2026-05-15T12:00:20.000Z",
          repoHash: "repo_a",
          type: "mcp_tool",
          name: "github.create_pull_request",
          durationMs: 200,
          totalTokens: 20,
          status: "failure",
        });
        insertCapability(db, {
          id: "cap_current_3",
          sessionId: "session_current_b",
          turnId: "turn_current_b",
          occurredAt: "2026-05-15T12:30:10.000Z",
          repoHash: "repo_b",
          type: "mcp_tool",
          name: "github.create_pull_request",
          durationMs: 500,
          totalTokens: 70,
          status: "success",
        });
        insertCapability(db, {
          id: "cap_skill_current",
          sessionId: "session_current_a",
          turnId: "turn_current_a",
          occurredAt: "2026-05-15T12:00:05.000Z",
          repoHash: "repo_a",
          type: "skill",
          name: "common-dev-pattern",
          durationMs: null,
          totalTokens: null,
          status: "unknown",
        });

        const data = readMetricsInsightData(db, {
          now: new Date("2026-05-15T10:00:00.000Z"),
        });
        const day = data.periods.find((period) => period.period === "day");
        assert.ok(day);
        assert.deepEqual(day.currentRange, {
          startDate: "2026-05-15",
          endDate: "2026-05-15",
        });
        assert.deepEqual(day.previousRange, {
          startDate: "2026-05-14",
          endDate: "2026-05-14",
        });

        assert.equal(day.overall.totalTokens, 200);
        assert.equal(day.overall.durationMs, 3_000);
        assert.equal(day.overall.tokenGrowthRate, 1);
        assert.equal(day.overall.durationGrowthRate, 2);

        const repoA = day.projects.find((project) => project.repoHash === "repo_a");
        assert.ok(repoA);
        assert.equal(repoA.totalTokens, 150);
        assert.equal(repoA.tokenShare, 0.75);
        assert.equal(repoA.skillInvocationCount, 1);
        assert.equal(repoA.mcpInvocationCount, 2);
        assert.equal(repoA.mcpTokenShare, 30 / 150);
        assert.equal(repoA.skillTokenShare, null);
        assert.equal(repoA.tokenGrowthRate, 0.5);

        const capability = day.capabilities.find(
          (candidate) => candidate.capabilityName === "github.create_pull_request",
        );
        assert.ok(capability);
        assert.equal(capability.invocationCount, 3);
        assert.equal(capability.invocationGrowthRate, 2);
        assert.equal(capability.successRate, 2 / 3);
        assert.ok(
          capability.successRateDelta !== null &&
            Math.abs(capability.successRateDelta - -1 / 3) < 0.000001,
        );
        assert.equal(capability.duration.min, 100);
        assert.equal(capability.duration.max, 500);
        assert.equal(capability.duration.avg, 800 / 3);
        assert.ok(capability.duration.stddev && capability.duration.stddev > 169);
        assert.equal(capability.tokens.total, 100);
        assert.equal(capability.tokens.growthRate, 9);

        assert.equal(
          day.alerts.some(
            (alert) =>
              alert.scope === "overall" &&
              alert.metric === "tokens" &&
              alert.severity === "critical",
          ),
          true,
        );
        assert.equal(
          day.alerts.some(
            (alert) =>
              alert.scope === "capability" &&
              alert.metric === "success_rate" &&
              alert.severity === "warning",
          ),
          true,
        );

        const week = data.periods.find((period) => period.period === "week");
        assert.ok(week);
        assert.equal(week.currentLabel, "2026 Week 20");
        assert.deepEqual(week.currentRange, {
          startDate: "2026-05-11",
          endDate: "2026-05-17",
        });
        assert.equal(week.previousLabel, "2026 Week 19");
        assert.deepEqual(week.previousRange, {
          startDate: "2026-05-04",
          endDate: "2026-05-10",
        });
        assert.equal(week.overall.tokenGrowthRate, null);
        assert.equal(
          week.alerts.some((alert) => alert.scope === "overall" && alert.metric === "tokens"),
          false,
        );

        const month = data.periods.find((period) => period.period === "month");
        assert.ok(month);
        assert.equal(month.currentLabel, "2026-05");
        assert.deepEqual(month.currentRange, {
          startDate: "2026-05-01",
          endDate: "2026-05-31",
        });
        assert.equal(month.previousLabel, "2026-04");
        assert.deepEqual(month.previousRange, {
          startDate: "2026-04-01",
          endDate: "2026-04-30",
        });

        const aprilBoundary = readMetricsInsightData(db, {
          now: new Date("2026-04-01T10:00:00.000Z"),
        });
        const aprilWeek = aprilBoundary.periods.find((period) => period.period === "week");
        assert.ok(aprilWeek);
        assert.equal(aprilWeek.currentLabel, "2026 Week 14");
        assert.deepEqual(aprilWeek.currentRange, {
          startDate: "2026-03-30",
          endDate: "2026-04-05",
        });
        const aprilMonth = aprilBoundary.periods.find((period) => period.period === "month");
        assert.ok(aprilMonth);
        assert.equal(aprilMonth.currentLabel, "2026-04");
      } finally {
        db.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps previous-only projects and capabilities so drops can alert", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "himan-metrics-drop-test-"));

    try {
      const { db } = initializeTrackerDatabase(path.join(homeDir, "himan.sqlite"));
      try {
        insertTurn(db, {
          id: "turn_drop_prev",
          eventId: "evt_turn_drop_prev",
          sessionId: "session_drop_prev",
          occurredAt: "2026-05-14T12:00:00.000Z",
          repoHash: "repo_drop",
          durationMs: 1_000,
          totalTokens: 100,
        });
        insertCapability(db, {
          id: "cap_drop_prev",
          sessionId: "session_drop_prev",
          turnId: "turn_drop_prev",
          occurredAt: "2026-05-14T12:00:10.000Z",
          repoHash: "repo_drop",
          type: "skill",
          name: "dropped-skill",
          durationMs: 500,
          totalTokens: 80,
          status: "success",
        });

        const data = readMetricsInsightData(db, {
          now: new Date("2026-05-15T10:00:00.000Z"),
        });
        const day = data.periods.find((period) => period.period === "day");
        assert.ok(day);

        const project = day.projects.find((candidate) => candidate.repoHash === "repo_drop");
        assert.ok(project);
        assert.equal(project.turnCount, 0);
        assert.equal(project.totalTokens, 0);
        assert.equal(project.tokenGrowthRate, -1);
        assert.equal(project.durationGrowthRate, -1);

        const capability = day.capabilities.find(
          (candidate) => candidate.capabilityName === "dropped-skill",
        );
        assert.ok(capability);
        assert.equal(capability.invocationCount, 0);
        assert.equal(capability.invocationGrowthRate, -1);
        assert.equal(capability.tokens.total, 0);
        assert.equal(capability.tokens.growthRate, -1);
        assert.equal(capability.duration.total, 0);
        assert.equal(capability.duration.growthRate, -1);

        assert.equal(
          day.alerts.some(
            (alert) =>
              alert.scope === "project" &&
              alert.subject === "repo_drop" &&
              alert.metric === "tokens" &&
              alert.change === -1 &&
              alert.severity === "critical",
          ),
          true,
        );
        assert.equal(
          day.alerts.some(
            (alert) =>
              alert.scope === "capability" &&
              alert.subject === "skill:dropped-skill" &&
              alert.metric === "invocations" &&
              alert.change === -1 &&
              alert.severity === "critical",
          ),
          true,
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

function insertTurn(
  db: SqliteDatabase,
  row: {
    id: string;
    eventId: string;
    sessionId: string;
    occurredAt: string;
    repoHash: string;
    durationMs: number;
    totalTokens: number;
  },
): void {
  db.prepare(
    `
    insert into turns (
      id,
      event_id,
      session_id,
      agent,
      model,
      occurred_at,
      duration_ms,
      input_tokens,
      output_tokens,
      total_tokens,
      status,
      repo_hash
    )
    values (?, ?, ?, 'codex', 'gpt-5.5', ?, ?, null, null, ?, 'success', ?)
    `,
  ).run(
    row.id,
    row.eventId,
    row.sessionId,
    row.occurredAt,
    row.durationMs,
    row.totalTokens,
    row.repoHash,
  );
}

function insertCapability(
  db: SqliteDatabase,
  row: {
    id: string;
    sessionId: string;
    turnId: string;
    occurredAt: string;
    repoHash: string;
    type: string;
    name: string;
    durationMs: number | null;
    totalTokens: number | null;
    status: string;
  },
): void {
  db.prepare(
    `
    insert into capability_usages (
      id,
      session_id,
      turn_id,
      agent,
      source,
      capability_type,
      capability_name,
      occurred_at,
      duration_ms,
      input_tokens,
      output_tokens,
      total_tokens,
      status,
      adopted,
      attribution_confidence,
      invocation_origin,
      repo_hash
    )
    values (?, ?, ?, 'codex', 'fixture', ?, ?, ?, ?, null, null, ?, ?, 'unknown', 'exact', 'observed', ?)
    `,
  ).run(
    row.id,
    row.sessionId,
    row.turnId,
    row.type,
    row.name,
    row.occurredAt,
    row.durationMs,
    row.totalTokens,
    row.status,
    row.repoHash,
  );
}
