import {
  isChatFormat,
  type GridDraftInput,
  type GridInput,
} from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";
import type {
  CreateCatalogModel,
  CreateCommand,
  CreateContext,
  CreateEvent,
  CreateOutcome,
  CreateTransition,
  CreationMachine,
  Draft,
} from "./machine-contract";
import {
  copyCreationData,
  equalCreationData,
  creationContextCodec,
  creationEventCodec,
  creationInitialCodec,
} from "./machine-codec";
import { creationPolicy } from "./creation-policy";
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
} from "./change-axis";

type Submission = {
  id: number;
  phase: "preparing" | "submitting" | "completed";
  input: GridInput;
  sourceGridId?: string;
  reuseArtifacts: boolean;
  continueWithLowBalance: boolean;
};

type CreateModel = {
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
  context: CreateContext;
};

function createModel(
  draft: Draft,
  caseIdPrefix: string,
  context: CreateContext,
): CreateModel {
  return {
    draft,
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
    context,
  };
}

type FormatChange = { draft: Draft; dropped: ParameterId[] };

function selectDraftFormat(
  draft: Draft,
  format: GridDraftInput["format"],
  models: readonly CreateCatalogModel[],
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

function replaceReferences<T extends GridInput | GridDraftInput>(
  input: T,
  localId: string,
  image: ReferenceImage,
): T {
  const next = copyCreationData(input);
  for (const images of referenceLists(next))
    for (let index = 0; index < images.length; index++)
      if (images[index].id === localId) images[index] = image;
  return next;
}

type Transition = {
  model: CreateModel;
  outcome: CreateOutcome;
  commands: CreateCommand[];
};

function updateCreateModel(model: CreateModel, event: CreateEvent): Transition {
  const unchanged = (): Transition => ({
    model,
    outcome: { stateChanged: false, draftChanged: false },
    commands: [],
  });
  const changed = (
    next: CreateModel,
    commands: CreateCommand[] = [],
    draftChanged = false,
  ): Transition => ({
    model: next,
    outcome: { stateChanged: true, draftChanged },
    commands,
  });
  const edit = (draft: Draft, nextCaseId = model.nextCaseId): Transition => {
    const draftChanged = !equalCreationData(draft, model.draft);
    if (
      !draftChanged &&
      !model.attempted &&
      !model.error &&
      !model.confirmation
    )
      return unchanged();
    return changed(
      {
        ...model,
        draft: draftChanged ? draft : model.draft,
        nextCaseId,
        attempted: false,
        error: "",
        confirmation: null,
      },
      draftChanged ? [{ type: "persist-draft", draft }] : [],
      draftChanged,
    );
  };
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
    case "provider-observed":
      return equalCreationData(model.context.provider, event.provider)
        ? unchanged()
        : changed({
            ...model,
            context: { ...model.context, provider: event.provider },
          });
    case "reference-uploaded": {
      const submission = model.submission;
      if (
        submission?.id !== event.id ||
        submission.phase !== "preparing" ||
        !event.localId.startsWith("local-") ||
        event.image.id.startsWith("local-") ||
        !referenceLists(submission.input).some((images) =>
          images.some((image) => image.id === event.localId),
        )
      )
        return unchanged();
      const input = replaceReferences(
        submission.input,
        event.localId,
        event.image,
      );
      const matchesDraft = referenceLists(model.draft.input).some((images) =>
        images.some((image) => image.id === event.localId),
      );
      const result = matchesDraft
        ? edit({
            ...model.draft,
            input: replaceReferences(
              model.draft.input,
              event.localId,
              event.image,
            ),
          })
        : unchanged();
      return changed(
        {
          ...result.model,
          submission: { ...submission, input },
        },
        [
          ...result.commands,
          { type: "remove-reference-file", localId: event.localId },
        ],
        result.outcome.draftChanged,
      );
    }
    case "upload-status-changed": {
      const pendingUploads = Math.max(
        0,
        model.pendingUploads + (event.busy ? 1 : -1),
      );
      return pendingUploads === model.pendingUploads
        ? unchanged()
        : changed({ ...model, pendingUploads });
    }
    case "confirmation-resolved":
      if (model.confirmation?.id !== event.id) return unchanged();
      return event.accepted
        ? edit(model.confirmation.draft)
        : changed({ ...model, confirmation: null });
    case "generate-requested": {
      const policy = creationPolicy(
        {
          ...model,
          submissionPhase: model.submission?.phase ?? "idle",
        },
        model.context,
      );
      if (!policy.eligibility.canAttempt) return unchanged();
      if (!policy.admittedInput)
        return model.attempted
          ? unchanged()
          : changed({ ...model, attempted: true });
      const input = policy.admittedInput;
      const id = model.nextRequestId;
      const submission: Submission = {
        id,
        phase: "preparing",
        input,
        ...(model.draft.sourceGridId !== undefined
          ? { sourceGridId: model.draft.sourceGridId }
          : {}),
        reuseArtifacts: model.draft.reuseArtifacts !== false,
        continueWithLowBalance: event.continueWithLowBalance,
      };
      return changed(
        {
          ...model,
          attempted: true,
          error: "",
          submission,
          nextRequestId: id + 1,
        },
        [{ type: "prepare-references", id, input }],
      );
    }
    case "references-prepared": {
      const submission = model.submission;
      if (
        submission?.id !== event.id ||
        submission.phase !== "preparing" ||
        referenceLists(submission.input).some((images) =>
          images.some((image) => image.id.startsWith("local-")),
        )
      )
        return unchanged();
      return changed(
        {
          ...model,
          submission: { ...submission, phase: "submitting" },
        },
        [
          {
            type: "submit-grid",
            id: submission.id,
            input: submission.input,
            ...(submission.sourceGridId !== undefined
              ? { sourceGridId: submission.sourceGridId }
              : {}),
            reuseArtifacts: submission.reuseArtifacts,
            continueWithLowBalance: submission.continueWithLowBalance,
          },
        ],
      );
    }
    case "submission-succeeded":
      if (
        model.submission?.id !== event.id ||
        model.submission.phase !== "submitting"
      )
        return unchanged();
      return changed(
        {
          ...model,
          lowBalance: null,
          submission: { ...model.submission, phase: "completed" },
        },
        [{ type: "creation-completed", id: event.id, gridId: event.gridId }],
      );
    case "submission-failed":
      if (
        model.submission?.id !== event.id ||
        model.submission.phase === "completed"
      )
        return unchanged();
      return changed({
        ...model,
        submission: null,
        error: event.balanceUsd !== null ? "" : event.message,
        lowBalance:
          event.balanceUsd !== null ? event.balanceUsd : model.lowBalance,
      });
    case "completion-failed":
      if (
        model.submission?.id !== event.id ||
        model.submission.phase !== "completed"
      )
        return unchanged();
      return changed({ ...model, submission: null, error: event.message });
    case "low-balance-dismissed":
      return model.lowBalance === null
        ? unchanged()
        : changed({ ...model, lowBalance: null });
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
      model.context.catalog,
      createCase,
    );
    draft = change.draft;
    if (change.dropped.length)
      message = `Changing format will discard incompatible or differing ${change.dropped.map((parameter) => parameterNames[parameter]).join(", ")} settings and case values. Differing values that become common will return to their defaults. Continue?`;
  } else {
    message = inputActionConfirmation(model.draft.input, event);
    const input = reduceInput(model.draft.input, event, createCase);
    if (equalCreationData(input, model.draft.input)) return edit(model.draft);
    draft = { ...model.draft, input };
  }
  if (message) {
    const id = model.nextConfirmationId;
    return changed(
      {
        ...model,
        nextCaseId,
        nextConfirmationId: id + 1,
        confirmation: { id, draft },
      },
      [{ type: "confirm", id, message }],
    );
  }
  return edit(draft, nextCaseId);
}

