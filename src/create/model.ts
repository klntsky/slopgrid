import {
  isChatFormat,
  type GridDraftInput,
  type ValidatedGridInput,
} from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";
import type { ModelInfo } from "../../server/model-catalog";
import {
  defaultGridDraft,
  axisParameters,
  isCaseAxis,
  parameterDefault,
  parameterNames,
  type CaseFactory,
  type CommonParameterId,
  type ParameterId,
} from "../../server/parameters";
import { canJudge } from "../../server/compatibility";
import { referenceLists } from "./reference-lists";
import {
  droppedParameters,
  hasParameterValue,
  inputActionConfirmation,
  neutralDimension,
  parameterValuesEqual,
  removeParameter,
  reduceInput,
  type InputAction,
} from "./change-axis";
import { validateDraftInput } from "./draft-input";

export type Draft = {
  formatSelected: boolean;
  input: GridDraftInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
};

type Submission = {
  id: number;
  phase: "preparing" | "submitting" | "completed";
  input: ValidatedGridInput;
  sourceGridId?: string;
  reuseArtifacts: boolean;
  continueWithLowBalance: boolean;
};

export type CreateModel = {
  draft: Draft;
  attempted: boolean;
  pendingUploads: number;
  error: string;
  lowBalance: number | null;
  submission: Submission | null;
  caseIdPrefix: string;
  nextCaseId: number;
  nextConfirmationId: number;
  nextRequestId: number;
  confirmation: { id: number; draft: Draft } | null;
};

export type CreateEvent =
  | InputAction
  | { type: "format-selected"; format: GridDraftInput["format"] }
  | { type: "format-cleared" }
  | { type: "budget-changed"; value: string }
  | { type: "reuse-artifacts-changed"; value: boolean }
  | { type: "reference-uploaded"; localId: string; image: ReferenceImage }
  | { type: "upload-status-changed"; busy: boolean }
  | { type: "confirmation-resolved"; id: number; accepted: boolean }
  | {
      type: "generate-requested";
      blocked: boolean;
      parallelWorkers: number | undefined;
      continueWithLowBalance?: boolean;
    }
  | { type: "references-prepared"; id: number; input: ValidatedGridInput }
  | { type: "submission-succeeded"; id: number; gridId: string }
  | {
      type: "submission-failed";
      id: number;
      message: string;
      balanceUsd?: number;
    }
  | { type: "low-balance-dismissed" };

export type CreateCommand =
  | { type: "persist-draft"; draft: Draft }
  | { type: "confirm"; id: number; message: string }
  | { type: "prepare-references"; id: number; input: ValidatedGridInput }
  | {
      type: "submit-grid";
      id: number;
      input: ValidatedGridInput;
      sourceGridId?: string;
      reuseArtifacts: boolean;
      continueWithLowBalance: boolean;
    }
  | { type: "creation-completed"; id: number; gridId: string }
  | { type: "navigate-home" }
  | { type: "remove-reference-file"; localId: string };

export function createModel(draft: Draft, caseIdPrefix: string): CreateModel {
  return {
    draft: structuredClone(draft),
    attempted: false,
    pendingUploads: 0,
    error: "",
    lowBalance: null,
    submission: null,
    caseIdPrefix,
    nextCaseId: 0,
    nextConfirmationId: 1,
    nextRequestId: 1,
    confirmation: null,
  };
}

type FormatChange = { draft: Draft; dropped: ParameterId[] };

