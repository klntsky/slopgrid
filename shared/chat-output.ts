import { z } from "zod";
import {
  generatedChatImageSchema,
  type ChatMessage,
  type FilledChatMessage,
} from "../server/domain.js";
import { referenceImageSchema } from "../server/image-settings.js";

const outputSchema = z.array(
  z
    .strictObject({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      images: z
        .array(
          z.union([generatedChatImageSchema, referenceImageSchema.strict()]),
        )
        .optional(),
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
      ...(images?.some((image) => "kind" in image)
        ? {
            images: images.filter((image) => "kind" in image),
          }
        : {}),
    })),
    null,
    2,
  );
}

export function withChatImages(
  messages: readonly FilledChatMessage[],
  template: readonly ChatMessage[] = [],
): FilledChatMessage[] {
  return messages.map((message, index) => {
    const images = message.images?.length
      ? message.images
      : template[index]?.images;
    return {
      ...message,
      ...((message.role === "user" || message.role === "assistant") &&
      images?.length
        ? { images }
        : {}),
    };
  });
}
