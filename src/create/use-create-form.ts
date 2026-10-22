import { useEffect, useMemo, useState } from "react";
import { type GridInput } from "../../server/domain";
import { estimateGrid } from "../../server/cost-estimates";
import { modelCatalog } from "../model-catalog";
import { useConnection, useInferenceCapacity } from "../queries";
import { useCreateDraft } from "./draft";
import { useCreateSubmission } from "./use-create-submission";
import { analyzeGridCompatibility } from "../../server/grid-compatibility";
import { canJudge } from "../../server/compatibility";
import { promptVariableIssue } from "../../server/prompt-variables";
import { judgeCriteriaIssue } from "../../server/judge-criteria";
import { compatibilityPreviewInput, validateDraftInput } from "./draft-input";
import type { InputAction } from "./change-axis";

function useBudgetEstimate(input: GridInput) {
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
      input.format === "image" || promptVariableIssue(input)
        ? undefined
        : estimateGrid(input, modelCatalog, new Date(minute * 60000)),
    [input, minute],
  );
}

export function useCreateForm() {
  const editing = useCreateDraft();
  const { draft } = editing;
  const { formatSelected, input } = draft;
  const validation = useMemo(() => validateDraftInput(input), [input]);
  const connection = useConnection();
  const capacity = useInferenceCapacity(
    formatSelected && connection.data?.connected === true,
    input.format,
  );
  const cellCount = input.rows.length * input.columns.length;
  const estimated = useBudgetEstimate(validation.candidate);
  const parallelWorkers =
    input.format === "image"
      ? Math.max(1, Math.min(cellCount, capacity.data?.parallelWorkers ?? 1))
      : undefined;
  const workersPending = !capacity.isSuccess || capacity.isFetching;
  const commonModel = input.parameters.model.kind === "common";
  const commonEffort = input.parameters.effort?.kind === "common";
  const modelMissing =
    input.parameters.model.kind === "common" && !input.parameters.model.value;
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
  const judgeModels = modelCatalog
    .filter((model) => canJudge(model, input.format))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id, "en"),
    );
  const judgeIssue = input.judge
    ? (judgeCriteriaIssue(input) ??
      (input.parameters.judge_model?.kind === "common" &&
      !input.parameters.judge_model.value
        ? "Select a judge model."
        : undefined))
    : undefined;
  const variableIssue = promptVariableIssue(input);
  const submission = useCreateSubmission({
    draft,
    blocked:
      !validation.parsed.success ||
      modelMissing ||
      !!judgeIssue ||
      blockingCompatibilityIssues.length > 0 ||
      !!variableIssue ||
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
  const models = modelCatalog
    .filter((model) => (input.format === "image" ? model.image : model.text))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id, "en"),
    );
  const generateReasons =
    [
      submission.busy && "Starting generation.",
      submission.uploading && "Uploading reference images.",
      workersPending &&
        connection.data?.connected &&
        (capacity.isError
          ? "Could not determine the automatic worker count."
          : "Checking the automatic worker count."),
      modelMissing && "Select a model.",
      judgeIssue,
      ...new Set(blockingCompatibilityIssues.map((issue) => issue.reason)),
      !input.rows.length && "Select row values.",
      !input.columns.length && "Select column values.",
      !connection.data?.connected && "Connect OpenRouter.",
      variableIssue,
      input.format !== "image" &&
        (!Number.isFinite(validation.candidate.budgetUsd) ||
          validation.candidate.budgetUsd <= 0) &&
        "Enter a positive per-cell budget.",
    ]
      .filter(Boolean)
      .join(" ") ||
    (!validation.parsed.success
      ? (validation.parsed.error.issues[0]?.message ?? "")
      : "");

  return {
    draft,
    candidate: validation.candidate,
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
