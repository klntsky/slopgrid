import type { GridDraftInput, GridInput } from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";
import { generatorInputEntries } from "../../server/generator-input";

export function referenceLists(
  input: Pick<
    GridInput | GridDraftInput,
    "parameters" | "rows" | "columns" | "caseAxes"
  >,
): ReferenceImage[][] {
  return [
    ...generatorInputEntries(input).flatMap(({ messages }) =>
      messages.flatMap((message) => (message.images ? [message.images] : [])),
    ),
    ...[...input.rows, ...input.columns].flatMap((entry) => [
      ...(entry.variable ?? []).flatMap((field) =>
        field?.images ? [field.images] : [],
      ),
    ]),
  ];
}
