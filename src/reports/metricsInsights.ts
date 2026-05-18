import type { SqliteDatabase } from "../storage/sqlite.js";
import {
  addDays,
  formatLocalDate,
  formatYearWeekLabel,
  parseLocalDate,
  startOfLocalWeek,
} from "./periodFormatter.js";

export type MetricsPeriod = "day" | "week" | "month";
export type AlertSeverity = "warning" | "major" | "critical";
export type AlertMetric =
  | "tokens"
  | "duration"
  | "invocations"
  | "success_rate"
  | "duration_cv"
  | "tokens_cv";

export type MetricsInsightAlert = {
  scope: "overall" | "project" | "capability";
  period: MetricsPeriod;
  severity: AlertSeverity;
  metric: AlertMetric;
  subject: string;
  current: number | null;
  previous: number | null;
  change: number | null;
  message: string;
};

export type MetricsInsightData = {
  generatedAt: string;
  periods: MetricsPeriodInsight[];
  alerts: MetricsInsightAlert[];
};

export type MetricsPeriodInsight = {
  period: MetricsPeriod;
  currentLabel: string;
  currentRange: DateRange;
  previousLabel: string;
  previousRange: DateRange;
  overall: OverallMetricsRow;
  overallRows: OverallMetricsPeriodRow[];
  projects: ProjectMetricsRow[];
  capabilities: CapabilityMetricsRow[];
  alerts: MetricsInsightAlert[];
};

export type DateRange = {
  startDate: string;
  endDate: string;
};

export type OverallMetricsRow = {
  sessionCount: number;
  turnCount: number;
  totalTokens: number | null;
  durationMs: number | null;
  avgTurnDurationMs: number | null;
  avgTokensPerTurn: number | null;
  tokenGrowthRate: number | null;
  durationGrowthRate: number | null;
};

export type OverallMetricsPeriodRow = OverallMetricsRow & {
  label: string;
  range: DateRange;
  previousLabel: string;
  previousRange: DateRange;
};

export type ProjectMetricsRow = {
  repoHash: string;
  turnCount: number;
  totalTokens: number | null;
  tokenShare: number | null;
  durationMs: number | null;
  durationShare: number | null;
  skillInvocationCount: number;
  mcpInvocationCount: number;
  skillTokenShare: number | null;
  mcpTokenShare: number | null;
  tokenGrowthRate: number | null;
  durationGrowthRate: number | null;
};

export type CapabilityMetricsRow = {
  agent: string;
  capabilityType: string;
  capabilityName: string;
  invocationCount: number;
  invocationGrowthRate: number | null;
  successRate: number | null;
  successRateDelta: number | null;
  durationBasis: DurationBasis;
  duration: DistributionMetrics;
  tokens: DistributionMetrics;
};

export type DurationBasis = "event" | "turn_estimate" | "mixed" | "none";

export type DistributionMetrics = {
  count: number;
  total: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  stddev: number | null;
  cv: number | null;
  growthRate: number | null;
};

type PeriodSpec = {
  period: MetricsPeriod;
};

type OverallAggregateRow = {
  session_count: number;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
};

type ProjectAggregateRow = {
  repo_hash: string | null;
  turn_count: number;
  total_tokens: number | null;
  duration_ms: number | null;
};

type ProjectCapabilityAggregateRow = {
  repo_hash: string | null;
  capability_type: string;
  invocation_count: number;
  total_tokens: number | null;
};

type CapabilityEventRow = {
  agent: string;
  capability_type: string;
  capability_name: string;
  total_tokens: number | null;
  duration_ms: number | null;
  duration_basis: DurationBasis;
  status: string;
};

type CapabilityAggregate = {
  agent: string;
  capabilityType: string;
  capabilityName: string;
  invocationCount: number;
  successCount: number;
  failureCount: number;
  eventDurationCount: number;
  turnEstimateDurationCount: number;
  durations: number[];
  tokens: number[];
};

const PERIOD_SPECS: PeriodSpec[] = [
  { period: "day" },
  { period: "week" },
  { period: "month" },
];

const CHANGE_THRESHOLDS: Array<{ severity: AlertSeverity; threshold: number }> = [
  { severity: "critical", threshold: 0.6 },
  { severity: "major", threshold: 0.4 },
  { severity: "warning", threshold: 0.2 },
];

const CV_THRESHOLDS: Array<{ severity: AlertSeverity; threshold: number }> = [
  { severity: "critical", threshold: 1.5 },
  { severity: "major", threshold: 1 },
  { severity: "warning", threshold: 0.5 },
];

