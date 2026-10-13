import { PreparationError } from "./generation-budget.js";
import type { Cell, Grid } from "./domain.js";
import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import { inferenceSignature } from "./prepared-inference.js";

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
  const matches = new Map<Cell, Cell[]>();
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
    if (match) {
      const destinations = matches.get(match) ?? [];
      destinations.push(cell);
      matches.set(match, destinations);
    }
  }
  for (const [source, destinations] of matches) {
    const bundle = await store.files.readArtifact(
      source.id,
      source.provenance!.files,
      source.thinkingId,
    );
    if (!bundle) continue;
    // Keep at most one source bundle in memory and read it once for all matches.
    for (const cell of destinations) {
      cell.thinkingId = await store.files.writeArtifact(cell.id, bundle);
      cell.status = "complete";
      cell.mediaType = source.mediaType;
      cell.usage = source.usage;
      cell.provenance = source.provenance;
    }
  }
}
