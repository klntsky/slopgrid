import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { GridInput } from "../../server/domain";
import { estimateGrid } from "../../server/cost-estimates";
import { modelCatalog } from "../model-catalog";
import { useConnection, useInferenceCapacity } from "../queries";
import { useCreateMachine } from "./use-create-machine";
import { canJudge } from "../../server/compatibility";
import { promptVariableIssue } from "../../server/prompt-variables";
import { validateDraftInput } from "./draft-input";

const sortedModelCatalog = [...modelCatalog].sort(
  (a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.id.localeCompare(b.id, "en"),
);

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
  const { view, dispatch } = useCreateMachine();
  const { draft } = view;
  const { formatSelected, input } = draft;
  const validation = useMemo(() => validateDraftInput(input), [input]);
  const connection = useConnection();
  const capacity = useInferenceCapacity(
    formatSelected && connection.data?.connected === true,
    input.format,
  );
  const connected = connection.data?.connected === true;
  const capacityStatus = capacity.isFetching
    ? "pending"
    : capacity.isError
      ? "error"
      : capacity.isSuccess
        ? "ready"
        : "pending";
  const automaticWorkers = capacity.data?.parallelWorkers ?? null;
  useLayoutEffect(() => {
    dispatch({
      type: "provider-observed",
      provider: {
        connected,
        capacity: {
          format: input.format,
          status: capacityStatus,
          parallelWorkers: automaticWorkers,
        },
      },
    });
  }, [dispatch, connected, input.format, capacityStatus, automaticWorkers]);
  const estimated = useBudgetEstimate(
    validation.candidate,
    validation.parsed.success,
  );
  const commonModel = input.parameters.model.kind === "common";
  const commonEffort = input.parameters.effort?.kind === "common";
  const commonJudgeModel =
    input.judge && input.parameters.judge_model?.kind === "common";
  const commonJudgeEffort =
    input.judge && input.parameters.judge_effort?.kind === "common";
  const { compatibilityCells, compatibilityIssues, validationIssues } = view;
  const judgeModels = sortedModelCatalog.filter((model) =>
    canJudge(model, input.format),
  );
  const submission = {
    attempted: view.attempted,
    uploading: view.pendingUploads > 0 || view.submissionPhase === "preparing",
    busy:
      view.submissionPhase === "submitting" ||
      view.submissionPhase === "completed",
    error: view.error,
    lowBalance: view.lowBalance,
  };
  const models = sortedModelCatalog.filter((model) =>
    input.format === "image" ? model.image : model.text,
  );
  const generateReasons = view.eligibility.reasons.join(" ");

  return {
    draft,
    validationIssues,
    compatibilityIssues,
    compatibilityCells,
    dispatch,
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
