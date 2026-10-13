import { PreparationError } from "./generation-budget.js";
import { readFileSync } from "node:fs";
import type { Cell, Grid } from "./domain.js";
import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import { inferenceSignature } from "./prepared-inference.js";
import { token } from "./ids.js";

export async function reuseArtifacts(
  store: Store,
  provider: Provider,
  source: Grid,
  format: Grid["input"]["format"],
  cells: Cell[],
) {
  const candidates = new Map<string, Cell>();
  for (const cell of source.cells)
    if (
      cell.status === "complete" &&
      cell.provenance?.files.length &&
      !candidates.has(cell.provenance.signature)
    )
      candidates.set(cell.provenance.signature, cell);
  if (!candidates.size) return;
  for (const cell of cells) {
    let prepared;
    try {
      prepared = await provider.prepare(
        format,
        cell,
        store.references.dataURLs(cell.imageSettings?.input_references ?? []),
      );
    } catch (error) {
      if (error instanceof PreparationError) continue;
      throw error;
    }
    const match = candidates.get(inferenceSignature(prepared));
    if (!match) continue;
    const files: Record<string, Uint8Array> = Object.create(null);
    let thinking: string | undefined;
    // Read the entire recorded inventory before writing anything. Only source
    // read failures are misses; destination and persistence errors propagate.
    try {
      for (const path of match.provenance!.files) {
        const file = store.files.path(match.id, path);
        if (!file) throw new Error("Missing artifact");
        files[path] = readFileSync(file);
      }
      if (match.thinkingId) {
        const file = store.files.thinkingPath(match.id, match.thinkingId);
        if (!file) throw new Error("Missing thinking");
        thinking = readFileSync(file, "utf8");
      }
    } catch {
      continue;
    }
    store.files.write(cell.id, files);
    if (thinking !== undefined) {
      cell.thinkingId = token();
      store.files.appendThinking(cell.id, cell.thinkingId, thinking);
    }
    cell.status = "complete";
    cell.mediaType = match.mediaType;
    cell.usage = match.usage;
    cell.provenance = match.provenance;
  }
}