const OVERALL_HISTORY_LIMIT: Record<MetricsPeriod, number> = {
  day: 7,
  week: 8,
  month: 6,
};

export function readMetricsInsightData(
  db: SqliteDatabase,
  options: {
    now?: Date;
  } = {},
): MetricsInsightData {
  const generatedAt = options.now ?? new Date();
  const periods = PERIOD_SPECS.map((spec) => readMetricsPeriodInsight(db, spec, generatedAt));

  return {
    generatedAt: generatedAt.toISOString(),
    periods,
    alerts: periods.flatMap((period) => period.alerts),
  };
}

function readMetricsPeriodInsight(
  db: SqliteDatabase,
  spec: PeriodSpec,
  now: Date,
): MetricsPeriodInsight {
  const currentRange = createCurrentRange(spec.period, now);
  const previousRange = createPreviousRange(db, spec.period, currentRange);
  const overallRows = readOverallMetricsHistory(db, spec.period, currentRange);
  const currentOverall = overallRows[0] ?? createOverallMetricsPeriodRow(db, spec.period, currentRange);
  const previousOverall = readOverallMetrics(db, previousRange);
  const projects = readProjectMetrics(db, currentRange, previousRange);
  const capabilities = readCapabilityMetrics(db, currentRange, previousRange);
  const alerts = [
    ...createOverallAlerts(spec.period, currentOverall, previousOverall),
    ...projects.flatMap((project) => createProjectAlerts(spec.period, project)),
    ...capabilities.flatMap((capability) => createCapabilityAlerts(spec.period, capability)),
  ];

  return {
    period: spec.period,
    currentLabel: formatPeriodLabel(spec.period, currentRange),
    currentRange,
    previousLabel: formatPeriodLabel(spec.period, previousRange),
    previousRange,
    overall: currentOverall,
    overallRows,
    projects,
    capabilities,
    alerts,
  };
}

function readOverallMetricsHistory(
  db: SqliteDatabase,
  period: MetricsPeriod,
  currentRange: DateRange,
): OverallMetricsPeriodRow[] {
  const rows: OverallMetricsPeriodRow[] = [];
  let range = currentRange;

  for (let index = 0; index < OVERALL_HISTORY_LIMIT[period]; index += 1) {
    const row = createOverallMetricsPeriodRow(db, period, range);
    if (index === 0 || row.turnCount > 0) {
      rows.push(row);
    }
    range = row.previousRange;
  }

  return rows;
}

function createOverallMetricsPeriodRow(
  db: SqliteDatabase,
  period: MetricsPeriod,
  range: DateRange,
): OverallMetricsPeriodRow {
  const previousRange = createPreviousRange(db, period, range);
  const current = readOverallMetrics(db, range);
  const previous = readOverallMetrics(db, previousRange);

  return {
    ...current,
    label: formatPeriodLabel(period, range),
    range,
    previousLabel: formatPeriodLabel(period, previousRange),
    previousRange,
    tokenGrowthRate: calculateGrowthRate(current.totalTokens, previous.totalTokens),
    durationGrowthRate: calculateGrowthRate(current.durationMs, previous.durationMs),
  };
}

function readOverallMetrics(db: SqliteDatabase, range: DateRange): OverallMetricsRow {
  const row = db
    .prepare(
      `
      select
        count(distinct session_id) as session_count,
        count(*) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms
      from turns
      where date(occurred_at, 'localtime') between ? and ?
      `,
    )
    .get(range.startDate, range.endDate) as OverallAggregateRow;

  return {
    sessionCount: row.session_count,
    turnCount: row.turn_count,
    totalTokens: row.turn_count === 0 ? 0 : row.total_tokens,
    durationMs: row.turn_count === 0 ? 0 : row.duration_ms,
    avgTurnDurationMs: divideNullable(row.duration_ms, row.turn_count),
    avgTokensPerTurn: divideNullable(row.total_tokens, row.turn_count),
    tokenGrowthRate: null,
    durationGrowthRate: null,
  };
}

