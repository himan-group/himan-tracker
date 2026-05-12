import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAverageDurationMs,
  formatNullableNumber,
  formatSuccessRate,
  formatTable,
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
    assert.equal(formatAverageDurationMs(null, 1), "n/a");
    assert.equal(formatSuccessRate(0, 0), "n/a");
  });
});
