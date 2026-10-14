import type { Model } from "./provider.js";
import { effectivePricing } from "./model-pricing.js";

export class PreparationError extends Error {}

/** Reserve a conservative input estimate; provider tokenization remains authoritative. */
export function generationBudget(
  model: Pick<
    Model,
    "name" | "pricing" | "contextLength" | "maxCompletionTokens"
  >,
  prompt: string,
  system: string,
  dollars: number,
  now = new Date(),
) {
  const inputTokens = new TextEncoder().encode(prompt + system).length + 256;
  if (!model.pricing || !model.contextLength) {
    const limits = [
      model.maxCompletionTokens,
      model.contextLength ? model.contextLength - inputTokens : undefined,
    ].filter((limit): limit is number => limit !== undefined && limit !== 0);
    return {
      maxOutputTokens: limits.length
        ? Math.max(1, Math.min(...limits))
        : undefined,
      inputTokens,
      pricing: model.pricing
        ? effectivePricing(model.pricing, inputTokens, now)
        : undefined,
      inputCost: undefined,
      ceiling: undefined,
      maxPrice: undefined,
    };
  }
  const pricing = effectivePricing(model.pricing, inputTokens, now);
  const inputCost = inputTokens * pricing.prompt + (pricing.request ?? 0);
  const ceiling = Math.min(
    model.maxCompletionTokens ?? model.contextLength,
    model.contextLength - inputTokens,
  );
  const maxOutputTokens = Math.floor(
    Math.min(
      ceiling,
      pricing.completion > 0
        ? (dollars - inputCost) / pricing.completion
        : ceiling,
    ),
  );
  if (!Number.isFinite(dollars) || dollars < inputCost || maxOutputTokens < 1)
    throw new PreparationError(
      `The cell budget is too small for ${model.name}. Increase it before generating.`,
    );
  return {
    maxOutputTokens,
    inputTokens,
    ceiling,
    inputCost,
    pricing,
    maxPrice: {
      prompt: pricing.prompt * 1000000,
      completion: pricing.completion * 1000000,
      ...(pricing.request !== undefined && {
        request: pricing.request,
      }),
    },
  };
}

export type TextBudget = ReturnType<typeof generationBudget>;
