import { test } from "node:test";
import assert from "node:assert/strict";
import { gridCost } from "../src/grid/cost-summary.js";

function complete(costUsd?: number) {
  return {
    outputReady: true,
    status: "complete" as const,
    usage: { inputTokens: 1, outputTokens: 1, costUsd },
  };
}

function running(costUsd?: number) {
  return {
    outputReady: false,
    status: "running" as const,
    estimatedUsage: { inputTokens: 1, outputTokens: 1, costUsd },
  };
}

// Distinct branches: every charge reported, some charges missing, no charge
// known, running estimates, and cells that contribute nothing yet.
test("grid cost marks a total that leaves out unreported charges", () => {
  const reported = gridCost([complete(0.01), complete(0.02)]);
  assert.equal(reported.text, "$0.03");
  assert.equal(reported.approximate, false);

  const partial = gridCost([
    complete(0.01),
    complete(undefined),
    complete(0.02),
  ]);
  assert.equal(partial.text, "$0.03+");
  assert.ok(Math.abs(partial.total! - 0.03) < 1e-9);

  const unreported = gridCost([complete(undefined)]);
  assert.equal(unreported.total, undefined);
  assert.equal(unreported.text, "Cost unavailable");

  const estimate = gridCost([complete(0.01), running(0.02)]);
  assert.equal(estimate.text, "≈$0.03");
  assert.equal(estimate.approximate, true);

  const estimateWithoutCharge = gridCost([complete(0.01), running(undefined)]);
  assert.equal(estimateWithoutCharge.text, "$0.01+");

  const idle = gridCost([
    { outputReady: false, status: "pending" },
    { outputReady: false, status: "error" },
  ]);
  assert.equal(idle.total, 0);
  assert.equal(idle.text, "$0.00");
});
