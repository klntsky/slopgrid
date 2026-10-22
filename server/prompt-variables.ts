import type { GridInput } from "./domain.js";
import type { ReferenceImage } from "./image-settings.js";
import { criteriaForCell } from "./judge-criteria.js";
import { axisParameters, type ParameterConfiguration } from "./parameters.js";
import { generatorInputForCell } from "./generator-input.js";

export type VariableField = { text: string; images?: ReferenceImage[] };
type VariableInput = ParameterConfiguration;
type TemplateInput = VariableInput & Pick<GridInput, "judge" | "format">;

// A numbered token or bare legacy token must end at a whole-word boundary.
export const variableToken = /\$(ROW|COLUMN)(\d*)(?![\p{L}\p{N}_])/gu;

export function mergeVariableImages(
  ...groups: (readonly ReferenceImage[] | undefined)[]
): ReferenceImage[] | undefined {
  const seen = new Set<string>();
  const images: ReferenceImage[] = [];
  for (const group of groups)
    for (const image of group ?? [])
      if (!seen.has(image.id)) {
        seen.add(image.id);
        images.push(image);
      }
  return images.length ? images : undefined;
}

export function referencedVariableImages(
  text: string,
  input: VariableInput,
  selection?: Partial<Record<"rows" | "columns", number>>,
): ReferenceImage[] {
  const images: ReferenceImage[] = [];
  const seen = new Set<string>();
  for (const [, name, number] of text.matchAll(variableToken)) {
    const side = name === "ROW" ? "rows" : "columns";
    const axis = input[side];
    if (input.parameters.variable?.kind !== side || !/^[1-9]\d*$/.test(number))
      continue;
    const index = selection?.[side];
    const values = index === undefined ? axis : [axis[index]];
    for (const record of values)
      for (const image of record?.variable?.[Number(number) - 1]?.images ?? [])
        if (!seen.has(image.id)) {
          seen.add(image.id);
          images.push(image);
        }
  }
  return images;
}

export type VariableInterpolationOptions = {
  allowUnresolvedVariables?: boolean;
};

export function interpolateVariables(
  text: string,
  input: VariableInput,
  row: number,
  column: number,
  options: VariableInterpolationOptions = {},
): { text: string; images?: ReferenceImage[] } {
  const images: ReferenceImage[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(
    variableToken,
    (token, name: string, number: string) => {
      const side = name === "ROW" ? "rows" : "columns";
      const axis = input[side];
      const index = name === "ROW" ? row : column;
      if (
        input.parameters.variable?.kind !== side ||
        !/^[1-9]\d*$/.test(number)
      ) {
        if (options.allowUnresolvedVariables) return token;
        throw new Error(`Invalid prompt variable ${token}.`);
      }
      const field = axis[index]?.variable?.[Number(number) - 1];
      if (!field) {
        if (options.allowUnresolvedVariables) return token;
        throw new Error(`Missing prompt variable ${token}.`);
      }
      for (const image of field.images ?? [])
        if (!seen.has(image.id)) {
          seen.add(image.id);
          images.push(image);
        }
      return field.text;
    },
  );
  return { text: expanded, ...(images.length ? { images } : {}) };
}

export function promptVariableIssue(input: TemplateInput): string | undefined {
  const variableSide = input.parameters.variable?.kind;
  if (variableSide) {
    const cases = input[variableSide];
    const fields = cases[0]?.variable;
    if (
      !fields ||
      cases.some(
        ({ variable }) =>
          !variable ||
          variable.length !== fields.length ||
          variable.some(
            (field, index) => (field === null) !== (fields[index] === null),
          ),
      )
    )
      return "Variable values must have the same active numbered fields.";
  }
  let fieldsUsed = false;
  const count = input.caseAxis ? input[input.caseAxis].length : 1;
  for (let index = 0; index < count; index++) {
    const row = input.caseAxis === "rows" ? index : 0;
    const column = input.caseAxis === "columns" ? index : 0;
    const templates = generatorInputForCell(input, row, column).map(
      ({ content, role }) => ({ text: content, role }),
    );
    if (input.judge)
      templates.push(
        ...criteriaForCell(input, row, column).map(({ text }) => ({
          text,
          role: "user" as const,
        })),
      );
    for (const { text, role } of templates)
      for (const [token, name, number] of text.matchAll(variableToken)) {
        const side = name === "ROW" ? "rows" : "columns";
        if (variableSide !== side)
          return input.caseAxis === side
            ? `Use Add variable in the ${side === "rows" ? "row" : "column"} cases to define ${token}.`
            : `Choose prompt variables for ${name === "ROW" ? "rows" : "columns"} to use ${token}.`;
        const caseIndex = side === "rows" ? row : column;
        const field = input[side][caseIndex]?.variable?.[Number(number) - 1];
        if (!/^[1-9]\d*$/.test(number) || !field)
          return `Unknown prompt variable ${token}.`;
        if (role !== "user" && field.images?.length)
          return "Variable images can only be attached to user messages.";
        fieldsUsed = true;
      }
  }
  if (
    input.caseAxis &&
    !axisParameters(input, input.caseAxis).some(
      (kind) => kind !== "variable",
    ) &&
    !fieldsUsed
  ) {
    const side = input.caseAxis;
    const index = input[side][0]?.variable?.findIndex(
      (field) => field !== null,
    );
    if (index !== undefined && index >= 0)
      return `Include $${side === "rows" ? "ROW" : "COLUMN"}${index + 1} in the prompt or judge criteria for ${side === "rows" ? "row" : "column"} variables.`;
    return "Use a case-owned prompt, chat history, parameter, or numbered field for the case axis.";
  }
}
