import { z } from "zod";
import type { GridInput } from "./domain.js";

const draftCriterionSchema = z.object({
  text: z.string(),
  correctAnswer: z.boolean(),
});
const criterionSchema = draftCriterionSchema.extend({
  text: draftCriterionSchema.shape.text
    .trim()
    .min(1, "Enter a yes-or-no question for each criterion."),
});
const rubricSchema = z
  .array(criterionSchema)
  .min(1, "Add at least one criterion.");
export type Criterion = z.infer<typeof criterionSchema>;
const variableCriteriaSchema = z
  .object({
    axis: z.enum(["rows", "columns"]),
    cases: z
      .array(rubricSchema)
      .min(1, "Add criteria for every variable case."),
  })
  .strict();
export const judgeCriteriaSchema = z.union([
  rubricSchema,
  variableCriteriaSchema,
]);
export type JudgeCriteria = z.infer<typeof judgeCriteriaSchema>;
export const draftJudgeCriteriaSchema = z.union([
  z.array(draftCriterionSchema),
  variableCriteriaSchema.extend({
    cases: z.array(z.array(draftCriterionSchema)),
  }),
]);

export function criteriaSets(source: JudgeCriteria | undefined): Criterion[][] {
  return source === undefined
    ? []
    : Array.isArray(source)
      ? [source]
      : source.cases;
}

export function criteriaForCell(
  input: Pick<GridInput, "judge">,
  row: number,
  column: number,
): Criterion[] {
  const source = input.judge?.criteria;
  if (!source) return [];
  return Array.isArray(source)
    ? source
    : (source.cases[source.axis === "rows" ? row : column] ?? []);
}

export function judgeCriteriaIssue(
  input: Pick<GridInput, "judge" | "rows" | "columns">,
): string | undefined {
  if (!input.judge) return;
  const result = (
    Array.isArray(input.judge.criteria) ? rubricSchema : variableCriteriaSchema
  ).safeParse(input.judge.criteria);
  if (!result.success) return result.error.issues[0]?.message;
  const source = result.data;
  if (Array.isArray(source)) return;
  const axis = input[source.axis];
  if (axis.kind !== "variable")
    return "The judge criteria axis must be a prompt variable dimension.";
  if (source.cases.length !== axis.values.length)
    return "Add one judge rubric for every case in the selected variable dimension.";
}
