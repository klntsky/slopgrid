import {
  gridSchema,
  type GridDraftInput,
  type GridInput,
} from "../../server/domain";

export function draftInputFromGridInput(input: GridInput): GridDraftInput {
  return { ...input, budgetUsd: String(input.budgetUsd) };
}

export function validateDraftInput(draft: GridDraftInput) {
  const candidate: GridInput = {
    ...draft,
    budgetUsd: draft.budgetUsd.trim() ? Number(draft.budgetUsd) : Number.NaN,
  };
  return { candidate, parsed: gridSchema.safeParse(candidate) };
}

export function compatibilityPreviewInput(input: GridInput): GridInput {
  function withPlaceholder(axis: GridInput["rows"]): GridInput["rows"] {
    if (axis.values.length) return axis;
    return axis.kind === "variable"
      ? { ...axis, values: [[{ text: "" }]] }
      : {
          ...axis,
          values: [
            axis.kind === "effort" || axis.kind === "judge_effort"
              ? "default"
              : "",
          ],
        };
  }
  return {
    ...input,
    rows: withPlaceholder(input.rows),
    columns: withPlaceholder(input.columns),
  };
}
