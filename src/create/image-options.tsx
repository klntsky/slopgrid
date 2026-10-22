import { useId } from "react";
import type { CompatibilityTables } from "./compatibility-table";
import type { GridDraftInput } from "../../server/domain";
import {
  imageChoices,
  type ScalarImageKind,
} from "../../server/image-settings";
import {
  parameterNames,
  type AxisSide,
  type CommonParameterId,
} from "../../server/parameters";
import { CustomImageSize } from "./custom-image-size";
import type { InputAction } from "./change-axis";
import { CommonParameterActions } from "./axis-editor";
import { ValidationField } from "./validation-feedback";

export function ImageOptions({
  input,
  onAction,
  compatibility,
  onMove,
  disabled = false,
}: {
  compatibility: CompatibilityTables;
  input: GridDraftInput;
  onAction: (action: InputAction) => void;
  onMove: (parameter: CommonParameterId, side: AxisSide) => void;
  disabled?: boolean;
}) {
  const id = useId();
  function select(parameter: ScalarImageKind, value: string) {
    onAction({ type: "common", parameter, value });
  }
  return (
    <div className="image-options">
      {(["size", "aspect_ratio", "background", "quality"] as const).map(
        (parameter) => {
          const source = input.parameters[parameter];
          if (source?.kind !== "common") return null;
          const value = source.value;
          const custom =
            parameter === "size" && !imageChoices.size.includes(value);
          return (
            <div
              key={parameter}
              className={
                parameter === "quality" ? "image-quality-option" : undefined
              }
            >
              <div className="parameter-header">
                <label
                  className="parameter-name"
                  htmlFor={`${id}-${parameter}`}
                >
                  {parameterNames[parameter]}
                </label>
                <CommonParameterActions
                  input={input}
                  parameter={parameter}
                  onMove={onMove}
                  disabled={disabled}
                />
              </div>
              <ValidationField path={["parameters", parameter, "value"]}>
                {(validation) => (
                  <>
                    <select
                      id={`${id}-${parameter}`}
                      {...validation}
                      value={custom ? "custom" : value}
                      onChange={(event) =>
                        select(
                          parameter,
                          event.target.value === "custom"
                            ? "x"
                            : event.target.value,
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
                      {parameter === "size" && (
                        <option value="custom">Custom</option>
                      )}
                    </select>
                    {custom && (
                      <CustomImageSize
                        label="Custom size"
                        value={value}
                        onChange={(size) => select(parameter, size)}
                      />
                    )}
                  </>
                )}
              </ValidationField>
              {compatibility[parameter]}
            </div>
          );
        },
      )}
    </div>
  );
}