function readProjectMetrics(
  db: SqliteDatabase,
  currentRange: DateRange,
  previousRange: DateRange,
): ProjectMetricsRow[] {
  const currentRows = readProjectAggregates(db, currentRange);
  const previousRows = new Map(
    readProjectAggregates(db, previousRange).map((row) => [normalizeRepoHash(row.repo_hash), row]),
  );
  const currentRowsByRepo = new Map(
    currentRows.map((row) => [normalizeRepoHash(row.repo_hash), row]),
  );
  const capabilityRowsByProject = groupProjectCapabilities(readProjectCapabilityAggregates(db, currentRange));
  const totalTokens = sumNullableValues(currentRows.map((row) => row.total_tokens));
  const totalDurationMs = sumNullableValues(currentRows.map((row) => row.duration_ms));

  return [...new Set([...currentRowsByRepo.keys(), ...previousRows.keys()])]
    .map((repoHash) => {
      const row = currentRowsByRepo.get(repoHash);
      const previous = previousRows.get(repoHash);
      const capabilityRows = capabilityRowsByProject.get(repoHash) ?? [];
      const skill = capabilityRows.find((candidate) => candidate.capability_type === "skill");
      const mcp = capabilityRows.find((candidate) => candidate.capability_type === "mcp_tool");
      const totalTokenValue = getCurrentMetricValue(row?.total_tokens ?? null, row !== undefined);
      const durationValue = getCurrentMetricValue(row?.duration_ms ?? null, row !== undefined);

      return {
        repoHash,
        turnCount: row?.turn_count ?? 0,
        totalTokens: totalTokenValue,
        tokenShare: divideNullable(totalTokenValue, totalTokens),
        durationMs: durationValue,
        durationShare: divideNullable(durationValue, totalDurationMs),
        skillInvocationCount: skill?.invocation_count ?? 0,
        mcpInvocationCount: mcp?.invocation_count ?? 0,
        skillTokenShare: divideNullable(skill?.total_tokens ?? null, totalTokenValue),
        mcpTokenShare: divideNullable(mcp?.total_tokens ?? null, totalTokenValue),
        tokenGrowthRate: calculateGrowthRate(totalTokenValue, previous?.total_tokens ?? null),
        durationGrowthRate: calculateGrowthRate(durationValue, previous?.duration_ms ?? null),
      };
    })
    .sort((left, right) => (right.totalTokens ?? -1) - (left.totalTokens ?? -1));
}

function readProjectAggregates(
  db: SqliteDatabase,
  range: DateRange,
): ProjectAggregateRow[] {
  return db
    .prepare(
      `
      select
        repo_hash,
        count(*) as turn_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens,
        case when count(duration_ms) = 0 then null else sum(duration_ms) end as duration_ms
      from turns
      where date(occurred_at, 'localtime') between ? and ?
      group by repo_hash
      `,
    )
    .all(range.startDate, range.endDate) as ProjectAggregateRow[];
}

function readProjectCapabilityAggregates(
  db: SqliteDatabase,
  range: DateRange,
): ProjectCapabilityAggregateRow[] {
  return db
    .prepare(
      `
      select
        repo_hash,
        capability_type,
        count(*) as invocation_count,
        case when count(total_tokens) = 0 then null else sum(total_tokens) end as total_tokens
      from capability_usages
      where date(occurred_at, 'localtime') between ? and ?
        and capability_type in ('skill', 'mcp_tool')
      group by repo_hash, capability_type
      `,
    )
    .all(range.startDate, range.endDate) as ProjectCapabilityAggregateRow[];
}

function groupProjectCapabilities(
  rows: ProjectCapabilityAggregateRow[],
): Map<string, ProjectCapabilityAggregateRow[]> {
  const grouped = new Map<string, ProjectCapabilityAggregateRow[]>();
  for (const row of rows) {
    const repoHash = normalizeRepoHash(row.repo_hash);
    const projectRows = grouped.get(repoHash) ?? [];
    projectRows.push(row);
    grouped.set(repoHash, projectRows);
  }
  return grouped;
}

