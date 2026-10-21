import type { Model } from "./provider.js";

export class ModelResolutionError extends Error {}

export function isMovingModelAlias(model: Pick<Model, "id" | "aliasTarget">) {
  return (
    !model.aliasTarget &&
    (model.id.startsWith("~") || /[-:]latest(?:$|:)/i.test(model.id))
  );
}

export function modelAliasResolver(
  catalog: ReadonlyMap<string, Pick<Model, "aliasTarget">>,
) {
  const resolved = new Map<string, string>();
  return (original: string): string => {
    const cached = resolved.get(original);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    let id = original;
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
      for (const alias of seen) resolved.set(alias, id);
      return id;
    }
  };
}
