import {
  chatImageSchema,
  type ChatMessage,
  type FilledChatMessage,
} from "./domain.js";
import type { ReferenceInputs } from "./image-references.js";
import { imageDimensions } from "./image-dimensions.js";

type ChatContent =
  | string
  | (
      | { type: "text"; text: string }
      | { type: "file"; data: Buffer; mediaType: string }
    )[];
export type ChatInputMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: ChatContent }
  | { role: "assistant"; content: ChatContent };
export type ReplayDetails = Record<string, unknown>[];

export function materializeChatMessages(
  messages: readonly ChatMessage[],
  references?: ReferenceInputs,
): FilledChatMessage[] {
  return messages.map(({ role, content, images }) => {
    if (role === "unfilled")
      throw new Error("Unfilled messages must be expanded before inference.");
    if (role === "system" && images?.length)
      throw new Error("System messages do not support image inputs.");
    return {
      role,
      content,
      ...(images?.length
        ? {
            images: images.map((image) => {
              const reference = references?.get(image.id);
              if (!reference) throw new Error("Reference image is unavailable");
              const dimensions = imageDimensions(reference.bytes);
              if (!dimensions)
                throw new Error("Reference image has invalid dimensions");
              return chatImageSchema.parse({
                name: image.name,
                mediaType: reference.mediaType,
                ...dimensions,
                dataUrl: `data:${reference.mediaType};base64,${reference.bytes.toString("base64")}`,
              });
            }),
          }
        : {}),
    };
  });
}

export function chatMessages(
  messages: readonly FilledChatMessage[],
): ChatInputMessage[] {
  return messages.map(({ role, content, images }): ChatInputMessage => {
    if (role === "system") {
      if (images?.length)
        throw new Error("System messages do not support image inputs.");
      return { role, content };
    }
    return {
      role,
      content: !images?.length
        ? content
        : [
            ...images.map((image) => ({
              type: "file" as const,
              data: Buffer.from(
                image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
                "base64",
              ),
              mediaType: image.mediaType,
            })),
            ...(content ? [{ type: "text" as const, text: content }] : []),
          ],
    };
  });
}

export function inputChatMessages(
  history: readonly ChatMessage[],
  references?: ReferenceInputs,
): ChatInputMessage[] {
  return history.map(({ role, content, images }): ChatInputMessage => {
    if (role === "unfilled")
      throw new Error("Unfilled messages must be expanded before inference.");
    if (role === "system") {
      if (images?.length)
        throw new Error("System messages do not support image inputs.");
      return { role, content };
    }
    return {
      role,
      content: !images?.length
        ? content
        : [
            ...images.map((image) => {
              const reference = references?.get(image.id);
              if (!reference) throw new Error("Reference image is unavailable");
              return {
                type: "file" as const,
                data: reference.bytes,
                mediaType: reference.mediaType,
              };
            }),
            ...(content ? [{ type: "text" as const, text: content }] : []),
          ],
    };
  });
}

export function chatWireMessages(
  messages: readonly ChatInputMessage[],
  cache?: { previousPrefixLength: number },
  replay?: ReadonlyMap<number, ReplayDetails>,
) {
  const imageIndices = messages.flatMap((message, index) =>
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "file")
      ? [index]
      : [],
  );
  return messages.map((message, index) => {
    const boundary =
      cache &&
      (index === messages.length - 1 ||
        index === cache.previousPrefixLength - 1);
    const content =
      typeof message.content === "string"
        ? boundary
          ? [
              {
                type: "text" as const,
                text: message.content,
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : message.content
        : message.content.map((part, i, parts) => ({
            ...(part.type === "text"
              ? part
              : {
                  type: "image_url" as const,
                  image_url: {
                    url: `data:${part.mediaType};base64,${part.data.toString("base64")}`,
                  },
                }),
            ...(cache &&
            ((boundary && i === parts.length - 1) ||
              (part.type === "file" &&
                (index === imageIndices[0] || index === imageIndices.at(-1)) &&
                parts[i + 1]?.type !== "file"))
              ? { cache_control: { type: "ephemeral" as const } }
              : {}),
          }));
    return {
      role: message.role,
      content,
      ...(replay?.has(index) ? { reasoning_details: replay.get(index) } : {}),
    };
  });
}