function readCapabilityMetrics(
  db: SqliteDatabase,
  currentRange: DateRange,
  previousRange: DateRange,
): CapabilityMetricsRow[] {
  const current = readCapabilityAggregates(db, currentRange);
  const previous = readCapabilityAggregates(db, previousRange);

  return [...new Set([...current.keys(), ...previous.keys()])]
    .map((key) => {
      const previousAggregate = previous.get(key);
      const aggregate = current.get(key) ?? createEmptyCapabilityAggregate(previousAggregate);
      const duration = createDistributionMetrics(
        aggregate.durations,
        previousAggregate?.durations ?? [],
        aggregate.invocationCount,
        previousAggregate?.invocationCount ?? 0,
      );
      const tokens = createDistributionMetrics(
        aggregate.tokens,
        previousAggregate?.tokens ?? [],
        aggregate.invocationCount,
        previousAggregate?.invocationCount ?? 0,
      );
      const successRate = calculateSuccessRate(aggregate.successCount, aggregate.failureCount);
      const previousSuccessRate = previousAggregate
        ? calculateSuccessRate(previousAggregate.successCount, previousAggregate.failureCount)
        : null;

      return {
        agent: aggregate.agent,
        capabilityType: aggregate.capabilityType,
        capabilityName: aggregate.capabilityName,
        invocationCount: aggregate.invocationCount,
        invocationGrowthRate: calculateGrowthRate(
          aggregate.invocationCount,
          previousAggregate?.invocationCount ?? null,
        ),
        successRate,
        successRateDelta:
          successRate === null || previousSuccessRate === null
            ? null
            : successRate - previousSuccessRate,
        durationBasis: resolveDurationBasis(aggregate),
        duration,
        tokens,
      };
    })
    .sort((left, right) => right.invocationCount - left.invocationCount);
}

function readCapabilityAggregates(
  db: SqliteDatabase,
  range: DateRange,
): Map<string, CapabilityAggregate> {
  const rows = db
    .prepare(
      `
      select
        c.agent,
        c.capability_type,
        c.capability_name,
        c.total_tokens,
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
          as duration_ms,
        case
          when c.duration_ms is not null then 'event'
          when c.capability_type = 'skill' and t.duration_ms is not null then 'turn_estimate'
          else 'none'
        end as duration_basis,
        c.status
      from capability_usages c
      left join turns t
        on t.id = c.turn_id
        and t.session_id = c.session_id
        and t.agent = c.agent
      where date(c.occurred_at, 'localtime') between ? and ?
      `,
    )
    .all(range.startDate, range.endDate) as CapabilityEventRow[];
  const aggregates = new Map<string, CapabilityAggregate>();

  for (const row of rows) {
    const key = `${row.agent}\u001f${row.capability_type}\u001f${row.capability_name}`;
    const aggregate = aggregates.get(key) ?? {
      agent: row.agent,
      capabilityType: row.capability_type,
      capabilityName: row.capability_name,
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      eventDurationCount: 0,
      turnEstimateDurationCount: 0,
      durations: [],
      tokens: [],
    };

    aggregate.invocationCount += 1;
    if (row.status === "success") {
      aggregate.successCount += 1;
    } else if (row.status === "failure") {
      aggregate.failureCount += 1;
    }
    if (row.duration_ms !== null) {
      aggregate.durations.push(row.duration_ms);
      if (row.duration_basis === "event") {
        aggregate.eventDurationCount += 1;
      } else if (row.duration_basis === "turn_estimate") {
        aggregate.turnEstimateDurationCount += 1;
      }
    }
    if (row.total_tokens !== null) {
      aggregate.tokens.push(row.total_tokens);
    }
    aggregates.set(key, aggregate);
  }

  return aggregates;
}

function createDistributionMetrics(
  currentValues: number[],
  previousValues: number[],
  currentInvocationCount: number,
  previousInvocationCount: number,
): DistributionMetrics {
  const currentTotal =
    currentValues.length > 0
      ? sumValues(currentValues)
      : currentInvocationCount === 0 && previousValues.length > 0
        ? 0
        : null;
  const previousTotal =
    previousValues.length > 0
      ? sumValues(previousValues)
      : previousInvocationCount === 0 && currentValues.length > 0
        ? 0
        : null;
  const avg = divideNullable(currentTotal, currentValues.length);
  const stddev = calculateStddev(currentValues);

  return {
    count: currentValues.length,
    total: currentTotal,
    avg,
    min: currentValues.length > 0 ? Math.min(...currentValues) : null,
    max: currentValues.length > 0 ? Math.max(...currentValues) : null,
    stddev,
    cv: divideNullable(stddev, avg),
    growthRate: calculateGrowthRate(currentTotal, previousTotal),
  };
}

function createOverallAlerts(
  period: MetricsPeriod,
  current: OverallMetricsRow,
  previous: OverallMetricsRow,
): MetricsInsightAlert[] {
  return [
    createChangeAlert({
      scope: "overall",
      period,
      metric: "tokens",
      subject: "overall",
      current: current.totalTokens,
      previous: previous.totalTokens,
    }),
    createChangeAlert({
      scope: "overall",
      period,
      metric: "duration",
      subject: "overall",
      current: current.durationMs,
      previous: previous.durationMs,
    }),
  ].filter((alert): alert is MetricsInsightAlert => alert !== null);
}

