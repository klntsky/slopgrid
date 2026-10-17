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
  if (input[side].kind !== axis.kind) {
    const previous = input[side];
    if (previous.kind === "model") next.model = previous.values[0] ?? "";
    if (previous.kind === "effort")
      next.effort = (previous.values[0] ?? "default") as GridInput["effort"];
    const other = side === "rows" ? "columns" : "rows";
    if (input[other].kind !== axis.kind) {
      if (axis.kind === "model")
        next[side] = { ...axis, values: next.model ? [next.model] : [] };
      if (axis.kind === "effort")
        next[side] = { ...axis, values: [next.effort] };
    }
  }
  if (input.judge && input[side].kind !== axis.kind) {
    const judge = { ...input.judge };
    const previous = input[side];
    if (previous.kind === "judge_model") judge.model = previous.values[0] ?? "";
    if (previous.kind === "judge_effort")
      judge.effort = (previous.values[0] ?? "default") as typeof judge.effort;
    const other = side === "rows" ? "columns" : "rows";
    if (input[other].kind !== axis.kind) {
      if (axis.kind === "judge_model")
        next[side] = { ...axis, values: judge.model ? [judge.model] : [] };
      if (axis.kind === "judge_effort")
        next[side] = { ...axis, values: [judge.effort] };
    }
    next.judge = judge;
  }
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
