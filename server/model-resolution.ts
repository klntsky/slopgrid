import type { GridInput } from "./domain.js";
import type { Model } from "./provider.js";

export class ModelResolutionError extends Error {}

export function resolveGridModels(
  input: GridInput,
  models: readonly Model[],
): GridInput {
  const catalog = new Map(models.map((model) => [model.id, model]));
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
      if (id.startsWith("~") || /[-:]latest(?:$|:)/i.test(id))
        throw new ModelResolutionError(
          `Cannot resolve ${id} to a concrete model. Choose a versioned model.`,
        );
      return id;
    }
  }
  const axis = (value: GridInput["rows"]): GridInput["rows"] =>
    value.kind === "model"
      ? { ...value, values: [...new Set(value.values.map(resolve))] }
      : { ...value, values: [...value.values] };
  const rows = axis(input.rows),
    columns = axis(input.columns);
  const model =
    rows.kind === "model"
      ? rows.values[0]
      : columns.kind === "model"
        ? columns.values[0]
        : resolve(input.model);
  return { ...input, model, rows, columns };
}
