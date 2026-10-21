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

export function ImageOptions({
  input,
  onAction,
  compatibility,
  onMove,
}: {
  compatibility: CompatibilityTables;
  input: GridDraftInput;
  onAction: (action: InputAction) => void;
  onMove: (parameter: CommonParameterId, side: AxisSide) => void;
}) {
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
              <label>
                <span className="parameter-name">
                  {parameterNames[parameter]}
                </span>
                <select
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
              </label>
              {custom && (
                <CustomImageSize
                  label="Custom size"
                  value={value}
                  onChange={(size) => select(parameter, size)}
                />
              )}
              {compatibility[parameter]}
              <CommonParameterActions
                input={input}
                parameter={parameter}
                onMove={onMove}
              />
            </div>
          );
        },
      )}
    </div>
  );
}
