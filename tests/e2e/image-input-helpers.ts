import type { CapturedRequest } from "../runtime-fixture";
import { rasterizeSvg } from "../../server/svg-raster";

export type WireRequest = CapturedRequest;
type WireMessage = CapturedRequest["messages"][number];

function decodedContent(message: WireMessage, separator: string) {
  const parts = message.content;
  return typeof parts === "string"
    ? { text: parts, images: [] as string[] }
    : {
        text: parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(separator),
        images: parts
          .filter((part) => part.type === "image_url")
          .map((part) => part.image_url!.url),
      };
}

export function messageContent(message: WireMessage) {
  return decodedContent(message, "");
}

export function userContents(messages: WireMessage[], separator = "") {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => decodedContent(message, separator));
}

const pictures = new Map<string, Promise<Buffer>>();
export async function picture(name: string, color: string) {
  let buffer = pictures.get(color);
  if (!buffer) {
    buffer = rasterizeSvg(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="${color}"/></svg>`,
      ),
    ).then((result) => result.bytes);
    pictures.set(color, buffer);
  }
  return { name, mimeType: "image/png", buffer: await buffer };
}

export const imageURL = (file: { buffer: Buffer }) =>
  `data:image/png;base64,${file.buffer.toString("base64")}`;
