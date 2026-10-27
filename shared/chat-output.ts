import { z } from "zod";
import { chatImageSchema, type FilledChatMessage } from "../server/domain.js";

const outputSchema = z.array(
  z.discriminatedUnion("role", [
    z.strictObject({
      role: z.literal("system"),
      content: z.string(),
      images: z.tuple([]).optional(),
    }),
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      images: z.array(chatImageSchema).optional(),
    }),
  ]),
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
