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

let change_coherence (change:D.change)
  : Lemma (D.draft_changed change ==> D.state_changed change) =
  match change with | D.NoChange -> () | D.MetadataChanged -> () | D.DraftChanged -> ()

let outcome_coherence (model:M.state) (event:D.event)
  : Lemma (
    let _,output = M.update model event in
    D.draft_changed output.change ==> D.state_changed output.change) =
  let result = M.update_step model event in
  change_coherence result.change

let submission_requires_admission (decision:D.admission_decision)
  : Lemma (D.can_submit decision ==> D.can_attempt decision) =
  match decision with
  | D.CannotAttempt _ -> ()
  | D.IncompleteSelection -> ()
  | D.ReadyToSubmit _ -> ()

let admitted_budget_is_positive_and_finite (input:D.admitted_input)
  : Lemma (Num.is_finite input.budget_usd /\ Num.lt Num.zero input.budget_usd) = ()

let admitted_axes_are_nonempty (input:D.admitted_input)
  : Lemma (input.admitted_layout.rows <> [] /\ input.admitted_layout.columns <> []) = ()

let duplicate_generation_is_ignored (model:M.state) (continue_low_balance:bool)
  : Lemma
    (requires (M.has_submission model))
    (ensures (ignored model (D.GenerateRequested continue_low_balance))) = ()

let stale_preparation_is_ignored (model:M.state) (id:pos)
  : Lemma
    (requires (not (M.owns model id D.Preparing)))
    (ensures (ignored model (D.ReferencesPrepared id))) = ()

let stale_success_is_ignored (model:M.state) (id:pos) (grid_id:string)
  : Lemma
    (requires (not (M.owns model id D.Submitting)))
    (ensures (ignored model (D.SubmissionSucceeded id grid_id))) = ()

let stale_completion_failure_is_ignored (model:M.state) (id:pos) (message:string)
  : Lemma
    (requires (not (M.owns model id D.Completed)))
    (ensures (ignored model (D.CompletionFailed id message))) = ()

let stale_reference_upload_is_ignored (model:M.state) (id:pos) (local_id:string)
  (image:D.reference_image)
  : Lemma
    (requires (not (M.owns model id D.Preparing)))
    (ensures (ignored model (D.ReferenceUploaded id local_id image))) = ()

let stale_confirmation_is_ignored (model:M.state) (id:pos) (accepted:bool)
  : Lemma
    (requires (not (M.owns_confirmation model id)))
    (ensures (ignored model (D.ConfirmationResolved id accepted))) = ()

let budget_edit_preserves_captured_request (model:M.state) (budget_text:string)
  : Lemma (
    (M.update_step model (D.ChangeBudget budget_text)).next_state.active == model.active) = ()

let upload_counter_increments (model:M.state)
  : Lemma (
    (M.update_step model (D.UploadStatus true)).next_state.pending_uploads == model.pending_uploads + 1) = ()

let upload_counter_decrements_without_underflow (model:M.state)
  : Lemma (
    (M.update_step model (D.UploadStatus false)).next_state.pending_uploads ==
      (if model.pending_uploads = 0 then 0 else model.pending_uploads - 1)) = ()

let generation_request_counter_never_decreases (model:M.state) (continue_low_balance:bool)
  : Lemma (
    (M.update_step model (D.GenerateRequested continue_low_balance)).next_state.next_request >= model.next_request) = ()

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

let reference_substitution_preserves_admission (input:D.admitted_input) (local_id:string)
  (image:D.reference_image)
  : Lemma (
    let replaced = M.replace_references input.admitted_layout local_id image in
    replaced.rows <> [] /\ replaced.columns <> []) = ()

#push-options "--fuel 0 --ifuel 0"
let transpose_preserves_cell_count (layout:D.layout)
  : Lemma (
    let swapped = I.swap layout in
    L.length swapped.rows * L.length swapped.columns ==
      L.length layout.rows * L.length layout.columns) =
  let swapped = I.swap layout in
  assert (L.length swapped.rows == L.length layout.columns);
  assert (L.length swapped.columns == L.length layout.rows)
#pop-options
