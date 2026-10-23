import type { GridInput } from "./domain.js";
import type { ReferenceImage } from "./image-settings.js";
import { criteriaForCell } from "./judge-criteria.js";
import {
  axisParameters,
  axisHasVariables,
  isCaseAxis,
  type AxisSide,
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
      if (!isCaseAxis(input, side) || !/^[1-9]\d*$/.test(number)) {
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
  const seen = new Set<string>();
  for (const [, name, number] of text.matchAll(variableToken)) {
    const side = name === "ROW" ? "rows" : "columns";
    if (!isCaseAxis(input, side) || !/^[1-9]\d*$/.test(number)) continue;
    const fieldIndex = Number(number) - 1;
    const caseIndex = side === "rows" ? row : column;
    const field = input[side][caseIndex]?.variable?.[fieldIndex];
    const identity = `${side}:${fieldIndex}`;
    if (!field || seen.has(identity)) continue;
    seen.add(identity);
    fields.push({
      field,
      path: [side, caseIndex, "variable", fieldIndex],
    });
  }
  return fields;
}

export function caseSetupIssue(
  input: VariableInput,
  side: AxisSide,
): { kind: "cases" | "parameters"; message: string } | undefined {
  if (!isCaseAxis(input, side)) return;
  const name = side === "rows" ? "row" : "column";
  if (!input[side].length)
    return { kind: "cases", message: `Add at least one ${name} case.` };
  const hasFields = axisParameters(input, side).some(
    (parameter) =>
      parameter !== "variable" ||
      input[side].some((record) =>
        record.variable?.some((field) => field !== null),
      ),
  );
  if (!hasFields)
    return {
      kind: "parameters",
      message:
        'Add a variable or click "define multiple cases" for a parameter.',
    };
}

export function promptVariableIssues(input: TemplateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const side of ["rows", "columns"] as const) {
    if (!axisHasVariables(input, side)) continue;
    const fields = input[side][0]?.variable;
    input[side].forEach(({ variable }, caseIndex) => {
      const path = [side, caseIndex, "variable"];
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
  const fieldsUsed = new Set<AxisSide>();
  for (let row = 0; row < Math.max(1, input.rows.length); row++) {
    for (let column = 0; column < Math.max(1, input.columns.length); column++) {
      const combination =
        isCaseAxis(input, "rows") && isCaseAxis(input, "columns")
          ? `Row case ${row + 1}, column case ${column + 1}: `
          : "";
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
          if (!isCaseAxis(input, side) || !axisHasVariables(input, side)) {
            issues.push({
              message:
                combination +
                (isCaseAxis(input, side)
                  ? `Use new variable in the ${side === "rows" ? "row" : "column"} cases to define ${token}.`
                  : `Choose prompt variables for ${side} to use ${token}.`),
              path,
            });
            continue;
          }
          const caseIndex = side === "rows" ? row : column;
          const fieldIndex = Number(number) - 1;
          const field = input[side][caseIndex]?.variable?.[fieldIndex];
          if (!/^[1-9]\d*$/.test(number) || !field) {
            issues.push({
              message: `${combination}Unknown prompt variable ${token}.`,
              path,
            });
            continue;
          }
          if (role !== "user" && field.images?.length) {
            const message = `${combination}Variable images can only be attached to user messages.`;
            issues.push(
              { message, path },
              {
                message,
                path: [side, caseIndex, "variable", fieldIndex, "images"],
              },
            );
          }
          fieldsUsed.add(side);
        }
    }
  }
  for (const side of input.caseAxes) {
    if (
      axisParameters(input, side).some((kind) => kind !== "variable") ||
      fieldsUsed.has(side)
    )
      continue;
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
      const setup = caseSetupIssue(input, side);
      if (setup) issues.push({ message: setup.message, path: [side] });
    }
  }
  return issues;
}

export function promptVariableIssue(input: TemplateInput): string | undefined {
  return promptVariableIssues(input)[0]?.message;
}
