import type { FilledChatMessage } from "../server/domain.js";

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
        typeof message.content !== "string",
    )
  )
    throw new Error("Invalid chat output.");
  return messages as FilledChatMessage[];
}