function createProjectAlerts(
  period: MetricsPeriod,
  project: ProjectMetricsRow,
): MetricsInsightAlert[] {
  return [
    createChangeAlert({
      scope: "project",
      period,
      metric: "tokens",
      subject: project.repoHash,
      current: ratioToCurrent(project.totalTokens, project.tokenGrowthRate),
      previous: ratioToPrevious(project.totalTokens, project.tokenGrowthRate),
      change: project.tokenGrowthRate,
    }),
    createChangeAlert({
      scope: "project",
      period,
      metric: "duration",
      subject: project.repoHash,
      current: ratioToCurrent(project.durationMs, project.durationGrowthRate),
      previous: ratioToPrevious(project.durationMs, project.durationGrowthRate),
      change: project.durationGrowthRate,
    }),
  ].filter((alert): alert is MetricsInsightAlert => alert !== null);
}

function createCapabilityAlerts(
  period: MetricsPeriod,
  capability: CapabilityMetricsRow,
): MetricsInsightAlert[] {
  const subject = `${capability.capabilityType}:${capability.capabilityName}`;
  return [
    createChangeAlert({
      scope: "capability",
      period,
      metric: "invocations",
      subject,
      current: capability.invocationCount,
      previous: ratioToPrevious(capability.invocationCount, capability.invocationGrowthRate),
      change: capability.invocationGrowthRate,
    }),
    createChangeAlert({
      scope: "capability",
      period,
      metric: "duration",
      subject,
      current: capability.duration.total,
      previous: ratioToPrevious(capability.duration.total, capability.duration.growthRate),
      change: capability.duration.growthRate,
    }),
    createChangeAlert({
      scope: "capability",
      period,
      metric: "tokens",
      subject,
      current: capability.tokens.total,
      previous: ratioToPrevious(capability.tokens.total, capability.tokens.growthRate),
      change: capability.tokens.growthRate,
    }),
    createSuccessRateAlert(period, subject, capability),
    createCvAlert(period, "duration_cv", subject, capability.duration.cv),
    createCvAlert(period, "tokens_cv", subject, capability.tokens.cv),
  ].filter((alert): alert is MetricsInsightAlert => alert !== null);
}

function createChangeAlert(options: {
  scope: MetricsInsightAlert["scope"];
  period: MetricsPeriod;
  metric: AlertMetric;
  subject: string;
  current: number | null;
  previous: number | null;
  change?: number | null;
}): MetricsInsightAlert | null {
  const change = options.change ?? calculateGrowthRate(options.current, options.previous);
  const severity = getThresholdSeverity(Math.abs(change ?? 0), CHANGE_THRESHOLDS);
  if (!severity || change === null) {
    return null;
  }

  return {
    scope: options.scope,
    period: options.period,
    severity,
    metric: options.metric,
    subject: options.subject,
    current: options.current,
    previous: options.previous,
    change,
    message: `${options.metric} ${change >= 0 ? "increased" : "decreased"} ${formatPercent(
      Math.abs(change),
    )}`,
  };
}

function createSuccessRateAlert(
  period: MetricsPeriod,
  subject: string,
  capability: CapabilityMetricsRow,
): MetricsInsightAlert | null {
  const delta = capability.successRateDelta;
  const severity = getThresholdSeverity(Math.abs(delta ?? 0), CHANGE_THRESHOLDS);
  if (!severity || delta === null || delta >= 0) {
    return null;
  }

  return {
    scope: "capability",
    period,
    severity,
    metric: "success_rate",
    subject,
    current: capability.successRate,
    previous:
      capability.successRate === null || delta === null ? null : capability.successRate - delta,
    change: delta,
    message: `success_rate decreased ${formatPercent(Math.abs(delta))}`,
  };
}

function createCvAlert(
  period: MetricsPeriod,
  metric: Extract<AlertMetric, "duration_cv" | "tokens_cv">,
  subject: string,
  cv: number | null,
): MetricsInsightAlert | null {
  const severity = getThresholdSeverity(cv ?? 0, CV_THRESHOLDS);
  if (!severity || cv === null) {
    return null;
  }

  return {
    scope: "capability",
    period,
    severity,
    metric,
    subject,
    current: cv,
    previous: null,
    change: null,
    message: `${metric} is ${cv.toFixed(2)}`,
  };
}

function getThresholdSeverity(
  value: number,
  thresholds: Array<{ severity: AlertSeverity; threshold: number }>,
): AlertSeverity | null {
  return thresholds.find((candidate) => value >= candidate.threshold)?.severity ?? null;
}

