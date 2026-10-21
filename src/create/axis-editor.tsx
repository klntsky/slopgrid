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

export function usesBulkAxis(input: GridDraftInput, side: AxisSide): boolean {
  const members = axisParameters(input, side);
  if (
    members.length !== 1 ||
    members[0] === "variable" ||
    members[0] === "judge_criteria"
  )
    return false;
  const parameter = members[0];
  const values = input[side].map((entry) => entry[parameter]);
  if (
    (parameter === "model" || parameter === "judge_model") &&
    values.some((value) => !value)
  )
    return false;
  return new Set(values).size === values.length;
}

export function AxisEditor({
  input,
  side,
  onAction,
}: Pick<AxisProps, "input" | "side" | "onAction">) {
  const members = axisParameters(input, side);
  const kinds: ParameterId[] = [
    ...(input.format === "image"
      ? (["model", "variable", ...imageKinds] as const)
      : (["model", "effort", "variable"] as const)),
    "judge_model",
    "judge_effort",
  ];
  const label = side === "rows" ? "Rows" : "Columns";
  const summary = members.length !== 1 || !kinds.includes(members[0]);
  return (
    <div className="axis">
      <label className="axis-selector">
        <span className="axis-name">{label}:</span>
        <select
          aria-label={label}
          value={summary ? "summary" : members[0]}
          onChange={(event) =>
            onAction({
              type: "dimension",
              side,
              parameter: event.target.value as ParameterId,
            })
          }
        >
          {summary && (
            <option value="summary" disabled>
              {members.length
                ? members.map((kind) => parameterNames[kind]).join(" + ")
                : "Cases"}
            </option>
          )}
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
              {parameterNames[kind]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function AxisValues({
  input,
  side,
  models,
  judgeModels,
  onAction,
  onUploading,
  children,
}: AxisProps) {
  const parameter = axisParameters(input, side)[0];
  const label = side === "rows" ? "Rows" : "Columns";
  if (!parameter || parameter === "variable" || parameter === "judge_criteria")
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
      {(["rows", "columns"] as const).map((side) => (
        <span
          key={side}
          title={
            !input[side].length
              ? `Add a ${side === "rows" ? "row" : "column"} case first.`
              : undefined
          }
        >
          <button
            type="button"
            disabled={!input[side].length}
            onClick={() => onMove(parameter, side)}
          >
            Make {parameterNames[parameter]} a{" "}
            {side === "rows" ? "row" : "column"} variable
          </button>
        </span>
      ))}
    </div>
  );
}