class MachineState {
  #model: CreateModel;

  constructor(model: CreateModel) {
    this.#model = model;
  }

  static read(state: unknown): CreateModel {
    if (!(state instanceof MachineState))
      throw new TypeError("Invalid TypeScript creation machine state.");
    return state.#model;
  }
}

export const typescriptCreationMachine: CreationMachine<unknown> = {
  init(initial, context) {
    const ownedInitial = creationInitialCodec.parse(initial);
    const ownedContext = creationContextCodec.parse(context);
    return new MachineState(
      createModel(ownedInitial.draft, ownedInitial.caseIdPrefix, ownedContext),
    );
  },
  update(state, event): CreateTransition<unknown> {
    const result = updateCreateModel(
      MachineState.read(state),
      creationEventCodec.parse(event),
    );
    return {
      state: new MachineState(result.model),
      outcome: result.outcome,
      commands: copyCreationData(result.commands),
    };
  },
  view(state) {
    const model = MachineState.read(state);
    const submissionPhase = model.submission?.phase ?? "idle";
    const policy = creationPolicy({ ...model, submissionPhase }, model.context);
    return copyCreationData({
      draft: model.draft,
      attempted: model.attempted,
      pendingUploads: model.pendingUploads,
      error: model.error,
      lowBalance: model.lowBalance,
      submissionPhase,
      validationIssues: policy.validationIssues,
      compatibilityIssues: policy.compatibilityIssues,
      compatibilityCells: policy.compatibilityCells,
      eligibility: policy.eligibility,
    });
  },
};
