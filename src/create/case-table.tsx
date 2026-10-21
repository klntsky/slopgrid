import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import {
  efforts,
  type CaseRecord,
  type GridDraftInput,
  type ParameterValues,
} from "../../server/domain";
import { imageChoices } from "../../server/image-settings";
import { effortLabel } from "../../server/compatibility";
import {
  axisParameters,
  parameterNames,
  type AxisSide,
  type CommonParameterId,
  type ParameterId,
} from "../../server/parameters";
import type { Model } from "../../server/provider";
import { ModelSelector } from "./model-selector";
import { CriteriaEditor } from "./criteria-editor";
import { CustomImageSize } from "./custom-image-size";
import {
  caseValueAction,
  type InputAction,
  type ParameterSetter,
} from "./change-axis";
import { VariableInput } from "./variable-input";

type LayoutField =
  { parameter: CommonParameterId } | { parameter: "variable"; index: number };

function fieldsFor(input: GridDraftInput, side: AxisSide): LayoutField[] {
  const fields: LayoutField[] = [];
  for (const parameter of axisParameters(input, side)) {
    if (parameter === "variable") {
      for (const [index, field] of (input[side][0]?.variable ?? []).entries())
        if (field !== null) fields.push({ parameter, index });
    } else fields.push({ parameter });
  }
  return fields;
}

function fieldKey(field: LayoutField) {
  return field.parameter === "variable"
    ? `variable-${field.index}`
    : field.parameter;
}

function CaseValue({
  input,
  entry,
  parameter,
  models,
  judgeModels,
  onChange,
}: {
  input: GridDraftInput;
  entry: CaseRecord;
  parameter: CommonParameterId;
  models: Model[];
  judgeModels: Model[];
  onChange: ParameterSetter;
}) {
  if (parameter === "model" || parameter === "judge_model") {
    const value = entry[parameter] ?? "";
    return (
      <ModelSelector
        models={parameter === "model" ? models : judgeModels}
        judge={parameter === "judge_model"}
        format={input.format}
        values={value ? [value] : []}
        onChange={(values) => onChange(parameter, values[0] ?? "")}
      />
    );
  }
  if (parameter === "judge_criteria")
    return (
      <CriteriaEditor
        criteria={entry.judge_criteria ?? []}
        onChange={(value) => onChange(parameter, value)}
      />
    );
  if (parameter === "effort" || parameter === "judge_effort")
    return (
      <select
        aria-label={parameterNames[parameter]}
        value={entry[parameter] ?? "default"}
        onChange={(event) =>
          onChange(parameter, event.target.value as ParameterValues["effort"])
        }
      >
        {efforts.map((value) => (
          <option key={value} value={value}>
            {effortLabel(value)}
          </option>
        ))}
      </select>
    );
  const value = entry[parameter] ?? "auto";
  const custom = parameter === "size" && !imageChoices.size.includes(value);
  return (
    <>
      <select
        aria-label={parameterNames[parameter]}
        value={custom ? "custom" : value}
        onChange={(event) =>
          onChange(
            parameter,
            event.target.value === "custom" ? "x" : event.target.value,
          )
        }
      >
        {[
          ...new Set([...imageChoices[parameter], ...(custom ? [] : [value])]),
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
          onChange={(value) => onChange(parameter, value)}
        />
      )}
    </>
  );
}

