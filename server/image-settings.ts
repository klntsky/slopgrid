import { z } from "zod";
import type {
  GenerationParameters,
  GridDraftInput,
  GridInput,
  StoredGridInput,
} from "./domain.js";
import {
  mergeVariableImages,
  referencedVariableImages,
} from "./prompt-variables.js";
import { criteriaForCell } from "./judge-criteria.js";
import { type ParameterConfiguration } from "./parameters.js";
import { legacySelectedReferences } from "./legacy-grid-input.js";
import { generatorInputEntries } from "./generator-input.js";

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
] as const;
export type ImageSettings = Partial<
  Record<(typeof imageKinds)[number], string>
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
export function normalizeImageSettings(
  settings: ImageSettings = {},
): ImageSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : !!value && value !== "auto",
    ),
  );
}
type ReferenceSelectionInput = ParameterConfiguration;

export function selectedReferences(
  input: StoredGridInput | GridDraftInput,
): ReferenceImage[] {
  if (input.inputVersion === undefined) return legacySelectedReferences(input);
  const attachments =
    input.inputVersion === 3
      ? generatorInputEntries(input).flatMap(({ messages }) =>
          messages.flatMap((message) => message.images ?? []),
        )
      : [
          ...input.promptImages,
          ...(input.messages ?? []).flatMap((message) => message.images ?? []),
        ];
  return (
    mergeVariableImages(
      attachments,
      ...[...input.rows, ...input.columns].flatMap(
        (record) => record.variable?.map((field) => field?.images) ?? [],
      ),
    ) ?? []
  );
}

export function generatorReferences(
  input: ReferenceSelectionInput,
): ReferenceImage[] {
  const groups: (ReferenceImage[] | undefined)[] = [];
  for (const { source, caseIndex, messages } of generatorInputEntries(input)) {
    const selection =
      source === "common" ? undefined : { [source]: caseIndex! };
    for (const message of messages) {
      groups.push(message.images);
      groups.push(referencedVariableImages(message.content, input, selection));
    }
  }
  return mergeVariableImages(...groups) ?? [];
}

export function judgeReferences(
  input: ReferenceSelectionInput & Pick<GridInput, "judge">,
): ReferenceImage[] {
  const groups: (ReferenceImage[] | undefined)[] = [generatorReferences(input)];
  if (input.judge)
    input.rows.forEach((_, row) =>
      input.columns.forEach((_, column) => {
        for (const criterion of criteriaForCell(input, row, column))
          groups.push(
            referencedVariableImages(criterion.text, input, {
              rows: row,
              columns: column,
            }),
          );
      }),
    );
  return mergeVariableImages(...groups) ?? [];
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
