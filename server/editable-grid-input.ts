import {
  gridDraftSchema,
  type ChatMessage,
  type GridDraftInput,
  type StoredGridInput,
} from "./domain.js";
import type { LegacyGridInput } from "./legacy-grid-input.js";
import { imageKinds } from "./image-settings.js";
import {
  isCurrentGridInput,
  parameterLayoutIssue,
  type AxisSide,
} from "./parameters.js";
import { migrateVariableInput } from "../shared/variable-migration.js";

// Master replaced bare tokens as substrings, in row-then-column order. Only
// whole tokens with token-free replacement values have the numbered semantics.
function safeLegacyTemplates(input: LegacyGridInput): boolean {
  const templates =
    input.format === "chat-template"
      ? (input.messages ?? []).map((message) => message.content)
      : [input.prompt];
  for (const text of templates) {
    if (typeof text !== "string") return false;
    const unmatched = text.replace(
      /\$(ROW|COLUMN)(\d*)(?![\p{L}\p{N}_])/gu,
      (token, name: string, number: string) => {
        const axis = input[name === "ROW" ? "rows" : "columns"];
        return axis.kind === "variable" &&
          /^[1-9]\d*$/.test(number) &&
          axis.values.every((fields) => fields?.[Number(number) - 1])
          ? ""
          : token;
      },
    );
    if (/\$(?:ROW|COLUMN)/u.test(unmatched)) return false;
  }
  for (const axis of [input.rows, input.columns])
    if (axis.kind === "variable")
      for (const fields of axis.values) {
        if (!Array.isArray(fields)) return false;
        for (const field of fields)
          if (
            !field ||
            typeof field.text !== "string" ||
            /\$(?:ROW|COLUMN)/u.test(field.text)
          )
            return false;
      }
  // Master judge criteria were literal, not templates. In particular, do not
  // reinterpret tokens normalized by the old metadata migration as variables.
  const criteria = input.judge?.criteria ?? [];
  return (
    Array.isArray(criteria) &&
    criteria.every(
      (criterion) =>
        typeof criterion.text === "string" &&
        !/\$(?:ROW|COLUMN)/u.test(criterion.text),
    )
  );
}

function legacyDraft(input: LegacyGridInput): GridDraftInput | undefined {
  if (
    !input.rows ||
    !input.columns ||
    !Array.isArray(input.rows.values) ||
    !Array.isArray(input.columns.values)
  )
    return;
  // An untouched master string axis cannot give numbered/sub-string tokens
  // their new meaning. The migration only establishes equivalence for bare,
  // whole-word tokens; persisted normalized field arrays already use numbers.
  for (const [side, name] of [
    ["rows", "ROW"],
    ["columns", "COLUMN"],
  ] as const) {
    const axis = input[side];
    if (
      axis.kind !== "variable" ||
      !axis.values.every((v) => typeof v === "string")
    )
      continue;
    const templates =
      input.format === "chat-template"
        ? (input.messages ?? []).map((message) => message.content)
        : [input.prompt];
    const bare = new RegExp(`\\$${name}(?![\\p{L}\\p{N}_])`, "gu");
    if (templates.some((text) => text.replace(bare, "").includes(`$${name}`)))
      return;
  }
  const legacy = migrateVariableInput(input) as LegacyGridInput;
  if (!safeLegacyTemplates(legacy)) return;
  let caseAxis: AxisSide | undefined;
  const ownCases = (side: AxisSide): boolean => {
    if (caseAxis && caseAxis !== side) return false;
    caseAxis = side;
    return true;
  };
  const messages: ChatMessage[] =
    legacy.format === "chat-template"
      ? (legacy.messages ?? [])
      : [
          {
            role: "user",
            content: legacy.prompt,
            ...(legacy.inputReferences?.length
              ? { images: legacy.inputReferences }
              : {}),
          },
        ];
  if (
    messages.some(
      ({ images }) =>
        images &&
        new Set(images.map((image) => image.id)).size !== images.length,
    )
  )
    return;
  const draft: GridDraftInput = {
    inputVersion: 3,
    format: legacy.format,
    budgetUsd: String(legacy.budgetUsd),
    judge: !!legacy.judge,
    ...(legacy.parallelWorkers !== undefined
      ? { parallelWorkers: legacy.parallelWorkers }
      : {}),
    parameters: {
      input: { kind: "common", value: messages },
      model: { kind: "common", value: legacy.model },
    },
    rows: legacy.rows.values.map((_, index) => ({
      id: `legacy-rows-${index + 1}`,
    })),
    columns: legacy.columns.values.map((_, index) => ({
      id: `legacy-columns-${index + 1}`,
    })),
  };
  if (legacy.format === "image")
    for (const kind of imageKinds)
      draft.parameters[kind] = {
        kind: "common",
        value: legacy.imageSettings?.[kind] ?? "auto",
      };
  else draft.parameters.effort = { kind: "common", value: legacy.effort };
  if (legacy.judge) {
    draft.parameters.judge_model = {
      kind: "common",
      value: legacy.judge.model,
    };
    draft.parameters.judge_effort = {
      kind: "common",
      value: legacy.judge.effort,
    };
    draft.parameters.judge_criteria = {
      kind: "common",
      value: legacy.judge.criteria,
    };
  }
  for (const side of ["rows", "columns"] as const) {
    const axis = legacy[side];
    if (axis.kind === "variable") {
      if (!ownCases(side)) return;
      draft.parameters.variable = { kind: side };
      draft[side].forEach((record, index) => {
        record.variable = axis.values[index];
      });
    } else if (axis.kind === "input_references") {
      if (legacy.format !== "image" || !ownCases(side)) return;
      draft.parameters.input = { kind: side };
      for (const [index, name] of axis.values.entries()) {
        const images = legacy.referenceGroups?.[name];
        if (
          !images ||
          new Set(images.map((image) => image.id)).size !== images.length
        )
          return;
        draft[side][index].input = [
          { role: "user", content: legacy.prompt, images },
        ];
      }
    } else {
      if (draft.parameters[axis.kind]?.kind !== "common") return;
      Object.assign(draft.parameters, { [axis.kind]: { kind: side } });
      draft[side].forEach((record, index) => {
        Object.assign(record, { [axis.kind]: axis.values[index] });
      });
    }
  }
  if (caseAxis) draft.caseAxis = caseAxis;
  return draft;
}

// This is structural editor hydration, not generation admission. Do not use
// model catalogs, provider availability, or gridSchema to decide editability.
export function editableGridInput(
  input: StoredGridInput,
): GridDraftInput | undefined {
  const draft = isCurrentGridInput(input)
    ? { ...input, budgetUsd: String(input.budgetUsd) }
    : input.inputVersion === undefined
      ? legacyDraft(input)
      : undefined;
  if (!draft) return;
  for (const side of ["rows", "columns"] as const)
    if (
      !Array.isArray(draft[side]) ||
      draft[side].some((record) => typeof record?.id !== "string" || !record.id)
    )
      return;
  if (!gridDraftSchema.safeParse(draft).success || parameterLayoutIssue(draft))
    return;
  return structuredClone(draft);
}
