import type { Cell, GridInput } from "./domain.js";
import type { Model } from "./provider.js";

export function effortLabel(effort: string): string {
  return effort === "default"
    ? "Model default"
    : effort === "none"
      ? "None"
      : effort;
}
export function compatibilityIssues(
  cells: readonly Pick<Cell, "model" | "effort">[],
  format: GridInput["format"],
  models: readonly Model[],
): string[] {
  const issues = new Set<string>();
  for (const cell of cells) {
    const model = models.find((m) => m.id === cell.model);
    if (!model) {
      issues.add(
        `${cell.model}: this model is unavailable in the OpenRouter catalog.`,
      );
      continue;
    }
    const name = `${model.name} (${model.id})`;
    if (format === "image" ? !model.image : !model.text) {
      issues.add(
        `${name}: does not support ${format === "image" ? "image" : "text"} output.`,
      );
      continue;
    }
    if (format === "image" || cell.effort === "default") continue;
    const supported = [
      "Model default",
      ...(model.reasoningEfforts ?? []).map(effortLabel),
    ].join(", ");
    if (cell.effort === "none" && model.reasoningMandatory) {
      issues.add(
        `${name}: requires thinking; None is not supported. Supported settings: ${supported}.`,
      );
    } else if (model.reasoningEfforts === undefined) {
      issues.add(
        `${name}: cannot verify thinking effort "${effortLabel(cell.effort)}" because OpenRouter does not publish its supported efforts. Choose Model default.`,
      );
    } else if (
      !model.reasoningEfforts.includes(cell.effort as GridInput["effort"])
    ) {
      const reason =
        model.reasoning && !model.reasoningEfforts.some((e) => e !== "none")
          ? `does not expose thinking-effort selection; "${effortLabel(cell.effort)}" is unsupported`
          : `does not support thinking effort "${effortLabel(cell.effort)}"`;
      issues.add(`${name}: ${reason}. Supported settings: ${supported}.`);
    }
  }
  return [...issues];
}