function createCurrentRange(period: MetricsPeriod, now: Date): DateRange {
  const today = startOfLocalDay(now);

  if (period === "day") {
    return createDateRange(today, today);
  }

  if (period === "week") {
    const start = startOfLocalWeek(today);
    return createDateRange(start, addDays(start, 6));
  }

  const start = startOfLocalMonth(today);
  return createDateRange(start, endOfLocalMonth(today));
}

function createPreviousRange(
  db: SqliteDatabase,
  period: MetricsPeriod,
  currentRange: DateRange,
): DateRange {
  const currentStart = parseLocalDate(currentRange.startDate);

  if (period === "day") {
    const nearestAvailableDate = findNearestPreviousDayWithTurns(db, currentRange.startDate);
    if (nearestAvailableDate !== null) {
      const nearest = parseLocalDate(nearestAvailableDate);
      return createDateRange(nearest, nearest);
    }

    const fallbackDate = addDays(currentStart, -1);
    return createDateRange(fallbackDate, fallbackDate);
  }

  if (period === "week") {
    const previousStart = addDays(currentStart, -7);
    return createDateRange(previousStart, addDays(previousStart, 6));
  }

  const previousMonth = new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1);
  return createDateRange(previousMonth, endOfLocalMonth(previousMonth));
}

function findNearestPreviousDayWithTurns(db: SqliteDatabase, currentDate: string): string | null {
  const row = db
    .prepare(
      `
      select date(occurred_at, 'localtime') as metric_date
      from turns
      where date(occurred_at, 'localtime') < ?
      group by metric_date
      order by metric_date desc
      limit 1
      `,
    )
    .get(currentDate) as
    | {
        metric_date: string;
      }
    | undefined;

  return row?.metric_date ?? null;
}

function createDateRange(start: Date, end: Date): DateRange {
  return {
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
  };
}

function formatPeriodLabel(period: MetricsPeriod, range: DateRange): string {
  if (period === "day") {
    return range.startDate;
  }

  if (period === "week") {
    return formatNaturalWeekLabel(range);
  }

  return range.startDate.slice(0, 7);
}

function formatNaturalWeekLabel(range: DateRange): string {
  return formatYearWeekLabel(parseLocalDate(range.startDate));
}

function calculateGrowthRate(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }

  return (current - previous) / previous;
}

function calculateSuccessRate(successCount: number, failureCount: number): number | null {
  const denominator = successCount + failureCount;
  return denominator > 0 ? successCount / denominator : null;
}

function calculateStddev(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const average = sumValues(values) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function divideNullable(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  return numerator === null || numerator === undefined || !denominator || denominator <= 0
    ? null
    : numerator / denominator;
}

function sumNullableValues(values: Array<number | null>): number | null {
  const presentValues = values.filter((value): value is number => value !== null);
  return presentValues.length > 0 ? sumValues(presentValues) : null;
}

function sumValues(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratioToCurrent(value: number | null, _growthRate: number | null): number | null {
  return value;
}

function ratioToPrevious(current: number | null, growthRate: number | null): number | null {
  if (current === null || growthRate === null || growthRate === -1) {
    return null;
  }

  return current / (1 + growthRate);
}

function createEmptyCapabilityAggregate(
  previousAggregate: CapabilityAggregate | undefined,
): CapabilityAggregate {
  if (!previousAggregate) {
    throw new Error("Expected previous capability aggregate");
  }

  return {
    agent: previousAggregate.agent,
    capabilityType: previousAggregate.capabilityType,
    capabilityName: previousAggregate.capabilityName,
    invocationCount: 0,
    successCount: 0,
    failureCount: 0,
    eventDurationCount: 0,
    turnEstimateDurationCount: 0,
    durations: [],
    tokens: [],
  };
}

function resolveDurationBasis(aggregate: CapabilityAggregate): DurationBasis {
  if (aggregate.eventDurationCount > 0 && aggregate.turnEstimateDurationCount > 0) {
    return "mixed";
  }
  if (aggregate.eventDurationCount > 0) {
    return "event";
  }
  if (aggregate.turnEstimateDurationCount > 0) {
    return "turn_estimate";
  }

  return "none";
}

function getCurrentMetricValue(value: number | null, hasCurrentRow: boolean): number | null {
  return hasCurrentRow ? value : 0;
}

function normalizeRepoHash(repoHash: string | null): string {
  return repoHash ?? "unknown";
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
