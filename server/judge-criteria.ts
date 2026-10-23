import { z } from "zod";
import type { GridInput } from "./domain.js";
import {
  parameterValue,
  parameterValuePath,
  type ParameterConfiguration,
  type ValidationIssue,
} from "./parameters.js";
import {
  interpolateVariables,
  mergeVariableImages,
  type VariableInterpolationOptions,
} from "./prompt-variables.js";
import type { ReferenceImage } from "./image-settings.js";

const draftCriterionSchema = z
  .object({
    text: z.string(),
    correctAnswer: z.boolean(),
  })
  .strict();
const criterionSchema = draftCriterionSchema.extend({
  text: draftCriterionSchema.shape.text
    .trim()
    .min(1, "Enter a yes-or-no question for each criterion."),
});
export const judgeCriteriaSchema = z
  .array(criterionSchema)
  .min(1, "Add at least one criterion.");
export const draftJudgeCriteriaSchema = z.array(draftCriterionSchema);
export type Criterion = z.infer<typeof criterionSchema>;

export function criteriaSets(
  input: Pick<GridInput, "parameters" | "rows" | "columns" | "judge">,
): Criterion[][] {
  if (!input.judge) return [];
  const source = input.parameters.judge_criteria;
  if (!source) return [];
  return source.kind === "common"
    ? [source.value]
    : input[source.kind].map((record) => record.judge_criteria ?? []);
}

export function criteriaForCell(
  input: ParameterConfiguration,
  row: number,
  column: number,
): Criterion[] {
  return parameterValue(input, "judge_criteria", row, column) ?? [];
}

export function resolveCriteriaForCell(
  input: ParameterConfiguration,
  row: number,
  column: number,
  options: VariableInterpolationOptions = {},
): { criteria: Criterion[]; images?: ReferenceImage[] } {
  let images: ReferenceImage[] | undefined;
  const criteria = criteriaForCell(input, row, column).map((criterion) => {
    const expanded = interpolateVariables(
      criterion.text,
      input,
      row,
      column,
      options,
    );
    images = mergeVariableImages(images, expanded.images);
    return { ...criterion, text: expanded.text };
  });
  return { criteria, ...(images ? { images } : {}) };
}

export function judgeCriteriaIssues(
  input: Pick<GridInput, "parameters" | "rows" | "columns" | "judge">,
): ValidationIssue[] {
  if (!input.judge) return [];
  const source = input.parameters.judge_criteria;
  if (!source) return [];
  const sets =
    source.kind === "common"
      ? [
          {
            criteria: source.value,
            path: parameterValuePath(input, "judge_criteria", 0, 0),
          },
        ]
      : input[source.kind].map((record, index) => ({
          criteria: record.judge_criteria ?? [],
          path: parameterValuePath(input, "judge_criteria", index, index),
        }));
  return sets.flatMap(({ criteria, path }) => {
    const result = judgeCriteriaSchema.safeParse(criteria);
    return result.success
      ? []
      : result.error.issues.map((issue) => ({
          message: issue.message,
          path: [...path, ...(issue.path as (string | number)[])],
        }));
  });
}
