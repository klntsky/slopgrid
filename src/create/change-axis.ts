import type {
  ChatMessage,
  CaseRecord,
  GridDraftInput,
  ParameterValues,
} from "../../server/domain";
import {
  axisParameters,
  axisHasVariables,
  isCaseAxis,
  newCase,
  parameterDefault,
  parameterNames,
  type AxisSide,
  type CommonParameterId,
  type ParameterId,
} from "../../server/parameters";
import {
  variableName,
  createVariableIndex,
} from "../../server/prompt-variables";
import {
  referencedVariableNames,
  rewriteVariableReferences,
} from "./judge-mode";

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
export type ScalarParameterId = Exclude<
  CommonParameterId,
  "input" | "judge_criteria"
>;
type CaseValuesAction = {
  [K in ScalarParameterId]: {
    type: "case-values";
    side: AxisSide;
    parameter: K;
    values: ParameterValues[K][];
  };
}[ScalarParameterId];
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
  | { type: "add-case"; side: AxisSide; value: CaseRecord }
  | { type: "remove-case"; side: AxisSide; index: number }
  | { type: "move-case"; side: AxisSide; index: number; to: number }
  | { type: "add-variable"; side: AxisSide }
  | { type: "remove-variable"; side: AxisSide; index: number }
  | { type: "rename-variable"; side: AxisSide; index: number; name: string }
  | { type: "rename-case"; side: AxisSide; index: number; name: string }
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

export function caseValuesAction<K extends ScalarParameterId>(
  side: AxisSide,
  parameter: K,
  values: ParameterValues[NoInfer<K>][],
): CaseValuesAction {
  return { type: "case-values", side, parameter, values } as CaseValuesAction;
}

