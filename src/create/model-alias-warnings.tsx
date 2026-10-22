import type { ModelInfo } from "../../server/model-catalog";
import { isMovingModelAlias } from "../../server/model-alias";
import { WarningMessage } from "../components/feedback-message";

export function ModelAliasWarnings({
  models,
  values,
}: {
  models: readonly ModelInfo[];
  values: readonly string[];
}) {
  return values.map((id) => {
    const model = models.find((model) => model.id === id);
    return model?.canonicalSlug && isMovingModelAlias(model) ? (
      <WarningMessage data-model-alias-warning={id} key={id}>
        {`The model alias ${id} is a reference to ${model.canonicalSlug}, which is not an established model snapshot. In the future, the alias may move its target without the ability to refer to the old snapshot`}
      </WarningMessage>
    ) : null;
  });
}
