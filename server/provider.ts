import { generateText, generateImage, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import {
  efforts,
  instruction,
  parseOutput,
  type Cell,
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
        fetch(`${this.baseURL}/${path}`, {
          signal: AbortSignal.timeout(15000),
        }),
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
  ): Promise<{
    files: Record<string, string | Uint8Array>;
    mediaType?: string;
    usage?: Cell["usage"];
  }> {
    let imageCost: number | undefined;
    const provider = createOpenRouter({
      apiKey: key,
      baseURL: this.baseURL,
      // The image adapter currently omits response usage.cost from its result.
      fetch:
        format === "image"
          ? async (input, init) => {
              const response = await fetch(input, init);
              if (response.ok) {
                const body = await response
                  .clone()
                  .json()
                  .catch(() => undefined);
                imageCost = reportedCost(body?.usage);
              }
              return response;
            }
          : undefined,
    });
    const requestSignal = () =>
      AbortSignal.any([
        AbortSignal.timeout(180000),
        ...(signal ? [signal] : []),
      ]);
    if (format === "image") {
      const result = await generateImage({
        model: provider.imageModel(cell.model),
        prompt: cell.prompt,
        maxRetries: 0,
        abortSignal: requestSignal(),
      });
      if (result.image.uint8Array.byteLength > 10_000_000)
        throw new Error("Image exceeds 10 MB");
      return {
        files: {
          image: result.image.uint8Array,
        },
        mediaType: result.image.mediaType,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: imageCost,
        },
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
    const cancellation = new AbortController();
    const streamSignal = AbortSignal.any([
      requestSignal(),
      cancellation.signal,
    ]);
    let failure: unknown;
    const result = streamText({
      model,
      system: instruction(format),
      prompt: cell.prompt,
      maxRetries: 0,
      abortSignal: streamSignal,
      onError: ({ error }) => {
        failure = error;
      },
    });
    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      if (text.length > 2_000_000) {
        cancellation.abort();
        throw new Error("Output exceeds 2 MB");
      }
      onChunk(text);
    }
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
    let usage = await result.usage;
    let costUsd = reportedCost(
      (await result.providerMetadata)?.openrouter?.usage,
    );
    if (cell.harness === "review") {
      const reviewed = await generateText({
        model,
        system: instruction(format),
        prompt: `Original request:\n${cell.prompt}\n\nDraft:\n${text}\n\nCheck the draft against the request and return the corrected final output.`,
        maxRetries: 0,
        abortSignal: requestSignal(),
      });
      text = reviewed.text;
      const reviewCost = reportedCost(
        reviewed.providerMetadata?.openrouter?.usage,
      );
      costUsd =
        costUsd !== undefined && reviewCost !== undefined
          ? costUsd + reviewCost
          : undefined;
      usage = {
        ...reviewed.usage,
        inputTokens:
          (usage.inputTokens ?? 0) + (reviewed.usage.inputTokens ?? 0),
        outputTokens:
          (usage.outputTokens ?? 0) + (reviewed.usage.outputTokens ?? 0),
      };
    }
    return {
      files: parseOutput(format, text),
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
      },
    };
  }
}
