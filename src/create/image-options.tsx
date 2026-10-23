import { useId } from "react";
import type { CompatibilityTables } from "./compatibility-table";
import type { GridDraftInput } from "../../server/domain";
import type { ScalarImageKind } from "../../server/image-settings";
import {
  parameterNames,
  type AxisSide,
  type CommonParameterId,
} from "../../server/parameters";
import { ScalarControl } from "./scalar-control";
import type { InputAction } from "./change-axis";
import { CommonParameterActions } from "./axis-editor";
import { ValidationScope } from "./validation-feedback";

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
              <ValidationScope path={["parameters", parameter, "value"]}>
                <ScalarControl
                  id={`${id}-${parameter}`}
                  parameter={parameter}
                  value={value}
                  format={input.format}
                  models={[]}
                  onChange={(value) => select(parameter, value)}
                />
              </ValidationScope>
              {compatibility[parameter]}
            </div>
          );
        },
      )}
    </div>
  );
}
