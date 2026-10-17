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
  const candidates = new Map<string, Cell[]>();
  for (const cell of source.cells) {
    if (cell.status !== "complete" || !cell.provenance?.files.length) continue;
    const key = cell.provenance.signature;
    const group = candidates.get(key) ?? [];
    group.push(cell);
    candidates.set(key, group);
  }
  if (!candidates.size) return;
  const matches = new Map<Cell, Cell[]>();
  const readReferences = store.references.loader();
  for (const cell of cells) {
    let prepared;
    try {
      prepared = await provider.prepare(
        format,
        cell,
        await readReferences(cell.imageSettings?.input_references ?? []),
      );
    } catch (error) {
      if (error instanceof PreparationError) continue;
      throw error;
    }
    const matching = candidates.get(inferenceSignature(prepared));
    let templateMatch: Cell | undefined;
    if (format === "chat-template") {
      for (const candidate of matching ?? []) {
        if (await provider.templateFits(cell, candidate.provenance?.templateSteps)) {
          templateMatch = candidate;
          break;
        }
      }
    }
    const match = format === "chat-template" ? templateMatch : matching
      ?.find((candidate) => {
        if (prepared.format === "image") return true;
        if (prepared.text.maxOutputTokens === undefined) return true;
        // Reported completion tokens include reasoning. If usage is absent, only
        // the original request ceiling can establish that the output fits.
        const tokens =
          candidate.usage?.outputTokens ??
          candidate.provenance?.maxOutputTokens;
        return (
          tokens !== undefined &&
          Number.isFinite(tokens) &&
          tokens >= 0 &&
          tokens <= prepared.text.maxOutputTokens
        );
      });
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