export function addCaseAction(
  input: GridDraftInput,
  side: AxisSide,
  source = input[side].at(-1),
): Extract<InputAction, { type: "add-case" }> {
  return {
    type: "add-case",
    side,
    value: newCase(structuredClone(source ?? caseDefaults(input, side))),
  };
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

export function parameterValuesEqual(a: unknown, b: unknown): boolean {
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
        parameterValuesEqual(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

function differing(input: GridDraftInput, parameter: CommonParameterId) {
  const source = input.parameters[parameter];
  if (!source || source.kind === "common") return false;
  const values = input[source.kind].map((entry) => entry[parameter]);
  return values.some((value) => !parameterValuesEqual(value, values[0]));
}

export function droppedParameters(
  input: GridDraftInput,
  action: InputAction,
): ParameterId[] {
  const replacement = action.type === "dimension" ? action : undefined;
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
      ? (action.type === "single" || action.type === "dimension") &&
        input[action.side].some((entry) =>
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

export function neutralDimension(
  input: GridDraftInput,
  side: AxisSide,
): GridDraftInput {
  if (isCaseAxis(input, side) || axisParameters(input, side).length)
    return input;
  return {
    ...input,
    [side]: [input[side][0] ? { id: input[side][0].id } : newCase()],
  };
}

export function hasParameterValue(parameter: ParameterId, value: unknown) {
  return (
    value !== undefined &&
    !parameterValuesEqual(value, parameterDefault(parameter))
  );
}

export function removeParameter(
  input: GridDraftInput,
  parameter: CommonParameterId,
): GridDraftInput {
  const parameters = { ...input.parameters };
  const source = input.parameters[parameter];
  delete parameters[parameter];
  const next = { ...input, parameters };
  if (!source || source.kind === "common") return next;
  return neutralDimension(
    {
      ...next,
      [source.kind]: input[source.kind].map((entry) => {
        const retained = { ...entry };
        delete retained[parameter];
        return retained;
      }),
    },
    source.kind,
  );
}

function collapse(
  input: GridDraftInput,
  parameter: CommonParameterId,
): GridDraftInput {
  const source = input.parameters[parameter];
  if (!source || source.kind === "common") return input;
  const entries = input[source.kind];
  const next = removeParameter(input, parameter);
  const value =
    entries.length && !differing(input, parameter)
      ? (entries[0][parameter] ?? parameterDefault(parameter))
      : parameterDefault(parameter);
  return {
    ...next,
    parameters: {
      ...next.parameters,
      [parameter]: { kind: "common", value: structuredClone(value) },
    },
  };
}

function own(
  input: GridDraftInput,
  parameter: CommonParameterId,
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

function stripVariables(input: GridDraftInput, side: AxisSide): GridDraftInput {
  const variableNames = { ...input.variableNames };
  delete variableNames[side];
  const next = { ...input };
  if (Object.keys(variableNames).length) next.variableNames = variableNames;
  else delete next.variableNames;
  return {
    ...next,
    [side]: input[side].map((entry) => {
      const next = { ...entry };
      delete next.variable;
      delete next.name;
      return next;
    }),
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

export function variableRenameError(
  input: GridDraftInput,
  side: AxisSide,
  index: number,
  name: string,
): string | undefined {
  if (name && !/^[A-Z0-9_]+$/.test(name))
    return "Use only ASCII letters, digits, and underscores.";
  const effective = name || `${side === "rows" ? "ROW" : "COLUMN"}${index + 1}`;
  const existing = createVariableIndex(input).get(effective);
  if (existing && (existing.side !== side || existing.index !== index))
    return `The variable $${effective} is already in use.`;
}

function setVariableName(
  input: GridDraftInput,
  side: AxisSide,
  index: number,
  name: string | null,
): GridDraftInput {
  const names = [...(input.variableNames?.[side] ?? [])];
  while (names.length <= index) names.push(null);
  names[index] = name;
  while (names.length && names.at(-1) === null) names.pop();
  const variableNames = { ...input.variableNames };
  if (names.length) variableNames[side] = names;
  else delete variableNames[side];
  const next = { ...input };
  if (Object.keys(variableNames).length) next.variableNames = variableNames;
  else delete next.variableNames;
  return next;
}

function unusedGeneratedName(side: AxisSide, index: number, used: Set<string>) {
  const prefix = side === "rows" ? "ROW" : "COLUMN";
  let number = index + 1;
  while (used.has(`${prefix}${number}`)) number++;
  const name = `${prefix}${number}`;
  used.add(name);
  return name;
}

export function reduceInput(
  input: GridDraftInput,
  action: InputAction,
): GridDraftInput {
  switch (action.type) {
    case "rename-variable": {
      if (
        !isCaseAxis(input, action.side) ||
        !input[action.side][0]?.variable?.[action.index] ||
        variableRenameError(input, action.side, action.index, action.name)
      )
        return input;
      const previous = variableName(input, action.side, action.index);
      const next = setVariableName(
        input,
        action.side,
        action.index,
        action.name || null,
      );
      const name = variableName(next, action.side, action.index);
      return rewriteVariableReferences(next, (token) =>
        token === previous ? name : token,
      );
    }
    case "rename-case": {
      if (!isCaseAxis(input, action.side) || !input[action.side][action.index])
        return input;
      const name = action.name.trim();
      return {
        ...input,
        [action.side]: input[action.side].map((entry, index) => {
          if (index !== action.index) return entry;
          const next = { ...entry };
          if (name) next.name = name;
          else delete next.name;
          return next;
        }),
      };
    }
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
      if (
        !isCaseAxis(input, action.side) ||
        input.parameters[action.parameter]?.kind !== "common"
      )
        return input;
      return own(input, action.parameter, action.side);
    case "to-common":
      return collapse(input, action.parameter);
    case "single": {
      let next = {
        ...input,
        caseAxes: input.caseAxes.filter((side) => side !== action.side),
      };
      for (const parameter of axisParameters(input, action.side))
        if (parameter !== "variable") next = collapse(next, parameter);
      next = stripVariables(next, action.side);
      return neutralDimension(next, action.side);
    }
    case "dimension": {
      if (action.parameter === "variable") {
        if (isCaseAxis(input, action.side)) return input;
        let next = input;
        for (const parameter of axisParameters(input, action.side))
          if (parameter !== "variable") next = collapse(next, parameter);
        return {
          ...next,
          caseAxes: [...next.caseAxes, action.side],
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
      if (source?.kind === action.side && !isCaseAxis(input, action.side))
        return input;
      const retained =
        source?.kind === action.side
          ? input[action.side].map((entry) => ({
              id: entry.id,
              [action.parameter]: entry[action.parameter],
            }))
          : undefined;
      let next = {
        ...input,
        caseAxes: input.caseAxes.filter((side) => side !== action.side),
      };
      for (const parameter of axisParameters(input, action.side))
        if (parameter !== "variable") next = collapse(next, parameter);
      next = stripVariables(next, action.side);
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
      if (
        action.parameter === "variable"
          ? !isCaseAxis(input, action.side) ||
            !axisHasVariables(input, action.side)
          : input.parameters[action.parameter]?.kind !== action.side
      )
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
      if (
        input.parameters[action.parameter]?.kind !== action.side ||
        isCaseAxis(input, action.side) ||
        axisParameters(input, action.side).length !== 1
      )
        return input;
      const remaining = [...input[action.side]];
      const matched = action.values.map((value) => {
        const match = remaining.findIndex((entry) =>
          parameterValuesEqual(entry[action.parameter], value),
        );
        return match >= 0 ? remaining.splice(match, 1)[0] : undefined;
      });
      const entries = action.values.map((value, index) => ({
        ...(matched[index] ??
          remaining.shift() ??
          newCase(caseDefaults(input, action.side))),
        [action.parameter]: value,
      }));
      return { ...input, [action.side]: entries };
    }
    case "add-case":
      if (!isCaseAxis(input, action.side)) return input;
      return {
        ...input,
        [action.side]: [...input[action.side], action.value],
      };
    case "remove-case":
      if (!isCaseAxis(input, action.side) || input[action.side].length <= 1)
        return input;
      return {
        ...input,
        [action.side]: input[action.side].filter(
          (_, index) => index !== action.index,
        ),
      };
    case "add-variable": {
      if (!isCaseAxis(input, action.side) || !input[action.side].length)
        return input;
      const index = input[action.side][0].variable?.length ?? 0;
      const used = new Set<string>();
      for (const names of Object.values(input.variableNames ?? {}))
        for (const name of names) if (name) used.add(name);
      for (const side of ["rows", "columns"] as const)
        if (isCaseAxis(input, side))
          for (const [index, field] of (
            input[side][0]?.variable ?? []
          ).entries())
            if (field) used.add(variableName(input, side, index));
      const name = unusedGeneratedName(action.side, index, used);
      const next: GridDraftInput = {
        ...input,
        [action.side]: input[action.side].map((entry) => ({
          ...entry,
          variable: [...(entry.variable ?? []), { text: "" }],
        })),
      };
      return setVariableName(
        next,
        action.side,
        index,
        name === `${action.side === "rows" ? "ROW" : "COLUMN"}${index + 1}`
          ? null
          : name,
      );
    }
    case "remove-variable":
      if (
        !isCaseAxis(input, action.side) ||
        !input[action.side][0]?.variable?.[action.index]
      )
        return input;
      return {
        ...input,
        [action.side]: input[action.side].map((entry) => ({
          ...entry,
          variable: (entry.variable ?? []).map((field, index) =>
            index === action.index ? null : field,
          ),
        })),
      };
    case "move-case": {
      if (!isCaseAxis(input, action.side)) return input;
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
      const renamed = new Map<string, string>();
      const used = new Set<string>();
      const variableNames: NonNullable<GridDraftInput["variableNames"]> = {};
      for (const side of ["rows", "columns"] as const) {
        if (!isCaseAxis(input, side)) continue;
        const other = side === "rows" ? "columns" : "rows";
        const names = input.variableNames?.[side];
        if (names) variableNames[other] = [...names];
        for (const [index, field] of (
          input[side][0]?.variable ?? []
        ).entries()) {
          if (!field) continue;
          const custom = names?.[index];
          if (custom) {
            used.add(custom);
            renamed.set(custom, custom);
          }
        }
      }
      const variableIndex = createVariableIndex(input);
      const unresolved = new Map<string, string>();
      for (const name of referencedVariableNames(input)) {
        if (variableIndex.get(name)) continue;
        const swapped = name.replace(
          /^(ROW|COLUMN)([1-9]\d*)$/,
          (_, axis: string, number: string) =>
            `${axis === "ROW" ? "COLUMN" : "ROW"}${number}`,
        );
        const target = used.has(swapped) ? name : swapped;
        unresolved.set(name, target);
        used.add(target);
      }
      for (const side of ["rows", "columns"] as const) {
        if (!isCaseAxis(input, side)) continue;
        const other = side === "rows" ? "columns" : "rows";
        for (const [index, field] of (
          input[side][0]?.variable ?? []
        ).entries()) {
          if (!field || input.variableNames?.[side]?.[index]) continue;
          const name = unusedGeneratedName(other, index, used);
          renamed.set(variableName(input, side, index), name);
          if (name !== `${other === "rows" ? "ROW" : "COLUMN"}${index + 1}`) {
            const names = variableNames[other] ?? [];
            while (names.length <= index) names.push(null);
            names[index] = name;
            variableNames[other] = names;
          }
        }
      }
      const rewritten = rewriteVariableReferences(
        input,
        (name) => renamed.get(name) ?? unresolved.get(name) ?? name,
      );
      const parameters = { ...rewritten.parameters };
      for (const parameter of Object.keys(parameters) as CommonParameterId[]) {
        const source = parameters[parameter];
        if (source?.kind === "rows" || source?.kind === "columns")
          Object.assign(parameters, {
            [parameter]: { kind: source.kind === "rows" ? "columns" : "rows" },
          });
      }
      return {
        ...rewritten,
        parameters,
        caseAxes: input.caseAxes.map((side) =>
          side === "rows" ? "columns" : "rows",
        ),
        ...(Object.keys(variableNames).length ? { variableNames } : {}),
        rows: rewritten.columns,
        columns: rewritten.rows,
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
