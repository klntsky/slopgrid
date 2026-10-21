import type {
  CaseRecord,
  GridDraftInput,
  ParameterValues,
} from "../../server/domain";
import {
  axisParameters,
  defaultGridDraft,
  newCase,
  parameterDefault,
  parameterNames,
  type AxisSide,
  type CommonParameterId,
  type ParameterId,
} from "../../server/parameters";
import { swapVariableTokens } from "./judge-mode";

type CommonAction = {
  [K in CommonParameterId]: {
    type: "common";
    parameter: K;
    value: ParameterValues[K];
  };
}[CommonParameterId];
type CaseValueAction = {
  [K in ParameterId]: {
    type: "case-value";
    side: AxisSide;
    index: number;
    parameter: K;
    value: ParameterValues[K];
  };
}[ParameterId];
type CaseValuesAction = {
  [K in ParameterId]: {
    type: "case-values";
    side: AxisSide;
    parameter: K;
    values: ParameterValues[K][];
  };
}[ParameterId];
export type ParameterSetter = <K extends CommonParameterId>(
  parameter: K,
  value: ParameterValues[NoInfer<K>],
) => void;

export type InputAction =
  | CommonAction
  | CaseValueAction
  | CaseValuesAction
  | { type: "to-axis"; parameter: CommonParameterId; side: AxisSide }
  | { type: "to-common"; parameter: CommonParameterId }
  | { type: "dimension"; side: AxisSide; parameter: ParameterId }
  | { type: "add-case"; side: AxisSide }
  | { type: "remove-case"; side: AxisSide; index: number }
  | { type: "move-case"; side: AxisSide; index: number; to: number }
  | { type: "swap" }
  | { type: "judge"; enabled: boolean };

export function caseValueAction<K extends ParameterId>(
  side: AxisSide,
  index: number,
  parameter: K,
  value: ParameterValues[NoInfer<K>],
): CaseValueAction {
  return {
    type: "case-value",
    side,
    index,
    parameter,
    value,
  } as CaseValueAction;
}

