import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
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
import { ReorderHandle } from "./reorder-handle";
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
  children,
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
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number>();
  const [dragTarget, setDragTarget] = useState<number>();
  const selectedSide = input.caseAxis;
  if (!selectedSide) return null;
  const side = selectedSide;
  const fields = fieldsFor(input, side);
  const entries = input[side];
  const rowCases = side === "rows";
  const chatInput =
    isChatFormat(input.format) &&
    fields.some((field) => field.parameter === "input");
  const columnWidths = rowCases
    ? fields.map((field) =>
        chatInput && field.parameter === "input" ? 420 : 300,
      )
    : entries.map(() => (chatInput ? 420 : 300));
  const requiredWidth = `calc(var(--case-label-width) + ${columnWidths.reduce((sum, width) => sum + width, 0)}px)`;
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
      <div className={`case-header-rail${side === "rows" ? " row-label" : ""}`}>
        <ReorderHandle
          index={index}
          label={`Move ${name} case ${index + 1}`}
          root={root}
          orientation={side === "rows" ? "vertical" : "horizontal"}
          itemSelector={
            side === "rows"
              ? ".layout-parameter-table > tbody > tr"
              : '.layout-parameter-table > thead > tr > th[scope="col"]'
          }
          count={entries.length}
          onMove={(from, to) =>
            onAction({ type: "move-case", side, index: from, to })
          }
          onDragChange={(source, target) => {
            setDragging(source);
            setDragTarget(target);
          }}
        />
        <span>Case {index + 1}</span>
        <span className="case-header-controls">
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
  function dragAttributes(index: number) {
    return {
      "data-dragging": dragging === index,
      "data-insertion":
        dragTarget === index
          ? "before"
          : index === entries.length - 1 && dragTarget === entries.length
            ? "after"
            : undefined,
    };
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
        <div className={`layout-parameter-heading${vertical ? " row-label" : ""}`}>
          <span>{label}</span>
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
              data-tooltip={`Return ${label.toLowerCase()} to common parameters`}
              aria-label={`Make ${label.toLowerCase()} common`}
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
  function add(kind: "case" | "variable") {
    const previousFocus = document.activeElement;
    onAction({ type: kind === "case" ? "add-case" : "add-variable", side });
    requestAnimationFrame(() => {
      if (
        document.activeElement !== document.body &&
        document.activeElement !== previousFocus
      )
        return;
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-add="${kind}"]`)
        ?.focus();
    });
  }
  function addCase() {
    return (
      <button
        type="button"
        className="text-button case-axis-add"
        aria-label="new case"
        data-add="case"
        onClick={() => add("case")}
      >
        <Plus aria-hidden="true" />
        new case
      </button>
    );
  }
  function addVariable() {
    return (
      <button
        type="button"
        className="text-button case-axis-add"
        aria-label="new variable"
        data-add="variable"
        disabled={!entries.length}
        onClick={() => add("variable")}
      >
        <Plus aria-hidden="true" />
        new variable
      </button>
    );
  }
  return (
    <div
      className="variable-editor"
      ref={root}
      style={{ "--case-required-width": requiredWidth } as CSSProperties}
      data-populated={entries.length > 0 && fields.length > 0}
      data-case-axis={side}
    >
      {entries.length ? (
        <>
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
              >
                <colgroup>
                  <col style={{ width: "var(--case-label-width)" }} />
                  {columnWidths.map((width, index) => (
                    <col
                      key={index}
                      style={
                        rowCases && fields.length > 1 && width !== 300
                          ? { width }
                          : undefined
                      }
                    />
                  ))}
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
                          <th
                            scope="col"
                            key={entry.id}
                            {...dragAttributes(index)}
                          >
                            {caseHeader(side, index)}
                          </th>
                        ))}
                  </tr>
                </thead>
                <tbody>
                  {rowCases
                    ? entries.map((entry, index) => (
                        <tr
                          key={entry.id}
                          {...dragAttributes(index)}
                        >
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
                              {...dragAttributes(index)}
                            >
                              {editor(side, field, index)}
                            </td>
                          ))}
                        </tr>
                      ))}
                </tbody>
              </table>
              <div className="case-table-footer">
                <div className="case-table-actions">
                  {addCase()}
                  {addVariable()}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="variable-table-actions">
          {addCase()}
          {addVariable()}
        </div>
      )}
      {children}
    </div>
  );
}
