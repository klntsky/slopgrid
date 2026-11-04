import type { GridDraftInput, GridInput } from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";
import type { ModelInfo } from "../../server/model-catalog";
import type { GridCompatibilityAnalysis } from "../../server/grid-compatibility";
import type { InputAction } from "./input-events";

/**
 * Boundary values are plain data: finite IEEE-754 numbers, safe integers in
 * semantic integer fields, normalized positive zero, and omitted optional object
 * fields rather than undefined values. Raw budget edits remain strings; null
 * explicitly denotes unavailable observations or previews. machine-codec.ts
 * defines and validates the complete canonical domain for every DTO.
 */
export type Draft = {
  formatSelected: boolean;
  input: GridDraftInput;
  sourceGridId?: string;
  reuseArtifacts?: boolean;
};

export type CreateCatalogModel = Pick<
  ModelInfo,
  | "id"
  | "aliasTarget"
  | "canonicalSlug"
  | "name"
  | "image"
  | "imageInput"
  | "text"
  | "reasoning"
  | "reasoningMandatory"
  | "structuredOutputs"
  | "reasoningEfforts"
  | "imageEndpoints"
>;

export type ProviderObservation = {
  connected: boolean;
  capacity: {
    format: GridDraftInput["format"];
    status: "pending" | "ready" | "error";
    parallelWorkers: number | null;
  };
};

export type CreateContext = {
  catalog: readonly CreateCatalogModel[];
  provider: ProviderObservation;
};

export type CreateInitial = { draft: Draft; caseIdPrefix: string };

export type CreateEvent =
  | InputAction
  | { type: "format-selected"; format: GridDraftInput["format"] }
  | { type: "format-cleared" }
  | { type: "budget-changed"; value: string }
  | { type: "reuse-artifacts-changed"; value: boolean }
  | { type: "provider-observed"; provider: ProviderObservation }
  | {
      type: "reference-uploaded";
      id: number;
      localId: string;
      image: ReferenceImage;
    }
  | { type: "upload-status-changed"; busy: boolean }
  | { type: "confirmation-resolved"; id: number; accepted: boolean }
  | { type: "generate-requested"; continueWithLowBalance: boolean }
  | { type: "references-prepared"; id: number }
  | { type: "submission-succeeded"; id: number; gridId: string }
  | {
      type: "submission-failed";
      id: number;
      message: string;
      balanceUsd: number | null;
    }
  | { type: "completion-failed"; id: number; message: string }
  | { type: "low-balance-dismissed" };

export type CreateCommand =
  | { type: "persist-draft"; draft: Draft }
  | { type: "confirm"; id: number; message: string }
  | { type: "prepare-references"; id: number; input: GridInput }
  | {
      type: "submit-grid";
      id: number;
      input: GridInput;
      sourceGridId?: string;
      reuseArtifacts: boolean;
      continueWithLowBalance: boolean;
    }
  | { type: "creation-completed"; id: number; gridId: string }
  | { type: "navigate-home" }
  | { type: "remove-reference-file"; localId: string };

/** Logical changes, not handle identity. draftChanged implies stateChanged. */
export type CreateOutcome = { stateChanged: boolean; draftChanged: boolean };

export type CreateView = {
  draft: Draft;
  attempted: boolean;
  pendingUploads: number;
  error: string;
  lowBalance: number | null;
  submissionPhase: "idle" | "preparing" | "submitting" | "completed";
  validationIssues: { message: string; path: (string | number)[] }[];
  compatibilityIssues: GridCompatibilityAnalysis["issues"];
  // Invalid budget text has no numeric preview; it is not an invented zero.
  compatibilityCells: (Omit<
    GridCompatibilityAnalysis["cells"][number],
    "budgetUsd"
  > & { budgetUsd: number | null })[];
  eligibility: {
    canAttempt: boolean;
    /** Full admission may still reject deferred empty model dimensions. */
    canSubmit: boolean;
    reasons: string[];
    parallelWorkers: number | null;
  };
};

export type CreateTransition<State> = {
  state: State;
  outcome: CreateOutcome;
  commands: CreateCommand[];
};

/**
 * Deterministic, browser-independent implementation boundary. Inputs and
 * returned DTOs must not alias retained state or previously returned values.
 * Updates leave earlier state handles usable; consumers never inspect handles.
 * Eligibility and submission snapshots belong here, not in the effect shell.
 */
export interface CreationMachine<State> {
  init(initial: CreateInitial, context: CreateContext): State;
  update(state: State, event: CreateEvent): CreateTransition<State>;
  view(state: State): CreateView;
}

/**
 * Language bridge with the same semantics. State handles stay backend-owned;
 * update.output encodes only { outcome, commands }. Use the canonical codecs
 * and machine-wire.ts adapters rather than serializing opaque state.
 */
export interface WireCreationMachine<State> {
  init(initial: string, context: string): State;
  update(state: State, event: string): { state: State; output: string };
  view(state: State): string;
}
