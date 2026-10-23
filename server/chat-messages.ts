import type { ChatMessage, FilledChatMessage } from "./domain.js";
import type { ReferenceInputs } from "./image-references.js";

export type ChatInputMessage =
  | FilledChatMessage
  | {
      role: "user";
      content: (
        | { type: "text"; text: string }
        | { type: "file"; data: Buffer; mediaType: string }
      )[];
    };

export function chatMessages(
  history: readonly ChatMessage[],
  references?: ReferenceInputs,
): ChatInputMessage[] {
  return history.map(({ role, content, images }) => {
    if (role === "unfilled")
      throw new Error("Unfilled messages must be expanded before inference.");
    if (!images?.length) return { role, content };
    if (role !== "user")
      throw new Error("Only user messages support image inputs.");
    return {
      role,
      content: [
        ...images.map(({ id }) => {
          const image = references?.get(id);
          if (!image) throw new Error("Reference image is unavailable");
          return {
            type: "file" as const,
            data: image.bytes,
            mediaType: image.mediaType,
          };
        }),
        ...(content ? [{ type: "text" as const, text: content }] : []),
      ],
    };
  });
}
