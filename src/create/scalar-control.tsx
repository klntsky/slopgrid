import { efforts, type GridDraftInput } from "../../server/domain";
import { imageChoices } from "../../server/image-settings";
import { effortLabel } from "../../server/compatibility";
import { parameterNames } from "../../server/parameters";
import type { Model } from "../../server/provider";
import type { ScalarParameterId } from "./change-axis";
import { ModelSelector } from "./model-selector";
import { CustomImageSize } from "./custom-image-size";
import { ValidationField } from "./validation-feedback";

export function ScalarControl({
  parameter,
  value,
  format,
  models,
  id,
  initialFilter,
  onFilterChange,
  onChange,
}: {
  parameter: ScalarParameterId;
  value: string;
  format: GridDraftInput["format"];
  models: Model[];
  id?: string;
  initialFilter?: string;
  onFilterChange?: (filter: string) => void;
  onChange: (value: string) => void;
}) {
  return (
    <ValidationField>
      {(validation) => {
        if (parameter === "model" || parameter === "judge_model")
          return (
            <div role="group" {...validation}>
              <ModelSelector
                models={models}
                judge={parameter === "judge_model"}
                format={format}
                values={value ? [value] : []}
                onChange={(values) => onChange(values[0] ?? "")}
                initialFilter={initialFilter}
                onFilterChange={onFilterChange}
              />
            </div>
          );
        if (parameter === "effort" || parameter === "judge_effort")
          return (
            <select
              id={id}
              aria-label={parameterNames[parameter]}
              {...validation}
              value={value}
              onChange={(event) => onChange(event.target.value)}
            >
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabel(effort)}
                </option>
              ))}
            </select>
          );
        const custom =
          parameter === "size" && !imageChoices.size.includes(value);
        return (
          <>
            <select
              id={id}
              aria-label={parameterNames[parameter]}
              {...validation}
              value={custom ? "custom" : value}
              onChange={(event) =>
                onChange(
                  event.target.value === "custom" ? "x" : event.target.value,
                )
              }
            >
              {[
                ...new Set([
                  ...imageChoices[parameter],
                  ...(custom ? [] : [value]),
                ]),
              ].map((choice) => (
                <option key={choice} value={choice}>
                  {choice === "auto" ? "Auto" : choice}
                </option>
              ))}
              {parameter === "size" && <option value="custom">Custom</option>}
            </select>
            {custom && (
              <CustomImageSize
                label="Custom size"
                value={value}
                validation={validation}
                onChange={onChange}
              />
            )}
          </>
        );
      }}
    </ValidationField>
  );
}
