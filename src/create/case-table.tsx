import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Plus,
  X,
} from "lucide-react";
import {
  efforts,
  isChatFormat,
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
import { PromptEditor } from "./prompt-editor";
import { ChatEditor } from "./chat-editor";
import { tooltipRef } from "../components/use-tooltip";
import "./case-table.css";

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
  parameter: Exclude<CommonParameterId, "input">;
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
    messageIndex?: number,
  ) => ReactNode;
}) {
  const side = input.caseAxis;
  if (!side) return null;
  const fields = fieldsFor(input, side);
  const entries = input[side];
  const rowCases = side === "rows";
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
      <div className="case-header-rail">
        <span className={side === "rows" ? "row-label" : undefined}>
          Case {index + 1}
        </span>
        <span className="case-header-controls">
          {([-1, 1] as const).map((direction) => {
            const earlier = direction === -1;
            const disabled = earlier
              ? index === 0
              : index === entries.length - 1;
            const label = `Move ${name} case ${index + 1} ${earlier ? "earlier" : "later"}`;
            const Icon =
              side === "rows"
                ? earlier
                  ? ArrowUp
                  : ArrowDown
                : earlier
                  ? ArrowLeft
                  : ArrowRight;
            return (
              <span
                key={direction}
                ref={tooltipRef}
                data-tooltip={label}
                tabIndex={disabled ? 0 : undefined}
              >
                <button
                  type="button"
                  className="text-button editor-icon-button"
                  aria-label={label}
                  disabled={disabled}
                  onClick={() =>
                    onAction({
                      type: "move-case",
                      side,
                      index,
                      to: index + direction,
                    })
                  }
                >
                  <Icon aria-hidden="true" />
                </button>
              </span>
            );
          })}
          <span
            ref={tooltipRef}
            data-tooltip={
              entries.length <= 1
                ? "Keep at least one case"
                : `Remove ${name} case ${index + 1} and its values`
            }
            tabIndex={entries.length <= 1 ? 0 : undefined}
          >
            <button
              type="button"
              className="text-button editor-icon-button editor-icon-danger"
              aria-label={`Remove ${name} case ${index + 1}`}
              disabled={entries.length <= 1}
              onClick={() => onAction({ type: "remove-case", side, index })}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        </span>
      </div>
    );
  }
  function header(side: AxisSide, field: LayoutField) {
    const vertical = side === "columns";
    const label =
      field.parameter === "variable"
        ? token(side, field.index)
        : field.parameter === "input"
          ? isChatFormat(input.format)
            ? "Chat history"
            : "Prompt"
          : parameterNames[field.parameter];
    return (
      <>
        <div className="layout-parameter-heading">
          <span className={vertical ? "row-label" : undefined}>{label}</span>
          {field.parameter === "variable" ? (
            <button
              type="button"
              className="text-button editor-icon-button editor-icon-danger"
              ref={tooltipRef}
              data-tooltip={`Remove ${label} and its values from all cases`}
              aria-label={`Remove ${label}`}
              onClick={() =>
                onAction({ type: "remove-variable", side, index: field.index })
              }
            >
              <X aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="text-button editor-icon-button"
              ref={tooltipRef}
              data-tooltip={`Return ${parameterNames[field.parameter].toLowerCase()} to common settings`}
              aria-label={`Make ${parameterNames[field.parameter].toLowerCase()} common`}
              onClick={() =>
                onAction({ type: "to-common", parameter: field.parameter })
              }
            >
              <X aria-hidden="true" />
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
    if (parameter === "input") {
      const messages = entry.input ?? [];
      const label = isChatFormat(input.format) ? "Chat history" : "Prompt";
      return (
        <div
          role="group"
          aria-label={`${side === "rows" ? "Row" : "Column"} case ${caseIndex + 1} ${label}`}
        >
          {isChatFormat(input.format) ? (
            <ChatEditor
              messages={messages}
              onBusy={onBusy}
              onChange={(change) =>
                onAction({
                  type: "edit-input",
                  source: side,
                  caseIndex,
                  change,
                })
              }
              compatibility={(messageIndex) =>
                compatibility(side, "input", caseIndex, undefined, messageIndex)
              }
            />
          ) : (
            <PromptEditor
              prompt={messages[0]?.content ?? ""}
              onPromptChange={(content) =>
                onAction({
                  type: "edit-input",
                  source: side,
                  caseIndex,
                  change: (current) => [
                    { ...current[0], role: "user", content },
                  ],
                })
              }
              attachments={{
                images: messages[0]?.images ?? [],
                onBusy,
                onChange: (images) =>
                  onAction({
                    type: "edit-input",
                    source: side,
                    caseIndex,
                    change: (current) => [
                      {
                        ...current[0],
                        role: "user",
                        content: current[0]?.content ?? "",
                        images,
                      },
                    ],
                  }),
              }}
            />
          )}
          {!isChatFormat(input.format) &&
            compatibility(side, "input", caseIndex)}
        </div>
      );
    }
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
  const addCase = (
    <button
      type="button"
      className="text-button case-axis-add"
      aria-label={`Add ${sideName(side)} case`}
      ref={tooltipRef}
      data-tooltip={`Add a ${sideName(side)} case`}
      onClick={() => onAction({ type: "add-case", side })}
    >
      <Plus aria-hidden="true" /> Add {sideName(side)} case
    </button>
  );
  const addVariable = (
    <span
      ref={tooltipRef}
      data-tooltip={
        entries.length
          ? "Add an optional field to every case"
          : "Add a case before adding a variable"
      }
      tabIndex={!entries.length ? 0 : undefined}
    >
      <button
        type="button"
        className="text-button case-axis-add"
        aria-label={`Add ${sideName(side)} variable`}
        disabled={!entries.length}
        onClick={() => onAction({ type: "add-variable", side })}
      >
        <Plus aria-hidden="true" /> Add variable
      </button>
    </span>
  );
  return (
    <div
      className="variable-editor"
      data-populated={entries.length > 0 && fields.length > 0}
      data-case-axis={side}
    >
      {entries.length ? (
        <>
          <p className="hint case-scroll-guidance">
            Scroll within the table to see more cases or fields. Case and field
            labels stay visible.
          </p>
          <div
            className="variable-table-scroll"
            role="region"
            aria-label="Editable case parameters; scroll for more cases and fields"
            tabIndex={0}
          >
            <div className="case-table-plane">
              <table
                className="variable-table layout-parameter-table"
                aria-label="Grid layout parameters"
                style={{
                  minWidth: `calc(var(--case-label-width) + ${rowCases ? fields.length : entries.length} * 300px)`,
                }}
              >
                <colgroup>
                  <col style={{ width: "var(--case-label-width)" }} />
                  {(rowCases ? fields.length : entries.length) > 0 && (
                    <col span={rowCases ? fields.length : entries.length} />
                  )}
                </colgroup>
                <thead>
                  <tr>
                    <td className="variable-corner" />
                    {rowCases
                      ? fields.map((field) => (
                          <th
                            scope="col"
                            key={fieldKey(field)}
                            data-field={field.parameter}
                          >
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
                              data-field={field.parameter}
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
                              data-field={field.parameter}
                            >
                              {editor(side, field, index)}
                            </td>
                          ))}
                        </tr>
                      ))}
                </tbody>
              </table>
              <div className="case-table-trailing-column">
                {rowCases ? addVariable : addCase}
              </div>
              <div className="case-table-trailing-row">
                {rowCases ? addCase : addVariable}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="variable-table-actions">
          {addCase}
          {addVariable}
        </div>
      )}
      <p className="hint">
        Each case is one {sideName(side)}. Add generator input or other settings
        to cases, or reference optional numbered fields in the input or judge
        criteria. Text and images are optional in each field.
      </p>
    </div>
  );
}
