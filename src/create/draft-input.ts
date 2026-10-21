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
