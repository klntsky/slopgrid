import { isMarkdownFormat, type GridInput } from "../../server/domain";
import {
  imageChoices,
  type ScalarImageKind,
  type ReferenceGroups,
} from "../../server/image-settings";

type Axis = GridInput["rows"];
type Side = "rows" | "columns";
type ModelParameters = Pick<GridInput, "model" | "effort">;

const fixedParameters = {
  model: { owner: "generator", field: "model" },
  effort: { owner: "generator", field: "effort" },
  judge_model: { owner: "judge", field: "model" },
  judge_effort: { owner: "judge", field: "effort" },
} as const;

function isFixedParameter(
  kind: Axis["kind"],
): kind is keyof typeof fixedParameters {
  return Object.hasOwn(fixedParameters, kind);
}

function isImageParameter(kind: Axis["kind"]): kind is ScalarImageKind {
  return Object.hasOwn(imageChoices, kind);
}

function moveAxisToFixed(input: GridInput, axis: Axis): void {
  if (axis.kind === "variable") return;
  if (isFixedParameter(axis.kind)) {
    const { owner, field } = fixedParameters[axis.kind];
    let settings: ModelParameters;
    if (owner === "generator") settings = input;
    else {
      if (!input.judge) return;
      settings = input.judge = { ...input.judge };
    }
    if (field === "model") settings.model = axis.values[0] ?? "";
    else settings.effort = (axis.values[0] ?? "default") as GridInput["effort"];
  } else if (axis.kind === "input_references") {
    delete input.inputReferences;
  } else if (input.format === "image") {
    // Image axes return to Auto, not their first selected value.
    if (
      isImageParameter(axis.kind) &&
      input.imageSettings?.[axis.kind] !== undefined
    ) {
      input.imageSettings = { ...input.imageSettings };
      delete input.imageSettings[axis.kind];
    }
  }
}

function moveFixedToAxis(input: GridInput, axis: Axis): Axis {
  if (axis.kind === "variable") return axis;
  if (isFixedParameter(axis.kind)) {
    const { owner, field } = fixedParameters[axis.kind];
    const settings = owner === "generator" ? input : input.judge;
    if (!settings) return axis;
    const value = settings[field];
    return { ...axis, values: value ? [value] : [] };
  }
  if (input.format === "image" && isImageParameter(axis.kind)) {
    const value = input.imageSettings?.[axis.kind];
    if (value === undefined) return axis;
    input.imageSettings = { ...input.imageSettings };
    delete input.imageSettings[axis.kind];
    return value ? { ...axis, values: [value] } : axis;
  }
  if (
    input.format === "image" &&
    axis.kind === "input_references" &&
    input.inputReferences?.length
  ) {
    let index = 1;
    while (
      input.referenceGroups &&
      Object.hasOwn(input.referenceGroups, `Group ${index}`)
    )
      index++;
    const name = `Group ${index}`;
    input.referenceGroups = {
      ...input.referenceGroups,
      [name]: input.inputReferences,
    };
    delete input.inputReferences;
    return { ...axis, values: [name] };
  }
  return axis;
}

function resetJudgeAxis(
  axis: Axis,
  format: GridInput["format"],
  side: Side,
): Axis {
  if (
    !isFixedParameter(axis.kind) ||
    fixedParameters[axis.kind].owner !== "judge"
  )
    return axis;
  if (isMarkdownFormat(format))
    return side === "rows"
      ? { kind: "effort", values: ["default"] }
      : { kind: "model", values: [] };
  if (side === "columns" && format === "image")
    return { kind: "quality", values: ["auto"] };
  return side === "rows"
    ? { kind: "model", values: [] }
    : { kind: "effort", values: ["default"] };
}

export function removeJudge(
  input: GridInput,
): Pick<GridInput, "judge" | "rows" | "columns"> {
  let rows = resetJudgeAxis(input.rows, input.format, "rows");
  let columns = resetJudgeAxis(input.columns, input.format, "columns");
  if (rows.kind === columns.kind) {
    if (rows !== input.rows)
      rows = moveFixedToAxis(
        { ...input },
        resetJudgeAxis(input.rows, input.format, "columns"),
      );
    else if (columns !== input.columns)
      columns = moveFixedToAxis(
        { ...input },
        resetJudgeAxis(input.columns, input.format, "rows"),
      );
  }
  return {
    judge: undefined,
    rows,
    columns,
  };
}

export function changeAxis(
  input: GridInput,
  side: Side,
  axis: Axis,
  groups?: ReferenceGroups,
): GridInput {
  const next = {
    ...input,
    [side]: axis,
    referenceGroups: groups
      ? { ...input.referenceGroups, ...groups }
      : input.referenceGroups,
  };
  const previous = input[side];
  if (previous.kind === axis.kind) return next;

  moveAxisToFixed(next, previous);
  const other: Side = side === "rows" ? "columns" : "rows";
  if (input[other].kind !== axis.kind) {
    next[side] = moveFixedToAxis(next, axis);
  }
  return next;
}
