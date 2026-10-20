import type { GridInput } from "./domain.js";
import type { Model } from "./provider.js";
import { imageInputIssue, judgeModelIssue } from "./compatibility.js";
import { judgeReferences } from "./image-settings.js";

export class ModelResolutionError extends Error {}

export function isMovingModelAlias(model: Pick<Model, "id" | "aliasTarget">) {
  return (
    !model.aliasTarget &&
    (model.id.startsWith("~") || /[-:]latest(?:$|:)/i.test(model.id))
  );
}

export function resolveGridModels(
  input: GridInput,
  models: readonly Model[],
): GridInput {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const imageInputs = judgeReferences(input).length > 0;
  function resolve(id: string): string {
    const seen = new Set<string>();
    while (true) {
      if (seen.has(id))
        throw new ModelResolutionError(
          `Cannot resolve ${id} to a concrete model. Choose a versioned model.`,
        );
      seen.add(id);
      const target = catalog.get(id)?.aliasTarget;
      if (target) {
        id = target;
        continue;
      }
      if (!catalog.has(id) && isMovingModelAlias({ id }))
        throw new ModelResolutionError(
          `Cannot resolve ${id} to a concrete model. Choose a versioned model.`,
        );
      return id;
    }
  }
  function resolveJudge(id: string): string {
    if (!id) throw new ModelResolutionError("Select a judge model.");
    const resolved = resolve(id);
    const issue = judgeModelIssue(
      catalog.get(resolved),
      input.format,
      imageInputs,
    );
    if (issue) throw new ModelResolutionError(issue);
    return resolved;
  }
  const axis = (value: GridInput["rows"]): GridInput["rows"] => {
    if (
      (value.kind === "judge_model" || value.kind === "judge_effort") &&
      !input.judge
    )
      throw new ModelResolutionError("Add a judge to use judge dimensions.");
    return value.kind === "model" || value.kind === "judge_model"
      ? {
          ...value,
          values: [
            ...new Set(
              value.values.map(value.kind === "model" ? resolve : resolveJudge),
            ),
          ],
        }
      : value.kind === "variable"
        ? { ...value, values: value.values.map((fields) => [...fields]) }
        : { ...value, values: [...value.values] };
  };
  if (input.judge && input.format === "html")
    throw new ModelResolutionError("Websites do not support a judge yet.");
  const rows = axis(input.rows),
    columns = axis(input.columns);
  const dimensions = [rows.kind, columns.kind];
  const model = dimensions.includes("model") ? "" : resolve(input.model);
  const judge = input.judge
    ? {
        ...input.judge,
        model: dimensions.includes("judge_model")
          ? ""
          : resolveJudge(input.judge.model),
      }
    : undefined;
  const resolved = {
    ...input,
    model,
    rows,
    columns,
    ...(judge ? { judge } : {}),
  };
  const issue = imageInputIssue(resolved, models);
  if (issue) throw new ModelResolutionError(issue);
  return resolved;
}
