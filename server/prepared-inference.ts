import { normalizeImageSettings } from "./image-settings.js";
import type { ReferenceContent } from "./image-references.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ChatMessage, GenerationParameters, GridInput } from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { instruction, websiteSchema } from "./output-format.js";
import { canonical } from "../shared/canonical.js";
import { chatMessages } from "./chat-messages.js";

const dependencies = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).dependencies;
// Bump the local revision when adapter semantics change without an SDK update.
const adapterVersion = `1/ai:${dependencies.ai}/openrouter:${dependencies["@openrouter/ai-sdk-provider"]}`;
export type SingleOutputFormat = Exclude<GridInput["format"], "chat-template">;
function common(cell: GenerationParameters) {
  return {
    adapterVersion,
    model: cell.model,
    prompt: cell.prompt,
  };
}
export function prepareImageInference(
  cell: GenerationParameters,
  references: ReferenceContent[],
) {
  const { input_references: _ids, ...imageSettings } = normalizeImageSettings(
    cell.imageSettings,
  );
  return {
    ...common(cell),
    format: "image" as const,
    image: {
      ...imageSettings,
      input_references: references.length ? references : undefined,
    },
  };
}
export function prepareTextInference(
  format: Exclude<SingleOutputFormat, "image">,
  cell: GenerationParameters,
  budget: TextBudget,
  structured: boolean,
  cache?: { sessionId: string; previousPrefixLength: number },
  references: ReferenceContent[] = [],
  template?: readonly ChatMessage[],
) {
  const messages = cell.messages
    ? chatMessages(cell.messages, references, template)
    : undefined;
  // OpenRouter 3.1.0's convertToOpenRouterChatMessages flattens assistant text
  // parts (dropping part providerOptions) and puts message cacheControl beside
  // content, not on a content block. Native providerOptions therefore cannot
  // mark our previous-prefix and final boundaries as documented content blocks;
  // request-level automatic caching does not express both explicit boundaries.
  // extraBody.messages replaces the whole SDK message array, so encode image
  // parts here too. Keep this wire-only adaptation out of the saved transcript.
  const cachedMessages =
    cache &&
    messages?.map((message, index) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content.map((part, i, parts) =>
              part.type === "text"
                ? part
                : {
                    type: "image_url" as const,
                    image_url: {
                      url: `data:${part.mediaType};base64,${part.data.toString("base64")}`,
                    },
                    // Retain image caching beyond the prefix lookback window.
                    ...(parts[i + 1]?.type !== "file" && {
                      cache_control: { type: "ephemeral" as const },
                    }),
                  },
            );
      const boundary =
        index === messages.length - 1 ||
        index ===
          cache.previousPrefixLength -
            1 +
            messages.length -
            cell.messages!.length;
      return {
        role: message.role,
        content: !boundary
          ? content
          : typeof content === "string"
            ? [
                {
                  type: "text" as const,
                  text: content,
                  cache_control: { type: "ephemeral" as const },
                },
              ]
            : content.map((part, i) =>
                i === content.length - 1
                  ? { ...part, cache_control: { type: "ephemeral" as const } }
                  : part,
              ),
      };
    });
  return {
    ...common(cell),
    format,
    pricing: budget.pricing,
    text: {
      messages,
      system: cell.messages ? "" : instruction(format),
      maxOutputTokens: budget.maxOutputTokens,
      schema: structured ? z.toJSONSchema(websiteSchema) : undefined,
      options: {
        extraBody: {
          modalities: ["text"],
          ...(cache && {
            session_id: cache.sessionId,
          }),
          ...(cachedMessages && { messages: cachedMessages }),
          ...(cell.effort !== "default"
            ? {
                reasoning:
                  cell.effort === "none"
                    ? { enabled: false }
                    : { effort: cell.effort },
              }
            : {}),
        },
        provider: { require_parameters: true, max_price: budget.maxPrice },
      },
    },
  };
}
export type PreparedInference =
  | ReturnType<typeof prepareTextInference>
  | ReturnType<typeof prepareImageInference>;
export function inferenceSignature(prepared: PreparedInference): string {
  if (prepared.format !== "image") {
    const { pricing: _estimation, ...request } = prepared;
    const { maxOutputTokens: _limit, ...text } = request.text;
    return digest({ ...request, text });
  }
  const references = prepared.image.input_references?.map(
    ({ mediaType, sha256 }) => ({
      mediaType: `data:${mediaType};base64`,
      sha256,
    }),
  );
  return digest({
    ...prepared,
    image: { ...prepared.image, input_references: references },
  });
}
function digest(request: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(request)))
    .digest("hex");
}

export function templateSignature(
  cell: GenerationParameters,
  references: ReferenceContent[] = [],
): string {
  return digest({
    ...common(cell),
    format: "chat-template",
    templateVersion: 4,
    effort: cell.effort,
    messages: cell.messages,
    references: references.length
      ? references.map(({ mediaType, sha256 }) => ({ mediaType, sha256 }))
      : undefined,
  });
}
