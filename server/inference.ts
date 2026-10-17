import type { PreparedInference } from "./prepared-inference.js";
import { completionFailure } from "./failures.js";
import { parseOutput } from "./output-format.js";
import { generateImage, streamText, Output, jsonSchema } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { CallObserver, CallRecorder } from "./billing.js";
import { upstreamFetch } from "./http.js";
import {
  type Cell,
  type Completion,
  type InferenceProgress,
  type FilledChatMessage,
} from "./domain.js";
const costUsage = z.object({
  cost: z.number().finite().nonnegative().optional(),
});
function reportedCost(usage: unknown): number | undefined {
  const result = costUsage.safeParse(usage);
  return result.success ? result.data.cost : undefined;
}
const thinkingMessage = z.object({
  reasoning: z.string().nullish(),
  reasoning_details: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().nullish(),
        summary: z.string().nullish(),
      }),
    )
    .nullish(),
});
const thinkingResponse = z.object({
  choices: z.array(
    z.object({
      delta: thinkingMessage.nullish(),
      message: thinkingMessage.nullish(),
    }),
  ),
});
function thinkingText(value: unknown): string {
  const parsed = thinkingResponse.safeParse(value);
  if (!parsed.success) return "";
  const choice = parsed.data.choices[0];
  const message = choice?.delta ?? choice?.message;
  // Details and the legacy reasoning field can contain the same text. Prefer
  // readable details, never opaque encrypted blocks, and never concatenate both.
  return (
    message?.reasoning_details
      ?.map((detail) =>
        detail.type === "reasoning.text"
          ? (detail.text ?? "")
          : detail.type === "reasoning.summary"
            ? (detail.summary ?? "")
            : "",
      )
      .join("") ||
    message?.reasoning ||
    ""
  );
}
export async function generateInference(
  baseURL: string,
  key: string,
  prepared: PreparedInference,
  onChunk: (progress: InferenceProgress) => void,
  signal?: AbortSignal,
  observe?: CallObserver,
): Promise<{
  files: Record<string, string | Uint8Array>;
  mediaType?: string;
  usage?: Cell["usage"];
}> {
  const { format } = prepared;
  if (
    format === "chat-template" ||
    (prepared.format !== "image" &&
      prepared.text.messages?.some((m) => m.role === "unfilled"))
  )
    throw new Error("Chat templates must be expanded before inference.");
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
      const thinking = thinkingText(body);
      if (thinking) onChunk({ text: "", thinking });
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
      const error = completionFailure(finishReason);
      if (error) throw new Error(error);
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
        model: provider.imageModel(prepared.model),
        prompt: prepared.prompt,
        providerOptions: {
          openrouter: {
            ...prepared.image,
            input_references: prepared.image.input_references?.map(
              ({ bytes, mediaType }) => ({
                type: "image_url",
                image_url: {
                  url: `data:${mediaType};base64,${bytes.toString("base64")}`,
                },
              }),
            ),
          },
        },
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
    const { maxOutputTokens, system, schema, options } = prepared.text;
    const model = provider.chat(prepared.model, options);
    let failure: unknown;
    const result = streamText({
      model,
      includeRawChunks: true,
      ...(prepared.text.messages
        ? {
            messages: prepared.text.messages as FilledChatMessage[],
            allowSystemInMessages: true,
          }
        : { system, prompt: prepared.prompt }),
      ...(schema && {
        output: Output.object({ schema: jsonSchema(schema), name: "website" }),
      }),
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal,
      onError: ({ error }) => {
        failure = error;
      },
    });
    // Approximate tokens from UTF-8 bytes; final provider usage replaces this.
    const inputTokens =
      Math.ceil(Buffer.byteLength(prepared.prompt + system, "utf8") / 4) + 8;
    const inputCost =
      prepared.pricing &&
      inputTokens * prepared.pricing.prompt + (prepared.pricing.request ?? 0);
    let text = "",
      thinking = "",
      outputBytes = 0;
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        outputBytes += Buffer.byteLength(chunk.text, "utf8");
        text += chunk.text;
      } else if (chunk.type === "raw") {
        // The adapter omits reasoning deltas after text starts. Raw events retain
        // interleaved thinking; ignoring normalized reasoning avoids duplicates.
        const delta = thinkingText(chunk.rawValue);
        if (!delta) continue;
        thinking += delta;
        outputBytes += Buffer.byteLength(delta, "utf8");
      } else if (chunk.type !== "start-step") continue;
      const outputTokens = Math.ceil(outputBytes / 4);
      onChunk({
        text,
        thinking,
        estimatedUsage: {
          inputTokens,
          outputTokens,
          costUsd:
            inputCost !== undefined && prepared.pricing
              ? inputCost + outputTokens * prepared.pricing.completion
              : undefined,
        },
      });
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
    if (
      finishReason === "length" &&
      maxOutputTokens !== undefined &&
      !text.trim() &&
      (streamUsage?.outputTokenDetails.reasoningTokens ?? 0) >= maxOutputTokens
    ) {
      const limit =
        maxOutputTokens >= 1000
          ? `${maxOutputTokens / 1000}K`
          : String(maxOutputTokens);
      throw new Error(
        `The model spent all of its ${limit} output token limit on thinking without producing output - this is a common failure mode of some models indicating that the thinking level is too high for the task`,
      );
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
