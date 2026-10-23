import type { ReactNode } from "react";
import { CornerRightUp, ListOrdered } from "lucide-react";
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
import { useTooltip } from "../components/use-tooltip";
import { ValidationField } from "./validation-feedback";
import "./parameter-actions.css";

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
  const dimension = input.caseAxis === side ? "variable" : members[0];
  return (
    <ValidationField
      path={input.caseAxis === side ? ["caseAxis"] : [side]}
      descendants={input.caseAxis !== side}
    >
      {(validation) => (
        <div className="axis" role="group" {...validation}>
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
                  if (parameter)
                    onAction({ type: "dimension", side, parameter });
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
                    (kind === "variable" &&
                      !!input.caseAxis &&
                      input.caseAxis !== side) ||
                    input.parameters[kind]?.kind ===
                      (side === "rows" ? "columns" : "rows") ||
                    (!input.judge &&
                      (kind === "judge_model" || kind === "judge_effort"))
                  }
                >
                  {kind === "variable"
                    ? "Multiple cases"
                    : parameterNames[kind]}
                </option>
              ))}
            </select>
          </label>
          {children}
        </div>
      )}
    </ValidationField>
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
    input.caseAxis === side ||
    !parameter ||
    parameter === "variable" ||
    parameter === "judge_criteria" ||
    parameter === "input"
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
    </>
  );
}

export function CommonParameterActions({
  input,
  parameter,
  onMove,
  disabled = false,
}: {
  input: GridDraftInput;
  parameter: CommonParameterId;
  onMove: (parameter: CommonParameterId, side: AxisSide) => void;
  disabled?: boolean;
}) {
  const side = input.caseAxis;
  const reason =
    !side || !input[side].length
      ? 'Select "Multiple cases" for rows or columns first'
      : undefined;
  const tooltip = useTooltip<HTMLSpanElement>(reason);
  const name =
    parameter === "input"
      ? input.format === "chat-template"
        ? "chat history"
        : "prompt"
      : parameterNames[parameter].toLowerCase();
  return (
    <span
      className="parameter-actions"
      ref={tooltip}
      tabIndex={reason ? 0 : undefined}
    >
      <button
        type="button"
        className="text-button parameter-case-action"
        disabled={disabled || !!reason}
        aria-label={`define multiple cases for ${name}`}
        onClick={() => {
          if (side) onMove(parameter, side);
        }}
      >
        <ListOrdered aria-hidden="true" />
        define multiple cases
        <CornerRightUp aria-hidden="true" />
      </button>
    </span>
  );
}
