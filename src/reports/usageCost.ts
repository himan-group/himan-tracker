import type { BillingCycleStartDay } from "../types/config.js";
import { formatLocalDate } from "./periodFormatter.js";

export const CODEX_WEEKLY_BUDGET_USD = 75;
export const CODEX_WEEKLY_BUDGET_CREDITS = 1_875;
export const USD_PER_CREDIT = CODEX_WEEKLY_BUDGET_USD / CODEX_WEEKLY_BUDGET_CREDITS;
export const CREDITS_PER_USD = CODEX_WEEKLY_BUDGET_CREDITS / CODEX_WEEKLY_BUDGET_USD;

export type CodexModelPricing = {
  inputCreditsPerMillion: number;
  cachedInputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
  sourceModel: string;
  aliasOf?: string;
};

export type BillingCycleRange = {
  startDate: string;
  endDate: string;
};

export type CodexCostEstimate = {
  estimatedCredits: number | null;
  estimatedUsd: number | null;
  inputCredits: number | null;
  cachedInputCredits: number | null;
  outputCredits: number | null;
  pricing: CodexModelPricing | null;
  coverage: "full" | "partial" | "none";
};

const DAY_NAMES: BillingCycleStartDay[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const PRICING_BY_MODEL: Record<string, CodexModelPricing> = {
  "gpt-5.5": {
    sourceModel: "gpt-5.5",
    inputCreditsPerMillion: 125,
    cachedInputCreditsPerMillion: 12.5,
    outputCreditsPerMillion: 750,
  },
  "gpt-5.4": {
    sourceModel: "gpt-5.4",
    inputCreditsPerMillion: 62.5,
    cachedInputCreditsPerMillion: 6.25,
    outputCreditsPerMillion: 375,
  },
  "gpt-5.4-mini": {
    sourceModel: "gpt-5.4-mini",
    inputCreditsPerMillion: 18.75,
    cachedInputCreditsPerMillion: 1.875,
    outputCreditsPerMillion: 113,
  },
  "gpt-5.3-codex": {
    sourceModel: "gpt-5.3-codex",
    inputCreditsPerMillion: 43.75,
    cachedInputCreditsPerMillion: 4.375,
    outputCreditsPerMillion: 350,
  },
  "gpt-5.2": {
    sourceModel: "gpt-5.2",
    inputCreditsPerMillion: 43.75,
    cachedInputCreditsPerMillion: 4.375,
    outputCreditsPerMillion: 350,
  },
  "gpt-5.1-codex": {
    sourceModel: "gpt-5.1-codex",
    inputCreditsPerMillion: 43.75,
    cachedInputCreditsPerMillion: 4.375,
    outputCreditsPerMillion: 350,
    aliasOf: "gpt-5.2",
  },
};

export function listBillingCycleStartDays(): BillingCycleStartDay[] {
  const days = [...DAY_NAMES];
  days.push(days.shift()!);
  return days;
}

export function parseBillingCycleStartDay(
  value: string | null | undefined,
  fallback: BillingCycleStartDay = "wednesday",
): BillingCycleStartDay {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return DAY_NAMES.find((day) => day === normalized) ?? fallback;
}

export function formatBillingCycleStartDay(day: BillingCycleStartDay): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

export function getBillingCycleRange(date: Date, startsOn: BillingCycleStartDay): BillingCycleRange {
  const start = startOfLocalDay(date);
  const startDay = DAY_NAMES.indexOf(startsOn);
  const dayOffset = (start.getDay() - startDay + 7) % 7;
  start.setDate(start.getDate() - dayOffset);

  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  return {
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
  };
}

export function resolveCodexModelPricing(model: string | null | undefined): CodexModelPricing | null {
  if (!model) {
    return null;
  }

  const normalized = model.trim().toLowerCase();
  const exact = PRICING_BY_MODEL[normalized];
  if (exact) {
    return exact;
  }

  for (const candidate of Object.keys(PRICING_BY_MODEL).sort((left, right) => right.length - left.length)) {
    if (normalized.startsWith(`${candidate}-`)) {
      return PRICING_BY_MODEL[candidate] ?? null;
    }
  }

  return null;
}

export function estimateCodexCost(input: {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  cachedInputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
}): CodexCostEstimate {
  const pricing = resolveCodexModelPricing(input.model);
  if (!pricing) {
    return {
      estimatedCredits: null,
      estimatedUsd: null,
      inputCredits: null,
      cachedInputCredits: null,
      outputCredits: null,
      pricing: null,
      coverage: "none",
    };
  }

  const hasInput = typeof input.inputTokens === "number";
  const hasCachedInput = typeof input.cachedInputTokens === "number";
  const hasOutput = typeof input.outputTokens === "number";
  if (!hasInput && !hasOutput) {
    return {
      estimatedCredits: null,
      estimatedUsd: null,
      inputCredits: null,
      cachedInputCredits: null,
      outputCredits: null,
      pricing,
      coverage: "none",
    };
  }

  const cachedInputTokens = hasCachedInput ? Math.max(input.cachedInputTokens ?? 0, 0) : null;
  const uncachedInputTokens = hasInput
    ? Math.max((input.inputTokens ?? 0) - (cachedInputTokens ?? 0), 0)
    : null;
  const inputCredits = uncachedInputTokens !== null
    ? (uncachedInputTokens / 1_000_000) * pricing.inputCreditsPerMillion
    : null;
  const cachedInputCredits = cachedInputTokens !== null
    ? (cachedInputTokens / 1_000_000) * pricing.cachedInputCreditsPerMillion
    : null;
  const outputCredits = hasOutput
    ? ((input.outputTokens ?? 0) / 1_000_000) * pricing.outputCreditsPerMillion
    : null;
  const estimatedCredits = (inputCredits ?? 0) + (cachedInputCredits ?? 0) + (outputCredits ?? 0);

  return {
    estimatedCredits,
    estimatedUsd: creditsToUsd(estimatedCredits),
    inputCredits,
    cachedInputCredits,
    outputCredits,
    pricing,
    coverage: hasInput && hasCachedInput && hasOutput ? "full" : "partial",
  };
}

export function creditsToUsd(credits: number): number {
  return credits * USD_PER_CREDIT;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
