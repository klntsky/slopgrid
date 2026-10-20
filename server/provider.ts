import type { ReferenceInputs } from "./image-references.js";
import {
  prepareTextInference,
  prepareImageInference,
  inferenceSignature,
  type PreparedInference,
  type SingleOutputFormat,
} from "./prepared-inference.js";
import { imageEndpointSchema, type ImageEndpoint } from "./image-settings.js";
import { instruction } from "./output-format.js";
import { z } from "zod";
import { generationBudget, PreparationError } from "./generation-budget.js";
import { generateInference, type InferenceContext } from "./inference.js";
import { parsePricing, type ModelPricing } from "./model-pricing.js";
import type { CallObserver } from "./billing.js";
import { upstreamFetch } from "./http.js";
import { judgeInference } from "./judge.js";
import type { ChatInputMessage } from "./chat-messages.js";
import {
  efforts,
  type Cell,
  type GenerationParameters,
  type GridInput,
  type InferenceProgress,
  type JudgmentInput,
} from "./domain.js";
export type Model = {
  id: string;
  aliasTarget?: string;
  canonicalSlug?: string;
  name: string;
  image: boolean;
  imageInput: boolean;
  text: boolean;
  reasoning: boolean;
  reasoningMandatory: boolean;
  structuredOutputs?: boolean;
  reasoningEfforts?: GridInput["effort"][];
  pricing?: ModelPricing;
  contextLength?: number;
  maxCompletionTokens?: number;
};
export class InvalidKey extends Error {}

