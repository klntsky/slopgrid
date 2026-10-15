import type { ModelInfo } from "../../server/model-catalog";
import { isMovingModelAlias } from "../../server/model-resolution";
export function ModelAliasWarnings({
  models,
  values,
}: {
  models: readonly ModelInfo[];
  values: readonly string[];
}) {
  return (
    <>
      {models
        .filter(
          (m) =>
            values.includes(m.id) && isMovingModelAlias(m) && m.canonicalSlug,
        )
        .map((m) => (
          <p key={m.id} data-model-alias-warning={m.id}>
            ⚠️ The model alias {m.id} is a reference to {m.canonicalSlug}, which
            is not an established model snapshot. In the future, the alias may
            move its target without the ability to refer to the old snapshot
          </p>
        ))}
    </>
  );
}
