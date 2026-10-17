import { createHash } from "node:crypto";
import type { Cell, GridInput } from "./domain.js";
import type { Store } from "./store.js";
import type { ReferenceContent } from "./image-references.js";
import { readChatOutput } from "../shared/chat-output.js";
import { rasterizeSvg } from "./svg-raster.js";

const artifacts = new WeakMap<Store, Map<string, Promise<ReferenceContent>>>();

export function releaseJudgeArtifact(store: Store, sourceId: string): void {
  artifacts.get(store)?.delete(sourceId);
}

export async function loadJudgeArtifact(
  store: Store,
  format: GridInput["format"],
  cell: Cell,
  signal?: AbortSignal,
): Promise<string | ReferenceContent> {
  signal?.throwIfAborted();
  if (format === "html") throw new Error("Websites do not support a judge yet.");
  const bundle = await store.files.readArtifact(cell.id, cell.provenance?.files ?? []);
  signal?.throwIfAborted();
  const filename = format === "image" ? "image" : format === "svg" ? "index.svg" :
    format === "chat-template" ? (bundle?.files["messages.json"] ? "messages.json" : "index.md") : "index.md";
  const data = bundle?.files[filename];
  if (!data) throw new Error("The generated output is unavailable for judging.");
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (format === "markdown") return bytes.toString("utf8");
  if (format === "chat-template") return JSON.stringify(readChatOutput(bytes.toString("utf8")));
  const artifact = {
    bytes,
    mediaType: format === "svg" ? "image/svg+xml" : (cell.mediaType ?? "application/octet-stream"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (artifact.mediaType !== "image/svg+xml") return artifact;
  let cache = artifacts.get(store);
  if (!cache) artifacts.set(store, cache = new Map());
  const sourceId = cell.generationSourceId ?? cell.id;
  let prepared = cache.get(sourceId);
  if (!prepared) {
    prepared = rasterizeSvg(bytes, signal).catch((error) => {
      if (cache.get(sourceId) === prepared) cache.delete(sourceId);
      throw error;
    });
    cache.set(sourceId, prepared);
  }
  return prepared;
}
