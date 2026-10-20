import { normalizeImageSettings } from "./image-settings.js";
import type { ReferenceContent } from "./image-references.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ChatMessage, GenerationParameters, GridInput } from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { instruction, websiteSchema } from "./output-format.js";
import { canonical } from "../shared/canonical.js";

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
type ChatWireMessage = {
  role: ChatMessage["role"];
  content:
    | string
    | (
        | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
        | {
            type: "image_url";
            image_url: { url: string };
            cache_control?: { type: "ephemeral" };
          }
      )[];
};

export function prepareChatMessages(
  history: readonly ChatMessage[],
  references: readonly ReferenceContent[] = [],
): ChatWireMessage[] {
  const messages: ChatWireMessage[] = history.map(({ role, content }) => ({
    role,
    content,
  }));
  if (references.length) {
    let index = messages.findIndex((message) => message.role === "user");
    if (index < 0) {
      messages.unshift({ role: "user", content: "" });
      index = 0;
    }
    messages[index].content = [
      ...(messages[index].content
        ? [{ type: "text" as const, text: messages[index].content as string }]
        : []),
      ...references.map(({ bytes, mediaType }) => ({
        type: "image_url" as const,
        image_url: {
          url: `data:${mediaType};base64,${bytes.toString("base64")}`,
        },
      })),
    ];
  }
  return messages;
}

export function prepareTextInference(
  format: Exclude<SingleOutputFormat, "image">,
  cell: GenerationParameters,
  budget: TextBudget,
  structured: boolean,
  cache?: { sessionId: string; previousPrefixLength: number },
  references: ReferenceContent[] = [],
) {
  let messages: ChatWireMessage[] | undefined;
  if (cell.messages && (cache || references.length)) {
    messages = prepareChatMessages(cell.messages, references);
    if (cache) {
      const offset = messages.length - cell.messages.length;
      for (const index of new Set([
        messages.length - 1,
        cache.previousPrefixLength - 1 + offset,
      ])) {
        const message = messages[index];
        if (!message) continue;
        if (typeof message.content === "string")
          message.content = [{ type: "text", text: message.content }];
        const last = message.content.at(-1);
        if (last) last.cache_control = { type: "ephemeral" };
      }
    }
  }
  return {
    ...common(cell),
    format,
    pricing: budget.pricing,
    text: {
      messages: cell.messages,
      system: cell.messages ? "" : instruction(format),
      maxOutputTokens: budget.maxOutputTokens,
      schema: structured ? z.toJSONSchema(websiteSchema) : undefined,
      options: {
        extraBody: {
          ...(cache && {
            session_id: cache.sessionId,
          }),
          ...(messages && { messages }),
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
    templateVersion: 2,
    effort: cell.effort,
    messages: cell.messages,
    references: references.length
      ? references.map(({ mediaType, sha256 }) => ({ mediaType, sha256 }))
      : undefined,
  });
}
