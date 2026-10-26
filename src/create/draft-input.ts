import {
  gridDraftSchema,
  gridSchema,
  type GridDraftInput,
  type GridInput,
} from "../../server/domain";
import {
  axisParameters,
  newCase,
  parameterDefault,
  parameterLayoutIssue,
} from "../../server/parameters";

export function draftInputFromGridInput(input: GridInput): GridDraftInput {
  // Hydrate structurally without admitting generation: saved models and draft
  // values remain editable even when current catalogs or run validation reject them.
  const draft = { ...input, budgetUsd: String(input.budgetUsd) };
  for (const side of ["rows", "columns"] as const)
    if (
      !Array.isArray(draft[side]) ||
      draft[side].some((record) => typeof record?.id !== "string" || !record.id)
    )
      throw new Error(
        "This grid has an invalid configuration and cannot be edited or forked.",
      );
  const parsed = gridDraftSchema.safeParse(draft);
  if (!parsed.success || parameterLayoutIssue(parsed.data))
    throw new Error(
      "This grid has an invalid configuration and cannot be edited or forked.",
    );
  return structuredClone(parsed.data);
}

export function validateDraftInput(draft: GridDraftInput) {
  const candidate: GridInput = {
    ...draft,
    budgetUsd: draft.budgetUsd.trim() ? Number(draft.budgetUsd) : Number.NaN,
  };
  const source = draft.parameters.input;
  if (source.kind === "common") {
    candidate.parameters = {
      ...draft.parameters,
      input: {
        ...source,
        value: source.value.map((message) =>
          message.role === "unfilled" ? { ...message, content: "" } : message,
        ),
      },
    };
  } else {
    candidate[source.kind] = draft[source.kind].map((entry) =>
      entry.input
        ? {
            ...entry,
            input: entry.input.map((message) =>
              message.role === "unfilled" ? { ...message, content: "" } : message,
            ),
          }
        : entry,
    );
  }
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
