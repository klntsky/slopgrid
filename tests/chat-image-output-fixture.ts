import { pixelPng, referencePng } from "./reference-image-fixture.js";

export const generatedPng = pixelPng;
export const generatedDataUrl = `data:image/png;base64,${generatedPng.toString("base64")}`;
export const secondGeneratedDataUrl = `data:image/png;base64,${referencePng.toString("base64")}`;
export const encryptedReasoning = {
  type: "reasoning.encrypted",
  data: "opaque-fixture-signature+/=must-remain-exact",
  format: "google-gemini-v1",
  index: 0,
};

export function imageDelta(url = generatedDataUrl) {
  return { images: [{ type: "image_url", image_url: { url } }] };
}

export type GeneratedImageJSON = {
  kind: "generated";
  name: string;
  mediaType: string;
  width: number;
  height: number;
  dataUrl: string;
};
export type TranscriptMessageJSON = {
  role: string;
  content: string;
  images?: (GeneratedImageJSON | { id: string; name: string })[];
};
