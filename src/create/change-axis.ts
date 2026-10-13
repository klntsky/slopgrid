import type { GridInput } from "../../server/domain";
import {
  imageChoices,
  type ScalarImageKind,
  type ReferenceGroups,
} from "../../server/image-settings";

export function changeAxis(
  input: GridInput,
  side: "rows" | "columns",
  axis: GridInput["rows"],
  groups?: ReferenceGroups,
): GridInput {
  const next = {
    ...input,
    [side]: axis,
    referenceGroups: { ...input.referenceGroups, ...groups },
  };
  if (input.format !== "image" || input[side].kind === axis.kind) return next;
  const settings = { ...input.imageSettings };
  delete settings[input[side].kind as ScalarImageKind];
  if (input[side].kind === "input_references") delete next.inputReferences;
  const other = side === "rows" ? "columns" : "rows";
  if (input[other].kind !== axis.kind) {
    if (axis.kind in imageChoices) {
      const kind = axis.kind as ScalarImageKind;
      const value = settings[kind];
      if (value) next[side] = { ...axis, values: [value] };
      delete settings[kind];
    } else if (
      axis.kind === "input_references" &&
      input.inputReferences?.length
    ) {
      let index = 1;
      while (Object.hasOwn(next.referenceGroups, `Group ${index}`)) index++;
      const name = `Group ${index}`;
      next.referenceGroups[name] = input.inputReferences;
      next[side] = { ...axis, values: [name] };
      delete next.inputReferences;
    }
  }
  next.imageSettings = settings;
  return next;
}
