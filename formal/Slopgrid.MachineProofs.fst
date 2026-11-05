module Slopgrid.MachineProofs

(* These proofs cover the creation form's event handling, not inference or
   browser storage. Request callbacks must match both the active request ID and
   its phase before they may change the form. *)

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

(* The form cannot report an edited draft without also reporting changed state. *)
let change_coherence (change: Domain.change)
  : Lemma (Domain.draft_changed change ==> Domain.state_changed change) =
  match change with
  | Domain.NoChange -> ()
  | Domain.MetadataChanged -> ()
  | Domain.DraftChanged -> ()

(* This applies the change-reporting rule to every form event, including events
   that only update a dialog or an active request. *)
let outcome_coherence (model: Machine.state) (event: Domain.event)
  : Lemma (
    let _, output = Machine.update model event in
    Domain.draft_changed output.change ==> Domain.state_changed output.change) =
  let result = Machine.update_step model event in
  change_coherence result.change

(* A ready-to-submit decision cannot also forbid the Generate attempt. *)
let submission_requires_admission (decision: Domain.admission_decision)
  : Lemma (Domain.can_submit decision ==> Domain.can_attempt decision) =
  match decision with
  | Domain.CannotAttempt _ -> ()
  | Domain.IncompleteSelection -> ()
  | Domain.ReadyToSubmit _ -> ()

(* The admitted-input type stores a finite positive budget. This is an internal
   type fact, not a claim that Image generation requires a text budget.
   Text and Image budget rules differ. PRODUCT.md 3.5.1. *)
let admitted_budget_is_positive_and_finite (input: Domain.admitted_input)
  : Lemma (Number.is_finite input.budget_usd /\ Number.lt Number.zero input.budget_usd) =
  ()

(* An admitted grid has a row and a column, so it has at least one cell. *)
let admitted_axes_are_nonempty (input: Domain.admitted_input)
  : Lemma (input.admitted_layout.rows <> [] /\ input.admitted_layout.columns <> []) =
  ()

(* Generate does nothing while the form still has an active submission.
   Repeated clicks cannot start another request or emit another command. *)
let duplicate_generation_is_ignored (model: Machine.state) (continue_low_balance: bool)
  : Lemma
    (requires (Machine.has_submission model))
    (ensures (ignored model (Domain.GenerateRequested continue_low_balance))) =
  ()

(* Reference preparation may finish after the form has moved on. Ignore the
   callback unless its ID matches the active request in Preparing. *)
let stale_preparation_is_ignored (model: Machine.state) (id: pos)
  : Lemma
    (requires (not (Machine.owns model id Domain.Preparing)))
    (ensures (ignored model (Domain.ReferencesPrepared id))) =
  ()

(* A submission success belongs only to the matching ID in Submitting.
   An old success cannot replace the current form state or emit commands. *)
let stale_success_is_ignored (model: Machine.state) (id: pos) (grid_id: string)
  : Lemma
    (requires (not (Machine.owns model id Domain.Submitting)))
    (ensures (ignored model (Domain.SubmissionSucceeded id grid_id))) =
  ()

(* A completion failure belongs only to the matching ID in Completed.
   Even a matching ID is ignored if the request is in a different phase. *)
let stale_completion_failure_is_ignored (model: Machine.state) (id: pos) (message: string)
  : Lemma
    (requires (not (Machine.owns model id Domain.Completed)))
    (ensures (ignored model (Domain.CompletionFailed id message))) =
  ()

(* Upload results may replace local image references only for the matching
   Preparing request. A stale result changes neither images nor other state.
   This covers callback ownership, not the upload/storage work in PRODUCT.md 3.7.4. *)
let stale_reference_upload_is_ignored (model: Machine.state) (id: pos) (local_id: string)
  (image: Domain.reference_image)
  : Lemma
    (requires (not (Machine.owns model id Domain.Preparing)))
    (ensures (ignored model (Domain.ReferenceUploaded id local_id image))) =
  ()

(* A dismissed or superseded loss dialog cannot apply its old proposal.
   Ignore both acceptance and cancellation when no pending ID matches. *)
let stale_confirmation_is_ignored (model: Machine.state) (id: pos) (accepted: bool)
  : Lemma
    (requires (not (Machine.owns_confirmation model id)))
    (ensures (ignored model (Domain.ConfirmationResolved id accepted))) =
  ()

(* Changing the budget edits the next setup, not the request already in flight.
   Here equality covers the entire active request, including its captured input. *)
let budget_edit_preserves_captured_request (model: Machine.state) (budget_text: string)
  : Lemma (
    (Machine.update_step model (Domain.ChangeBudget budget_text)).next_state.active ==
      model.active) =
  ()

(* Starting an attachment upload adds one to the form's pending-upload count. *)
let upload_counter_increments (model: Machine.state)
  : Lemma (
    (Machine.update_step model (Domain.UploadStatus true)).next_state.pending_uploads ==
      model.pending_uploads + 1) =
  ()

(* Finishing an attachment upload removes one pending upload if any remain.
   An extra finish notification cannot make the count negative. *)
let upload_counter_decrements_without_underflow (model: Machine.state)
  : Lemma (
    (Machine.update_step model (Domain.UploadStatus false)).next_state.pending_uploads ==
      (if model.pending_uploads = 0 then 0 else model.pending_uploads - 1)) =
  ()

(* Generate never rolls back the counter used to identify request callbacks. *)
let generation_request_counter_never_decreases (model: Machine.state) (continue_low_balance: bool)
  : Lemma (
    (Machine.update_step model
      (Domain.GenerateRequested continue_low_balance)).next_state.next_request >=
    model.next_request) =
  ()

(* With no active submission and a submittable policy decision, Generate starts
   Preparing under the next request ID and advances the counter once.
   This proves the ID, phase, and counter only, not captured-payload equality. *)
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

(* Replacing local attachment references keeps an admitted grid's rows and
   columns nonempty. The name does not claim all admission checks still pass,
   and this pure replacement does not perform the upload in PRODUCT.md 3.7.4. *)
let reference_substitution_preserves_admission
  (input: Domain.admitted_input) (local_id: string) (image: Domain.reference_image)
  : Lemma (
    let replaced = Machine.replace_references input.admitted_layout local_id image in
    replaced.rows <> [] /\ replaced.columns <> []) =
  ()

#push-options "--fuel 0 --ifuel 0"
(* Swap exchanges row and column counts without changing the number of cells.
   This is the cell-count part of PRODUCT.md 3.1.4, even for an empty axis. *)
let transpose_preserves_cell_count (layout: Domain.layout)
  : Lemma (
    let swapped = Input.swap layout in
    List.length swapped.rows * List.length swapped.columns ==
      List.length layout.rows * List.length layout.columns) =
  let swapped = Input.swap layout in
  assert (List.length swapped.rows == List.length layout.columns);
  assert (List.length swapped.columns == List.length layout.rows)
#pop-options
