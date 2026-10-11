import { instruction } from "./output-format.js";
import { z } from "zod";
import { generationBudget } from "./generation-budget.js";
import { generateInference } from "./inference.js";
import type { CallObserver } from "./billing.js";
import { upstreamFetch } from "./http.js";
import { efforts, type Cell, type GridInput } from "./domain.js";
export type Model = {
  id: string;
  aliasTarget?: string;
  name: string;
  image: boolean;
  text: boolean;
  reasoning: boolean;
  reasoningMandatory: boolean;
  reasoningEfforts?: GridInput["effort"][];
  pricing?: { prompt: number; completion: number; request?: number };
  contextLength?: number;
  maxCompletionTokens?: number;
};
export class InvalidKey extends Error {}

export class Provider {
  constructor(readonly baseURL = "https://openrouter.ai/api/v1") {}
  private catalog?: { at: number; models: Model[] };
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
      name: string;
      pricing?: { prompt?: string; completion?: string; request?: string };
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
      const price = (value: string | undefined) => {
        if (value === undefined || value.trim() === "") return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
      };
      const promptPrice = price(m.pricing?.prompt),
        completionPrice = price(m.pricing?.completion);
      byId.set(m.id, {
        id: m.id,
        aliasTarget: previous?.aliasTarget ?? m.alias_target?.slug,
        name: m.name,
        pricing:
          previous?.pricing ??
          (promptPrice !== undefined && completionPrice !== undefined
            ? {
                prompt: promptPrice,
                completion: completionPrice,
                request: price(m.pricing?.request),
              }
            : undefined),
        contextLength: previous?.contextLength ?? m.context_length,
        maxCompletionTokens:
          previous?.maxCompletionTokens ??
          m.top_provider?.max_completion_tokens ??
          undefined,
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
    observe?: CallObserver,
  ): Promise<{
    files: Record<string, string | Uint8Array>;
    mediaType?: string;
    usage?: Cell["usage"];
  }> {
    const pricedModel =
      format !== "image"
        ? (await this.models()).find((model) => model.id === cell.model)
        : undefined;
    if (format !== "image" && !pricedModel)
      throw new Error(`Pricing is unavailable for ${cell.model}.`);
    return generateInference(
      this.baseURL,
      key,
      format,
      cell,
      onChunk,
      signal,
      observe,
      pricedModel
        ? generationBudget(
            pricedModel,
            cell.prompt,
            instruction(format),
            cell.budgetUsd,
          )
        : undefined,
    );
  }
}
