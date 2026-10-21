import { useEffect, useMemo, useState } from "react";
import {
  isChatFormat,
  chatInputIssue,
  type GridInput,
} from "../../server/domain";
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
  const cellCount = input.rows.values.length * input.columns.values.length;
  const estimated = useBudgetEstimate(validation.candidate);
  const parallelWorkers =
    input.format === "image"
      ? Math.max(1, Math.min(cellCount, capacity.data?.parallelWorkers ?? 1))
      : undefined;
  const workersPending = !capacity.isSuccess || capacity.isFetching;
  const commonModel = ![input.rows.kind, input.columns.kind].includes("model");
  const commonEffort =
    input.format !== "image" &&
    ![input.rows.kind, input.columns.kind].includes("effort");
  const modelMissing = commonModel && !input.model;
  const commonJudgeModel =
    !!input.judge &&
    ![input.rows.kind, input.columns.kind].includes("judge_model");
  const commonJudgeEffort =
    !!input.judge &&
    ![input.rows.kind, input.columns.kind].includes("judge_effort");
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
      (commonJudgeModel && !input.judge.model
        ? "Select a judge model."
        : undefined))
    : [input.rows, input.columns].some(
          (axis) => axis.kind === "judge_model" || axis.kind === "judge_effort",
        )
      ? "Add a judge to use judge dimensions."
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
      !input.rows.values.length && "Select row values.",
      !input.columns.values.length && "Select column values.",
      !connection.data?.connected && "Connect OpenRouter.",
      isChatFormat(input.format)
        ? chatInputIssue(input.messages)
        : !input.prompt.trim() &&
          (input.format === "image" || !input.inputReferences?.length) &&
          "Enter a prompt.",
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
    selectFormat,
    swapAxes: () => {
      editing.swapAxes();
      submission.reset();
    },
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
