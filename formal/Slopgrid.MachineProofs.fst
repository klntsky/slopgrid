module Slopgrid.MachineProofs

module D = Slopgrid.Domain
module Num = Slopgrid.Number
module M = Slopgrid.Machine
module L = FStar.List.Tot.Base
module I = Slopgrid.Input
module Policy = Slopgrid.Policy

#set-options "--fuel 8 --ifuel 2"

let ignored (model:M.state) (event:D.event) : prop =
  let result = M.update_step model event in
  result.next_state == model /\ result.commands == [] /\ result.change == D.NoChange

(* A reported draft change always counts as a state change. *)
let change_coherence (change:D.change)
  : Lemma (D.draft_changed change ==> D.state_changed change) =
  match change with | D.NoChange -> () | D.MetadataChanged -> () | D.DraftChanged -> ()

(* Every dispatched event reports changes consistently: a changed draft cannot
   be reported as unchanged state. *)
let outcome_coherence (model:M.state) (event:D.event)
  : Lemma (
    let _,output = M.update model event in
    D.draft_changed output.change ==> D.state_changed output.change) =
  let result = M.update_step model event in
  change_coherence result.change

(* A decision that permits submission also permits attempting generation. *)
let submission_requires_admission (decision:D.admission_decision)
  : Lemma (D.can_submit decision ==> D.can_attempt decision) =
  match decision with
  | D.CannotAttempt _ -> ()
  | D.IncompleteSelection -> ()
  | D.ReadyToSubmit _ -> ()

(* Every admitted request carries a finite, strictly positive per-cell budget;
   this invariant is enforced by the admitted-input type. *)
let admitted_budget_is_positive_and_finite (input:D.admitted_input)
  : Lemma (Num.is_finite input.budget_usd /\ Num.lt Num.zero input.budget_usd) = ()

(* Every admitted request has at least one row and one column. *)
let admitted_axes_are_nonempty (input:D.admitted_input)
  : Lemma (input.admitted_layout.rows <> [] /\ input.admitted_layout.columns <> []) = ()

(* While a submission exists, another generation request leaves the entire
   state unchanged and emits no commands. *)
let duplicate_generation_is_ignored (model:M.state) (continue_low_balance:bool)
  : Lemma
    (requires (M.has_submission model))
    (ensures (ignored model (D.GenerateRequested continue_low_balance))) = ()

(* A preparation callback that does not own the current preparing request has
   no state change or commands. *)
let stale_preparation_is_ignored (model:M.state) (id:pos)
  : Lemma
    (requires (not (M.owns model id D.Preparing)))
    (ensures (ignored model (D.ReferencesPrepared id))) = ()

(* A success callback that does not own the current submitting request cannot
   change state or trigger commands. *)
let stale_success_is_ignored (model:M.state) (id:pos) (grid_id:string)
  : Lemma
    (requires (not (M.owns model id D.Submitting)))
    (ensures (ignored model (D.SubmissionSucceeded id grid_id))) = ()

(* A completion failure that does not own the current completed request cannot
   change state or trigger commands. *)
let stale_completion_failure_is_ignored (model:M.state) (id:pos) (message:string)
  : Lemma
    (requires (not (M.owns model id D.Completed)))
    (ensures (ignored model (D.CompletionFailed id message))) = ()

(* An uploaded reference from a callback that does not own the preparing
   request cannot replace images or otherwise change state or commands. *)
let stale_reference_upload_is_ignored (model:M.state) (id:pos) (local_id:string)
  (image:D.reference_image)
  : Lemma
    (requires (not (M.owns model id D.Preparing)))
    (ensures (ignored model (D.ReferenceUploaded id local_id image))) = ()

(* Resolving a confirmation whose identity is not pending has no effect,
   whether the answer accepts or cancels it. *)
let stale_confirmation_is_ignored (model:M.state) (id:pos) (accepted:bool)
  : Lemma
    (requires (not (M.owns_confirmation model id)))
    (ensures (ignored model (D.ConfirmationResolved id accepted))) = ()

(* Editing the budget leaves the complete active request unchanged, so the
   edit cannot alter the request that has already been captured. *)
let budget_edit_preserves_captured_request (model:M.state) (budget_text:string)
  : Lemma (
    (M.update_step model (D.ChangeBudget budget_text)).next_state.active == model.active) = ()

(* Starting an upload increases the pending-upload count by exactly one. *)
let upload_counter_increments (model:M.state)
  : Lemma (
    (M.update_step model (D.UploadStatus true)).next_state.pending_uploads == model.pending_uploads + 1) = ()

(* Finishing an upload decreases the pending count by one when positive and
   leaves zero at zero; the counter never underflows. *)
let upload_counter_decrements_without_underflow (model:M.state)
  : Lemma (
    (M.update_step model (D.UploadStatus false)).next_state.pending_uploads ==
      (if model.pending_uploads = 0 then 0 else model.pending_uploads - 1)) = ()

(* A generation request never decreases the next request identifier. *)
let generation_request_counter_never_decreases (model:M.state) (continue_low_balance:bool)
  : Lemma (
    (M.update_step model (D.GenerateRequested continue_low_balance)).next_state.next_request >= model.next_request) = ()

(* With no existing submission and a submittable policy decision, generation
   starts a preparing request with the current identifier and advances the next
   identifier exactly once. *)
let generation_captures_request_and_advances_counter (model:M.state) (continue_low_balance:bool)
  : Lemma
    (requires (not (M.has_submission model) /\
      D.can_submit (Policy.evaluate model.draft model.attempted model.pending_uploads
        (M.submission_phase model) model.context).decision))
    (ensures (
      let result = M.update_step model (D.GenerateRequested continue_low_balance) in
      result.next_state.next_request == model.next_request + 1 /\
      (match result.next_state.active with
      | None -> False
      | Some request -> request.request_id == model.next_request /\
          request.request_phase == D.Preparing))) = ()

(* Replacing reference images leaves both axes of an admitted layout nonempty.
   This establishes the axis invariant, not every admission-policy condition. *)
let reference_substitution_preserves_admission (input:D.admitted_input) (local_id:string)
  (image:D.reference_image)
  : Lemma (
    let replaced = M.replace_references input.admitted_layout local_id image in
    replaced.rows <> [] /\ replaced.columns <> []) = ()

#push-options "--fuel 0 --ifuel 0"
(* Transpose preserves the number of Cartesian cells by exchanging the row and
   column counts; it does not require either dimension to be nonempty. *)
let transpose_preserves_cell_count (layout:D.layout)
  : Lemma (
    let swapped = I.swap layout in
    L.length swapped.rows * L.length swapped.columns ==
      L.length layout.rows * L.length layout.columns) =
  let swapped = I.swap layout in
  assert (L.length swapped.rows == L.length layout.columns);
  assert (L.length swapped.columns == L.length layout.rows)
#pop-options
