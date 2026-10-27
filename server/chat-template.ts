import {
  chatText,
  type Cell,
  type GenerationParameters,
  type ChatMessage,
  type FilledChatMessage,
  type InferenceProgress,
  type TemplateStep,
} from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { sumUsage } from "./usage.js";
import { writeChatOutput } from "../shared/chat-output.js";
import { materializeChatMessages } from "./chat-messages.js";
import type { ReferenceInputs } from "./image-references.js";

export function templateSequence(messages: ChatMessage[]): ChatMessage[] {
  return messages.length && messages.at(-1)!.role !== "unfilled"
    ? [...messages, { role: "unfilled", content: "" }]
    : messages;
}

export async function fillChatTemplate(
  cell: GenerationParameters,
  budgetFor: (prompt: string, dollars: number) => TextBudget,
  run: (
    messages: FilledChatMessage[],
    budget: TextBudget,
    onChunk: (progress: InferenceProgress) => void,
  ) => Promise<{
    usage?: Cell["usage"];
    assistant: FilledChatMessage;
  }>,
  onChunk: (progress: InferenceProgress) => void,
  signal?: AbortSignal,
  references?: ReferenceInputs,
) {
  const history: FilledChatMessage[] = [];
  const templateSteps: TemplateStep[] = [];
  const sequence = templateSequence(cell.messages!);
  let remaining = cell.budgetUsd;
  let callsRemaining = sequence.filter((m) => m.role === "unfilled").length;
  let thinking = "";
  for (const message of sequence) {
    signal?.throwIfAborted();
    if (message.role !== "unfilled") {
      history.push(...materializeChatMessages([message], references));
      continue;
    }
    const prompt = chatText(history);
    const allowance = remaining / callsRemaining;
    const budget = budgetFor(prompt, allowance);
    let latest: InferenceProgress | undefined;
    let pending = false;
    let active = true;
    let emittedAt: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!active || !pending || !latest) return;
      pending = false;
      emittedAt = Date.now();
      const progress = latest;
      const messages: FilledChatMessage[] = [
        ...history,
        {
          role: "assistant",
          content: progress.text,
          ...(progress.images?.length ? { images: progress.images } : {}),
        },
      ];
      onChunk({
        text: JSON.stringify(messages, null, 2),
        thinking: thinking + progress.thinking,
        estimatedUsage: sumUsage([
          ...templateSteps.map((step) => step.usage),
          progress.estimatedUsage,
        ]),
        currentCallCostUsd: progress.estimatedUsage?.costUsd,
      });
    };
    let result: {
      usage?: Cell["usage"];
      assistant: FilledChatMessage;
    };
    try {
      result = await run(history, budget, (progress) => {
        if (!active) return;
        latest = progress;
        pending = true;
        const delay =
          emittedAt === undefined
            ? 0
            : Math.max(0, 300 - (Date.now() - emittedAt));
        if (!delay) flush();
        else if (timer === undefined) timer = setTimeout(flush, delay);
      });
      const assistant = result.assistant;
      if (!assistant || (!assistant.content.trim() && !assistant.images?.length))
        throw new Error("Missing chat completion output.");
      if (callsRemaining > 1) flush();
    } catch (error) {
      flush();
      throw error;
    } finally {
      active = false;
      clearTimeout(timer);
    }
    const assistant = result.assistant;
    const usage = result.usage;
    const costUsd =
      usage?.costUsd ??
      (budget.pricing &&
      usage?.inputTokens !== undefined &&
      usage.outputTokens !== undefined
        ? usage.inputTokens * budget.pricing.prompt +
          usage.outputTokens * budget.pricing.completion +
          (budget.pricing.request ?? 0)
        : latest?.estimatedUsage?.costUsd);
    // Reserve the allocated share if cost cannot be estimated; unknown pricing
    // still leaves the provider in control of token limits on subsequent calls.
    remaining = Math.max(0, remaining - (costUsd ?? allowance));
    templateSteps.push({
      maxOutputTokens: budget.maxOutputTokens,
      usage,
      costUsd,
    });
    callsRemaining--;
    history.push(assistant);
    thinking += latest?.thinking ?? "";
  }
  const text = JSON.stringify(history, null, 2);
  const usage = sumUsage(templateSteps.map((step) => step.usage));
  onChunk({ text, thinking, estimatedUsage: usage, currentCallCostUsd: 0 });
  return {
    files: { "messages.json": writeChatOutput(history) },
    usage,
    templateSteps,
  };
}

export function templateFits(
  steps: TemplateStep[],
  dollars: number,
  budgetFor: (inputTokens: number, dollars: number) => TextBudget,
): boolean {
  let remaining = dollars;
  return steps.every((step, index) => {
    const inputTokens = step.usage?.inputTokens;
    if (
      inputTokens === undefined ||
      !Number.isFinite(inputTokens) ||
      inputTokens < 0
    )
      return false;
    const allowance = remaining / (steps.length - index);
    const budget = budgetFor(inputTokens, allowance);
    const tokens = step.usage?.outputTokens ?? step.maxOutputTokens;
    if (
      budget.maxOutputTokens !== undefined &&
      (tokens === undefined ||
        !Number.isFinite(tokens) ||
        tokens < 0 ||
        tokens > budget.maxOutputTokens)
    )
      return false;
    if (step.costUsd !== undefined && step.costUsd > allowance) return false;
    remaining = Math.max(0, remaining - (step.costUsd ?? allowance));
    return true;
  });
}
