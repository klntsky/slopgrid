import {
  chatText,
  type GenerationParameters,
  type GridInput,
  type InferenceProgress,
  type TemplateStep,
} from "./domain.js";
import type { Provider } from "./provider.js";
import type { ReferenceInputs } from "./image-references.js";
import type { InferenceContext } from "./inference.js";
import { generationBudget, PreparationError } from "./generation-budget.js";
import {
  prepareTextInference,
  templateSignature,
} from "./prepared-inference.js";
import { fillChatTemplate } from "./chat-template.js";
import type { ReplayDetails } from "./chat-messages.js";

export type AttemptResult = Awaited<ReturnType<Provider["generate"]>> & {
  templateSteps?: TemplateStep[];
};

// Jobs owns the lifetime of an attempt. Its request context applies to every
// provider call, including calls reached after an earlier response completes.
export async function generateAttempt(
  provider: Provider,
  key: string,
  format: GridInput["format"],
  cell: GenerationParameters,
  taskId: string,
  onChunk: (progress: InferenceProgress) => void,
  context: InferenceContext,
  references?: ReferenceInputs,
): Promise<AttemptResult> {
  if (format !== "chat-template")
    return provider.generate(
      key,
      format,
      cell,
      onChunk,
      context.signal,
      context.observe,
      references,
      context.beforeRequest,
      taskId,
    );
  const model = (await provider.models()).find(
    (model) => model.id === cell.model,
  );
  if (!model)
    throw new PreparationError(`Pricing is unavailable for ${cell.model}.`);
  if (!model.text)
    throw new PreparationError(
      "Chat completion requires a model that supports text output.",
    );
  let previousPrefixLength = 0;
  const replay = new Map<number, ReplayDetails>();
  const result = await fillChatTemplate(
    cell,
    (prompt, dollars) => generationBudget(model, prompt, "", dollars),
    async (messages, budget, progress) => {
      const prepared = prepareTextInference(
        "chat-template",
        { ...cell, prompt: chatText(messages), messages },
        budget,
        false,
        { sessionId: taskId, previousPrefixLength },
        model.chatImageOutput,
        replay,
      );
      previousPrefixLength = messages.length;
      const result = await provider.request(key, prepared, progress, context);
      if (result.reasoningDetails?.length)
        replay.set(messages.length, result.reasoningDetails);
      if (!result.assistant) throw new Error("Missing chat completion output.");
      return { assistant: result.assistant, usage: result.usage };
    },
    onChunk,
    context.signal,
    references,
  );
  return { ...result, signature: templateSignature(cell, references) };
}
