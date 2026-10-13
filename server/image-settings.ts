import { z } from "zod";

export const imageChoices = {
  size: ["512", "768", "1K", "1.5K", "2K", "4K"],
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
  pricing: z
    .array(
      z.object({
        billable: z.string(),
        unit: z.string(),
        cost_usd: z.number().finite().nonnegative(),
        variant: z.string().optional(),
      }),
    )
    .default([]),
});
export type ImageEndpoint = z.infer<typeof imageEndpointSchema>;
export function validImageSize(value: string) {
  return imageChoices.size.includes(value) || /^[1-9]\d*x[1-9]\d*$/.test(value);
}
