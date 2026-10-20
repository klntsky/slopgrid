import type { ChatMessage, FilledChatMessage } from "../server/domain.js";

export function readChatOutput(json: string): FilledChatMessage[] {
  const messages: unknown = JSON.parse(json);
  if (
    !Array.isArray(messages) ||
    messages.some(
      (message) =>
        !message ||
        typeof message !== "object" ||
        (message.role !== "system" &&
          message.role !== "user" &&
          message.role !== "assistant") ||
        typeof message.content !== "string" ||
        (message.images !== undefined &&
          (message.role !== "user" ||
            !Array.isArray(message.images) ||
            message.images.some(
              (image: unknown) =>
                !image ||
                typeof image !== "object" ||
                !("id" in image) ||
                typeof image.id !== "string" ||
                !image.id ||
                !("name" in image) ||
                typeof image.name !== "string" ||
                !image.name ||
                (("width" in image || "height" in image) &&
                  (!("width" in image) ||
                    !("height" in image) ||
                    typeof image.width !== "number" ||
                    typeof image.height !== "number" ||
                    !Number.isInteger(image.width) ||
                    !Number.isInteger(image.height) ||
                    image.width <= 0 ||
                    image.height <= 0)),
            ))),
    )
  )
    throw new Error("Invalid chat output.");
  return messages as FilledChatMessage[];
}

export function writeChatOutput(
  messages: readonly FilledChatMessage[],
): string {
  return JSON.stringify(
    messages.map(({ role, content }) => ({ role, content })),
    null,
    2,
  );
}

export function withChatImages(
  messages: readonly FilledChatMessage[],
  template: readonly ChatMessage[] = [],
): FilledChatMessage[] {
  return messages.map(({ role, content }, index) => {
    const images = template[index]?.images;
    return {
      role,
      content,
      ...(role === "user" && images?.length ? { images } : {}),
    };
  });
}
