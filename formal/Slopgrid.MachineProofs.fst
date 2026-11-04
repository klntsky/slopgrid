module Slopgrid.MachineProofs

module D = Slopgrid.Data
module M = Slopgrid.Machine

#set-options "--fuel 8 --ifuel 2"

let ignored (model:M.state) (event:D.json) : prop =
  let result = M.update_step model event in
  result.next_state == model /\ result.commands == [] /\
  not result.outcome.state_changed

let kind (event:D.json) (name:string) : Tot bool =
  D.str (D.get event "type") = name

let request_id (event:D.json) : Tot nat = D.natural (D.get event "id")

let outcome_coherence (model:M.state) (event:D.json)
  : Lemma (
    let result = M.update_step model event in
    let _,output = M.update model event in
    let flags = D.get output "outcome" in
    D.get flags "stateChanged" == D.JBool result.outcome.state_changed /\
    D.get flags "draftChanged" == D.JBool result.outcome.draft_changed /\
    (result.outcome.draft_changed ==> result.outcome.state_changed)) = ()

let duplicate_generation_is_ignored (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "generate-requested" /\ M.has_submission model))
    (ensures (ignored model event)) = ()

let stale_preparation_is_ignored (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "references-prepared" /\
      not (M.owns model (request_id event) M.Preparing)))
    (ensures (ignored model event)) = ()

let stale_success_is_ignored (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "submission-succeeded" /\
      not (M.owns model (request_id event) M.Submitting)))
    (ensures (ignored model event)) = ()

let stale_completion_failure_is_ignored (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "completion-failed" /\
      not (M.owns model (request_id event) M.Completed)))
    (ensures (ignored model event)) = ()

let stale_reference_upload_is_ignored (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "reference-uploaded" /\
      not (M.owns model (request_id event) M.Preparing)))
    (ensures (ignored model event)) = ()

let stale_confirmation_is_ignored (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "confirmation-resolved" /\
      not (M.owns_confirmation model (request_id event))))
    (ensures (ignored model event)) = ()

let budget_edit_preserves_captured_request (model:M.state) (event:D.json)
  : Lemma
    (requires (kind event "budget-changed"))
    (ensures ((M.update_step model event).next_state.active == model.active)) = ()
