import { test } from "node:test";
import assert from "node:assert/strict";
import { generationBudget } from "../server/generation-budget.js";
import { estimateCell, recommendWorkers } from "../server/cost-estimates.js";
import { parsePricing, effectivePricing } from "../server/model-pricing.js";
import type { Model } from "../server/provider.js";

const model: Model = {
  id: "test/model",
  name: "Test",
  text: true,
  image: false,
  reasoning: false,
  reasoningMandatory: false,
  pricing: { prompt: 0, completion: 0.001 },
  contextLength: 10000,
  maxCompletionTokens: 100,
};
const cell = { model: model.id, prompt: "hello", budgetUsd: 3 };

test("cell estimates use actual token ceilings and retain the $3 fallback independently", () => {
  const cheap = estimateCell(model, cell, "markdown");
  assert.equal(cheap.costUsd, 0.1);
  assert.equal(cheap.support, "supported");
  const capped = estimateCell(
    { ...model, maxCompletionTokens: 5000 },
    cell,
    "markdown",
  );
  assert.equal(capped.costUsd, 3);
  assert.equal(capped.maximumCostUsd, 5);
  assert.equal(capped.support, "unsupported");
  for (const unknown of [
    undefined,
    { ...model, pricing: undefined },
    { ...model, maxCompletionTokens: undefined },
    { ...model, pricing: { ...model.pricing!, incomplete: true } },
  ]) {
    assert.equal(estimateCell(unknown, cell, "markdown").costUsd, 3);
    assert.equal(estimateCell(unknown, cell, "markdown").support, "unknown");
  }
  assert.equal(
    estimateCell(model, { ...cell, prompt: "x".repeat(11000) }, "markdown")
      .costUsd,
    3,
  );
  assert.equal(recommendWorkers(3.2, [0.1, 3, 0.1, 0.1]), 3);
  assert.equal(recommendWorkers(1, [0.6, 0.1, 0.1, 0.1]), 4);
  assert.equal(recommendWorkers(1, [0.1, 2, 0]), 1);
  assert.equal(recommendWorkers(0, [0, 0, 0]), 3);
  assert.equal(recommendWorkers(null, [0.1, 0.1]), 1);
  assert.equal(recommendWorkers(-1, [0.1]), 1);
});

test("pricing preserves zero, rejects sentinels, and applies thresholds and UTC schedules", () => {
  assert.equal(parsePricing({ prompt: "-1", completion: "-1" }), undefined);
  assert.equal(parsePricing({ prompt: null, completion: "0" }), undefined);
  const pricing = parsePricing({
    prompt: "0",
    completion: "0.001",
    overrides: [
      { min_prompt_tokens: 100, prompt: "0.002" },
      {
        utc_start: 2300,
        utc_end: 100,
        utc_days: ["monday"],
        completion: "0.003",
      },
      { min_prompt_tokens: 100, prompt: "0.004" },
      { unknown_condition: true, completion: "99" },
    ],
  })!;
  assert.equal(
    effectivePricing(pricing, 100, new Date("2026-10-12T23:30:00Z")).prompt,
    0,
  );
  const peak = effectivePricing(pricing, 101, new Date("2026-10-12T23:30:00Z"));
  assert.equal(peak.prompt, 0.004);
  assert.equal(peak.completion, 0.003);
  assert.equal(pricing.incomplete, true);
  assert.equal(
    effectivePricing(pricing, 101, new Date("2026-10-13T00:30:00Z")).completion,
    0.001,
  );
  assert.equal(
    effectivePricing(pricing, 101, new Date("2026-10-12T01:00:00Z")).completion,
    0.001,
  );
  assert.equal(
    parsePricing({ prompt: "0", completion: "0", web_search: "0.01" }, true)!
      .incomplete,
    true,
  );
  assert.equal(
    parsePricing({ prompt: "0", completion: "0", web_search: "0.01" })!
      .incomplete,
    undefined,
  );
});

test("generation and estimates share effective pricing, UTF-8 input, and free output boundaries", () => {
  const pricing = parsePricing({
    prompt: "0",
    completion: "0.001",
    overrides: [{ min_prompt_tokens: 256, completion: "0.002" }],
  })!;
  const budget = generationBudget({ ...model, pricing }, "é", "", 0.1);
  assert.equal(budget.maxOutputTokens, 50);
  assert.equal(budget.maxPrice.completion, 2000);
  assert.equal(budget.inputTokens, 258);
  const freeOutput = generationBudget(
    { ...model, pricing: { prompt: 0.001, completion: 0 } },
    "",
    "",
    0.256,
  );
  assert.equal(freeOutput.maxOutputTokens, 100);
});
