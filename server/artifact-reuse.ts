import {
  generationBudgetForInput,
  PreparationError,
} from "./generation-budget.js";
import { hasCompletedOutput, type Cell, type Grid } from "./domain.js";
import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import { inferenceSignature, templateSignature } from "./prepared-inference.js";
import { templateFits, templateSequence } from "./chat-template.js";

export async function reuseArtifacts(
  store: Store,
  provider: Provider,
  source: Grid,
  format: Grid["input"]["format"],
  cells: Cell[],
) {
  const candidates = new Map<string, Cell[]>();
  for (const cell of source.cells) {
    if (!hasCompletedOutput(cell) || !cell.provenance?.files.length) continue;
    const key = cell.provenance.signature;
    const group = candidates.get(key) ?? [];
    group.push(cell);
    candidates.set(key, group);
  }
  if (!candidates.size) return;
  const groups = new Map<string, Cell[]>();
  for (const cell of cells) {
    const key = cell.judge ? (cell.generationSourceId ?? cell.id) : cell.id;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  const matches = new Map<Cell, Cell[]>();
  const readReferences = store.references.loader();
  for (const group of groups.values()) {
    const cell =
      group.find((cell) => cell.id === cell.generationSourceId) ?? group[0];
    let match: Cell | undefined;
    try {
      if (format === "chat-template") {
        const matching = candidates.get(templateSignature(cell));
        if (!matching) continue;
        const model = (await provider.models()).find(
          (model) => model.id === cell.model,
        );
        if (!model) continue;
        const calls = templateSequence(cell.messages ?? []).filter(
          (m) => m.role === "unfilled",
        ).length;
        match = matching.find((candidate) => {
          const steps = candidate.provenance?.templateSteps;
          if (!steps?.length || steps.length !== calls) return false;
          try {
            return templateFits(steps, cell.budgetUsd, (inputTokens, dollars) =>
              generationBudgetForInput(model, inputTokens, dollars),
            );
          } catch (error) {
            if (error instanceof PreparationError) return false;
            throw error;
          }
        });
      } else {
        const prepared = await provider.prepare(
          format,
          cell,
          await readReferences(cell.imageSettings?.input_references ?? []),
        );
        match = candidates
          .get(inferenceSignature(prepared))
          ?.find((candidate) => {
            if (
              prepared.format === "image" ||
              prepared.text.maxOutputTokens === undefined
            )
              return true;
            // Reported completion tokens include reasoning; otherwise the original
            // ceiling must fit, since an unknown usage cannot prove compatibility.
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
      }
    } catch (error) {
      if (error instanceof PreparationError) continue;
      throw error;
    }
    if (match) {
      const destinations = matches.get(match) ?? [];
      destinations.push(...group);
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
      cell.status = cell.judge ? "pending" : "complete";
      if (cell.generationSourceId === cell.id)
        cell.generationStatus = "complete";
      cell.mediaType = source.mediaType;
      cell.usage = source.usage;
      cell.provenance = source.provenance;
    }
  }
}
