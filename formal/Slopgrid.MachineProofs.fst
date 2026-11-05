module Slopgrid.MachineProofs

module Domain = Slopgrid.Domain
module Number = Slopgrid.Number
module Machine = Slopgrid.Machine
module List = FStar.List.Tot.Base
module Input = Slopgrid.Input
module Policy = Slopgrid.Policy

#set-options "--fuel 8 --ifuel 2"

let ignored (model: Machine.state) (event: Domain.event) : prop =
  let result = Machine.update_step model event in
  result.next_state == model /\ result.commands == [] /\ result.change == Domain.NoChange

(* A reported draft change always counts as a state change. *)
let change_coherence (change: Domain.change)
  : Lemma (Domain.draft_changed change ==> Domain.state_changed change) =
  match change with
  | Domain.NoChange -> ()
  | Domain.MetadataChanged -> ()
  | Domain.DraftChanged -> ()

(* Every dispatched event reports changes consistently: a changed draft cannot
   be reported as unchanged state. *)
let outcome_coherence (model: Machine.state) (event: Domain.event)
  : Lemma (
    let _, output = Machine.update model event in
    Domain.draft_changed output.change ==> Domain.state_changed output.change) =
  let result = Machine.update_step model event in
  change_coherence result.change

(* A decision that permits submission also permits attempting generation. *)
let submission_requires_admission (decision: Domain.admission_decision)
  : Lemma (Domain.can_submit decision ==> Domain.can_attempt decision) =
  match decision with
  | Domain.CannotAttempt _ -> ()
  | Domain.IncompleteSelection -> ()
  | Domain.ReadyToSubmit _ -> ()

(* Every admitted request carries a finite, strictly positive per-cell budget;
   this invariant is enforced by the admitted-input type. *)
let admitted_budget_is_positive_and_finite (input: Domain.admitted_input)
  : Lemma (Number.is_finite input.budget_usd /\ Number.lt Number.zero input.budget_usd) =
  ()

(* Every admitted request has at least one row and one column. *)
let admitted_axes_are_nonempty (input: Domain.admitted_input)
  : Lemma (input.admitted_layout.rows <> [] /\ input.admitted_layout.columns <> []) =
  ()

(* While a submission exists, another generation request leaves the entire
   state unchanged and emits no commands. *)
let duplicate_generation_is_ignored (model: Machine.state) (continue_low_balance: bool)
  : Lemma
    (requires (Machine.has_submission model))
    (ensures (ignored model (Domain.GenerateRequested continue_low_balance))) =
  ()

(* A preparation callback that does not own the current preparing request has
   no state change or commands. *)
let stale_preparation_is_ignored (model: Machine.state) (id: pos)
  : Lemma
    (requires (not (Machine.owns model id Domain.Preparing)))
    (ensures (ignored model (Domain.ReferencesPrepared id))) =
  ()

(* A success callback that does not own the current submitting request cannot
   change state or trigger commands. *)
let stale_success_is_ignored (model: Machine.state) (id: pos) (grid_id: string)
  : Lemma
    (requires (not (Machine.owns model id Domain.Submitting)))
    (ensures (ignored model (Domain.SubmissionSucceeded id grid_id))) =
  ()

(* A completion failure that does not own the current completed request cannot
   change state or trigger commands. *)
let stale_completion_failure_is_ignored (model: Machine.state) (id: pos) (message: string)
  : Lemma
    (requires (not (Machine.owns model id Domain.Completed)))
    (ensures (ignored model (Domain.CompletionFailed id message))) =
  ()

(* An uploaded reference from a callback that does not own the preparing
   request cannot replace images or otherwise change state or commands. *)
let stale_reference_upload_is_ignored (model: Machine.state) (id: pos) (local_id: string)
  (image: Domain.reference_image)
  : Lemma
    (requires (not (Machine.owns model id Domain.Preparing)))
    (ensures (ignored model (Domain.ReferenceUploaded id local_id image))) =
  ()

(* Resolving a confirmation whose identity is not pending has no effect,
   whether the answer accepts or cancels it. *)
let stale_confirmation_is_ignored (model: Machine.state) (id: pos) (accepted: bool)
  : Lemma
    (requires (not (Machine.owns_confirmation model id)))
    (ensures (ignored model (Domain.ConfirmationResolved id accepted))) =
  ()

(* Editing the budget leaves the complete active request unchanged, so the
   edit cannot alter the request that has already been captured. *)
let budget_edit_preserves_captured_request (model: Machine.state) (budget_text: string)
  : Lemma (
    (Machine.update_step model (Domain.ChangeBudget budget_text)).next_state.active ==
      model.active) =
  ()

(* Starting an upload increases the pending-upload count by exactly one. *)
let upload_counter_increments (model: Machine.state)
  : Lemma (
    (Machine.update_step model (Domain.UploadStatus true)).next_state.pending_uploads ==
      model.pending_uploads + 1) =
  ()

(* Finishing an upload decreases the pending count by one when positive and
   leaves zero at zero; the counter never underflows. *)
let upload_counter_decrements_without_underflow (model: Machine.state)
  : Lemma (
    (Machine.update_step model (Domain.UploadStatus false)).next_state.pending_uploads ==
      (if model.pending_uploads = 0 then 0 else model.pending_uploads - 1)) =
  ()

(* A generation request never decreases the next request identifier. *)
let generation_request_counter_never_decreases (model: Machine.state) (continue_low_balance: bool)
  : Lemma (
    (Machine.update_step model
      (Domain.GenerateRequested continue_low_balance)).next_state.next_request >=
    model.next_request) =
  ()

(* With no existing submission and a submittable policy decision, generation
   starts a preparing request with the current identifier and advances the next
   identifier exactly once. *)
let generation_captures_request_and_advances_counter
  (model: Machine.state) (continue_low_balance: bool)
  : Lemma
    (requires (
      not (Machine.has_submission model) /\
      Domain.can_submit
        (Policy.evaluate model.draft model.attempted model.pending_uploads
          (Machine.submission_phase model) model.context).decision))
    (ensures (
      let result = Machine.update_step model (Domain.GenerateRequested continue_low_balance) in
      result.next_state.next_request == model.next_request + 1 /\
      (match result.next_state.active with
       | None -> False
       | Some request ->
         request.request_id == model.next_request /\
         request.request_phase == Domain.Preparing))) =
  ()

(* Replacing reference images leaves both axes of an admitted layout nonempty.
   This establishes the axis invariant, not every admission-policy condition. *)
let reference_substitution_preserves_admission
  (input: Domain.admitted_input) (local_id: string) (image: Domain.reference_image)
  : Lemma (
    let replaced = Machine.replace_references input.admitted_layout local_id image in
    replaced.rows <> [] /\ replaced.columns <> []) =
  ()

#push-options "--fuel 0 --ifuel 0"
(* Transpose preserves the number of Cartesian cells by exchanging the row and
   column counts; it does not require either dimension to be nonempty. *)
let transpose_preserves_cell_count (layout: Domain.layout)
  : Lemma (
    let swapped = Input.swap layout in
    List.length swapped.rows * List.length swapped.columns ==
      List.length layout.rows * List.length layout.columns) =
  let swapped = Input.swap layout in
  assert (List.length swapped.rows == List.length layout.columns);
  assert (List.length swapped.columns == List.length layout.rows)
#pop-options