export function caseValuesAction<K extends ParameterId>(
  side: AxisSide,
  parameter: K,
  values: ParameterValues[NoInfer<K>][],
): CaseValuesAction {
  return { type: "case-values", side, parameter, values } as CaseValuesAction;
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a);
  const right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equal(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

function differing(input: GridDraftInput, parameter: ParameterId) {
  const source = input.parameters[parameter];
  if (!source || source.kind === "common") return false;
  const values = input[source.kind].map((entry) => entry[parameter]);
  return values.some((value) => !equal(value, values[0]));
}

export function droppedParameters(
  input: GridDraftInput,
  action: InputAction,
): ParameterId[] {
  const removed =
    action.type === "to-common"
      ? [action.parameter]
      : action.type === "dimension"
        ? axisParameters(input, action.side).filter(
            (kind) => kind !== action.parameter,
          )
        : [];
  return removed.filter((kind) => differing(input, kind));
}

export function confirmInputAction(
  input: GridDraftInput,
  action: InputAction,
): boolean {
  const dropped = droppedParameters(input, action);
  if (!dropped.length) return true;
  const restored = dropped.filter((kind) => kind !== "variable");
  return window.confirm(
    `The ${dropped.map((kind) => parameterNames[kind]).join(", ")} values differ between cases. Drop these values?` +
      (dropped.includes("variable")
        ? " The differing prompt-variable fields and images will be discarded."
        : "") +
      (restored.length
        ? ` ${restored.map((kind) => parameterNames[kind]).join(", ")} will return to their common defaults.`
        : ""),
  );
}

function collapse(
  input: GridDraftInput,
  parameter: ParameterId,
): GridDraftInput {
  const source = input.parameters[parameter];
  if (!source || source.kind === "common") return input;
  const parameters = { ...input.parameters };
  const entries = input[source.kind];
  if (parameter === "variable") delete parameters.variable;
  else {
    const value =
      entries.length && !differing(input, parameter)
        ? (entries[0][parameter] ?? parameterDefault(parameter))
        : parameterDefault(parameter);
    Object.assign(parameters, {
      [parameter]: { kind: "common", value: structuredClone(value) },
    });
  }
  return {
    ...input,
    parameters,
    [source.kind]: entries.map((entry) => {
      const next = { ...entry };
      delete next[parameter];
      return next;
    }),
  };
}

function own(
  input: GridDraftInput,
  parameter: ParameterId,
  side: AxisSide,
): GridDraftInput {
  const source = input.parameters[parameter];
  if (source?.kind === side) return input;
  if (source && source.kind !== "common") return input;
  const value =
    source?.kind === "common" ? source.value : parameterDefault(parameter);
  return {
    ...input,
    parameters: { ...input.parameters, [parameter]: { kind: side } },
    [side]: input[side].map((entry) => ({
      ...entry,
      [parameter]: structuredClone(value),
    })),
  };
}

function caseDefaults(
  input: GridDraftInput,
  side: AxisSide,
): Partial<ParameterValues> {
  const values: Partial<ParameterValues> = {};
  for (const parameter of axisParameters(input, side)) {
    const value =
      parameter === "variable"
        ? Array.from({ length: input[side][0]?.variable?.length ?? 1 }, () => ({
            text: "",
          }))
        : parameterDefault(parameter);
    Object.assign(values, { [parameter]: value });
  }
  return values;
}

export function reduceInput(
  input: GridDraftInput,
  action: InputAction,
): GridDraftInput {
  switch (action.type) {
    case "common":
      if (input.parameters[action.parameter]?.kind !== "common") return input;
      return {
        ...input,
        parameters: {
          ...input.parameters,
          [action.parameter]: { kind: "common", value: action.value },
        },
      };
    case "to-axis":
      if (
        !input[action.side].length ||
        input.parameters[action.parameter]?.kind !== "common"
      )
        return input;
      return own(input, action.parameter, action.side);
    case "to-common":
      return collapse(input, action.parameter);
    case "dimension": {
      const source = input.parameters[action.parameter];
      const other = action.side === "rows" ? "columns" : "rows";
      if (
        source?.kind === other ||
        (!source && action.parameter !== "variable")
      )
        return input;
      let next = input;
      for (const parameter of axisParameters(input, action.side))
        if (parameter !== action.parameter) next = collapse(next, parameter);
      if (source?.kind === action.side) return next;
      const value =
        source?.kind === "common"
          ? source.value
          : parameterDefault(action.parameter);
      // Replace ownership, not the aligned case records that remain on this axis.
      if (!next[action.side].length)
        next = { ...next, [action.side]: [newCase()] };
      next = own(next, action.parameter, action.side);
      if (
        (action.parameter === "model" || action.parameter === "judge_model") &&
        !value
      )
        next = { ...next, [action.side]: [] };
      return next;
    }
    case "case-value":
      if (input.parameters[action.parameter]?.kind !== action.side)
        return input;
      return {
        ...input,
        [action.side]: input[action.side].map((entry, index) =>
          index === action.index
            ? { ...entry, [action.parameter]: action.value }
            : entry,
        ),
      };
    case "case-values": {
      if (input.parameters[action.parameter]?.kind !== action.side)
        return input;
      const members = axisParameters(input, action.side);
      if (
        members.length > 1 &&
        action.values.length !== input[action.side].length
      )
        return input;
      const remaining = [...input[action.side]];
      const positional = members.length > 1 || action.parameter === "variable";
      const matched = action.values.map((value, index) => {
        if (positional) return input[action.side][index];
        const match = remaining.findIndex((entry) =>
          equal(entry[action.parameter], value),
        );
        return match >= 0 ? remaining.splice(match, 1)[0] : undefined;
      });
      const entries = action.values.map((value, index) => ({
        ...(matched[index] ??
          (positional ? undefined : remaining.shift()) ??
          newCase(caseDefaults(input, action.side))),
        [action.parameter]: value,
      }));
      return { ...input, [action.side]: entries };
    }
    case "add-case":
      return {
        ...input,
        [action.side]: [
          ...input[action.side],
          newCase(caseDefaults(input, action.side)),
        ],
      };
    case "remove-case":
      if (input[action.side].length <= 1) return input;
      return {
        ...input,
        [action.side]: input[action.side].filter(
          (_, index) => index !== action.index,
        ),
      };
    case "move-case": {
      const entries = [...input[action.side]];
      if (
        !entries[action.index] ||
        action.to < 0 ||
        action.to >= entries.length
      )
        return input;
      entries.splice(action.to, 0, entries.splice(action.index, 1)[0]);
      return { ...input, [action.side]: entries };
    }
    case "swap": {
      const parameters = { ...input.parameters };
      for (const parameter of Object.keys(parameters) as ParameterId[]) {
        const source = parameters[parameter];
        if (source?.kind === "rows" || source?.kind === "columns")
          Object.assign(parameters, {
            [parameter]: { kind: source.kind === "rows" ? "columns" : "rows" },
          });
      }
      const criteria = input.parameters.judge_criteria;
      if (criteria?.kind === "common")
        parameters.judge_criteria = {
          kind: "common",
          value: criteria.value.map((criterion) => ({
            ...criterion,
            text: swapVariableTokens(criterion.text),
          })),
        };
      const swapCases = (entries: CaseRecord[]) =>
        entries.map((entry) => ({
          ...entry,
          ...(entry.judge_criteria && {
            judge_criteria: entry.judge_criteria.map((criterion) => ({
              ...criterion,
              text: swapVariableTokens(criterion.text),
            })),
          }),
        }));
      return {
        ...input,
        parameters,
        rows: swapCases(input.columns),
        columns: swapCases(input.rows),
        prompt: swapVariableTokens(input.prompt),
        messages: input.messages?.map((message) => ({
          ...message,
          content: swapVariableTokens(message.content),
        })),
      };
    }
    case "judge": {
      if (
        action.enabled === input.judge ||
        (action.enabled && input.format === "html")
      )
        return input;
      const parameters = { ...input.parameters };
      const kinds = ["judge_model", "judge_effort", "judge_criteria"] as const;
      if (action.enabled) {
        for (const kind of kinds)
          Object.assign(parameters, {
            [kind]: { kind: "common", value: parameterDefault(kind) },
          });
        return { ...input, judge: true, parameters };
      }
      for (const kind of kinds) delete parameters[kind];
      const strip = (entries: CaseRecord[]) =>
        entries.map((entry) => {
          const next = { ...entry };
          for (const kind of kinds) delete next[kind];
          return next;
        });
      let next = {
        ...input,
        judge: false,
        parameters,
        rows: strip(input.rows),
        columns: strip(input.columns),
      };
      const defaults = defaultGridDraft(input.format);
      for (const side of ["rows", "columns"] as const) {
        if (
          !axisParameters(input, side).some((kind) =>
            kind.startsWith("judge_"),
          ) ||
          axisParameters(next, side).length
        )
          continue;
        const other = side === "rows" ? "columns" : "rows";
        const parameter = [
          ...axisParameters(defaults, side),
          ...axisParameters(defaults, other),
        ].find((kind) => next.parameters[kind]?.kind === "common");
        if (!parameter) continue;
        const source = next.parameters[parameter];
        const fallback = defaults.parameters[parameter];
        if (
          source?.kind !== "common" ||
          !fallback ||
          fallback.kind === "common"
        )
          continue;
        const values = equal(source.value, parameterDefault(parameter))
          ? defaults[fallback.kind].map((entry) => entry[parameter])
          : [source.value];
        next = {
          ...next,
          parameters: { ...next.parameters, [parameter]: { kind: side } },
          [side]: values.map((value) =>
            newCase({ [parameter]: structuredClone(value) }),
          ),
        };
      }
      return next;
    }
  }
}
