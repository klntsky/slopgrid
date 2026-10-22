import { normalizeImageSettings } from "./image-settings.js";
import type { ReferenceInputs } from "./image-references.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { GenerationParameters, GridInput } from "./domain.js";
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
  references?: ReferenceInputs,
) {
  const { input_references: _ids, ...imageSettings } = normalizeImageSettings(
    cell.imageSettings,
  );
  const images = cell.imageSettings?.input_references?.map((id) =>
    referenceContent(references, id),
  );
  return {
    ...common(cell),
    format: "image" as const,
    image: {
      ...imageSettings,
      input_references: images?.length ? images : undefined,
    },
  };
}
export function prepareTextInference(
  format: Exclude<GridInput["format"], "image">,
  cell: GenerationParameters,
  budget: TextBudget,
  structured: boolean,
  cache?: { sessionId: string; previousPrefixLength: number },
  references?: ReferenceInputs,
) {
  const messages = cell.messages
    ? chatMessages(cell.messages, references)
    : cell.images?.length
      ? chatMessages(
          [{ role: "user", content: cell.prompt, images: cell.images }],
          references,
        )
      : undefined;
  // OpenRouter 3.1.0's convertToOpenRouterChatMessages flattens assistant text
  // parts (dropping part providerOptions) and puts message cacheControl beside
  // content, not on a content block. Native providerOptions therefore cannot
  // mark our previous-prefix and final boundaries as documented content blocks;
  // request-level automatic caching does not express both explicit boundaries.
  // extraBody.messages replaces the whole SDK message array, so encode image
  // parts here too. Keep this wire-only adaptation out of the saved transcript.
  let firstImage = -1;
  let lastImage = -1;
  if (cache && messages)
    for (const [index, message] of messages.entries())
      if (
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "file")
      ) {
        if (firstImage < 0) firstImage = index;
        lastImage = index;
      }
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
                    // Two image checkpoints leave room for both text boundaries.
                    ...((index === firstImage || index === lastImage) &&
                      parts[i + 1]?.type !== "file" && {
                        cache_control: { type: "ephemeral" as const },
                      }),
                  },
            );
      const boundary =
        index === messages.length - 1 ||
        index === cache.previousPrefixLength - 1;
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
    format: format === "chat-template" ? ("markdown" as const) : format,
    pricing: budget.pricing,
    text: {
      messages,
      system: format === "chat-template" ? "" : instruction(format),
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
    const history = text.messages;
    // A single plain user message is the same request as the former prompt input.
    const messages =
      history?.length === 1 &&
      history[0].role === "user" &&
      history[0].content === request.prompt
        ? undefined
        : history?.map((message) =>
            typeof message.content === "string"
              ? message
              : {
                  ...message,
                  content: message.content.map((part) =>
                    part.type === "file"
                      ? {
                          type: part.type,
                          mediaType: part.mediaType,
                          sha256: createHash("sha256")
                            .update(part.data)
                            .digest("hex"),
                        }
                      : part,
                  ),
                },
          );
    return digest({ ...request, text: { ...text, messages } });
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
  references?: ReferenceInputs,
): string {
  return digest({
    ...common(cell),
    format: "chat-template",
    templateVersion: 4,
    effort: cell.effort,
    messages: cell.messages?.map(({ role, content, images }) => ({
      role,
      content,
      images: images?.length
        ? images.map(({ id }) => {
            const { mediaType, sha256 } = referenceContent(references, id);
            return { mediaType, sha256 };
          })
        : undefined,
    })),
  });
}

function referenceContent(references: ReferenceInputs | undefined, id: string) {
  const image = references?.get(id);
  if (!image) throw new Error("Reference image is unavailable");
  return image;
}
