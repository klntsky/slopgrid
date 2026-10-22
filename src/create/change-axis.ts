import type {
  ChatMessage,
  CaseRecord,
  GridDraftInput,
  ParameterValues,
} from "../../server/domain";
import {
  axisParameters,
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
  | {
      type: "edit-input";
      source: "common" | AxisSide;
      caseIndex?: number;
      change: (messages: ChatMessage[]) => ChatMessage[];
    }
  | { type: "to-axis"; parameter: CommonParameterId; side: AxisSide }
  | { type: "to-common"; parameter: CommonParameterId }
  | { type: "dimension"; side: AxisSide; parameter: ParameterId }
  | { type: "single"; side: AxisSide }
  | { type: "add-case"; side: AxisSide }
  | { type: "remove-case"; side: AxisSide; index: number }
  | { type: "move-case"; side: AxisSide; index: number; to: number }
  | { type: "add-variable"; side: AxisSide }
  | { type: "remove-variable"; side: AxisSide; index: number }
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

function comparisonKeys(value: object) {
  return Object.keys(value).filter((key) => {
    const entry = Reflect.get(value, key);
    return (
      entry !== undefined &&
      !(key === "images" && Array.isArray(entry) && entry.length === 0)
    );
  });
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = comparisonKeys(a);
  const right = comparisonKeys(b);
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
  const replacement =
    action.type === "dimension"
      ? action
      : action.type === "to-axis" && input.caseAxis !== action.side
        ? action
        : undefined;
  const removed =
    action.type === "single"
      ? axisParameters(input, action.side)
      : action.type === "to-common"
        ? [action.parameter]
        : replacement
          ? axisParameters(input, replacement.side).filter(
              (kind) => kind !== replacement.parameter,
            )
          : [];
  return removed.filter((kind) =>
    kind === "variable"
      ? input[input.parameters.variable!.kind].some((entry) =>
          entry.variable?.some(
            (field) => field && (field.text.length || field.images?.length),
          ),
        )
      : differing(input, kind),
  );
}

export function confirmInputAction(
  input: GridDraftInput,
  action: InputAction,
): boolean {
  const dropped = droppedParameters(input, action);
  if (!dropped.length) return true;
  const restored = dropped.filter((kind) => kind !== "variable");
  return window.confirm(
    `Changing the ${dropped.map((kind) => parameterNames[kind]).join(", ")} setup will discard values. Drop these values?` +
      (dropped.includes("variable")
        ? " The prompt-variable text and images will be discarded."
        : "") +
      (restored.length
        ? ` ${restored.map((kind) => parameterNames[kind]).join(", ")} will return to their common defaults.`
        : ""),
  );
}

function neutralDimension(
  input: GridDraftInput,
  side: AxisSide,
): GridDraftInput {
  if (input.caseAxis === side || axisParameters(input, side).length)
    return input;
  return {
    ...input,
    [side]: [input[side][0] ? { id: input[side][0].id } : newCase()],
  };
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
  return neutralDimension(
    {
      ...input,
      parameters,
      [source.kind]: entries.map((entry) => {
        const next = { ...entry };
        delete next[parameter];
        return next;
      }),
    },
    source.kind,
  );
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
    [side]: (input[side].length
      ? input[side]
      : [newCase(caseDefaults(input, side))]
    ).map((entry) => ({
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
        ? (input[side][0]?.variable ?? []).map((field) =>
            field === null ? null : { text: "" },
          )
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
    case "edit-input": {
      const source = input.parameters.input;
      if (source.kind !== action.source) return input;
      if (source.kind === "common")
        return reduceInput(input, {
          type: "common",
          parameter: "input",
          value: action.change(source.value),
        });
      const index = action.caseIndex;
      if (index === undefined || !input[source.kind][index]) return input;
      return reduceInput(
        input,
        caseValueAction(
          source.kind,
          index,
          "input",
          action.change(input[source.kind][index].input ?? []),
        ),
      );
    }
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
      if (input.parameters[action.parameter]?.kind !== "common") return input;
      if (input.caseAxis === action.side)
        return own(input, action.parameter, action.side);
      if (action.parameter === "judge_criteria" || action.parameter === "input")
        return input;
      return reduceInput(input, { ...action, type: "dimension" });
    case "to-common":
      return collapse(input, action.parameter);
    case "single": {
      let next =
        input.caseAxis === action.side
          ? { ...input, caseAxis: undefined }
          : input;
      for (const parameter of axisParameters(input, action.side))
        next = collapse(next, parameter);
      return neutralDimension(next, action.side);
    }
    case "dimension": {
      if (action.parameter === "variable") {
        if (input.caseAxis) return input;
        let next = input;
        for (const parameter of axisParameters(input, action.side))
          next = collapse(next, parameter);
        return {
          ...next,
          caseAxis: action.side,
          [action.side]: [newCase()],
        };
      }
      const source = input.parameters[action.parameter];
      const other = action.side === "rows" ? "columns" : "rows";
      if (
        source?.kind === other ||
        !source ||
        action.parameter === "judge_criteria" ||
        action.parameter === "input"
      )
        return input;
      if (source?.kind === action.side && input.caseAxis !== action.side)
        return input;
      const retained =
        source?.kind === action.side
          ? input[action.side].map((entry) => ({
              id: entry.id,
              [action.parameter]: entry[action.parameter],
            }))
          : undefined;
      let next =
        input.caseAxis === action.side
          ? { ...input, caseAxis: undefined }
          : input;
      for (const parameter of axisParameters(input, action.side))
        next = collapse(next, parameter);
      if (retained) {
        return {
          ...next,
          parameters: {
            ...next.parameters,
            [action.parameter]: { kind: action.side },
          },
          [action.side]: retained,
        };
      }
      const value =
        source?.kind === "common"
          ? source.value
          : parameterDefault(action.parameter);
      const unselectedModel =
        (action.parameter === "model" || action.parameter === "judge_model") &&
        !value;
      return {
        ...next,
        parameters: {
          ...next.parameters,
          [action.parameter]: { kind: action.side },
        },
        [action.side]: unselectedModel
          ? []
          : [newCase({ [action.parameter]: structuredClone(value) })],
      };
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
        (input.caseAxis === action.side || members.length > 1) &&
        action.values.length !== input[action.side].length
      )
        return input;
      const remaining = [...input[action.side]];
      const positional =
        input.caseAxis === action.side ||
        members.length > 1 ||
        action.parameter === "variable";
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
      if (input.caseAxis !== action.side) return input;
      return {
        ...input,
        [action.side]: [
          ...input[action.side],
          newCase(caseDefaults(input, action.side)),
        ],
      };
    case "remove-case":
      if (input.caseAxis !== action.side || input[action.side].length <= 1)
        return input;
      return {
        ...input,
        [action.side]: input[action.side].filter(
          (_, index) => index !== action.index,
        ),
      };
    case "add-variable":
      if (input.caseAxis !== action.side || !input[action.side].length)
        return input;
      return {
        ...input,
        parameters: {
          ...input.parameters,
          variable: { kind: action.side },
        },
        [action.side]: input[action.side].map((entry) => ({
          ...entry,
          variable: [...(entry.variable ?? []), { text: "" }],
        })),
      };
    case "remove-variable":
      if (
        input.caseAxis !== action.side ||
        !input[action.side][0]?.variable?.[action.index]
      )
        return input;
      return {
        ...input,
        [action.side]: input[action.side].map((entry) => ({
          ...entry,
          variable: entry.variable!.map((field, index) =>
            index === action.index ? null : field,
          ),
        })),
      };
    case "move-case": {
      if (input.caseAxis !== action.side) return input;
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
      const generatorInput = input.parameters.input;
      if (generatorInput.kind === "common")
        parameters.input = {
          kind: "common",
          value: generatorInput.value.map((message) => ({
            ...message,
            content: swapVariableTokens(message.content),
          })),
        };
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
          ...(entry.input && {
            input: entry.input.map((message) => ({
              ...message,
              content: swapVariableTokens(message.content),
            })),
          }),
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
        caseAxis:
          input.caseAxis === "rows"
            ? "columns"
            : input.caseAxis === "columns"
              ? "rows"
              : undefined,
        rows: swapCases(input.columns),
        columns: swapCases(input.rows),
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
      for (const side of ["rows", "columns"] as const)
        next = neutralDimension(next, side);
      return next;
    }
  }
}
