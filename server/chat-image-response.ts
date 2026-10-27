import sharp from "sharp";
import { z } from "zod";
import type { ChatImage } from "./domain.js";
import type { ReplayDetails } from "./chat-messages.js";

const imagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string() }),
});
const record = z.record(z.string(), z.unknown());
const envelope = z.object({
  choices: z.array(
    z.object({ delta: record.nullish(), message: record.nullish() }),
  ),
});
const maximumBytes = 20 * 1024 * 1024;

async function decodeImage(url: string, index: number): Promise<ChatImage> {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || !match[2] || match[2].length > Math.ceil(maximumBytes / 3) * 4)
    throw new Error("The model returned an invalid chat image.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== match[2])
    throw new Error("The model returned an invalid chat image.");
  try {
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    const metadata = await decoder.metadata();
    const mediaType =
      metadata.format === "png"
        ? "image/png"
        : metadata.format === "jpeg"
          ? "image/jpeg"
          : metadata.format === "webp"
            ? "image/webp"
            : undefined;
    if (
      !mediaType ||
      mediaType !== match[1] ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error();
    await decoder.stats();
    const rotated =
      metadata.orientation !== undefined &&
      metadata.orientation >= 5 &&
      metadata.orientation <= 8;
    return {
      name: `image-${index + 1}.${metadata.format === "jpeg" ? "jpg" : metadata.format}`,
      mediaType,
      width: rotated ? metadata.height : metadata.width,
      height: rotated ? metadata.width : metadata.height,
      dataUrl: url,
    };
  } catch {
    throw new Error("The model returned an invalid chat image.");
  }
}

export function chatImageResponse() {
  const images: ChatImage[] = [];
  const reasoningDetails: ReplayDetails = [];
  const indexed = new Map<number, Record<string, unknown>>();
  let failure: Error | undefined;
  async function inspect(value: unknown) {
    const parsed = envelope.safeParse(value);
    if (!parsed.success)
      throw new Error("The model returned an invalid chat response.");
    const message =
      parsed.data.choices[0]?.delta ?? parsed.data.choices[0]?.message;
    if (!message) return;
    if (
      message.content !== undefined &&
      message.content !== null &&
      typeof message.content !== "string"
    )
      throw new Error("The model returned an invalid chat response.");
    if (message.images !== undefined && message.images !== null) {
      const parts = z.array(imagePart).safeParse(message.images);
      if (!parts.success)
        throw new Error("The model returned an invalid chat image.");
      for (const part of parts.data)
        images.push(await decodeImage(part.image_url.url, images.length));
    }
    if (
      message.reasoning_details !== undefined &&
      message.reasoning_details !== null
    ) {
      const details = z.array(record).safeParse(message.reasoning_details);
      if (!details.success)
        throw new Error("The model returned an invalid chat response.");
      for (const detail of details.data) {
        if (typeof detail.index !== "number") {
          reasoningDetails.push(detail);
          continue;
        }
        const previous = indexed.get(detail.index);
        if (!previous) {
          indexed.set(detail.index, detail);
          reasoningDetails.push(detail);
          continue;
        }
        for (const [key, value] of Object.entries(detail)) {
          if (
            ["data", "text", "summary"].includes(key) &&
            typeof value === "string" &&
            typeof previous[key] === "string"
          )
            previous[key] += value;
          else previous[key] = value;
        }
      }
    }
  }
  async function frame(text: string): Promise<string> {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return text;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      failure ??= new Error("The model returned an invalid chat response.");
      return ": invalid provider event";
    }
    const root = record.safeParse(value);
    if (root.success && "error" in root.data) return text;
    try {
      await inspect(value);
    } catch (error) {
      failure ??=
        error instanceof Error
          ? error
          : new Error("The model returned an invalid chat response.");
    }
    if (!root.success) return ": invalid provider event";
    const choices = z.array(record).safeParse(root.data.choices);
    if (!choices.success) return ": invalid provider event";
    function sdkMessage(value: unknown) {
      const parsed = record.safeParse(value);
      if (!parsed.success) return {};
      const {
        images: _images,
        content,
        reasoning_details,
        ...rest
      } = parsed.data;
      const details = z.array(record).safeParse(reasoning_details);
      const readable = details.success
        ? details.data.flatMap((detail) => {
            const type =
              detail.type ??
              (typeof detail.index === "number"
                ? indexed.get(detail.index)?.type
                : undefined);
            return type === "reasoning.text" || type === "reasoning.summary"
              ? [{ ...detail, type }]
              : [];
          })
        : [];
      return {
        ...rest,
        ...(typeof content === "string" ? { content } : {}),
        ...(readable.length ? { reasoning_details: readable } : {}),
      };
    }
    return `data: ${JSON.stringify({
      ...root.data,
      choices: choices.data.map((choice) => ({
        ...choice,
        ...(choice.delta != null ? { delta: sdkMessage(choice.delta) } : {}),
        ...(choice.message != null
          ? { message: sdkMessage(choice.message) }
          : {}),
      })),
    })}`;
  }
  return {
    images,
    reasoningDetails,
    get failure() {
      return failure;
    },
    wrap(response: Response): Response {
      if (!response.ok || !response.body) return response;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const fragments: string[] = [];
      let carriageReturn = false;
      let lineFeed = false;
      function append(text: string) {
        if (!text) return;
        if (lineFeed) {
          fragments.push("\n");
          lineFeed = false;
        }
        fragments.push(text);
      }
      async function consume(
        text: string,
        controller: TransformStreamDefaultController<Uint8Array>,
      ) {
        let start = 0;
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          if (carriageReturn) {
            carriageReturn = false;
            if (code !== 10) append("\r");
          }
          if (code !== 13 && code !== 10) continue;
          append(text.slice(start, index));
          start = index + 1;
          if (code === 13) {
            carriageReturn = true;
            continue;
          }
          if (lineFeed) {
            const event = fragments.join("");
            fragments.length = 0;
            lineFeed = false;
            controller.enqueue(encoder.encode((await frame(event)) + "\n\n"));
          } else lineFeed = true;
        }
        append(text.slice(start));
      }
      const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            await consume(decoder.decode(chunk, { stream: true }), controller);
          },
          async flush(controller) {
            await consume(decoder.decode(), controller);
            if (carriageReturn) append("\r");
            if (lineFeed) fragments.push("\n");
            const event = fragments.join("");
            if (event.trim()) {
              controller.enqueue(encoder.encode(await frame(event)));
            }
          },
        }),
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

export function safeProviderError(error: unknown): unknown {
  let cause = error;
  for (
    let depth = 0;
    depth < 8 && typeof cause === "object" && cause !== null;
    depth++
  ) {
    if (
      "name" in cause &&
      typeof cause.name === "string" &&
      /(?:TypeValidation|JSONParse|InvalidResponseData|InvalidPrompt|NoOutputGenerated|NoObjectGenerated)/.test(
        cause.name,
      )
    )
      return new Error("The model returned an invalid response.");
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return error;
}
