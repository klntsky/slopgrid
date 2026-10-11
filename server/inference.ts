import { generateImage, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { TextBudget } from "./generation-budget.js";
import type { CallObserver, CallRecorder } from "./billing.js";
import { upstreamFetch } from "./http.js";
import {
  instruction,
  parseOutput,
  type Cell,
  type Completion,
  type GridInput,
} from "./domain.js";
const costUsage = z.object({
  cost: z.number().finite().nonnegative().optional(),
});
function reportedCost(usage: unknown): number | undefined {
  const result = costUsage.safeParse(usage);
  return result.success ? result.data.cost : undefined;
}
export async function generateInference(
  baseURL: string,
  key: string,
  format: GridInput["format"],
  cell: Cell,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  observe?: CallObserver,
  budget?: TextBudget,
): Promise<{
  files: Record<string, string | Uint8Array>;
  mediaType?: string;
  usage?: Cell["usage"];
}> {
  const phase: Completion["phase"] = format === "image" ? "image" : "direct";
  let call: CallRecorder | undefined;
  let imageFinishReason: string | undefined;
  let imageCost: number | undefined;
  const inferenceFetch: typeof upstreamFetch = async (input, init) => {
    call = observe?.(phase);
    const response = await upstreamFetch(input, init);
    call?.update({
      httpStatus: response.status,
      generationId: response.headers.get("x-generation-id") ?? undefined,
    });
    if (format === "image" && response.ok) {
      const body = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (typeof body?.id === "string") call?.update({ generationId: body.id });
      // The image adapter currently omits response usage.cost from its result.
      imageCost = reportedCost(body?.usage);
      imageFinishReason =
        body?.choices?.[0]?.finish_reason ?? body?.finish_reason;
    }
    return response;
  };
  try {
    let usage: Cell["usage"];
    function recordCompletion(completion: Completion, current: Cell["usage"]) {
      call?.complete(completion, current);
      usage = current;
    }
    function requireSuccess(finishReason: string | undefined) {
      if (finishReason !== "stop")
        throw new Error(
          "The model did not complete its response. Retry generation.",
        );
    }
    async function optional<T>(value: PromiseLike<T>): Promise<T | undefined> {
      try {
        return await value;
      } catch {
        return undefined;
      }
    }
    const provider = createOpenRouter({
      apiKey: key,
      baseURL: baseURL,
      fetch: inferenceFetch,
    });
    if (format === "image") {
      const result = await generateImage({
        model: provider.imageModel(cell.model),
        prompt: cell.prompt,
        maxRetries: 0,
        abortSignal: signal,
      });
      recordCompletion(
        {
          phase: "image",
          finishReason: imageFinishReason ?? "stop",
          rawFinishReason: imageFinishReason,
        },
        {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: imageCost,
        },
      );
      requireSuccess(imageFinishReason ?? "stop");
      return {
        files: {
          image: result.image.uint8Array,
        },
        mediaType: result.image.mediaType,
        usage,
      };
    }
    if (!budget)
      throw new Error("A priced token budget is required for text generation.");
    const { maxOutputTokens, maxPrice } = budget;
    const model = provider.chat(cell.model, {
      extraBody:
        cell.effort !== "default"
          ? {
              reasoning:
                cell.effort === "none"
                  ? { enabled: false }
                  : { effort: cell.effort },
            }
          : {},
      provider: { require_parameters: true, max_price: maxPrice },
    });
    let failure: unknown;
    const result = streamText({
      model,
      system: instruction(format),
      prompt: cell.prompt,
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal,
      onError: ({ error }) => {
        failure = error;
      },
    });
    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      onChunk(text);
    }
    const [streamUsage, metadata, finishReason, rawFinishReason] =
      await Promise.all([
        optional(result.usage),
        optional(result.providerMetadata),
        optional(result.finishReason),
        optional(result.rawFinishReason),
      ]);
    const streamResponse = await optional(result.response);
    if (streamResponse?.id) call?.update({ generationId: streamResponse.id });
    recordCompletion(
      {
        phase: "direct",
        finishReason,
        rawFinishReason,
        reasoningTokens: streamUsage?.outputTokenDetails.reasoningTokens,
      },
      streamUsage && {
        inputTokens: streamUsage.inputTokens,
        outputTokens: streamUsage.outputTokens,
        costUsd: reportedCost(metadata?.openrouter?.usage),
      },
    );
    if (failure) {
      if (
        failure !== null &&
        typeof failure === "object" &&
        !Object.hasOwn(failure, "responseHeaders")
      ) {
        Object.assign(failure, { responseHeaders: streamResponse?.headers });
      }
      throw failure;
    }
    requireSuccess(finishReason);
    return {
      files: parseOutput(format, text),
      usage,
    };
  } catch (error) {
    call?.fail(error, signal?.aborted === true);
    throw error;
  }
}
