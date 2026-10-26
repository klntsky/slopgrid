import type { GridInput } from "./domain.js";
import type { ReferenceImage } from "./image-settings.js";
import { criteriaForCell } from "./judge-criteria.js";
import {
  axisParameters,
  axisHasVariables,
  isCaseAxis,
  type AxisSide,
  parameterValuePath,
  parameterValue,
  type ParameterConfiguration,
  type ValidationIssue,
} from "./parameters.js";
import { generatorInputForCell } from "./generator-input.js";

export type VariableField = { text: string; images?: ReferenceImage[] };
type VariableInput = ParameterConfiguration;
type TemplateInput = VariableInput & Pick<GridInput, "judge" | "format">;

export const variableToken = /\$([A-Z0-9_]+)(?![\p{L}\p{N}_])/gu;

export function variableName(
  input: ParameterConfiguration,
  side: AxisSide,
  index: number,
): string {
  return (
    input.variableNames?.[side]?.[index] ??
    `${side === "rows" ? "ROW" : "COLUMN"}${index + 1}`
  );
}

type VariableSlot = { side: AxisSide; index: number };
export type VariableIndex = ReadonlyMap<string, VariableSlot>;

export function createVariableIndex(
  input: ParameterConfiguration,
): VariableIndex {
  const variables = new Map<string, VariableSlot>();
  for (const side of input.caseAxes)
    for (const [index, field] of (input[side][0]?.variable ?? []).entries()) {
      if (!field) continue;
      const name = variableName(input, side, index);
      if (!variables.has(name)) variables.set(name, { side, index });
    }
  return variables;
}

export function variableNameIssues(
  input: ParameterConfiguration,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Map<string, { side: AxisSide; index: number }[]>();
  for (const side of ["rows", "columns"] as const) {
    input.variableNames?.[side]?.forEach((name, index) => {
      if (name !== null && !/^[A-Z0-9_]+$/.test(name))
        issues.push({
          message:
            "Variable names must contain only A-Z, digits, or underscore.",
          path: ["variableNames", side, index],
        });
    });
    if (!isCaseAxis(input, side)) continue;
    for (const [index, field] of (input[side][0]?.variable ?? []).entries()) {
      if (!field) continue;
      const name = variableName(input, side, index);
      const locations = names.get(name) ?? [];
      locations.push({ side, index });
      names.set(name, locations);
    }
  }
  for (const [name, locations] of names)
    if (locations.length > 1)
      for (const { side, index } of locations)
        issues.push({
          message: `Variable name ${name} is already in use.`,
          path: ["variableNames", side, index],
        });
  return issues;
}

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
  variableIndex?: VariableIndex;
};

export function interpolateVariables(
  text: string,
  input: VariableInput,
  row: number,
  column: number,
  options: VariableInterpolationOptions = {},
): { text: string; images?: ReferenceImage[] } {
  const variableIndex = options.variableIndex ?? createVariableIndex(input);
  const images: ReferenceImage[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(variableToken, (token, name: string) => {
    const resolved = variableIndex.get(name);
    const field =
      resolved &&
      input[resolved.side][resolved.side === "rows" ? row : column]?.variable?.[
        resolved.index
      ];
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
  });
  return { text: expanded, ...(images.length ? { images } : {}) };
}

export function referencedVariableFields(
  text: string,
  input: VariableInput,
  row: number,
  column: number,
  variableIndex: VariableIndex = createVariableIndex(input),
): { field: VariableField; path: (string | number)[] }[] {
  const fields: { field: VariableField; path: (string | number)[] }[] = [];
  const seen = new Set<string>();
  for (const [, name] of text.matchAll(variableToken)) {
    const resolved = variableIndex.get(name);
    if (!resolved) continue;
    const { side, index: fieldIndex } = resolved;
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

export function promptVariableIssues(
  input: TemplateInput,
  variableIndex: VariableIndex = createVariableIndex(input),
): ValidationIssue[] {
  const issues: ValidationIssue[] = variableNameIssues(input);
  for (const side of ["rows", "columns"] as const) {
    if (!axisHasVariables(input, side)) continue;
    const fields = input[side][0]?.variable;
    input[side].forEach(({ variable }, caseIndex) => {
      const path = [side, caseIndex, "variable"];
      if (!fields || !variable || variable.length !== fields.length)
        issues.push({
          message: "Variable values must have the same active fields.",
          path,
        });
      if (fields && variable)
        variable.forEach((field, fieldIndex) => {
          if ((field === null) !== (fields[fieldIndex] === null))
            issues.push({
              message: "Variable values must have the same active fields.",
              path: [...path, fieldIndex],
            });
        });
    });
  }
  const fieldsUsed = new Set<AxisSide>();
  for (let row = 0; row < Math.max(1, input.rows.length); row++) {
    for (let column = 0; column < Math.max(1, input.columns.length); column++) {
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
          {
            text: parameterValue(input, "judge_system", row, column) ?? "",
            role: "system" as const,
            path: parameterValuePath(input, "judge_system", row, column),
          },
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
        for (const [token, name] of text.matchAll(variableToken)) {
          const resolved = variableIndex.get(name);
          if (!resolved) {
            issues.push({
              message: `Unknown prompt variable ${token}`,
              path,
            });
            continue;
          }
          const { side, index: fieldIndex } = resolved;
          const caseIndex = side === "rows" ? row : column;
          const field = input[side][caseIndex]?.variable?.[fieldIndex];
          if (!field) {
            issues.push({
              message: `Unknown prompt variable ${token}`,
              path,
            });
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
      const message = `$${variableName(input, side, index)} is not used anywhere`;
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
