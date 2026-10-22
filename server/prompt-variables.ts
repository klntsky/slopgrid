import type { GridInput } from "./domain.js";
import type { ReferenceImage } from "./image-settings.js";
import { criteriaForCell } from "./judge-criteria.js";
import {
  axisParameters,
  parameterValuePath,
  type ParameterConfiguration,
  type ValidationIssue,
} from "./parameters.js";
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

export function referencedVariableFields(
  text: string,
  input: VariableInput,
  row: number,
  column: number,
): { field: VariableField; path: (string | number)[] }[] {
  const fields: { field: VariableField; path: (string | number)[] }[] = [];
  const seen = new Set<number>();
  for (const [, name, number] of text.matchAll(variableToken)) {
    const side = name === "ROW" ? "rows" : "columns";
    if (input.parameters.variable?.kind !== side || !/^[1-9]\d*$/.test(number))
      continue;
    const fieldIndex = Number(number) - 1;
    const caseIndex = side === "rows" ? row : column;
    const field = input[side][caseIndex]?.variable?.[fieldIndex];
    if (!field || seen.has(fieldIndex)) continue;
    seen.add(fieldIndex);
    fields.push({
      field,
      path: [side, caseIndex, "variable", fieldIndex],
    });
  }
  return fields;
}

export function caseSetupIssue(
  input: VariableInput,
):
  | { kind: "cases" | "parameters" | "axis-values"; message: string }
  | undefined {
  const side = input.caseAxis;
  if (!side) return;
  const name = side === "rows" ? "row" : "column";
  if (!input[side].length)
    return { kind: "cases", message: `Add at least one ${name} case.` };
  const hasFields = axisParameters(input, side).some(
    (parameter) =>
      parameter !== "variable" ||
      input[side][0]?.variable?.some((field) => field !== null),
  );
  if (!hasFields)
    return {
      kind: "parameters",
      message: `Add a variable or parameter to the ${name} cases.`,
    };
  const other = side === "rows" ? "columns" : "rows";
  if (!input[other].length)
    return {
      kind: "axis-values",
      message: `Select at least one ${axisParameters(input, other).includes("model") ? "model" : "value"} for ${other}.`,
    };
}

export function promptVariableIssues(input: TemplateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const variableSide = input.parameters.variable?.kind;
  if (variableSide) {
    const cases = input[variableSide];
    const fields = cases[0]?.variable;
    if (!cases.length)
      issues.push({
        message: "Variable values must have the same active numbered fields.",
        path: [variableSide],
      });
    cases.forEach(({ variable }, caseIndex) => {
      const path = [variableSide, caseIndex, "variable"];
      if (!fields || !variable || variable.length !== fields.length)
        issues.push({
          message: "Variable values must have the same active numbered fields.",
          path,
        });
      if (fields && variable)
        variable.forEach((field, fieldIndex) => {
          if ((field === null) !== (fields[fieldIndex] === null))
            issues.push({
              message:
                "Variable values must have the same active numbered fields.",
              path: [...path, fieldIndex],
            });
        });
    });
  }
  let fieldsUsed = false;
  const count = input.caseAxis ? input[input.caseAxis].length : 1;
  for (let index = 0; index < count; index++) {
    const row = input.caseAxis === "rows" ? index : 0;
    const column = input.caseAxis === "columns" ? index : 0;
    const templates = generatorInputForCell(input, row, column).map(
      ({ content, role }, messageIndex) => ({
        text: content,
        role,
        path: [
          ...parameterValuePath(input, "input", row, column),
          messageIndex,
          "content",
        ],
      }),
    );
    if (input.judge)
      templates.push(
        ...criteriaForCell(input, row, column).map(
          ({ text }, criterionIndex) => ({
            text,
            role: "user" as const,
            path: [
              ...parameterValuePath(input, "judge_criteria", row, column),
              criterionIndex,
              "text",
            ],
          }),
        ),
      );
    for (const { text, role, path } of templates)
      for (const [token, name, number] of text.matchAll(variableToken)) {
        const side = name === "ROW" ? "rows" : "columns";
        if (variableSide !== side) {
          issues.push({
            message:
              input.caseAxis === side
                ? `Use new variable in the ${side === "rows" ? "row" : "column"} cases to define ${token}.`
                : `Choose prompt variables for ${name === "ROW" ? "rows" : "columns"} to use ${token}.`,
            path,
          });
          continue;
        }
        const caseIndex = side === "rows" ? row : column;
        const fieldIndex = Number(number) - 1;
        const field = input[side][caseIndex]?.variable?.[fieldIndex];
        if (!/^[1-9]\d*$/.test(number) || !field) {
          issues.push({ message: `Unknown prompt variable ${token}.`, path });
          continue;
        }
        if (role !== "user" && field.images?.length) {
          const message =
            "Variable images can only be attached to user messages.";
          issues.push(
            { message, path },
            {
              message,
              path: [side, caseIndex, "variable", fieldIndex, "images"],
            },
          );
        }
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
    if (index !== undefined && index >= 0) {
      const message = `Include $${side === "rows" ? "ROW" : "COLUMN"}${index + 1} in the prompt or judge criteria for ${side === "rows" ? "row" : "column"} variables.`;
      input[side].forEach((record, caseIndex) => {
        if (record.variable?.[index])
          issues.push({
            message,
            path: [side, caseIndex, "variable", index, "text"],
          });
      });
    } else {
      const setup = caseSetupIssue(input);
      if (setup) issues.push({ message: setup.message, path: [side] });
    }
  }
  return issues;
}

export function promptVariableIssue(input: TemplateInput): string | undefined {
  return promptVariableIssues(input)[0]?.message;
}
