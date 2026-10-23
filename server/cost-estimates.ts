import { chatText, expandGrid, type Cell, type GridInput } from "./domain.js";
import { templateSequence } from "./chat-template.js";
import { generationBudget, PreparationError } from "./generation-budget.js";
import { instruction } from "./generation-instructions.js";
import { prepareGridModels } from "./model-resolution.js";
import { ModelResolutionError } from "./model-alias.js";
import type { Model } from "./provider.js";

export type CostEstimate = {
  costUsd: number;
  maximumCostUsd?: number;
  support: "supported" | "unsupported" | "unknown";
  reason?: string;
};
const dollars = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 6, useGrouping: false });

export function estimateCell(
  model: Model | undefined,
  cell: Pick<Cell, "prompt" | "budgetUsd" | "messages">,
  format: GridInput["format"],
  now = new Date(),
): CostEstimate {
  const unknown = (reason: string): CostEstimate => ({
    costUsd: format === "chat-template" ? cell.budgetUsd : 3,
    support: "unknown",
    reason,
  });
  if (!model?.pricing) return unknown("Pricing unavailable.");
  if (!model.contextLength || !model.maxCompletionTokens)
    return unknown("Token limits unavailable.");
  if (model.pricing.incomplete)
    return unknown("Total cost estimate unavailable.");
  let prompt = cell.prompt;
  if (format === "chat-template") {
    if (!cell.messages?.length)
      return unknown("Total cost estimate unavailable.");
    const sequence = templateSequence(cell.messages);
    // Later requests contain answers whose lengths are unknown before generation.
    // Reserve the whole attempt budget, including any implicit final call.
    if (sequence.filter((message) => message.role === "unfilled").length > 1)
      return { costUsd: cell.budgetUsd, support: "unknown" };
    prompt = chatText(
      sequence.slice(
        0,
        sequence.findIndex((message) => message.role === "unfilled"),
      ),
    );
  }
  try {
    const budget = generationBudget(
      model,
      prompt,
      format === "chat-template" ? "" : instruction(format),
      cell.budgetUsd,
      now,
    );
    if (budget.inputCost === undefined)
      return unknown("Token limits unavailable.");
    const maximumCostUsd =
      budget.inputCost + budget.ceiling * budget.pricing.completion;
    const reduced = budget.maxOutputTokens < budget.ceiling;
    return {
      costUsd:
        budget.inputCost + budget.maxOutputTokens * budget.pricing.completion,
      maximumCostUsd,
      support: reduced ? "unsupported" : "supported",
      ...(reduced
        ? {
            reason: `The max cost you specified ($${dollars(cell.budgetUsd)}) is lower than the cost of this model's available max_output_tokens at the current price ($${dollars(maximumCostUsd)}). This causes slopgrid to set max_output_tokens for an inference call to a lower value than what the model supports, effectively increasing the chance of a failure due to insufficient tokens to produce a response. Consider increasing your inference cost limit: model providers charge for failed requests anyway.`,
          }
        : {}),
    };
  } catch (error) {
    if (!(error instanceof PreparationError)) throw error;
    return unknown(error.message);
  }
}

export function estimateGrid(
  input: GridInput,
  models: readonly Model[],
  now = new Date(),
) {
  let resolved = input;
  let cells: Omit<Cell, "id">[] | undefined;
  try {
    const prepared = prepareGridModels(input, models);
    resolved = prepared.input;
    cells = prepared.cells;
  } catch (error) {
    if (!(error instanceof ModelResolutionError)) throw error;
  }
  const byId = new Map(models.map((model) => [model.id, model]));
  return {
    input: resolved,
    estimates: (cells ?? expandGrid(resolved)).map((cell) =>
      estimateCell(byId.get(cell.model), cell, input.format, now),
    ),
  };
}

export function recommendWorkers(
  balanceUsd: number | null,
  costs: readonly number[],
) {
  if (balanceUsd === null) return 1;
  let total = 0,
    count = 0;
  for (const cost of costs) {
    const next = total + cost;
    // Ignore floating-point summation noise at an exact dollar boundary.
    if (
      next - balanceUsd >
      Number.EPSILON *
        Math.max(1, Math.abs(next), Math.abs(balanceUsd)) *
        (count + 2)
    )
      break;
    total = next;
    count++;
  }
  return Math.max(1, count);
}
