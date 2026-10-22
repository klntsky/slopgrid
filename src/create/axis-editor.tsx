import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
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
      <div className="parameter-header">
        <span className="parameter-name">{parameterNames[parameter]}</span>
        <button
          type="button"
          className="text-button parameter-return-common"
          aria-label={`Make ${parameterNames[parameter].toLowerCase()} common`}
          onClick={() => onAction({ type: "to-common", parameter })}
        >
          Make common
        </button>
      </div>
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
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(0);
  const name =
    parameter === "input"
      ? input.format === "chat-template"
        ? "chat history"
        : "prompt"
      : parameterNames[parameter].toLowerCase();
  function openMenu(index = 0) {
    initialFocus.current = index;
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    if (disabled) {
      setOpen(false);
      return;
    }
    menu.current
      ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      [initialFocus.current]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, disabled]);
  return (
    <div
      className="parameter-actions"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <button
        type="button"
        className="text-button parameter-move-trigger"
        ref={trigger}
        disabled={disabled}
        aria-label={`Move ${name} to...`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" ? 1 : 0);
          }
        }}
      >
        Move to... <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div
          className="parameter-move-menu"
          id={id}
          ref={menu}
          role="menu"
          aria-label={`Move ${name} to`}
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ),
            );
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            let next: number;
            if (event.key === "ArrowDown") next = (current + 1) % items.length;
            else if (event.key === "ArrowUp")
              next = (current - 1 + items.length) % items.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          {(["rows", "columns"] as const).map((side) => {
            const unavailable =
              (parameter === "judge_criteria" || parameter === "input") &&
              input.caseAxis !== side;
            const label = side === "rows" ? "Rows" : "Columns";
            const explanation = unavailable
              ? `Select Multiple variable cases for ${label} first.`
              : undefined;
            return (
              <button
                key={side}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={unavailable || undefined}
                aria-label={
                  parameter === "input"
                    ? `Add ${input.format === "chat-template" ? "chat history" : "prompt"} to ${side === "rows" ? "row" : "column"} cases`
                    : `Make ${parameterNames[parameter]} a ${side === "rows" ? "row" : "column"} variable`
                }
                aria-describedby={unavailable ? `${id}-${side}` : undefined}
                onClick={() => {
                  if (
                    unavailable ||
                    disabled ||
                    trigger.current?.matches(":disabled")
                  )
                    return;
                  setOpen(false);
                  onMove(parameter, side);
                }}
              >
                <span>{label}</span>
                {explanation && (
                  <span className="parameter-move-reason" id={`${id}-${side}`}>
                    {explanation}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
