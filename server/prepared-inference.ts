import { normalizeImageSettings } from "./image-settings.js";
import type { ReferenceInputs } from "./image-references.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  FilledChatMessage,
  GenerationParameters,
  GridInput,
} from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { instruction, websiteSchema } from "./output-format.js";
import { canonical } from "../shared/canonical.js";
import {
  chatMessages,
  chatWireMessages,
  type ReplayDetails,
} from "./chat-messages.js";

const dependencies = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).dependencies;
// Bump the local revision when adapter semantics change without an SDK update.
const adapterVersion = `1/ai:${dependencies.ai}/openrouter:${dependencies["@openrouter/ai-sdk-provider"]}`;
export type SingleOutputFormat = Exclude<GridInput["format"], "chat-template">;
function common(cell: Pick<GenerationParameters, "model" | "prompt">) {
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
  cell: Omit<GenerationParameters, "messages"> & {
    messages?: FilledChatMessage[];
  },
  budget: TextBudget,
  structured: boolean,
  cache?: { sessionId: string; previousPrefixLength: number },
  chatImageOutput = false,
  replay?: ReadonlyMap<number, ReplayDetails>,
) {
  const messages = cell.messages ? chatMessages(cell.messages) : undefined;
  const wireMessages =
    format === "chat-template" && messages
      ? chatWireMessages(messages, cache, replay)
      : undefined;
  return {
    ...common(cell),
    format: format === "chat-template" ? ("markdown" as const) : format,
    chat: format === "chat-template",
    pricing: budget.pricing,
    text: {
      messages,
      system: format === "chat-template" ? "" : instruction(format),
      maxOutputTokens: budget.maxOutputTokens,
      schema: structured ? z.toJSONSchema(websiteSchema) : undefined,
      options: {
        extraBody: {
          modalities:
            format === "chat-template" && chatImageOutput
              ? ["text", "image"]
              : ["text"],
          ...(cache && {
            session_id: cache.sessionId,
          }),
          ...(wireMessages && { messages: wireMessages }),
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
    const { pricing: _estimation, chat, ...request } = prepared;
    const { maxOutputTokens: _limit, ...text } = request.text;
    const history = text.messages;
    const singlePromptMessage =
      history?.length === 1 &&
      history[0].role === "user" &&
      history[0].content === request.prompt;
    const messages = singlePromptMessage
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
    const { modalities, messages: _wire, ...body } = text.options.extraBody;
    const textOnly = modalities?.length === 1 && modalities[0] === "text";
    const extraBody = textOnly ? body : { ...body, modalities };
    return digest({
      ...request,
      ...(chat && { chat: true }),
      text: {
        ...text,
        messages,
        options: { ...text.options, extraBody },
      },
    });
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
    templateVersion: 5,
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
