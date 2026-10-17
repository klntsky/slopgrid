import { test } from "node:test";
import assert from "node:assert/strict";
import { fillChatTemplate, templateFits } from "../server/chat-template.js";
import {
  generationBudget,
  generationBudgetForInput,
} from "../server/generation-budget.js";
import type { Cell, InferenceProgress } from "../server/domain.js";

const model = {
  name: "Test",
  pricing: { prompt: 0.001, completion: 0.01 },
  contextLength: 10000,
  maxCompletionTokens: 1000,
};
const budgetFor = (prompt: string, dollars: number) =>
  generationBudget(model, prompt, "", dollars);
const reuseBudgetFor = (inputTokens: number, dollars: number) =>
  generationBudgetForInput(model, inputTokens, dollars);
const cell: Cell = {
  id: "test",
  row: 0,
  column: 0,
  model: "test",
  effort: "default",
  budgetUsd: 10,
  status: "running",
  prompt: "",
  messages: [
    { role: "user", content: "First" },
    { role: "unfilled", content: "" },
    { role: "user", content: "Second" },
    { role: "unfilled", content: "" },
  ],
};

test("template budgets use actual prefixes and remaining allowance, and reuse checks every step", async () => {
  const allowances: number[] = [];
  const prompts: string[] = [];
  const progress: InferenceProgress[] = [];
  const result = await fillChatTemplate(
    cell,
    (prompt, dollars) => {
      allowances.push(dollars);
      prompts.push(prompt);
      return budgetFor(prompt, dollars);
    },
    async (_messages, _budget, onChunk) => {
      onChunk({
        text: "Answer",
        thinking: "Thought",
        estimatedUsage: { costUsd: 3 },
      });
      return {
        files: { "index.md": "Answer" },
        usage: { inputTokens: 20, outputTokens: 30, costUsd: 2 },
      };
    },
    (p) => progress.push(p),
  );
  assert.deepEqual(allowances, [5, 8]);
  assert.deepEqual(prompts, [
    "user: First",
    "user: First\n\nassistant: Answer\n\nuser: Second",
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 40,
    outputTokens: 60,
    costUsd: 4,
  });
  assert.equal(progress.at(-1)!.thinking, "ThoughtThought");
  assert.equal(templateFits(result.templateSteps, 10, reuseBudgetFor), true);
  assert.equal(templateFits(result.templateSteps, 1, reuseBudgetFor), false);
  const unknown = result.templateSteps.map((step) => ({
    ...step,
    usage: undefined,
  }));
  assert.equal(templateFits(unknown, 10, reuseBudgetFor), true);
  assert.equal(templateFits(unknown, 5, reuseBudgetFor), false);
  assert.equal(JSON.stringify(result.templateSteps).includes("Answer"), false);
  assert.equal(
    result.templateSteps[1].inputTokens,
    budgetFor(prompts[1], 8).inputTokens,
  );
});

test("later failures preserve the emitted prefix and retries start again", async () => {
  const progress: InferenceProgress[] = [];
  let calls = 0;
  const run = async () =>
    fillChatTemplate(
      cell,
      budgetFor,
      async (messages, _budget, onChunk) => {
        calls++;
        if (messages.length > 1) throw new Error("Later failure");
        onChunk({ text: "First answer", thinking: "" });
        return { files: { "index.md": "First answer" } };
      },
      (p) => progress.push(p),
    );
  await assert.rejects(run, /Later failure/);
  assert.match(progress.at(-1)!.text, /First answer/);
  await assert.rejects(run, /Later failure/);
  assert.equal(calls, 4);
  assert.equal(cell.messages![1].role, "unfilled");
});

test("cancellation and exhausted shared budget prevent subsequent calls", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(() =>
      fillChatTemplate(
        cell,
        budgetFor,
        async () => {
          calls++;
          if (cancel) controller.abort();
          return { files: { "index.md": "Answer" }, usage: { costUsd: 10 } };
        },
        () => {},
        controller.signal,
      ),
    );
    assert.equal(calls, 1);
  }
});

test("missing reported cost uses token estimates and unknown metadata keeps provider defaults", async () => {
  const allowances: number[] = [];
  const result = await fillChatTemplate(
    cell,
    (prompt, dollars) => {
      allowances.push(dollars);
      return budgetFor(prompt, dollars);
    },
    async () => ({
      files: { "index.md": "Answer" },
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
    () => {},
  );
  assert.equal(allowances[1], 9.89);
  assert.equal(result.usage?.costUsd, undefined);
  let calls = 0;
  await fillChatTemplate(
    cell,
    (prompt, dollars) =>
      generationBudget({ name: "Unknown" }, prompt, "", dollars),
    async (_messages, budget) => {
      calls++;
      assert.equal(budget.maxOutputTokens, undefined);
      return { files: { "index.md": "Answer" } };
    },
    () => {},
  );
  assert.equal(calls, 2);
});

test("template reuse rejects changed pricing on later prefixes even when the first call is unchanged", async () => {
  const tiered = {
    ...model,
    pricing: {
      ...model.pricing,
      overrides: [{ min_prompt_tokens: 300, prompt: 0.002 }],
    },
  };
  const result = await fillChatTemplate(
    cell,
    (prompt, dollars) => generationBudget(tiered, prompt, "", dollars),
    async () => ({
      files: { "index.md": "Long answer ".repeat(30) },
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.2 },
    }),
    () => {},
  );
  const changed = {
    ...tiered,
    pricing: {
      ...tiered.pricing,
      overrides: [{ min_prompt_tokens: 300, prompt: 0.003 }],
    },
  };
  assert.deepEqual(
    generationBudget(tiered, "user: First", "", 5).maxPrice,
    generationBudget(changed, "user: First", "", 5).maxPrice,
  );
  assert.equal(
    templateFits(result.templateSteps, 10, (inputTokens, dollars) =>
      generationBudgetForInput(changed, inputTokens, dollars),
    ),
    false,
  );
});
