import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CODEX_WEEKLY_BUDGET_CREDITS,
  CODEX_WEEKLY_BUDGET_USD,
  creditsToUsd,
  estimateCodexCost,
  getBillingCycleRange,
  parseBillingCycleStartDay,
  resolveCodexModelPricing,
} from "../../src/reports/usageCost.js";

describe("usageCost", () => {
  it("defaults billing cycle to wednesday", () => {
    assert.equal(parseBillingCycleStartDay(null), "wednesday");
    assert.equal(parseBillingCycleStartDay("MONDAY"), "monday");
    assert.equal(parseBillingCycleStartDay("invalid"), "wednesday");
  });

  it("computes custom weekly cycle ranges", () => {
    const date = new Date("2026-05-12T13:00:00.000Z");

    assert.deepEqual(getBillingCycleRange(date, "wednesday"), {
      startDate: "2026-05-06",
      endDate: "2026-05-12",
    });
    assert.deepEqual(getBillingCycleRange(date, "monday"), {
      startDate: "2026-05-11",
      endDate: "2026-05-17",
    });
  });

  it("prices known codex models and legacy aliases", () => {
    assert.equal(resolveCodexModelPricing("gpt-5.5")?.outputCreditsPerMillion, 750);
    assert.equal(resolveCodexModelPricing("gpt-5.4-mini-2026-05-01")?.inputCreditsPerMillion, 18.75);
    assert.equal(resolveCodexModelPricing("gpt-5.1-codex")?.aliasOf, "gpt-5.2");
    assert.equal(resolveCodexModelPricing("unknown-model"), null);
  });

  it("estimates credits from input and output token splits", () => {
    const estimate = estimateCodexCost({
      model: "gpt-5.3-codex",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });

    assert.equal(estimate.coverage, "full");
    assert.equal(estimate.estimatedCredits, 218.75);
    assert.equal(estimate.estimatedUsd, creditsToUsd(218.75));
  });

  it("marks missing token splits as partial or none", () => {
    const partial = estimateCodexCost({
      model: "gpt-5.5",
      inputTokens: 500_000,
      outputTokens: null,
    });
    const none = estimateCodexCost({
      model: "gpt-5.5",
      inputTokens: null,
      outputTokens: null,
    });

    assert.equal(partial.coverage, "partial");
    assert.equal(partial.estimatedCredits, 62.5);
    assert.equal(none.coverage, "none");
    assert.equal(none.estimatedCredits, null);
  });

  it("keeps codex budget constants aligned", () => {
    assert.equal(creditsToUsd(CODEX_WEEKLY_BUDGET_CREDITS), CODEX_WEEKLY_BUDGET_USD);
  });
});
