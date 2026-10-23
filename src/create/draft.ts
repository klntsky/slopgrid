import { useState, useEffect } from "react";
import {
  gridDraftSchema,
  isChatFormat,
  type GridDraftInput,
} from "../../server/domain";
import { type ReferenceImage } from "../../server/image-settings";
import {
  defaultGridDraft,
  axisParameters,
  parameterDefault,
  parameterNames,
  type ParameterId,
} from "../../server/parameters";
import {
  confirmInputAction,
  droppedParameters,
  hasParameterValue,
  neutralDimension,
  parameterValuesEqual,
  removeParameter,
  reduceInput,
  type InputAction,
} from "./change-axis";
import { referenceLists } from "./reference-files";
import { canJudge } from "../../server/compatibility";
import { modelCatalog } from "../model-catalog";

export type Draft = {
  formatSelected: boolean;
  input: GridDraftInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
};
const storageKey = "slopgrid-draft";
const submissionKey = "slopgrid-creation";
export function creationSubmission(body: Record<string, unknown>) {
  // Automatic capacity can change between retries; the submitted request cannot.
  const { parallelWorkers: _workers, ...intent } = body;
  const fingerprint = JSON.stringify(intent);
  const previous = JSON.parse(sessionStorage.getItem(submissionKey) ?? "null");
  if (previous?.fingerprint === fingerprint)
    return previous.body as Record<string, unknown>;
  const request = { ...body, creationRequestId: crypto.randomUUID() };
  sessionStorage.setItem(
    submissionKey,
    JSON.stringify({ fingerprint, body: request }),
  );
  return request;
}
const initial = (): Draft => ({
  formatSelected: false,
  input: defaultGridDraft("svg"),
});
function readDraft(): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (!saved || saved.input?.inputVersion !== 3) return initial();
    return { ...saved, input: gridDraftSchema.parse(saved.input) };
  } catch {
    return initial();
  }
}
export function saveDraft(draft: Draft) {
  sessionStorage.setItem(storageKey, JSON.stringify(draft));
}
export function clearDraft() {
  sessionStorage.removeItem(storageKey);
  sessionStorage.removeItem(submissionKey);
}
export function startDraft(format: GridDraftInput["format"]) {
  const change = selectDraftFormat(readDraft(), format);
  if (confirmFormatChange(change)) saveDraft(change.draft);
}

type FormatChange = { draft: Draft; dropped: ParameterId[] };

function confirmFormatChange({ dropped }: FormatChange): boolean {
  return (
    !dropped.length ||
    window.confirm(
      `Changing format will discard incompatible or differing ${dropped
        .map((parameter) => parameterNames[parameter])
        .join(
          ", ",
        )} settings and case values. Differing values that become common will return to their defaults. Continue?`,
    )
  );
}

