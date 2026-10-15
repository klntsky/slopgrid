import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCost } from "../src/format-cost";

test("reported costs distinguish missing, zero, sub-cent and sub-precision charges", () => {
  assert.equal(formatCost(undefined), "Cost unavailable");
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.00123456), "$0.00123456");
  assert.equal(formatCost(0.00000001), "$0.00000001");
  assert.equal(formatCost(0.000000001), "<$0.00000001");
  assert.equal(formatCost(1234.567891234), "$1,234.56789123");
});
