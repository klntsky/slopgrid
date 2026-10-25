import { z } from "zod";
import { chatImageSchema, type FilledChatMessage } from "../server/domain.js";

const outputSchema = z.array(
  z
    .strictObject({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      images: z.array(chatImageSchema).optional(),
    })
    .refine((message) => !message.images?.length || message.role !== "system"),
);

export function readChatOutput(json: string): FilledChatMessage[] {
  const parsed = outputSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error("Invalid chat output.");
  return parsed.data;
}

export function writeChatOutput(
  messages: readonly FilledChatMessage[],
): string {
  return JSON.stringify(
    messages.map(({ role, content, images }) => ({
      role,
      content,
      ...(images?.length ? { images } : {}),
    })),
    null,
    2,
  );
}
