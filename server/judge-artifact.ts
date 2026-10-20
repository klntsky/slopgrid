import { createHash } from "node:crypto";
import type { FilledChatMessage, GenerationTask } from "./domain.js";
import type { Store } from "./store.js";
import type { ReferenceContent } from "./image-references.js";
import { readChatOutput } from "../shared/chat-output.js";
import { rasterizeSvg } from "./svg-raster.js";

export type JudgeArtifact = string | ReferenceContent | FilledChatMessage[];
const artifacts = new WeakMap<Store, Map<string, Promise<ReferenceContent>>>();

export function releaseJudgeArtifact(store: Store, generationId: string): void {
  artifacts.get(store)?.delete(generationId);
}

export async function loadJudgeArtifact(
  store: Store,
  generation: GenerationTask,
  signal?: AbortSignal,
): Promise<JudgeArtifact> {
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
  if (format === "markdown") return bytes.toString("utf8");
  if (format === "chat-template") return readChatOutput(bytes.toString("utf8"));
  const artifact = {
    bytes,
    mediaType:
      format === "svg"
        ? "image/svg+xml"
        : (output.mediaType ?? "application/octet-stream"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (artifact.mediaType !== "image/svg+xml") return artifact;
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
  return prepared;
}
