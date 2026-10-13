import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Cell, GridInput } from "./domain.js";
import type { TextBudget } from "./generation-budget.js";
import { instruction, websiteSchema } from "./output-format.js";

const dependencies = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).dependencies;
// Bump the local revision when adapter semantics change without an SDK update.
const adapterVersion = `1/ai:${dependencies.ai}/openrouter:${dependencies["@openrouter/ai-sdk-provider"]}`;
export function prepareInference(
  format: GridInput["format"],
  cell: Cell,
  budget?: TextBudget,
  structured = false,
  references: string[] = [],
) {
  const { input_references: _ids, ...imageSettings } = cell.imageSettings ?? {};
  return {
    adapterVersion,
    format,
    model: cell.model,
    prompt: cell.prompt,
    budgetUsd: cell.budgetUsd,
    image:
      format === "image"
        ? {
            ...imageSettings,
            input_references: references.length
              ? references.map((url) => ({
                  type: "image_url" as const,
                  image_url: { url },
                }))
              : undefined,
          }
        : undefined,
    text:
      format !== "image"
        ? {
            system: instruction(format),
            maxOutputTokens: budget!.maxOutputTokens,
            schema: structured ? z.toJSONSchema(websiteSchema) : undefined,
            options: {
              extraBody:
                cell.effort !== "default"
                  ? {
                      reasoning:
                        cell.effort === "none"
                          ? { enabled: false }
                          : { effort: cell.effort },
                    }
                  : {},
              provider: {
                require_parameters: true,
                max_price: budget!.maxPrice,
              },
            },
          }
        : undefined,
  };
}
export type PreparedInference = ReturnType<typeof prepareInference>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function inferenceSignature(prepared: PreparedInference): string {
  const references = prepared.image?.input_references?.map(
    ({ image_url: { url } }) => {
      const [header, data] = url.split(",", 2);
      return {
        mediaType: header,
        sha256: createHash("sha256")
          .update(Buffer.from(data, "base64"))
          .digest("hex"),
      };
    },
  );
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          ...prepared,
          image: prepared.image && {
            ...prepared.image,
            input_references: references,
          },
        }),
      ),
    )
    .digest("hex");
}
