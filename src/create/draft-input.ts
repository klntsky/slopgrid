import {
  gridSchema,
  type GridDraftInput,
  type GridInput,
  type StoredGridInput,
} from "../../server/domain";
import {
  axisParameters,
  isEditableGridInput,
  newCase,
  parameterDefault,
} from "../../server/parameters";

export function draftInputFromGridInput(
  input: StoredGridInput,
): GridDraftInput {
  if (!isEditableGridInput(input))
    throw new Error(
      "This grid uses an older configuration and cannot be edited or forked.",
    );
  return structuredClone({ ...input, budgetUsd: String(input.budgetUsd) });
}

export function validateDraftInput(draft: GridDraftInput) {
  const candidate: GridInput = {
    ...draft,
    budgetUsd: draft.budgetUsd.trim() ? Number(draft.budgetUsd) : Number.NaN,
  };
  return { candidate, parsed: gridSchema.safeParse(candidate) };
}

export function compatibilityPreviewInput(input: GridInput): GridInput {
  const preview = { ...input };
  for (const side of ["rows", "columns"] as const) {
    if (input[side].length) continue;
    const entry = newCase();
    for (const parameter of axisParameters(input, side))
      Object.assign(entry, { [parameter]: parameterDefault(parameter) });
    preview[side] = [entry];
  }
  return preview;
}
