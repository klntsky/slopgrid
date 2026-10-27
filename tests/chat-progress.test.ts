import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fillChatTemplate } from "../server/chat-template.js";
import { generationBudget } from "../server/generation-budget.js";
import type {
  Cell,
  FilledChatMessage,
  GenerationParameters,
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
const input: GenerationParameters = {
  model: "test",
  effort: "default",
  budgetUsd: 10,
  prompt: "",
  messages: [
    { role: "user", content: "Draw a picture" },
    { role: "unfilled", content: "" },
  ],
};
const images = [referencePngOutput("preview.png"), referencePngOutput("detail.png")];
const burstSize = 128;
type RunResult = {
  assistant: FilledChatMessage;
  usage?: Cell["usage"];
};

function burst(onChunk: (progress: InferenceProgress) => void, label: string) {
  let latest!: InferenceProgress;
  for (let index = 1; index <= burstSize; index++) {
    latest = {
      text: `${label} answer ${index}`,
      thinking: `${label} thought ${index}`,
      images,
      estimatedUsage: { inputTokens: 11, outputTokens: index, costUsd: 0.5 },
    };
    onChunk(latest);
  }
  return latest;
}

test("image progress bursts coalesce, deliver a trailing snapshot, and settle with the canonical completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const boundary = Promise.withResolvers<(progress: InferenceProgress) => void>();
  const provider = Promise.withResolvers<RunResult>();
  const snapshots: InferenceProgress[] = [];
  const completion: RunResult = {
    assistant: {
      role: "assistant",
      content: "Canonical final answer",
      images: [referencePngOutput("final.png")],
    },
    usage: { inputTokens: 17, outputTokens: 23, costUsd: 0.75 },
  };
  const pending = fillChatTemplate(
    input,
    budgetFor,
    async (_messages, _budget, onChunk) => {
      boundary.resolve(onChunk);
      return provider.promise;
    },
    (progress) => snapshots.push(progress),
  );
  const emit = await boundary.promise;
  const first = burst(emit, "first");
  const deliveredDuringBurst = snapshots.length;
  // Drain whatever cadence is chosen, without depending on its duration.
  t.mock.timers.runAll();
  await setImmediate();
  const trailing = snapshots.at(-1);
  const deliveredAfterTrailing = snapshots.length;
  const last = burst(emit, "last");
  provider.resolve(completion);
  const result = await pending;
  const deliveredAtSettlement = snapshots.length;
  t.mock.timers.runAll();
  await setImmediate();

  assert.ok(deliveredDuringBurst <= 2, "one burst must not serialize every delta");
  assert.ok(deliveredAfterTrailing <= 2, "the trailing delivery must stay bounded");
  assert.ok(trailing, "an active call must deliver its pending latest snapshot");
  assert.equal(typeof trailing.text, "string");
  assert.deepEqual(readChatOutput(trailing.text), [
    input.messages![0],
    { role: "assistant", content: first.text, images: first.images },
  ]);
  assert.equal(trailing.thinking, first.thinking);
  assert.deepEqual(trailing.estimatedUsage, first.estimatedUsage);
  assert.equal(trailing.currentCallCostUsd, 0.5);
  assert.ok(deliveredAtSettlement <= 5, "two bursts and completion need bounded snapshots");
  const final = snapshots.at(-1)!;
  assert.equal(typeof final.text, "string");
  assert.deepEqual(readChatOutput(final.text), [input.messages![0], completion.assistant]);
  assert.deepEqual(readChatOutput(result.files["messages.json"]), readChatOutput(final.text));
  assert.equal(final.thinking, last.thinking);
  assert.deepEqual(final.estimatedUsage, completion.usage);
  assert.deepEqual(result.usage, completion.usage);
  assert.equal(final.currentCallCostUsd, 0);
  assert.equal(snapshots.length, deliveredAtSettlement, "settlement must cancel pending deliveries");
});

for (const outcome of ["error", "cancellation"] as const) {
  test(`image progress flushes the latest partial history on ${outcome} and never delivers after rejection`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
    const controller = new AbortController();
    const boundary = Promise.withResolvers<(progress: InferenceProgress) => void>();
    const provider = Promise.withResolvers<RunResult>();
    const snapshots: InferenceProgress[] = [];
    const prefix: FilledChatMessage = {
      role: "assistant",
      content: "Completed first picture",
      images: [referencePngOutput("previous.png")],
    };
    const messages: GenerationParameters["messages"] = [
      ...input.messages!,
      { role: "user", content: "Draw another" },
      { role: "unfilled", content: "" },
    ];
    let calls = 0;
    let secondHistory: FilledChatMessage[] = [];
    const pending = fillChatTemplate(
      { ...input, messages },
      budgetFor,
      async (history, _budget, onChunk) => {
        calls++;
        if (calls === 1) {
          onChunk({ text: prefix.content, images: prefix.images, thinking: "First thought. " });
          return {
            assistant: prefix,
            usage: { inputTokens: 5, outputTokens: 7, costUsd: 0.25 },
          };
        }
        secondHistory = [...history];
        const abort = () => provider.reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        boundary.resolve(onChunk);
        try {
          return await provider.promise;
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
      },
      (progress) => snapshots.push(progress),
      controller.signal,
    );
    const emit = await boundary.promise;
    emit({ text: "Second picture started", images, thinking: "Starting" });
    t.mock.timers.runAll();
    await setImmediate();
    const beforeBurst = snapshots.length;
    const latest = burst(emit, outcome);
    const deliveredDuringBurst = snapshots.length - beforeBurst;
    const failure = outcome === "error"
      ? new Error("Provider stream failed")
      : new DOMException("Cancelled by caller", "AbortError");
    const rejected = assert.rejects(pending, (error) => error === failure);
    if (outcome === "error") provider.reject(failure);
    else controller.abort(failure);
    await rejected;
    const deliveredAtSettlement = snapshots.length;
    const terminal = snapshots.at(-1)!;
    t.mock.timers.runAll();
    await setImmediate();

    assert.equal(calls, 2);
    assert.deepEqual(secondHistory, [messages![0], prefix, messages![2]]);
    assert.ok(deliveredDuringBurst <= 2, "partial image bursts must coalesce before delivery");
    assert.ok(deliveredAtSettlement - beforeBurst <= 3, "rejection must flush only bounded pending snapshots");
    assert.equal(typeof terminal.text, "string");
    assert.deepEqual(readChatOutput(terminal.text), [
      ...secondHistory,
      { role: "assistant", content: latest.text, images: latest.images },
    ]);
    assert.equal(terminal.thinking, `First thought. ${latest.thinking}`);
    assert.deepEqual(terminal.estimatedUsage, {
      inputTokens: 16,
      outputTokens: 7 + burstSize,
      costUsd: 0.75,
    });
    assert.equal(terminal.currentCallCostUsd, 0.5);
    assert.equal(snapshots.length, deliveredAtSettlement, "rejection must cancel pending deliveries");
  });
}
