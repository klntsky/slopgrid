import { generateImage, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { Model } from "./provider.js";
import { generationBudget } from "./generation-budget.js";
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
  onCompletion?: (completion: Completion, usage: Cell["usage"]) => void,
  observe?: CallObserver,
  pricedModel?: Model,
): Promise<{
  files: Record<string, string | Uint8Array>;
  mediaType?: string;
  usage?: Cell["usage"];
  completions?: Completion[];
}> {
  const phase: Completion["phase"] = format === "image" ? "image" : "direct";
  let call: CallRecorder | undefined;
  const inferenceFetch: typeof upstreamFetch = async (input, init) => {
    call = observe?.(phase);
    const response = await upstreamFetch(input, init);
    call?.update({
      httpStatus: response.status,
      generationId: response.headers.get("x-generation-id") ?? undefined,
    });
    if (
      !init?.body ||
      typeof init.body !== "string" ||
      JSON.parse(init.body).stream !== true
    ) {
      const body = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (typeof body?.id === "string") call?.update({ generationId: body.id });
    }
    return response;
  };
  try {
    const completions: Completion[] = [];
    let usage: Cell["usage"];
    function recordCompletion(completion: Completion, current: Cell["usage"]) {
      call?.complete(completion, current);
      completions.push(completion);
      usage = current;
      onCompletion?.(completion, usage);
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
    let imageFinishReason: string | undefined;
    let imageCost: number | undefined;
    const provider = createOpenRouter({
      apiKey: key,
      baseURL: baseURL,
      // The image adapter currently omits response usage.cost from its result.
      fetch:
        format === "image"
          ? async (input, init) => {
              const response = await inferenceFetch(input, init);
              if (response.ok) {
                const body = await response
                  .clone()
                  .json()
                  .catch(() => undefined);
                imageCost = reportedCost(body?.usage);
                imageFinishReason =
                  body?.choices?.[0]?.finish_reason ?? body?.finish_reason;
              }
              return response;
            }
          : inferenceFetch,
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
        completions,
      };
    }
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
      ...(pricedModel?.pricing
        ? {
            provider: {
              require_parameters: true,
              max_price: {
                prompt: pricedModel.pricing.prompt * 1000000,
                completion: pricedModel.pricing.completion * 1000000,
                ...(pricedModel.pricing.request !== undefined && {
                  request: pricedModel.pricing.request,
                }),
              },
            },
          }
        : cell.effort !== "default"
          ? { provider: { require_parameters: true } }
          : {}),
    });
    async function streamed(prompt: string): Promise<string> {
      let failure: unknown;
      const result = streamText({
        model,
        system: instruction(format),
        prompt,
        maxOutputTokens: pricedModel
          ? generationBudget(
              pricedModel,
              prompt,
              instruction(format),
              cell.budgetUsd ?? 5,
            ).maxOutputTokens
          : undefined,
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
          const response = await Promise.resolve(result.response).catch(
            () => undefined,
          );
          Object.assign(failure, { responseHeaders: response?.headers });
        }
        throw failure;
      }
      requireSuccess(finishReason);
      return text;
    }
    const text = await streamed(cell.prompt);
    return {
      files: parseOutput(format, text),
      usage,
      completions,
    };
  } catch (error) {
    call?.fail(error, signal?.aborted === true);
    throw error;
  }
}
