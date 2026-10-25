import {
  generationBudgetForInput,
  PreparationError,
} from "./generation-budget.js";
import type { GenerationTask, Grid, WorkflowTask } from "./domain.js";
import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import { inferenceSignature, templateSignature } from "./prepared-inference.js";
import { templateFits, templateSequence } from "./chat-template.js";
import { referenceIds } from "./image-settings.js";
import type { ReferenceInputs } from "./image-references.js";
import { readChatOutput, writeChatOutput } from "../shared/chat-output.js";

export async function reuseArtifacts(
  store: Store,
  provider: Provider,
  source: Grid,
  tasks: readonly WorkflowTask[],
) {
  const candidates = new Map<string, GenerationTask[]>();
  for (const task of store.workflow(source.id)) {
    if (task.kind !== "generation" || !task.output?.provenance?.files.length)
      continue;
    const key = task.output.provenance.signature;
    const group = candidates.get(key) ?? [];
    group.push(task);
    candidates.set(key, group);
  }
  if (!candidates.size) return;
  let readReferences:
    ((ids: readonly string[]) => Promise<ReferenceInputs>) | undefined;
  const available = new Map<string, Promise<boolean>>();
  for (const task of tasks) {
    if (task.kind !== "generation") continue;
    const { format } = task.input;
    const parameters = task.input;
    let matching: GenerationTask[] | undefined;
    let fits: (candidate: GenerationTask) => boolean = () => true;
    try {
      const ids = referenceIds(parameters);
      const references = ids.length
        ? await (readReferences ??= store.references.loader())(ids)
        : undefined;
      if (format === "chat-template") {
        matching = candidates.get(templateSignature(parameters, references));
        if (!matching) continue;
        const model = (await provider.models()).find(
          (model) => model.id === parameters.model,
        );
        if (!model) continue;
        const calls = templateSequence(parameters.messages ?? []).filter(
          (m) => m.role === "unfilled",
        ).length;
        fits = (candidate) => {
          const steps = candidate.output?.provenance.templateSteps;
          if (!steps?.length || steps.length !== calls) return false;
          try {
            return templateFits(
              steps,
              parameters.budgetUsd,
              (inputTokens, dollars) =>
                generationBudgetForInput(model, inputTokens, dollars),
            );
          } catch (error) {
            if (error instanceof PreparationError) return false;
            throw error;
          }
        };
      } else {
        const prepared = await provider.prepare(format, parameters, references);
        matching = candidates.get(inferenceSignature(prepared));
        fits = (candidate) => {
          if (
            prepared.format === "image" ||
            prepared.text.maxOutputTokens === undefined
          )
            return true;
          // Reported completion tokens include reasoning; otherwise the original
          // ceiling must fit, since an unknown usage cannot prove compatibility.
          const tokens =
            candidate.output?.usage?.outputTokens ??
            candidate.output?.provenance.maxOutputTokens;
          return (
            tokens !== undefined &&
            Number.isFinite(tokens) &&
            tokens >= 0 &&
            tokens <= prepared.text.maxOutputTokens
          );
        };
      }
    } catch (error) {
      if (error instanceof PreparationError) continue;
      throw error;
    }
    for (const candidate of matching ?? []) {
      if (!fits(candidate)) continue;
      const output = candidate.output!;
      const key = JSON.stringify([
        output.artifactId,
        output.provenance.files,
        output.thinkingId,
        output.thinkingSourceId,
      ]);
      let content = available.get(key);
      if (!content) {
        content = store.files.hasArtifact(
          output.artifactId,
          output.provenance.files,
          output.thinkingId,
          output.thinkingSourceId,
        );
        available.set(key, content);
      }
      if (!(await content)) continue;
      const reused = structuredClone(output);
      if (format === "chat-template") {
        const bundle = await store.files.readArtifact(
          output.artifactId,
          output.provenance.files,
        );
        if (!bundle?.files["messages.json"]) continue;
        const original = Buffer.from(bundle.files["messages.json"]).toString(
          "utf8",
        );
        const messages = readChatOutput(original);
        let changed = false;
        for (const [index, configured] of (
          parameters.messages ?? []
        ).entries()) {
          if (configured.role === "unfilled" || !configured.images?.length)
            continue;
          const images = messages[index]?.images;
          if (!images || images.length !== configured.images.length)
            throw new Error(
              "Canonical chat output does not match its accepted input",
            );
          for (const [imageIndex, supplied] of configured.images.entries()) {
            if (images[imageIndex].name === supplied.name) continue;
            images[imageIndex].name = supplied.name;
            changed = true;
          }
        }
        if (changed) {
          const replacement = {
            ...bundle.files,
            "messages.json": Buffer.from(writeChatOutput(messages)),
          };
          reused.artifactId = store.files.writeImmutable(replacement);
        }
      }
      task.output = reused;
      task.status = "complete";
      break;
    }
  }
}