function selectDraftFormat(
  draft: Draft,
  format: GridDraftInput["format"],
): FormatChange {
  if (draft.input.format === format)
    return { draft: { ...draft, formatSelected: true }, dropped: [] };
  const previous = draft.input;
  const defaults = defaultGridDraft(format);
  // An untouched starting form uses the chosen format's ordinary defaults.
  const withoutCaseIds = (input: GridDraftInput) => ({
    ...input,
    rows: input.rows.map(({ id: _id, ...entry }) => entry),
    columns: input.columns.map(({ id: _id, ...entry }) => entry),
  });
  if (
    parameterValuesEqual(
      withoutCaseIds(previous),
      withoutCaseIds(defaultGridDraft(previous.format)),
    )
  )
    return {
      draft: { ...draft, input: defaults, formatSelected: true },
      dropped: [],
    };
  const dropped = new Set<ParameterId>();
  const applicable = new Set<ParameterId>([
    ...(Object.keys(defaults.parameters) as ParameterId[]),
    "variable",
    ...(previous.judge && format !== "html"
      ? (["judge_model", "judge_effort", "judge_criteria"] as const)
      : []),
  ]);
  let input: GridDraftInput = {
    ...previous,
    format,
    judge: previous.judge && format !== "html",
    parameters: { ...previous.parameters },
  };
  for (const parameter of Object.keys(input.parameters) as ParameterId[]) {
    if (applicable.has(parameter)) continue;
    const source = input.parameters[parameter];
    if (
      source?.kind === "common"
        ? hasParameterValue(parameter, source.value)
        : source &&
          input[source.kind].some((entry) =>
            hasParameterValue(parameter, entry[parameter]),
          )
    )
      dropped.add(parameter);
    input = removeParameter(input, parameter);
  }
  // Strip unowned fields while retaining compatible cases' identities.
  for (const side of ["rows", "columns"] as const) {
    input[side] = input[side].map((entry) => {
      const next = { ...entry };
      for (const key of Object.keys(entry)) {
        if (key === "id") continue;
        const parameter = key as ParameterId;
        if (input.parameters[parameter]?.kind === side) continue;
        if (hasParameterValue(parameter, entry[parameter]))
          dropped.add(parameter);
        delete next[parameter];
      }
      return next;
    });
  }
  for (const parameter of applicable) {
    if (parameter === "variable" || input.parameters[parameter]) continue;
    Object.assign(input.parameters, {
      [parameter]: { kind: "common", value: parameterDefault(parameter) },
    });
  }
  for (const parameter of ["model", "judge_model"] as const) {
    const source = input.parameters[parameter];
    const compatible = (value: string | undefined) => {
      if (!value) return true;
      const model = modelCatalog.find((model) => model.id === value);
      if (!model) return true;
      // Missing structured-output metadata is not evidence of incompatibility.
      if (parameter === "judge_model" && model.structuredOutputs === undefined)
        return (
          model.text &&
          ((format !== "svg" && format !== "image") || model.imageInput)
        );
      return parameter === "judge_model"
        ? canJudge(model, format)
        : format === "image"
          ? model.image
          : model.text;
    };
    if (source?.kind === "common") {
      if (!compatible(source.value)) {
        dropped.add(parameter);
        input.parameters[parameter] = { kind: "common", value: "" };
      }
    } else if (source) {
      input[source.kind] = input[source.kind].map((entry) => {
        if (compatible(entry[parameter])) return entry;
        dropped.add(parameter);
        return { ...entry, [parameter]: "" };
      });
    }
  }
  const collapse = (parameter: Exclude<ParameterId, "variable">) => {
    const action = { type: "to-common", parameter } as const;
    for (const lost of droppedParameters(input, action)) dropped.add(lost);
    input = reduceInput(input, action);
  };
  for (const side of ["rows", "columns"] as const) {
    if (input.caseAxis === side) continue;
    const owned = axisParameters(input, side);
    const native = owned.find((parameter) => parameter !== "judge_criteria");
    for (const parameter of owned)
      if (parameter !== native && parameter !== "variable") collapse(parameter);
    input = neutralDimension(input, side);
  }
  if (!isChatFormat(format)) {
    const source = input.parameters.input;
    if (source.kind === "common") {
      if (source.value.length !== 1 || source.value[0].role !== "user") {
        dropped.add("input");
        input.parameters.input = {
          kind: "common",
          value: parameterDefault("input"),
        };
      }
    } else {
      input[source.kind] = input[source.kind].map((entry) => {
        if (entry.input?.length === 1 && entry.input[0].role === "user")
          return entry;
        dropped.add("input");
        return { ...entry, input: parameterDefault("input") };
      });
    }
  }
  return {
    dropped: [...dropped],
    draft: {
      ...draft,
      formatSelected: true,
      input,
    },
  };
}

export function useCreateDraft() {
  const [draft, setDraft] = useState(() => ({
    ...readDraft(),
    formatSelected: true,
  }));
  useEffect(() => {
    saveDraft(draft);
  }, [draft]);
  function update(
    change:
      | Partial<GridDraftInput>
      | ((input: GridDraftInput) => Partial<GridDraftInput>),
  ) {
    setDraft((draft) => {
      const partial =
        typeof change === "function" ? change(draft.input) : change;
      return {
        ...draft,
        input: {
          ...draft.input,
          ...partial,
        },
      };
    });
  }
  function dispatch(action: InputAction) {
    if (!confirmInputAction(draft.input, action)) return false;
    setDraft((draft) => ({
      ...draft,
      input: reduceInput(draft.input, action),
    }));
    return true;
  }
  function selectFormat(format: GridDraftInput["format"]) {
    const change = selectDraftFormat(draft, format);
    if (confirmFormatChange(change)) setDraft(change.draft);
  }
  function replaceReference(localId: string, image: ReferenceImage) {
    setDraft((draft) => {
      const next = structuredClone(draft);
      const lists = referenceLists(next.input);
      for (const images of lists)
        for (let index = 0; index < images.length; index++)
          if (images[index].id === localId) images[index] = image;
      return next;
    });
  }
  return {
    draft,
    update,
    dispatch,
    selectFormat,
    replaceReference,
    setReuseArtifacts: (reuseArtifacts: boolean) =>
      setDraft((draft) => ({ ...draft, reuseArtifacts })),
  };
}
