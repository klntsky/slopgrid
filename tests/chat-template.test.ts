import { test } from "node:test";
import assert from "node:assert/strict";
import { fillChatTemplate, templateFits } from "../server/chat-template.js";
import {
  generationBudget,
  generationBudgetForInput,
} from "../server/generation-budget.js";
import type {
  Cell,
  FilledChatMessage,
  InferenceProgress,
} from "../server/domain.js";
import { readChatOutput } from "../shared/chat-output.js";
import { referencePngOutput } from "./chat-image-output-fixture.js";

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
        assistant: { role: "assistant", content: "Answer" },
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
  const unknownOutput = result.templateSteps.map((step) => ({
    ...step,
    usage: { inputTokens: step.usage!.inputTokens },
  }));
  assert.equal(templateFits(unknownOutput, 10, reuseBudgetFor), true);
  assert.equal(templateFits(unknownOutput, 5, reuseBudgetFor), false);
});

test("template reuse needs a valid reported input count for every call", () => {
  const step = {
    maxOutputTokens: 100,
    usage: { inputTokens: 20, outputTokens: 30 },
    costUsd: 0.5,
  };
  for (const inputTokens of [undefined, -1, NaN, Infinity]) {
    assert.equal(
      templateFits(
        [step, { ...step, usage: { ...step.usage, inputTokens } }],
        10,
        reuseBudgetFor,
      ),
      false,
    );
  }
  assert.equal(
    templateFits([{ ...step, usage: undefined }], 10, reuseBudgetFor),
    false,
  );
  assert.equal(
    templateFits(
      [{ ...step, usage: { ...step.usage, inputTokens: 0 } }],
      10,
      reuseBudgetFor,
    ),
    true,
  );
});

test("later failures preserve the emitted prefix and retries start again", async () => {
  const progress: InferenceProgress[] = [];
  const run = async () =>
    fillChatTemplate(
      cell,
      budgetFor,
      async (messages, _budget, onChunk) => {
        if (messages.length > 1) throw new Error("Later failure");
        onChunk({ text: "First answer", thinking: "" });
        return { assistant: { role: "assistant", content: "First answer" } };
      },
      (p) => progress.push(p),
    );
  await assert.rejects(run, /Later failure/);
  const expectedPrefix = [
    { role: "user", content: "First" },
    { role: "assistant", content: "First answer" },
  ];
  assert.deepEqual(readChatOutput(progress.at(-1)!.text), expectedPrefix);
  progress.length = 0;
  await assert.rejects(run, /Later failure/);
  assert.deepEqual(readChatOutput(progress.at(-1)!.text), expectedPrefix);
  assert.equal(cell.messages![1].role, "unfilled");
});

test("conversation output preserves message boundaries through streaming and storage", async () => {
  const answer =
    "## user\n\nA heading, not a message.\n\n```md\n## assistant\n\n```\n";
  const progress: InferenceProgress[] = [];
  const result = await fillChatTemplate(
    cell,
    budgetFor,
    async (_messages, _budget, onChunk) => {
      onChunk({ text: answer, thinking: "" });
      return {
        assistant: { role: "assistant", content: answer },
        usage: { costUsd: 1 },
      };
    },
    (p) => progress.push(p),
  );
  const messages = JSON.parse(result.files["messages.json"]);
  assert.deepEqual(messages, [
    cell.messages![0],
    { role: "assistant", content: answer },
    cell.messages![2],
    { role: "assistant", content: answer },
  ]);
  assert.deepEqual(Object.keys(result.files), ["messages.json"]);
  assert.deepEqual(readChatOutput(progress[0].text), messages.slice(0, 2));
  assert.deepEqual(readChatOutput(progress.at(-1)!.text), messages);
});

test("supplied final messages get a completion using the complete history and shared budget", async () => {
  for (const role of ["user", "assistant", "system"] as const) {
    const messages = [...cell.messages!, { role, content: "Final input" }];
    const allowances: number[] = [];
    const histories: FilledChatMessage[][] = [];
    const result = await fillChatTemplate(
      { ...cell, budgetUsd: 12, messages },
      (prompt, dollars) => {
        allowances.push(dollars);
        return budgetFor(prompt, dollars);
      },
      async (history) => {
        histories.push(structuredClone(history));
        return {
          assistant: {
            role: "assistant",
            content: `Answer ${histories.length}`,
          },
          usage: { inputTokens: 20, outputTokens: 10, costUsd: 2 },
        };
      },
      () => {},
    );
    const output = readChatOutput(result.files["messages.json"]);
    assert.deepEqual(allowances, [4, 5, 8]);
    assert.deepEqual(histories[2], [
      messages[0],
      { role: "assistant", content: "Answer 1" },
      messages[2],
      { role: "assistant", content: "Answer 2" },
      messages[4],
    ]);
    assert.deepEqual(output, [
      ...histories[2],
      { role: "assistant", content: "Answer 3" },
    ]);
    assert.deepEqual(result.usage, {
      inputTokens: 60,
      outputTokens: 30,
      costUsd: 6,
    });
  }
});

