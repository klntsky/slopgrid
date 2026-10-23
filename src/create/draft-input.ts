import {
  gridSchema,
  type GridDraftInput,
  type GridInput,
  type StoredGridInput,
} from "../../server/domain";
import {
  axisParameters,
  newCase,
  parameterDefault,
} from "../../server/parameters";
import { editableGridInput } from "../../server/editable-grid-input";

export function draftInputFromGridInput(
  input: StoredGridInput,
): GridDraftInput {
  const draft = editableGridInput(input);
  if (!draft)
    throw new Error(
      "This grid uses an older configuration and cannot be edited or forked.",
    );
  return draft;
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
