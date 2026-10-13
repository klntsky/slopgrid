import { z } from "zod";

export const imageChoices = {
  size: ["auto", "512", "768", "1K", "1.5K", "2K", "4K"],
  aspect_ratio: [
    "auto",
    "1:1",
    "1:2",
    "1:4",
    "1:8",
    "2:1",
    "2:3",
    "2.35:1",
    "3:2",
    "3:4",
    "4:1",
    "4:3",
    "4:5",
    "5:2",
    "5:4",
    "5:7",
    "7:5",
    "8:1",
    "9:16",
    "16:9",
    "9:19.5",
    "19.5:9",
    "9:20",
    "20:9",
    "9:21",
    "21:9",
  ],
  quality: ["auto", "low", "medium", "high", "xhigh", "max"],
  background: ["auto", "transparent", "opaque"],
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
export const referenceImageSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(255),
});
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
export const sharedImageSettingsSchema = z.object({
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
export function selectedReferences(input: {
  referenceGroups?: ReferenceGroups;
  inputReferences?: ReferenceImage[];
}) {
  return [
    ...Object.values(input.referenceGroups ?? {}).flat(),
    ...(input.inputReferences ?? []),
  ];
}
