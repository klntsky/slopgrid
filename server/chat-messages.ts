import type { ChatMessage, FilledChatMessage } from "./domain.js";
import type { ReferenceContent } from "./image-references.js";

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
  images: readonly ReferenceContent[] = [],
): ChatInputMessage[] {
  const messages: ChatInputMessage[] = history.map(({ role, content }) => {
    if (role === "unfilled")
      throw new Error("Unfilled messages must be expanded before inference.");
    return { role, content };
  });
  if (!images.length) return messages;
  const index = history.findIndex((message) => message.role === "user");
  const text = index < 0 ? "" : history[index].content;
  const user: ChatInputMessage = {
    role: "user",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map(({ bytes, mediaType }) => ({
        type: "file" as const,
        data: bytes,
        mediaType,
      })),
    ],
  };
  if (index < 0) messages.unshift(user);
  else messages[index] = user;
  return messages;
}
