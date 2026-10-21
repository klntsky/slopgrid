import { z } from "zod";
import type { GenerationParameters, GridInput } from "./domain.js";
import {
  mergeVariableImages,
  referencedVariableImages,
} from "./prompt-variables.js";
import { criteriaSets } from "./judge-criteria.js";

import {
  ImageGenerationRequestAspectRatio,
  ImageGenerationRequestBackground,
  ImageGenerationRequestQuality,
  ImageGenerationRequestResolution,
} from "@openrouter/sdk/models/imagegenerationrequest.js";

function withAuto(values: Record<string, string>): string[] {
  return ["auto", ...Object.values(values).filter((value) => value !== "auto")];
}
export const imageChoices = {
  size: withAuto(ImageGenerationRequestResolution),
  aspect_ratio: withAuto(ImageGenerationRequestAspectRatio),
  quality: withAuto(ImageGenerationRequestQuality),
  background: withAuto(ImageGenerationRequestBackground),
};
export const imageKinds = [
  "size",
  "aspect_ratio",
  "quality",
  "background",
  "input_references",
] as const;
export type ImageSettings = Partial<
  Record<Exclude<(typeof imageKinds)[number], "input_references">, string>
> & { input_references?: string[] };
export const referenceImageSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(255),
    width: z.number().finite().int().positive().optional(),
    height: z.number().finite().int().positive().optional(),
  })
  .refine(
    (image) => (image.width === undefined) === (image.height === undefined),
    "Image dimensions must include both width and height.",
  );
export type ReferenceImage = z.infer<typeof referenceImageSchema>;
export type ReferenceGroups = Record<string, ReferenceImage[]>;
export const imageCapabilitiesSchema = z.record(
  z.string(),
  z.union([
    z.object({ type: z.literal("enum"), values: z.array(z.string()) }),
    z.object({ type: z.literal("range"), min: z.number(), max: z.number() }),
    z.object({ type: z.literal("boolean") }),
    z.object({ type: z.string() }),
  ]),
);
export type ImageCapabilities = z.infer<typeof imageCapabilitiesSchema>;
export const imageEndpointSchema = z.object({
  provider_name: z.string().trim().min(1),
  supported_parameters: imageCapabilitiesSchema,
  pricing: z.array(
    z.object({
      billable: z.string(),
      unit: z.string(),
      cost_usd: z.number().finite().nonnegative(),
      variant: z.string().optional(),
    }),
  ),
});
export type ImageEndpoint = z.infer<typeof imageEndpointSchema>;
export function validImageSize(value: string) {
  return imageChoices.size.includes(value) || /^[1-9]\d*x[1-9]\d*$/.test(value);
}

export type ScalarImageKind = keyof typeof imageChoices;
export function validImageSetting(kind: ScalarImageKind, value: string) {
  return kind === "size"
    ? validImageSize(value)
    : imageChoices[kind].includes(value);
}
function sharedSetting(kind: ScalarImageKind) {
  return z
    .string()
    .trim()
    .refine(
      (value) => !value || validImageSetting(kind, value),
      kind === "size"
        ? "Use a resolution or a size such as 1536x1024"
        : "Unknown image setting",
    )
    .optional();
}
export const draftImageSettingsSchema = z.object({
  size: z.string().optional(),
  aspect_ratio: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
});
export const sharedImageSettingsSchema = draftImageSettingsSchema.extend({
  size: sharedSetting("size"),
  aspect_ratio: sharedSetting("aspect_ratio"),
  quality: sharedSetting("quality"),
  background: sharedSetting("background"),
});
export function normalizeImageSettings(
  settings: ImageSettings = {},
): ImageSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : !!value && value !== "auto",
    ),
  );
}
export function selectedReferences(
  input: Pick<
    GridInput,
    | "format"
    | "messages"
    | "rows"
    | "columns"
    | "referenceGroups"
    | "inputReferences"
  >,
): ReferenceImage[] {
  return (
    mergeVariableImages(
      explicitReferences(input),
      ...[input.rows, input.columns].flatMap((axis) =>
        axis.kind === "variable"
          ? axis.values.flatMap((fields) => fields.map((field) => field.images))
          : [],
      ),
    ) ?? []
  );
}

type ReferenceSelectionInput = Pick<
  GridInput,
  | "format"
  | "prompt"
  | "messages"
  | "rows"
  | "columns"
  | "referenceGroups"
  | "inputReferences"
>;

function explicitReferences(
  input: Pick<
    ReferenceSelectionInput,
    | "format"
    | "messages"
    | "rows"
    | "columns"
    | "referenceGroups"
    | "inputReferences"
  >,
): ReferenceImage[] {
  if (input.format === "chat-template")
    return input.messages?.flatMap((message) => message.images ?? []) ?? [];
  const axis = [input.rows, input.columns].find(
    (axis) => axis.kind === "input_references",
  );
  return axis?.kind === "input_references"
    ? axis.values.flatMap((value) => input.referenceGroups?.[value] ?? [])
    : (input.inputReferences ?? []);
}

export function generatorReferences(
  input: ReferenceSelectionInput,
): ReferenceImage[] {
  const templates =
    input.format === "chat-template"
      ? (input.messages?.map((message) => message.content) ?? [])
      : [input.prompt];
  return (
    mergeVariableImages(
      explicitReferences(input),
      ...templates.map((text) => referencedVariableImages(text, input)),
    ) ?? []
  );
}

export function judgeReferences(
  input: ReferenceSelectionInput & Pick<GridInput, "judge">,
): ReferenceImage[] {
  const source = input.judge?.criteria;
  return (
    mergeVariableImages(
      generatorReferences(input),
      ...criteriaSets(source).flatMap((criteria, index) =>
        criteria.map((criterion) =>
          referencedVariableImages(
            criterion.text,
            input,
            source && !Array.isArray(source)
              ? { [source.axis]: index }
              : undefined,
          ),
        ),
      ),
    ) ?? []
  );
}

export function referenceIds(
  input: Pick<GenerationParameters, "messages" | "images" | "imageSettings">,
): readonly string[] {
  return input.messages
    ? input.messages.flatMap(
        (message) => message.images?.map((image) => image.id) ?? [],
      )
    : [
        ...(input.images?.map((image) => image.id) ?? []),
        ...(input.imageSettings?.input_references ?? []),
      ];
}