export class Provider {
  constructor(readonly baseURL = "https://openrouter.ai/api/v1") {}
  private catalog?: { at: number; models: Model[] };
  async exchangeKey(code: string, verifier: string): Promise<string> {
    const response = await upstreamFetch(`${this.baseURL}/auth/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
    if (!response.ok) throw new Error("Exchange failed");
    return z.object({ key: z.string().min(1) }).parse(await response.json())
      .key;
  }
  async keyInfo(key: string) {
    const response = await upstreamFetch(`${this.baseURL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.status === 401 || response.status === 403)
      throw new InvalidKey();
    if (!response.ok) throw new Error("Key lookup failed");
    return z
      .object({
        data: z.object({
          limit_remaining: z.number().finite().nullable().optional(),
        }),
      })
      .parse(await response.json()).data;
  }
  private async credits(
    key: string,
    allowForbidden = false,
  ): Promise<number | null> {
    const response = await upstreamFetch(`${this.baseURL}/credits`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (allowForbidden && response.status === 403) return null;
    if (!response.ok)
      throw new Error("Could not check your OpenRouter balance. Try again.");
    const body = z
      .object({
        data: z.object({
          total_credits: z.number().finite(),
          total_usage: z.number().finite(),
        }),
      })
      .parse(await response.json());
    return body.data.total_credits - body.data.total_usage;
  }
  async balanceUsd(key: string): Promise<number> {
    return (await this.credits(key))!;
  }
  async manualCredits(key: string): Promise<number | null> {
    const { limit_remaining: limit } = await this.keyInfo(key);
    const balance = await this.credits(key, true);
    return balance === null
      ? (limit ?? null)
      : limit == null
        ? balance
        : Math.min(balance, limit);
  }
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
      canonical_slug?: string;
      name: string;
      pricing?: unknown;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number | null };
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
      if (
        [m.id, m.alias_target?.slug].some((id) =>
          id?.split(":").slice(1).includes("batch"),
        )
      )
        continue;
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
        canonicalSlug: previous?.canonicalSlug ?? m.canonical_slug,
        name: m.name,
        // Native Sonar search and the online variant incur search charges without
        // an explicit search plugin. Optional search pricing alone does not.
        pricing:
          previous?.pricing ??
          parsePricing(
            m.pricing,
            m.id.startsWith("perplexity/sonar") || m.id.endsWith(":online"),
          ),
        contextLength: previous?.contextLength ?? m.context_length,
        maxCompletionTokens:
          previous?.maxCompletionTokens ??
          m.top_provider?.max_completion_tokens ??
          undefined,
        image: imageIds.has(m.id),
        imageInput:
          previous?.imageInput ||
          m.architecture.input_modalities?.includes("image") ||
          false,
        text:
          previous?.text ||
          m.architecture.output_modalities?.includes("text") ||
          false,
        reasoning: previous?.reasoning || reasoning,
        reasoningMandatory: previous?.reasoningMandatory || mandatory,
        structuredOutputs:
          previous?.structuredOutputs ||
          parameters.includes("structured_outputs"),
        reasoningEfforts: previous?.reasoning
          ? previous.reasoningEfforts
          : reasoningEfforts,
      });
    }
    const models = [...byId.values()].filter((m) => m.text || m.image);
    this.catalog = { at: Date.now(), models };
    return models;
  }
  private imageCatalog = new Map<
    string,
    { at: number; data: Promise<ImageEndpoint[]> }
  >();
  async imageEndpoints(model: string): Promise<ImageEndpoint[]> {
    const known = (await this.models()).find(
      (candidate) => candidate.id === model && candidate.image,
    );
    if (!known) throw new Error("Unknown image model");
    const id = known.aliasTarget ?? model;
    const cached = this.imageCatalog.get(id);
    if (cached && Date.now() - cached.at < 300000) return cached.data;
    const data = (async () => {
      const path = id.split("/").map(encodeURIComponent).join("/");
      const response = await upstreamFetch(
        `${this.baseURL}/images/models/${path}/endpoints`,
      );
      if (!response.ok) throw new Error("Could not load image model details");
      return z
        .object({ endpoints: z.array(imageEndpointSchema) })
        .parse(await response.json()).endpoints;
    })();
    this.imageCatalog.set(id, { at: Date.now(), data });
    try {
      return await data;
    } catch (error) {
      this.imageCatalog.delete(id);
      throw error;
    }
  }

  judge(
    key: string,
    input: JudgmentInput,
    messages: ChatInputMessage[],
    context: InferenceContext = {},
  ) {
    return judgeInference(this.baseURL, key, input, messages, context);
  }
  async generate(
    key: string,
    format: SingleOutputFormat,
    cell: GenerationParameters,
    onChunk: (progress: InferenceProgress) => void,
    signal?: AbortSignal,
    observe?: CallObserver,
    references?: ReferenceInputs,
    beforeRequest?: () => Promise<void>,
    _taskId?: string,
  ): Promise<{
    signature: string;
    maxOutputTokens?: number;
    files: Record<string, string | Uint8Array>;
    mediaType?: string;
    usage?: Cell["usage"];
  }> {
    const prepared = await this.prepare(format, cell, references);
    const result = await this.request(key, prepared, onChunk, {
      signal,
      observe,
      beforeRequest,
    });
    return {
      ...result,
      signature: inferenceSignature(prepared),
      maxOutputTokens:
        prepared.format === "image" ? undefined : prepared.text.maxOutputTokens,
    };
  }
  request(
    key: string,
    prepared: PreparedInference,
    onChunk: (progress: InferenceProgress) => void,
    context: InferenceContext = {},
  ) {
    return generateInference(this.baseURL, key, prepared, onChunk, context);
  }
  async prepare(
    format: SingleOutputFormat,
    cell: GenerationParameters,
    references?: ReferenceInputs,
  ) {
    if (format === "image") return prepareImageInference(cell, references);
    const pricedModel = (await this.models()).find(
      (model) => model.id === cell.model,
    );
    if (!pricedModel)
      throw new PreparationError(`Pricing is unavailable for ${cell.model}.`);
    const budget = generationBudget(
      pricedModel,
      cell.prompt,
      instruction(format),
      cell.budgetUsd,
    );
    return prepareTextInference(
      format,
      cell,
      budget,
      format === "html" && pricedModel.structuredOutputs === true,
      undefined,
      references,
    );
  }
}
