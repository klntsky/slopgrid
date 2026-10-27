import { useEffect, useMemo, useState } from "react";
import { modelSelectionIssueKind, type GridInput } from "../../server/domain";
import { estimateGrid } from "../../server/cost-estimates";
import { modelCatalog } from "../model-catalog";
import { useConnection, useInferenceCapacity } from "../queries";
import { useCreateDraft } from "./draft";
import { useCreateSubmission } from "./use-create-submission";
import { analyzeGridCompatibility } from "../../server/grid-compatibility";
import { canJudge } from "../../server/compatibility";
import { promptVariableIssue } from "../../server/prompt-variables";
import { compatibilityPreviewInput, validateDraftInput } from "./draft-input";
import type { InputAction } from "./change-axis";
import type { ZodIssue } from "zod";
import { modelAliasResolver } from "../../server/model-alias";

function isDeferredModelIssue(issue: ZodIssue) {
  return (
    issue.code === "custom" && issue.params?.kind === modelSelectionIssueKind
  );
}

const sortedModelCatalog = [...modelCatalog].sort(
  (a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.id.localeCompare(b.id, "en"),
);
const catalogById = new Map(modelCatalog.map((model) => [model.id, model]));
const resolveModel = modelAliasResolver(catalogById);
function eligibleModel(model: (typeof modelCatalog)[number]) {
  try {
    return catalogById.get(resolveModel(model.id));
  } catch {
    return undefined;
  }
}

function useBudgetEstimate(input: GridInput, validated: boolean) {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000));
  useEffect(() => {
    const timer = setInterval(
      () => setMinute(Math.floor(Date.now() / 60000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return useMemo(
    () =>
      input.format === "image" || (!validated && promptVariableIssue(input))
        ? undefined
        : estimateGrid(input, modelCatalog, new Date(minute * 60000)),
    [input, minute, validated],
  );
}

export function useCreateForm() {
  const editing = useCreateDraft();
  const { draft } = editing;
  const { formatSelected, input } = draft;
  const validation = useMemo(() => validateDraftInput(input), [input]);
  const validationIssues = validation.parsed.success
    ? []
    : validation.parsed.error.issues;
  const blockingValidationIssues = validationIssues.filter(
    (issue) => !isDeferredModelIssue(issue),
  );
  const connection = useConnection();
  const capacity = useInferenceCapacity(
    formatSelected && connection.data?.connected === true,
    input.format,
  );
  const cellCount = input.rows.length * input.columns.length;
  const estimated = useBudgetEstimate(
    validation.candidate,
    validation.parsed.success,
  );
  const parallelWorkers =
    input.format === "image"
      ? Math.max(1, Math.min(cellCount, capacity.data?.parallelWorkers ?? 1))
      : undefined;
  const workersPending = !capacity.isSuccess || capacity.isFetching;
  const commonModel = input.parameters.model.kind === "common";
  const commonEffort = input.parameters.effort?.kind === "common";
  const commonJudgeModel =
    input.judge && input.parameters.judge_model?.kind === "common";
  const commonJudgeEffort =
    input.judge && input.parameters.judge_effort?.kind === "common";
  const compatibilityAnalysis = useMemo(
    () =>
      analyzeGridCompatibility(
        compatibilityPreviewInput(validation.candidate),
        modelCatalog,
      ),
    [validation.candidate],
  );
  const { cells: compatibilityCells, issues: compatibilityIssues } =
    compatibilityAnalysis;
  const blockingCompatibilityIssues = compatibilityIssues.filter(
    (issue) => issue.blocking,
  );
  const judgeModels = sortedModelCatalog.filter((model) => {
    const effective = eligibleModel(model);
    return effective && canJudge(effective, input.format);
  });
  const submission = useCreateSubmission({
    draft,
    blocked:
      blockingValidationIssues.length > 0 ||
      blockingCompatibilityIssues.length > 0 ||
      workersPending,
    parallelWorkers,
    onReferenceUploaded: editing.replaceReference,
  });
  function update(change: Parameters<typeof editing.update>[0]) {
    editing.update(change);
    submission.reset();
  }
  function dispatch(action: InputAction) {
    const applied = editing.dispatch(action);
    if (applied) submission.reset();
    return applied;
  }
  function selectFormat(format: GridInput["format"]) {
    submission.reset();
    editing.selectFormat(format);
  }
  const models = sortedModelCatalog.filter((model) => {
    const effective = eligibleModel(model);
    return input.format === "image" ? effective?.image : effective?.text;
  });
  const generateReasons = [
    submission.busy && "Starting generation.",
    submission.uploading && "Uploading reference images.",
    workersPending &&
      connection.data?.connected &&
      (capacity.isError
        ? "Could not determine the automatic worker count."
        : "Checking the automatic worker count."),
    ...new Set(blockingValidationIssues.map((issue) => issue.message)),
    ...new Set(blockingCompatibilityIssues.map((issue) => issue.reason)),
    !connection.data?.connected && "Connect OpenRouter.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    draft,
    candidate: validation.candidate,
    validationIssues: validationIssues.filter(
      (issue) => submission.attempted || !isDeferredModelIssue(issue),
    ),
    compatibilityIssues,
    compatibilityCells,
    update,
    dispatch,
    selectFormat,
    swapAxes: () => dispatch({ type: "swap" }),
    setReuseArtifacts: editing.setReuseArtifacts,
    connection,
    capacity,
    estimated,
    models,
    commonModel,
    commonEffort,
    judgeModels,
    commonJudgeModel,
    commonJudgeEffort,
    generateReasons,
    submission,
  };
}
