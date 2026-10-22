import type { ReactNode } from "react";
import { imageKinds, imageChoices } from "../../server/image-settings";
import {
  efforts,
  type GridDraftInput,
  type ParameterValues,
} from "../../server/domain";
import {
  axisParameters,
  parameterNames,
  type AxisSide,
  type ParameterId,
  type CommonParameterId,
} from "../../server/parameters";
import { effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { ModelSelector } from "./model-selector";
import { CustomAxisSizes } from "./custom-image-size";
import { caseValuesAction, type InputAction } from "./change-axis";

type AxisProps = {
  input: GridDraftInput;
  side: AxisSide;
  models: Model[];
  judgeModels: Model[];
  onAction: (action: InputAction) => void;
  onUploading: (busy: boolean) => void;
  children?: ReactNode;
};

export function AxisEditor({
  input,
  side,
  onAction,
  children,
}: Pick<AxisProps, "input" | "side" | "onAction" | "children">) {
  const members = axisParameters(input, side);
  const kinds: ParameterId[] = [
    ...(input.format === "image"
      ? (["model", "variable", ...imageKinds] as const)
      : (["model", "effort", "variable"] as const)),
    "judge_model",
    "judge_effort",
  ];
  const label = side === "rows" ? "Rows" : "Columns";
  const dimension =
    input.parameters.variable?.kind === side ? "variable" : members[0];
  return (
    <div className="axis">
      <label className="axis-selector">
        <span className="axis-name">{label}:</span>
        <select
          aria-label={label}
          value={dimension ?? "single"}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "single") onAction({ type: "single", side });
            else {
              const parameter = kinds.find((kind) => kind === value);
              if (parameter) onAction({ type: "dimension", side, parameter });
            }
          }}
        >
          <option value="single">
            Single {side === "rows" ? "row" : "column"}
          </option>
          {kinds.map((kind) => (
            <option
              key={kind}
              value={kind}
              disabled={
                input.parameters[kind]?.kind ===
                  (side === "rows" ? "columns" : "rows") ||
                (!input.judge &&
                  (kind === "judge_model" || kind === "judge_effort"))
              }
            >
              {kind === "variable"
                ? "Multiple variable cases"
                : parameterNames[kind]}
            </option>
          ))}
        </select>
      </label>
      {children}
    </div>
  );
}

export function AxisValues({
  input,
  side,
  models,
  judgeModels,
  onAction,
  children,
}: AxisProps) {
  const parameter = axisParameters(input, side)[0];
  const label = side === "rows" ? "Rows" : "Columns";
  if (
    input.parameters.variable?.kind === side ||
    !parameter ||
    parameter === "variable" ||
    parameter === "judge_criteria"
  )
    return null;
  const values = input[side].map((entry) => entry[parameter]);
  function change<K extends ParameterId>(
    parameter: K,
    values: ParameterValues[NoInfer<K>][],
  ) {
    onAction(caseValuesAction(side, parameter, values));
  }
  const strings = values as string[];
  const choices =
    parameter === "effort" || parameter === "judge_effort"
      ? efforts.map((effort) => ({ id: effort, name: effortLabel(effort) }))
      : [
          ...new Set([
            ...(imageChoices[parameter as keyof typeof imageChoices] ?? []),
            ...(parameter === "size" ? [] : strings),
          ]),
        ].map((value) => ({
          id: value,
          name: value === "auto" ? "Auto" : value,
        }));
  return (
    <>
      <fieldset
        aria-label={side === "rows" ? "Row values" : "Column values"}
        data-case-parameter={`${side}-${parameter}`}
      >
        {parameter === "model" || parameter === "judge_model" ? (
          <ModelSelector
            multiple
            label={label}
            models={parameter === "judge_model" ? judgeModels : models}
            judge={parameter === "judge_model"}
            format={input.format}
            values={strings}
            onChange={(values) => change(parameter, values)}
          />
        ) : (
          <div className="value-list">
            {choices.map((choice) => (
              <label className="checkbox" key={choice.id}>
                <input
                  type="checkbox"
                  aria-label={choice.name}
                  checked={strings.includes(choice.id)}
                  onChange={(event) => {
                    const selected = new Set(strings);
                    if (event.target.checked) selected.add(choice.id);
                    else selected.delete(choice.id);
                    if (parameter === "effort" || parameter === "judge_effort")
                      change(
                        parameter,
                        efforts.filter((effort) => selected.has(effort)),
                      );
                    else change(parameter, [...selected]);
                  }}
                />
                <span>{choice.name}</span>
              </label>
            ))}
          </div>
        )}
        {parameter === "size" && (
          <CustomAxisSizes
            label={label}
            values={strings}
            onChange={(values) => change(parameter, values)}
          />
        )}
      </fieldset>
      {children}
      <button
        type="button"
        className="text-button"
        aria-label={`Make ${parameterNames[parameter].toLowerCase()} common`}
        onClick={() => onAction({ type: "to-common", parameter })}
      >
        Make {parameterNames[parameter].toLowerCase()} common
      </button>
    </>
  );
}

export function CommonParameterActions({
  input,
  parameter,
  onMove,
}: {
  input: GridDraftInput;
  parameter: CommonParameterId;
  onMove: (parameter: CommonParameterId, side: AxisSide) => void;
}) {
  return (
    <div className="variable-table-actions">
      {(["rows", "columns"] as const).map((side) => {
        const disabled =
          parameter === "judge_criteria" &&
          input.parameters.variable?.kind !== side;
        const explanation = disabled
          ? `Select Prompt variables for ${side === "rows" ? "Rows" : "Columns"} to use per-case judge criteria.`
          : undefined;
        return (
          <span key={side}>
            <button
              type="button"
              disabled={disabled}
              aria-describedby={
                disabled ? `judge-criteria-${side}-explanation` : undefined
              }
              onClick={() => onMove(parameter, side)}
            >
              Make {parameterNames[parameter]} a{" "}
              {side === "rows" ? "row" : "column"} variable
            </button>
            {explanation && (
              <span className="hint" id={`judge-criteria-${side}-explanation`}>
                {explanation}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
