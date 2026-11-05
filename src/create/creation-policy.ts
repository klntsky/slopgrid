import { modelSelectionIssueKind, type GridInput } from "../../server/domain";
import { analyzeGridCompatibility } from "../../server/grid-compatibility";
import { compatibilityPreviewInput, validateDraftInput } from "./draft-input";
import type { CreateContext, CreateView, Draft } from "./machine-contract";

type PolicyState = {
  draft: Draft;
  attempted: boolean;
  pendingUploads: number;
  submissionPhase: CreateView["submissionPhase"];
};

export function creationPolicy(
  state: PolicyState,
  context: CreateContext,
): {
  validationIssues: CreateView["validationIssues"];
  compatibilityIssues: CreateView["compatibilityIssues"];
  compatibilityCells: CreateView["compatibilityCells"];
  eligibility: CreateView["eligibility"];
  admittedInput: GridInput | null;
} {
  const { draft } = state;
  const capacity = context.provider.capacity;
  const capacityReady =
    capacity.status === "ready" && capacity.format === draft.input.format;
  const parallelWorkers =
    draft.input.format === "image" && capacityReady
      ? Math.max(
          1,
          Math.min(
            draft.input.rows.length * draft.input.columns.length,
            capacity.parallelWorkers ?? 1,
          ),
        )
      : null;
  const { parallelWorkers: _previousWorkers, ...editableInput } = draft.input;
  const validation = validateDraftInput({
    ...editableInput,
    ...(parallelWorkers !== null ? { parallelWorkers } : {}),
  });
  const issues = validation.parsed.success
    ? []
    : validation.parsed.error.issues;
  const budget = validation.candidate.budgetUsd;
  const deferred = (issue: (typeof issues)[number]) =>
    issue.code === "custom" && issue.params?.kind === modelSelectionIssueKind;
  const blockingValidation = issues.filter((issue) => !deferred(issue));
  const compatibility = analyzeGridCompatibility(
    compatibilityPreviewInput(validation.candidate),
    context.catalog,
  );
  const blockingCompatibility = compatibility.issues.filter(
    (issue) => issue.blocking,
  );
  const busy =
    state.submissionPhase === "submitting" ||
    state.submissionPhase === "completed";
  const uploading =
    state.pendingUploads > 0 || state.submissionPhase === "preparing";
  const canAttempt =
    draft.formatSelected &&
    context.provider.connected &&
    capacityReady &&
    !busy &&
    !uploading &&
    !blockingValidation.length &&
    !blockingCompatibility.length;
  const canSubmit = canAttempt && validation.parsed.success;
  const reasons = [
    ...(busy ? ["Starting generation."] : []),
    ...(uploading ? ["Uploading reference images."] : []),
    ...(!capacityReady && context.provider.connected
      ? [
          capacity.format === draft.input.format && capacity.status === "error"
            ? "Could not determine the automatic worker count."
            : "Checking the automatic worker count.",
        ]
      : []),
    ...new Set(blockingValidation.map((issue) => issue.message)),
    ...new Set(blockingCompatibility.map((issue) => issue.reason)),
    ...(!context.provider.connected ? ["Connect OpenRouter."] : []),
  ];
  return {
    validationIssues: issues
      .filter((issue) => state.attempted || !deferred(issue))
      .map((issue) => ({
        message: issue.message,
        path: issue.path.map((part) =>
          typeof part === "number" ? part : String(part),
        ),
      })),
    compatibilityIssues: compatibility.issues,
    compatibilityCells: compatibility.cells.map((cell) => ({
      ...cell,
      budgetUsd: Number.isFinite(budget) ? budget : null,
    })),
    eligibility: { canAttempt, canSubmit, reasons, parallelWorkers },
    admittedInput:
      canSubmit && validation.parsed.success ? validation.parsed.data : null,
  };
}
