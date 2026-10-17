import { normalizeImageSettings } from "./image-settings.js";
import type { ReferenceContent } from "./image-references.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Cell, GridInput } from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { instruction, websiteSchema } from "./output-format.js";
import { canonical } from "../shared/canonical.js";

const dependencies = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).dependencies;
// Bump the local revision when adapter semantics change without an SDK update.
const adapterVersion = `1/ai:${dependencies.ai}/openrouter:${dependencies["@openrouter/ai-sdk-provider"]}`;
export type SingleOutputFormat = Exclude<GridInput["format"], "chat-template">;
function common(cell: Cell) {
  return {
    adapterVersion,
    model: cell.model,
    prompt: cell.prompt,
  };
}
export function prepareImageInference(
  cell: Cell,
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
  cell: Cell,
  budget: TextBudget,
  structured: boolean,
  cache?: { sessionId: string; previousPrefixLength: number },
) {
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
            // Use wire content blocks: the SDK otherwise puts assistant cache
            // controls on the message rather than on its text block.
            messages: cell.messages?.map((message, index, messages) => ({
              role: message.role,
              content:
                index === messages.length - 1 ||
                index === cache.previousPrefixLength - 1
                  ? [
                      {
                        type: "text",
                        text: message.content,
                        cache_control: { type: "ephemeral" },
                      },
                    ]
                  : message.content,
            })),
          }),
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

export function templateSignature(cell: Cell): string {
  return digest({
    ...common(cell),
    format: "chat-template",
    templateVersion: 2,
    effort: cell.effort,
    messages: cell.messages,
  });
}