export function GridLayoutTable({
  input,
  models,
  judgeModels,
  onAction,
  onBusy,
  compatibility,
}: {
  input: GridDraftInput;
  models: Model[];
  judgeModels: Model[];
  onAction: (action: InputAction) => void;
  onBusy: (busy: boolean) => void;
  compatibility: (
    side: AxisSide,
    parameter: ParameterId,
    caseIndex?: number,
    fieldIndex?: number,
  ) => ReactNode;
}) {
  const side = input.parameters.variable?.kind;
  if (!side) return null;
  const fields = fieldsFor(input, side);
  let variableFieldCount = 0;
  for (const field of fields)
    if (field.parameter === "variable") variableFieldCount++;
  const entries = input[side];
  const rowCases = side === "rows";
  const headerWidth = rowCases ? 58 : 92;
  function token(side: AxisSide, index: number) {
    return `$${side === "rows" ? "ROW" : "COLUMN"}${index + 1}`;
  }
  function sideName(side: AxisSide) {
    return side === "rows" ? "row" : "column";
  }
  function caseHeader(side: AxisSide, index: number) {
    const entries = input[side];
    const name = sideName(side);
    return (
      <>
        <span className={side === "rows" ? "row-label" : undefined}>
          Case {index + 1}
        </span>
        <button
          type="button"
          className="text-button"
          aria-label={`Move ${name} case ${index + 1} earlier`}
          disabled={index === 0}
          onClick={() =>
            onAction({ type: "move-case", side, index, to: index - 1 })
          }
        >
          <ArrowUp aria-hidden="true" />
        </button>
        <button
          type="button"
          className="text-button"
          aria-label={`Move ${name} case ${index + 1} later`}
          disabled={index === entries.length - 1}
          onClick={() =>
            onAction({ type: "move-case", side, index, to: index + 1 })
          }
        >
          <ArrowDown aria-hidden="true" />
        </button>
        <button
          type="button"
          className="text-button"
          aria-label={`Remove ${name} case ${index + 1}`}
          disabled={entries.length <= 1}
          onClick={() => onAction({ type: "remove-case", side, index })}
        >
          <X aria-hidden="true" />
        </button>
      </>
    );
  }
  function header(side: AxisSide, field: LayoutField) {
    const vertical = side === "columns";
    const label =
      field.parameter === "variable"
        ? token(side, field.index)
        : parameterNames[field.parameter];
    return (
      <>
        <div className="layout-parameter-heading">
          <span className={vertical ? "row-label" : undefined}>{label}</span>
          {field.parameter === "variable" ? (
            <button
              type="button"
              className="text-button"
              aria-label={`Remove ${label}`}
              disabled={variableFieldCount <= 1}
              onClick={() =>
                onAction({ type: "remove-variable", side, index: field.index })
              }
            >
              <X aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={`Make ${parameterNames[field.parameter].toLowerCase()} common`}
              onClick={() =>
                onAction({ type: "to-common", parameter: field.parameter })
              }
            >
              Make common
            </button>
          )}
        </div>
      </>
    );
  }
  function editor(side: AxisSide, field: LayoutField, caseIndex: number) {
    const entry = input[side][caseIndex];
    if (field.parameter === "variable") {
      const index = field.index;
      return (
        <VariableInput
          label={`${token(side, index)}, case ${caseIndex + 1}`}
          field={entry.variable?.[index] ?? { text: "" }}
          onBusy={onBusy}
          onChange={(value) =>
            onAction(
              caseValueAction(
                side,
                caseIndex,
                "variable",
                (entry.variable ?? [{ text: "" }]).map(
                  (previous, fieldIndex) =>
                    fieldIndex === index ? value : previous,
                ),
              ),
            )
          }
        >
          {compatibility(side, "variable", caseIndex, index)}
        </VariableInput>
      );
    }
    const parameter = field.parameter;
    return (
      <div
        role="group"
        aria-label={`${side === "rows" ? "Row" : "Column"} case ${caseIndex + 1} ${parameter === "judge_criteria" ? "judge criteria" : parameterNames[parameter]}`}
      >
        <CaseValue
          input={input}
          entry={entry}
          parameter={parameter}
          models={models}
          judgeModels={judgeModels}
          onChange={(parameter, value) =>
            onAction(caseValueAction(side, caseIndex, parameter, value))
          }
        />
        {compatibility(side, parameter, caseIndex)}
      </div>
    );
  }
  const actions = (
    <div className="variable-table-actions">
      <button
        type="button"
        className="text-button"
        aria-label={`Add ${sideName(side)} case`}
        onClick={() => onAction({ type: "add-case", side })}
      >
        <Plus aria-hidden="true" /> Add {sideName(side)} case
      </button>
      <button
        type="button"
        className="text-button"
        aria-label={`Add ${sideName(side)} variable`}
        disabled={!entries.length}
        onClick={() => onAction({ type: "add-variable", side })}
      >
        <Plus aria-hidden="true" /> Add variable
      </button>
    </div>
  );
  const columns = rowCases ? fields.length : entries.length;
  return (
    <div className="variable-editor">
      {entries.length ? (
        <div className="variable-table-scroll">
          <table
            className="variable-table layout-parameter-table"
            aria-label="Grid layout parameters"
            style={{ minWidth: `${headerWidth + columns * 256}px` }}
          >
            <colgroup>
              <col
                className="variable-row-header"
                style={{ width: headerWidth }}
              />
              {rowCases
                ? fields.map((field) => <col key={fieldKey(field)} />)
                : entries.map((entry) => <col key={entry.id} />)}
            </colgroup>
            <thead>
              <tr>
                <td className="variable-corner" />
                {rowCases
                  ? fields.map((field) => (
                      <th scope="col" key={fieldKey(field)}>
                        {header(side, field)}
                      </th>
                    ))
                  : entries.map((entry, index) => (
                      <th scope="col" key={entry.id}>
                        {caseHeader(side, index)}
                      </th>
                    ))}
              </tr>
            </thead>
            <tbody>
              {rowCases
                ? entries.map((entry, index) => (
                    <tr key={entry.id}>
                      <th scope="row">{caseHeader(side, index)}</th>
                      {fields.map((field) => (
                        <td
                          key={fieldKey(field)}
                          data-case-parameter={`${side}-${field.parameter}`}
                        >
                          {editor(side, field, index)}
                        </td>
                      ))}
                    </tr>
                  ))
                : fields.map((field) => (
                    <tr key={fieldKey(field)}>
                      <th scope="row">{header(side, field)}</th>
                      {entries.map((entry, index) => (
                        <td
                          key={entry.id}
                          data-case-parameter={`${side}-${field.parameter}`}
                        >
                          {editor(side, field, index)}
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={columns + 1}>{actions}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        actions
      )}
      <p className="hint">
        Each case is one {sideName(side)}. Reference numbered variables in the
        prompt or judge criteria. Text and images are optional in each field.
      </p>
    </div>
  );
}
