import {
  chatText,
  type Cell,
  type FilledChatMessage,
  type InferenceProgress,
  type TemplateStep,
} from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { sumUsage } from "./usage.js";

export function chatTranscript(messages: FilledChatMessage[]): string {
  return messages
    .map(({ role, content }) => `## ${role}\n\n${content}`)
    .join("\n\n");
}

export async function fillChatTemplate(
  cell: Cell,
  budgetFor: (prompt: string, dollars: number) => TextBudget,
  run: (
    messages: FilledChatMessage[],
    budget: TextBudget,
    onChunk: (progress: InferenceProgress) => void,
  ) => Promise<{
    files: Record<string, string | Uint8Array>;
    usage?: Cell["usage"];
  }>,
  onChunk: (progress: InferenceProgress) => void,
  signal?: AbortSignal,
) {
  const history: FilledChatMessage[] = [];
  const templateSteps: TemplateStep[] = [];
  let remaining = cell.budgetUsd;
  let blanks = cell.messages!.filter((m) => m.role === "unfilled").length;
  let thinking = "";
  for (const message of cell.messages!) {
    signal?.throwIfAborted();
    if (message.role !== "unfilled") {
      history.push({ ...message, role: message.role });
      continue;
    }
    const prompt = chatText(history);
    const allowance = remaining / blanks;
    const budget = budgetFor(prompt, allowance);
    let latest: InferenceProgress | undefined;
    const result = await run(history, budget, (progress) => {
      latest = progress;
      onChunk({
        text: chatTranscript([
          ...history,
          { role: "assistant", content: progress.text },
        ]),
        thinking: thinking + progress.thinking,
        estimatedUsage: sumUsage([
          ...templateSteps.map((step) => step.usage),
          progress.estimatedUsage,
        ]),
        currentCallCostUsd: progress.estimatedUsage?.costUsd,
      });
    });
    const content = result.files["index.md"];
    if (typeof content !== "string")
      throw new Error("Missing chat completion output.");
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
    blanks--;
    history.push({ role: "assistant", content });
    thinking += latest?.thinking ?? "";
  }
  const text = chatTranscript(history);
  const usage = sumUsage(templateSteps.map((step) => step.usage));
  onChunk({ text, thinking, estimatedUsage: usage, currentCallCostUsd: 0 });
  return { files: { "index.md": text }, usage, templateSteps };
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
