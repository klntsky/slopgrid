import { test } from "node:test";
import assert from "node:assert/strict";
import { generationBudget } from "../server/generation-budget.js";
import {
  estimateCell,
  estimateGrid,
  recommendWorkers,
} from "../server/cost-estimates.js";
import { parsePricing, effectivePricing } from "../server/model-pricing.js";
import type { Model } from "../server/provider.js";
import { chatText, expandGrid, type ChatMessage } from "../server/domain.js";
import { currentInput } from "./current-grid-fixture.js";

const model: Model = {
  id: "test/model",
  name: "Test",
  text: true,
  image: false,
  imageInput: false,
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
  assert.equal(budget.maxPrice?.completion, 2000);
  assert.equal(budget.inputTokens, 258);
  const freeOutput = generationBudget(
    { ...model, pricing: { prompt: 0.001, completion: 0 } },
    "",
    "",
    0.256,
  );
  assert.equal(freeOutput.maxOutputTokens, 100);
});

for (const side of ["rows", "columns"] as const) {
  test(`grid estimates resolve generator ownership from ${side}, independently of judge settings`, () => {
    const other = side === "rows" ? "columns" : "rows";
    const expensive: Model = {
      ...model,
      id: "test/expensive",
      pricing: { prompt: 0, completion: 0.002 },
    };
    const input = currentInput({
      budgetUsd: 0.15,
      judge: true,
      caseAxes: [side],
      parameters: {
        input: { kind: side },
        model: { kind: side },
        effort: { kind: other },
        judge_model: { kind: side },
      },
      [side]: [
        {
          id: "cheap",
          model: model.id,
          judge_model: expensive.id,
          input: [{ role: "user", content: "hello" }],
        },
        {
          id: "expensive",
          model: expensive.id,
          judge_model: model.id,
          input: [{ role: "user", content: "world" }],
        },
      ],
      [other]: [
        { id: "default-effort", effort: "default" },
        { id: "disabled-effort", effort: "none" },
      ],
    });
    const original = structuredClone(input);
    const result = estimateGrid(input, [model, expensive]);
    const cheap = [0.1, "supported"];
    const capped = [0.15, "unsupported"];
    assert.deepEqual(
      result.estimates.map((estimate) => [estimate.costUsd, estimate.support]),
      side === "rows"
        ? [cheap, cheap, capped, capped]
        : [cheap, capped, cheap, capped],
    );
    assert.deepEqual(
      result.input[side].map((entry) => [
        entry.id,
        entry.model,
        entry.judge_model,
      ]),
      input[side].map((entry) => [entry.id, entry.model, entry.judge_model]),
    );
    assert.deepEqual(input, original);
  });
}

test("unknown chat capacity reserves the configured inference budget instead of the non-chat fallback", () => {
  const configured = { ...cell, budgetUsd: 0.125 };
  assert.equal(estimateCell(undefined, configured, "markdown").costUsd, 3);
  assert.equal(
    estimateCell(undefined, configured, "chat-template").costUsd,
    0.125,
  );
  assert.equal(
    estimateCell({ ...model, pricing: undefined }, configured, "chat-template")
      .reason,
    "Pricing unavailable.",
  );
});

for (const finalUnfilled of [false, true]) {
  test(`single-call chat estimates include all supplied roles with ${finalUnfilled ? "one final explicit unfilled turn" : "zero explicit unfilled turns"}`, () => {
    const history: ChatMessage[] = [
      { role: "system", content: "Use UTF-8: é" },
      { role: "user", content: "First question" },
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Next question" },
    ];
    const messages: ChatMessage[] = finalUnfilled
      ? [...history, { role: "unfilled", content: "" }]
      : history;
    const priced = { ...model, pricing: { prompt: 0.001, completion: 0.001 } };
    for (const budgetUsd of [3, 0.4]) {
      const configured = {
        ...cell,
        prompt: "This stale prompt is not the inference input.",
        messages,
        budgetUsd,
      };
      const budget = generationBudget(priced, chatText(history), "", budgetUsd);
      const estimate = estimateCell(priced, configured, "chat-template");
      assert.equal(
        estimate.costUsd,
        budget.inputCost! +
          budget.maxOutputTokens! * budget.pricing!.completion,
      );
      assert.equal(
        estimate.maximumCostUsd,
        budget.inputCost! + budget.ceiling! * budget.pricing!.completion,
      );
      assert.equal(
        estimate.support,
        budget.maxOutputTokens! < budget.ceiling! ? "unsupported" : "supported",
      );
      assert.equal(
        estimate.support,
        budgetUsd === 3 ? "supported" : "unsupported",
      );
    }
  });
}

test("chat grid estimates use per-cell interpolated messages for prompt costs and context caps", () => {
  const input = currentInput({
    format: "chat-template",
    caseAxes: ["rows"],
    parameters: {
      model: { kind: "common", value: model.id },
      input: {
        kind: "common",
        value: [
          { role: "system", content: "Instructions: $ROW1" },
          { role: "user", content: "Question: $ROW1" },
          { role: "assistant", content: "Prior: $ROW1" },
          { role: "unfilled", content: "" },
        ],
      },
    },
    rows: [
      { variable: [{ text: "é" }] },
      { variable: [{ text: "x".repeat(100) }] },
    ],
  });
  const cells = expandGrid(input);
  for (const priced of [
    { ...model, pricing: { prompt: 0.001, completion: 0.001 } },
    { ...model, contextLength: 700, maxCompletionTokens: 1000 },
  ]) {
    const { estimates } = estimateGrid(input, [priced]);
    const expected = cells.map((expanded) => {
      const history = expanded.messages!.filter(
        (message) => message.role !== "unfilled",
      );
      const budget = generationBudget(
        priced,
        chatText(history),
        "",
        expanded.budgetUsd,
      );
      return (
        budget.inputCost! + budget.maxOutputTokens! * budget.pricing!.completion
      );
    });
    assert.deepEqual(
      estimates.map((estimate) => estimate.costUsd),
      expected,
    );
    assert.deepEqual(
      estimates.map((estimate) => estimate.support),
      ["supported", "supported"],
    );
    assert.notEqual(estimates[0]!.costUsd, estimates[1]!.costUsd);
  }
});

for (const implicitFinal of [false, true]) {
  test(`multi-call chat estimates reserve the full budget ${implicitFinal ? "including an implicit final call after an explicit unfilled turn" : "for explicit unfilled turns"}`, () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "First question" },
      { role: "unfilled", content: "" },
      { role: "user", content: "Next question" },
      ...(implicitFinal ? [] : [{ role: "unfilled" as const, content: "" }]),
    ];
    const configured = { ...cell, messages, budgetUsd: 0.125 };
    assert.deepEqual(estimateCell(model, configured, "chat-template"), {
      costUsd: configured.budgetUsd,
      support: "unknown",
    });
    for (const [incomplete, reason] of [
      [{ ...model, pricing: undefined }, "Pricing unavailable."],
      [{ ...model, contextLength: undefined }, "Token limits unavailable."],
      [
        { ...model, pricing: { ...model.pricing!, incomplete: true } },
        "Total cost estimate unavailable.",
      ],
    ] as const) {
      assert.deepEqual(estimateCell(incomplete, configured, "chat-template"), {
        costUsd: configured.budgetUsd,
        support: "unknown",
        reason,
      });
    }
  });
}