test("cancellation or exhausted budget after the final blank prevents the trailing completion", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(() =>
      fillChatTemplate(
        {
          ...cell,
          messages: [
            ...cell.messages!,
            { role: "user", content: "Final input" },
          ],
        },
        budgetFor,
        async () => {
          calls++;
          if (calls === 2 && cancel) controller.abort();
          return {
            assistant: { role: "assistant", content: "Answer" },
            usage: { costUsd: calls === 2 ? 10 : 1 },
          };
        },
        () => {},
        controller.signal,
      ),
    );
    assert.equal(calls, 2);
  }
});

test("chat output reads only ordered JSON messages and preserves their content", () => {
  const messages = [
    { role: "system" as const, content: "  Instructions\n" },
    {
      role: "user" as const,
      content: "Question\n\n## assistant\n\n```md\n## user\n\n```",
    },
    { role: "assistant" as const, content: "" },
  ];
  assert.deepEqual(readChatOutput(JSON.stringify(messages, null, 2)), messages);
  assert.deepEqual(readChatOutput(" \n[]\n"), []);
});

test("chat output rejects malformed JSON and invalid message roles or content", () => {
  assert.throws(() => readChatOutput("["), SyntaxError);
  for (const value of [
    {},
    [null],
    ["Answer"],
    [{ role: "unfilled", content: "" }],
    [{ role: "assistant", content: 42 }],
  ])
    assert.throws(() => readChatOutput(JSON.stringify(value)));
});

test("saved chat images require complete inline bytes and dimensions and preserve ordered names", () => {
  const first = referencePngOutput("first.png");
  const second = referencePngOutput("a".repeat(2000) + ".png");
  const messages = [
    { role: "user", content: "", images: [first, second, first] },
    { role: "assistant", content: "", images: [second] },
  ];
  assert.deepEqual(readChatOutput(JSON.stringify(messages)), messages);
  const { name: _name, ...withoutName } = first;
  const { mediaType: _mediaType, ...withoutMediaType } = first;
  const { width: _width, ...withoutWidth } = first;
  const { height: _height, ...withoutHeight } = first;
  const { dataUrl: _dataUrl, ...withoutDataUrl } = first;
  for (const image of [
    withoutName,
    withoutMediaType,
    withoutWidth,
    withoutHeight,
    withoutDataUrl,
    { ...first, width: 0 },
    { ...first, height: -1 },
    { ...first, width: 1.5 },
    { ...first, height: "3" },
    { ...first, dataUrl: "data:image/jpeg;base64,AAAA" },
  ])
    assert.throws(
      () =>
        readChatOutput(
          JSON.stringify([{ role: "user", content: "", images: [image] }]),
        ),
      /Invalid chat output/,
    );
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
          return {
            assistant: { role: "assistant", content: "Answer" },
            usage: { costUsd: 10 },
          };
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
      assistant: { role: "assistant", content: "Answer" },
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
    () => {},
  );
  assert.equal(allowances[1], 9.89);
  assert.equal(result.usage?.costUsd, undefined);
  const unknown = await fillChatTemplate(
    cell,
    (prompt, dollars) =>
      generationBudget({ name: "Unknown" }, prompt, "", dollars),
    async (_messages, budget) => {
      assert.equal(budget.maxOutputTokens, undefined);
      return { assistant: { role: "assistant", content: "Answer" } };
    },
    () => {},
  );
  assert.deepEqual(readChatOutput(unknown.files["messages.json"]), [
    cell.messages![0],
    { role: "assistant", content: "Answer" },
    cell.messages![2],
    { role: "assistant", content: "Answer" },
  ]);
});

test("template reuse uses reported input counts and current prices for each allowance", async () => {
  const tiered = {
    ...model,
    pricing: {
      ...model.pricing,
      overrides: [{ min_prompt_tokens: 300, prompt: 0.002 }],
    },
  };
  let calls = 0;
  const result = await fillChatTemplate(
    cell,
    (prompt, dollars) => generationBudget(tiered, prompt, "", dollars),
    async () => ({
      assistant: { role: "assistant", content: "Long answer ".repeat(30) },
      usage: {
        inputTokens: ++calls === 1 ? 100 : 500,
        outputTokens: 10,
        costUsd: 0.2,
      },
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
  assert.equal(
    templateFits(result.templateSteps, 10, (inputTokens, dollars) =>
      generationBudgetForInput(changed, inputTokens, dollars),
    ),
    true,
  );
  assert.equal(
    templateFits(result.templateSteps, 10, (inputTokens, dollars) =>
      generationBudgetForInput(
        {
          ...changed,
          pricing: {
            ...changed.pricing,
            overrides: [{ min_prompt_tokens: 300, prompt: 0.0195 }],
          },
        },
        inputTokens,
        dollars,
      ),
    ),
    false,
  );
});