function selectDraftFormat(
  draft: Draft,
  format: GridDraftInput["format"],
  models: readonly ModelInfo[],
  createCase: CaseFactory,
): FormatChange {
  if (draft.input.format === format)
    return { draft: { ...draft, formatSelected: true }, dropped: [] };
  const previous = draft.input;
  const defaults = defaultGridDraft(format, createCase);
  const withoutCaseIds = (input: GridDraftInput) => ({
    ...input,
    rows: input.rows.map(({ id: _id, ...entry }) => entry),
    columns: input.columns.map(({ id: _id, ...entry }) => entry),
  });
  if (
    parameterValuesEqual(
      withoutCaseIds(previous),
      withoutCaseIds(defaultGridDraft(previous.format, createCase)),
    )
  )
    return {
      draft: { ...draft, input: defaults, formatSelected: true },
      dropped: [],
    };
  const dropped = new Set<ParameterId>();
  const applicable = new Set<CommonParameterId>([
    ...(Object.keys(defaults.parameters) as CommonParameterId[]),
    ...(previous.judge && format !== "html"
      ? ([
          "judge_model",
          "judge_effort",
          "judge_system",
          "judge_criteria",
        ] as const)
      : []),
  ]);
  let input: GridDraftInput = {
    ...previous,
    format,
    judge: previous.judge && format !== "html",
    parameters: { ...previous.parameters },
  };
  for (const parameter of Object.keys(
    input.parameters,
  ) as CommonParameterId[]) {
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
    input = removeParameter(input, parameter, createCase);
  }
  for (const side of ["rows", "columns"] as const) {
    input[side] = input[side].map((entry) => {
      const next = { ...entry };
      for (const key of Object.keys(entry)) {
        if (key === "id" || (key === "name" && isCaseAxis(input, side)))
          continue;
        if (key === "name") {
          delete next.name;
          continue;
        }
        const parameter = key as ParameterId;
        if (parameter === "variable") {
          if (isCaseAxis(input, side)) continue;
        } else if (input.parameters[parameter]?.kind === side) continue;
        if (hasParameterValue(parameter, entry[parameter]))
          dropped.add(parameter);
        delete next[parameter];
      }
      return next;
    });
  }
  for (const parameter of applicable) {
    if (input.parameters[parameter]) continue;
    Object.assign(input.parameters, {
      [parameter]: { kind: "common", value: parameterDefault(parameter) },
    });
  }
  for (const parameter of ["model", "judge_model"] as const) {
    const source = input.parameters[parameter];
    const compatible = (value: string | undefined) => {
      if (!value) return true;
      const model = models.find((model) => model.id === value);
      if (!model) return true;
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
    input = reduceInput(input, action, createCase);
  };
  for (const side of ["rows", "columns"] as const) {
    if (isCaseAxis(input, side)) continue;
    const owned = axisParameters(input, side);
    const native = owned.find(
      (parameter) =>
        parameter !== "judge_criteria" && parameter !== "judge_system",
    );
    for (const parameter of owned)
      if (parameter !== native && parameter !== "variable") collapse(parameter);
    input = neutralDimension(input, side, createCase);
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
    draft: { ...draft, formatSelected: true, input },
  };
}

function replaceReference(
  draft: Draft,
  localId: string,
  image: ReferenceImage,
): Draft {
  const next = structuredClone(draft);
  const lists = referenceLists(next.input);
  for (const images of lists)
    for (let index = 0; index < images.length; index++)
      if (images[index].id === localId) images[index] = image;
  return next;
}

export function updateCreateModel(
  model: CreateModel,
  event: CreateEvent,
  models: readonly ModelInfo[],
): { model: CreateModel; commands: CreateCommand[] } {
  const unchanged = () => ({ model, commands: [] as CreateCommand[] });
  const edit = (
    draft: Draft,
    nextCaseId = model.nextCaseId,
  ): { model: CreateModel; commands: CreateCommand[] } => ({
    model: {
      ...model,
      draft,
      nextCaseId,
      attempted: false,
      error: "",
      confirmation: null,
    },
    commands: [{ type: "persist-draft", draft }],
  });
  switch (event.type) {
    case "format-cleared": {
      const result = edit({ ...model.draft, formatSelected: false });
      result.commands.push({ type: "navigate-home" });
      return result;
    }
    case "budget-changed":
      return edit({
        ...model.draft,
        input: { ...model.draft.input, budgetUsd: event.value },
      });
    case "reuse-artifacts-changed":
      return edit({ ...model.draft, reuseArtifacts: event.value });
    case "reference-uploaded": {
      const result = edit(
        replaceReference(model.draft, event.localId, event.image),
      );
      result.commands.push({
        type: "remove-reference-file",
        localId: event.localId,
      });
      return result;
    }
    case "upload-status-changed":
      return {
        model: {
          ...model,
          pendingUploads: Math.max(
            0,
            model.pendingUploads + (event.busy ? 1 : -1),
          ),
        },
        commands: [],
      };
    case "confirmation-resolved":
      if (model.confirmation?.id !== event.id) return unchanged();
      return event.accepted
        ? edit(model.confirmation.draft)
        : { model: { ...model, confirmation: null }, commands: [] };
    case "generate-requested": {
      if (event.blocked || model.pendingUploads || model.submission)
        return unchanged();
      const { parsed } = validateDraftInput({
        ...model.draft.input,
        parallelWorkers: event.parallelWorkers,
      });
      if (!parsed.success)
        return { model: { ...model, attempted: true }, commands: [] };
      const input = structuredClone(parsed.data);
      if (input.parallelWorkers === undefined) delete input.parallelWorkers;
      const id = model.nextRequestId;
      const submission: Submission = {
        id,
        phase: "preparing",
        input,
        ...(model.draft.sourceGridId !== undefined
          ? { sourceGridId: model.draft.sourceGridId }
          : {}),
        reuseArtifacts: model.draft.reuseArtifacts !== false,
        continueWithLowBalance: event.continueWithLowBalance === true,
      };
      return {
        model: {
          ...model,
          attempted: true,
          error: "",
          submission,
          nextRequestId: id + 1,
        },
        commands: [{ type: "prepare-references", id, input }],
      };
    }
    case "references-prepared": {
      const submission = model.submission;
      if (submission?.id !== event.id || submission.phase !== "preparing")
        return unchanged();
      const input = structuredClone(event.input);
      if (submission.input.parallelWorkers === undefined)
        delete input.parallelWorkers;
      else input.parallelWorkers = submission.input.parallelWorkers;
      return {
        model: {
          ...model,
          submission: { ...submission, phase: "submitting", input },
        },
        commands: [
          {
            type: "submit-grid",
            id: submission.id,
            input,
            ...(submission.sourceGridId !== undefined
              ? { sourceGridId: submission.sourceGridId }
              : {}),
            reuseArtifacts: submission.reuseArtifacts,
            continueWithLowBalance: submission.continueWithLowBalance,
          },
        ],
      };
    }
    case "submission-succeeded":
      if (
        model.submission?.id !== event.id ||
        model.submission.phase !== "submitting"
      )
        return unchanged();
      return {
        model: {
          ...model,
          lowBalance: null,
          submission: { ...model.submission, phase: "completed" },
        },
        commands: [
          { type: "creation-completed", id: event.id, gridId: event.gridId },
        ],
      };
    case "submission-failed":
      if (model.submission?.id !== event.id) return unchanged();
      return {
        model: {
          ...model,
          submission: null,
          error: event.balanceUsd !== undefined ? "" : event.message,
          lowBalance:
            event.balanceUsd !== undefined
              ? event.balanceUsd
              : model.lowBalance,
        },
        commands: [],
      };
    case "low-balance-dismissed":
      return { model: { ...model, lowBalance: null }, commands: [] };
  }
  let nextCaseId = model.nextCaseId;
  let used: Set<string> | undefined;
  const createCase: CaseFactory = (values = {}) => {
    if (!used) {
      used = new Set();
      for (const entry of model.draft.input.rows) used.add(entry.id);
      for (const entry of model.draft.input.columns) used.add(entry.id);
    }
    let id: string;
    do id = `${model.caseIdPrefix}${nextCaseId++}`;
    while (used.has(id));
    used.add(id);
    return { ...values, id };
  };
  let draft: Draft;
  let message: string | undefined;
  if (event.type === "format-selected") {
    const change = selectDraftFormat(
      model.draft,
      event.format,
      models,
      createCase,
    );
    draft = change.draft;
    if (change.dropped.length)
      message = `Changing format will discard incompatible or differing ${change.dropped.map((parameter) => parameterNames[parameter]).join(", ")} settings and case values. Differing values that become common will return to their defaults. Continue?`;
  } else {
    message = inputActionConfirmation(model.draft.input, event);
    const input = reduceInput(model.draft.input, event, createCase);
    if (input === model.draft.input) return unchanged();
    draft = { ...model.draft, input };
  }
  if (message) {
    const id = model.nextConfirmationId;
    return {
      model: {
        ...model,
        nextCaseId,
        nextConfirmationId: id + 1,
        confirmation: { id, draft },
      },
      commands: [{ type: "confirm", id, message }],
    };
  }
  return edit(draft, nextCaseId);
}
