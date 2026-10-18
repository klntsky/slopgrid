import { useEffect, useMemo, useState } from "react";
import {
  unusedVariableIssue,
  isChatFormat,
  chatInputIssue,
  type GridInput,
} from "../../server/domain";
import { estimateGrid } from "../../server/cost-estimates";
import { modelCatalog } from "../model-catalog";
import { useConnection, useInferenceCapacity } from "../queries";
import { useCreateDraft } from "./draft";
import { useCreateSubmission } from "./use-create-submission";
import { canJudge } from "../../server/compatibility";

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
      input.format === "image"
        ? undefined
        : estimateGrid(input, modelCatalog, new Date(minute * 60000)),
    [input, minute],
  );
}

export function useCreateForm() {
  const editing = useCreateDraft();
  const { draft } = editing;
  const { formatSelected, input } = draft;
  const connection = useConnection();
  const capacity = useInferenceCapacity(
    formatSelected && connection.data?.connected === true,
    input.format,
  );
  const cellCount = input.rows.values.length * input.columns.values.length;
  const estimated = useBudgetEstimate(input);
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
  const judgeModels = modelCatalog
    .filter((model) => canJudge(model, input.format))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id, "en"),
    );
  const judgeModelIds = [input.rows, input.columns].find(
    (axis) => axis.kind === "judge_model",
  )?.values ?? [input.judge?.model ?? ""];
  const judgeIssue = input.judge
    ? !input.judge.criteria.length
      ? "Add at least one criterion."
      : input.judge.criteria.some(
            (criterion) =>
              !criterion.text.trim() ||
              typeof criterion.correctAnswer !== "boolean",
          )
        ? "Enter a yes-or-no question for each criterion."
        : !judgeModels.length
          ? "No compatible judge models are available for this output type."
          : !judgeModelIds.length || judgeModelIds.some((id) => !id)
            ? "Select a judge model."
            : judgeModelIds.some(
                  (id) => !judgeModels.some((model) => model.id === id),
                )
              ? "Select a judge model."
              : undefined
    : [input.rows, input.columns].some(
          (axis) => axis.kind === "judge_model" || axis.kind === "judge_effort",
        )
      ? "Add a judge to use judge dimensions."
      : undefined;
  const submission = useCreateSubmission({
    draft,
    blocked: modelMissing || !!judgeIssue || workersPending,
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
    .filter((m) => (input.format === "image" ? m.image : m.text))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id, "en"),
    );
  const generateReasons = [
    submission.busy && "Starting generation.",
    submission.uploading && "Uploading reference images.",
    workersPending &&
      connection.data?.connected &&
      (capacity.isError
        ? "Could not determine the automatic worker count."
        : "Checking the automatic worker count."),
    modelMissing && "Select a model.",
    judgeIssue,
    !input.rows.values.length && "Select row values.",
    !input.columns.values.length && "Select column values.",
    !connection.data?.connected && "Connect OpenRouter.",
    isChatFormat(input.format)
      ? chatInputIssue(input.messages)
      : !input.prompt.trim() && "Enter a prompt.",
    unusedVariableIssue(input),
    input.format !== "image" &&
      (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) &&
      "Enter a positive per-cell budget.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    draft,
    update,
    selectFormat,
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
