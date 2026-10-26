import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import tippy, { type Instance } from "tippy.js";
import { CornerRightUp, ListOrdered } from "lucide-react";
import { imageKinds, imageChoices } from "../../server/image-settings";
import {
  efforts,
  type GridDraftInput,
  type ParameterValues,
} from "../../server/domain";
import {
  axisParameters,
  isCaseAxis,
  parameterNames,
  type AxisSide,
  type ParameterId,
  type CommonParameterId,
} from "../../server/parameters";
import { effortLabel } from "../../server/compatibility";
import type { Model } from "../../server/provider";
import { ModelSelector } from "./model-selector";
import { CustomAxisSizes } from "./custom-image-size";
import {
  caseValuesAction,
  type InputAction,
  type ScalarParameterId,
} from "./change-axis";
import { useTooltip } from "../components/use-tooltip";
import {
  ValidationField,
  type ValidationAttributes,
} from "./validation-feedback";
import "./parameter-actions.css";

type AxisProps = {
  input: GridDraftInput;
  side: AxisSide;
  models: Model[];
  judgeModels: Model[];
  onAction: (action: InputAction) => void;
  validation: ValidationAttributes;
  children?: ReactNode;
};

export function AxisEditor({
  input,
  side,
  onAction,
  children,
}: Pick<AxisProps, "input" | "side" | "onAction"> & {
  children: (validation: ValidationAttributes) => ReactNode;
}) {
  const members = axisParameters(input, side);
  const kinds: ParameterId[] = [
    ...(input.format === "image"
      ? (["model", "variable", ...imageKinds] as const)
      : (["model", "effort", "variable"] as const)),
    "judge_model",
    "judge_effort",
  ];
  const label = side === "rows" ? "Rows" : "Columns";
  const dimension = isCaseAxis(input, side) ? "variable" : members[0];
  return (
    <div className="axis" role="group">
      <ValidationField
        path={isCaseAxis(input, side) ? ["caseAxes"] : [side]}
        descendants={!isCaseAxis(input, side)}
      >
        {(validation) => (
          <>
            <label className="axis-selector">
              <span className="axis-name">{label}:</span>
              <select
                aria-label={label}
                {...validation}
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
                      (kind !== "variable" &&
                        input.parameters[kind]?.kind ===
                          (side === "rows" ? "columns" : "rows")) ||
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
            {children(validation)}
          </>
        )}
      </ValidationField>
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
  validation,
}: AxisProps) {
  const parameter = axisParameters(input, side)[0];
  const label = side === "rows" ? "Rows" : "Columns";
  if (
    isCaseAxis(input, side) ||
    !parameter ||
    parameter === "variable" ||
    parameter === "judge_criteria" ||
    parameter === "judge_system" ||
    parameter === "input"
  )
    return null;
  const values = input[side].map((entry) => entry[parameter]);
  function change<K extends ScalarParameterId>(
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
            validation={validation}
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
  const destinations = (["rows", "columns"] as const).filter((side) =>
    isCaseAxis(input, side),
  );
  const chooseDestination = destinations.length === 2;
  const side = destinations[0];
  const reason = !side
    ? 'Select "Multiple cases" for rows or columns first'
    : !destinations.some((destination) => input[destination].length > 0)
      ? "Add at least one case before defining parameter cases"
      : undefined;
  const tooltip = useTooltip<HTMLSpanElement>(reason);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<Instance | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  useEffect(() => {
    if (!chooseDestination || disabled || reason) return;
    const element = button.current!;
    const content = document.createElement("div");
    setContainer(content);
    const instance = tippy(element, {
      content,
      theme: "case-destination",
      trigger: "manual",
      hideOnClick: false,
      interactive: true,
      placement: "bottom-end",
      appendTo: () => document.body,
      arrow: false,
      role: "presentation",
      aria: { content: null, expanded: false },
      onShow: () => setOpen(true),
      onHide: () => setOpen(false),
      onMount: () =>
        content
          .querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
          ?.focus(),
    });
    popup.current = instance;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !instance.state.isVisible) return;
      event.preventDefault();
      event.stopPropagation();
      instance.hide();
      element.focus();
    };
    const outside = (event: PointerEvent | FocusEvent) => {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !instance.popper.contains(event.target)
      )
        instance.hide();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      instance.destroy();
      popup.current = null;
      setOpen(false);
      setContainer(null);
    };
  }, [chooseDestination, disabled, reason]);
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
        ref={button}
        className="text-button parameter-case-action"
        disabled={disabled || !!reason}
        aria-label={`define multiple cases for ${name}`}
        aria-haspopup={chooseDestination ? "menu" : undefined}
        aria-expanded={chooseDestination ? open : undefined}
        aria-controls={open ? menuId : undefined}
        onKeyDown={(event) => {
          if (
            chooseDestination &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            popup.current?.show();
          }
        }}
        onClick={() => {
          if (chooseDestination) {
            if (popup.current?.state.isVisible) popup.current.hide();
            else popup.current?.show();
          } else if (side && input[side].length) onMove(parameter, side);
        }}
      >
        <ListOrdered aria-hidden="true" />
        define multiple cases
        <CornerRightUp aria-hidden="true" />
      </button>
      {container &&
        createPortal(
          <div
            id={menuId}
            className="case-destination-menu"
            role="menu"
            aria-label={`Define multiple cases for ${name} in`}
            onKeyDown={(event) => {
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowDown"
                      ? (index + 1) % items.length
                      : event.key === "ArrowUp"
                        ? (index + items.length - 1) % items.length
                        : undefined;
              if (next !== undefined) {
                event.preventDefault();
                items[next]?.focus();
              }
            }}
          >
            {destinations.map((destination) => (
              <button
                key={destination}
                type="button"
                role="menuitem"
                className="text-button"
                disabled={!input[destination].length}
                title={
                  !input[destination].length
                    ? `Add at least one ${destination === "rows" ? "row" : "column"} case first`
                    : undefined
                }
                onClick={() => {
                  if (!input[destination].length) return;
                  popup.current?.hide();
                  button.current?.focus();
                  onMove(parameter, destination);
                }}
              >
                {destination === "rows" ? "Row cases" : "Column cases"}
              </button>
            ))}
          </div>,
          container,
        )}
    </span>
  );
}
