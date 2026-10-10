import { generateText, generateImage, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { upstreamFetch } from "./http.js";
import {
  efforts,
  instruction,
  parseOutput,
  type Cell,
  type Completion,
  type GridInput,
} from "./domain.js";
export type Model = {
  id: string;
  aliasTarget?: string;
  name: string;
  image: boolean;
  text: boolean;
  reasoning: boolean;
  reasoningMandatory: boolean;
  reasoningEfforts?: GridInput["effort"][];
};
const costUsage = z.object({
  cost: z.number().finite().nonnegative().optional(),
});
function reportedCost(usage: unknown): number | undefined {
  const result = costUsage.safeParse(usage);
  return result.success ? result.data.cost : undefined;
}
export class Provider {
  constructor(readonly baseURL = "https://openrouter.ai/api/v1") {}
  private catalog?: { at: number; models: Model[] };
  async models(): Promise<Model[]> {
    if (this.catalog && Date.now() - this.catalog.at < 300000)
      return this.catalog.models;
    const responses = await Promise.all(
      ["models", "images/models"].map((path) =>
        upstreamFetch(`${this.baseURL}/${path}`),
      ),
    );
    if (responses.some((response) => !response.ok))
      throw new Error("Could not load OpenRouter models");
    type RemoteModel = {
      id: string;
      alias_target?: { slug?: string };
      name: string;
      architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
      };
      supported_parameters?: string[] | Record<string, unknown>;
      reasoning?: { mandatory?: boolean; supported_efforts?: string[] | null };
    };
    const [textCatalog, imageCatalog] = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ data: RemoteModel[] }>,
      ),
    );
    const imageIds = new Set(imageCatalog.data.map((m) => m.id));
    const byId = new Map<string, Model>();
    for (const m of [...textCatalog.data, ...imageCatalog.data]) {
      if (!m.architecture?.input_modalities?.includes("text")) continue;
      const previous = byId.get(m.id);
      const parameters = Array.isArray(m.supported_parameters)
        ? m.supported_parameters
        : Object.keys(m.supported_parameters ?? {});
      const reasoning =
        !!m.reasoning ||
        parameters.some((p) => p === "reasoning" || p === "reasoning_effort");
      const mandatory = m.reasoning?.mandatory === true;
      let reasoningEfforts: GridInput["effort"][] | undefined;
      if (!reasoning) reasoningEfforts = ["none"];
      else if (m.reasoning) {
        const supported =
          m.reasoning.supported_efforts === null
            ? efforts
            : (m.reasoning.supported_efforts ?? []);
        reasoningEfforts = efforts.filter(
          (e) =>
            e !== "default" &&
            (e === "none" ? !mandatory : supported.includes(e)),
        );
      }
      byId.set(m.id, {
        id: m.id,
        aliasTarget: previous?.aliasTarget ?? m.alias_target?.slug,
        name: m.name,
        image: imageIds.has(m.id),
        text:
          previous?.text ||
          m.architecture.output_modalities?.includes("text") ||
          false,
        reasoning: previous?.reasoning || reasoning,
        reasoningMandatory: previous?.reasoningMandatory || mandatory,
        reasoningEfforts: previous?.reasoning
          ? previous.reasoningEfforts
          : reasoningEfforts,
      });
    }
    const models = [...byId.values()].filter((m) => m.text || m.image);
    this.catalog = { at: Date.now(), models };
    return models;
  }
  async generate(
    key: string,
    format: GridInput["format"],
    cell: Cell,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    onCompletion?: (completion: Completion, usage: Cell["usage"]) => void,
  ): Promise<{
    files: Record<string, string | Uint8Array>;
    mediaType?: string;
    usage?: Cell["usage"];
    completions?: Completion[];
  }> {
    const completions: Completion[] = [];
    let usage: Cell["usage"];
    function recordCompletion(completion: Completion, current: Cell["usage"]) {
      completions.push(completion);
      usage =
        usage && current
          ? {
              inputTokens:
                (usage.inputTokens ?? 0) + (current.inputTokens ?? 0),
              outputTokens:
                (usage.outputTokens ?? 0) + (current.outputTokens ?? 0),
              costUsd:
                usage.costUsd !== undefined && current.costUsd !== undefined
                  ? usage.costUsd + current.costUsd
                  : undefined,
            }
          : (current ?? usage);
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
      baseURL: this.baseURL,
      // The image adapter currently omits response usage.cost from its result.
      fetch:
        format === "image"
          ? async (input, init) => {
              const response = await upstreamFetch(input, init);
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
          : upstreamFetch,
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
              provider: { require_parameters: true },
            }
          : {},
    });
    let failure: unknown;
    const result = streamText({
      model,
      system: instruction(format),
      prompt: cell.prompt,
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
    recordCompletion(
      {
        phase: cell.harness === "review" ? "draft" : "direct",
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
    if (cell.harness === "review") {
      const reviewed = await generateText({
        model,
        system: instruction(format),
        prompt: `Original request:\n${cell.prompt}\n\nDraft:\n${text}\n\nCheck the draft against the request and return the corrected final output.`,
        maxRetries: 0,
        abortSignal: signal,
      });
      text = reviewed.text;
      recordCompletion(
        {
          phase: "review",
          finishReason: reviewed.finishReason,
          rawFinishReason: reviewed.rawFinishReason,
          reasoningTokens: reviewed.usage.outputTokenDetails.reasoningTokens,
        },
        {
          inputTokens: reviewed.usage.inputTokens,
          outputTokens: reviewed.usage.outputTokens,
          costUsd: reportedCost(reviewed.providerMetadata?.openrouter?.usage),
        },
      );
      requireSuccess(reviewed.finishReason);
    }
    return {
      files: parseOutput(format, text),
      usage,
      completions,
    };
  }
}
