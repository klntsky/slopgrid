import { generateText, generateImage, streamText, APICallError } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  instruction,
  parseOutput,
  type Cell,
  type GridInput,
} from "./domain.js";
export type Model = {
  id: string;
  name: string;
  image: boolean;
  text: boolean;
  reasoning: boolean;
};
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
      name: string;
      architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
      };
      supported_parameters?: string[] | Record<string, unknown>;
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
      byId.set(m.id, {
        id: m.id,
        name: m.name,
        image: imageIds.has(m.id),
        text:
          previous?.text ||
          m.architecture.output_modalities?.includes("text") ||
          false,
        reasoning:
          previous?.reasoning ||
          (Array.isArray(m.supported_parameters) &&
            m.supported_parameters.includes("reasoning")) ||
          false,
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
    files: Record<string, string>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }> {
    const provider = createOpenRouter({ apiKey: key, baseURL: this.baseURL });
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
          image: `data:${result.image.mediaType};base64,${result.image.base64}`,
        },
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      };
    }
    const supportsReasoning = (await this.models()).find(
      (m) => m.id === cell.model,
    )?.reasoning;
    const model = provider.chat(cell.model, {
      extraBody: supportsReasoning
        ? {
            reasoning: { effort: cell.effort },
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
    if (failure) throw failure;
    let usage = await result.usage;
    if (cell.harness === "review") {
      const reviewed = await generateText({
        model,
        system: instruction(format),
        prompt: `Original request:\n${cell.prompt}\n\nDraft:\n${text}\n\nCheck the draft against the request and return the corrected final output.`,
        maxRetries: 0,
        abortSignal: requestSignal(),
      });
      text = reviewed.text;
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
      },
    };
  }
}
export function interruption(error: unknown): "billing" | "auth" | undefined {
  const details = error as { statusCode?: number; code?: number };
  const status = APICallError.isInstance(error)
    ? error.statusCode
    : (details?.statusCode ?? details?.code);
  if (status === 402) return "billing";
  if (status === 401 || status === 403) return "auth";
}
