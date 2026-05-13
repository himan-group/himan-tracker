import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAverageDurationMs,
  formatNullableNumber,
  formatSuccessRate,
  formatTable,
  formatTokenCount,
} from "../../src/reports/formatTable.js";

describe("formatTable", () => {
  it("formats rows with stable column widths", () => {
    assert.deepEqual(formatTable(["Name", "Value"], [["a", "123"]]), [
      "Name | Value",
      "---- | -----",
      "a    | 123  ",
    ]);
  });

  it("formats missing metrics as n/a", () => {
    assert.equal(formatNullableNumber(null), "n/a");
    assert.equal(formatTokenCount(null), "n/a");
    assert.equal(formatAverageDurationMs(null, 1), "n/a");
    assert.equal(formatSuccessRate(0, 0), "n/a");
  });

  it("formats token counts with compact units", () => {
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1_250), "1.25K");
    assert.equal(formatTokenCount(15_000), "15K");
    assert.equal(formatTokenCount(3_557_933), "3.56M");
    assert.equal(formatTokenCount(1_200_000_000), "1.2G");
  });
});
