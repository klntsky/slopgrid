import type { Model } from "./provider.js";

/** Reserve a conservative input estimate; provider tokenization remains authoritative. */
export function generationBudget(
  model: Pick<
    Model,
    "name" | "pricing" | "contextLength" | "maxCompletionTokens"
  >,
  prompt: string,
  system: string,
  dollars: number,
) {
  if (!model.pricing || !model.contextLength)
    throw new Error(
      `Pricing or token limits are unavailable for ${model.name}.`,
    );
  const inputTokens = Buffer.byteLength(prompt + system, "utf8") + 256;
  const inputCost =
    inputTokens * model.pricing.prompt + (model.pricing.request ?? 0);
  const ceiling = Math.min(
    model.maxCompletionTokens ?? model.contextLength,
    model.contextLength - inputTokens,
  );
  const maxOutputTokens = Math.floor(
    Math.min(
      ceiling,
      model.pricing.completion > 0
        ? (dollars - inputCost) / model.pricing.completion
        : ceiling,
    ),
  );
  if (dollars <= inputCost || maxOutputTokens < 1)
    throw new Error(
      `The cell budget is too small for ${model.name}. Increase it before generating.`,
    );
  return { maxOutputTokens, inputCost };
}
