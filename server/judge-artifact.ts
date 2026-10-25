import type { GenerationTask } from "./domain.js";
import type { Store } from "./store.js";
import type { ReferenceContent, ReferenceInputs } from "./image-references.js";
import { readChatOutput } from "../shared/chat-output.js";
import { rasterizeSvg } from "./svg-raster.js";
import {
  chatMessages,
  inputChatMessages,
  type ChatInputMessage,
} from "./chat-messages.js";
import { referenceIds } from "./image-settings.js";

const artifacts = new WeakMap<Store, Map<string, Promise<ReferenceContent>>>();

export function releaseJudgeArtifact(store: Store, generationId: string): void {
  artifacts.get(store)?.delete(generationId);
}

export async function loadJudgeMessages(
  store: Store,
  generation: GenerationTask,
  signal?: AbortSignal,
  inputReferences?: ReferenceInputs,
): Promise<ChatInputMessage[]> {
  signal?.throwIfAborted();
  const { format } = generation.input;
  const output = generation.output;
  if (!output)
    throw new Error("The generated output is unavailable for judging.");
  if (format === "html")
    throw new Error("Websites do not support a judge yet.");
  const bundle = await store.files.readArtifact(
    output.artifactId,
    output.provenance.files,
  );
  signal?.throwIfAborted();
  const filename =
    format === "image"
      ? "image"
      : format === "svg"
        ? "index.svg"
        : format === "chat-template"
          ? "messages.json"
          : "index.md";
  const data = bundle?.files[filename];
  if (!data)
    throw new Error("The generated output is unavailable for judging.");
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (format === "chat-template")
    return chatMessages(readChatOutput(bytes.toString("utf8")));
  const ids = referenceIds(generation.input);
  const references =
    inputReferences ??
    (ids.length ? await store.references.loader()(ids) : undefined);
  signal?.throwIfAborted();
  const sourceMessages = ids.length
    ? inputChatMessages(
        [
          {
            role: "user",
            content: generation.input.prompt,
            images: ids.map((id) => ({ id, name: id })),
          },
        ],
        references,
      )
    : [];
  if (format === "markdown")
    return [
      ...sourceMessages,
      { role: "assistant", content: bytes.toString("utf8") },
    ];
  const mediaType =
    format === "svg"
      ? "image/svg+xml"
      : (output.mediaType ?? "application/octet-stream");
  let image = { bytes, mediaType };
  if (mediaType === "image/svg+xml") {
    let cache = artifacts.get(store);
    if (!cache) artifacts.set(store, (cache = new Map()));
    const generationId = generation.id;
    let prepared = cache.get(generationId);
    if (!prepared) {
      prepared = rasterizeSvg(bytes, signal).catch((error) => {
        if (cache.get(generationId) === prepared) cache.delete(generationId);
        throw error;
      });
      cache.set(generationId, prepared);
    }
    image = await prepared;
  }
  // This is input to a separate judge call, not image output from the judge.
  // AI SDK 7 uses file parts for images; OpenRouter 3.1.0 encodes user image
  // files as image_url but drops assistant file parts.
  return [
    ...sourceMessages,
    {
      role: "user",
      content: [
        { type: "file", data: image.bytes, mediaType: image.mediaType },
      ],
    },
  ];
}
