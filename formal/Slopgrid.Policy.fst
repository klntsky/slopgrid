module Slopgrid.Policy

module D = Slopgrid.Domain
open Slopgrid.Domain
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module B = Slopgrid.PolicyBase
module A = Slopgrid.PolicyAdmission
module C = Slopgrid.PolicyCompatibility

let evaluate (draft:D.draft) (attempted:bool) (pending_uploads:nat) (submission_phase:D.submission_phase) (context:D.context) : Tot D.policy =
  let input = draft.editable in
  let g = input.draft_layout in
  let provider = context.provider in
  let capacity_ready = match provider.capacity with | D.CapacityReady format _ -> format = g.output_format | _ -> false in
  let workers : option pos = if g.output_format = D.Image && capacity_ready then
    let cells = L.length g.rows * L.length g.columns in
    let available = match provider.capacity with | D.CapacityReady _ (Some n) -> n | _ -> 1 in
    let chosen = if cells < available then cells else available in
    Some (if chosen < 1 then 1 else chosen) else None in
  let editable = {input with draft_layout={g with parallel_workers=workers}} in
  let candidate,budget,admitted,validation_issues = A.admit_input editable in
  let cells,compatibility_issues = C.analyze (A.preview candidate) budget context.catalog in
  let blocking_validation = L.filter (fun issue -> not issue.D.deferred) validation_issues in
  let blocking_compatibility = L.filter (fun issue -> issue.D.blocking) compatibility_issues in
  let busy = submission_phase = D.Submitting || submission_phase = D.Completed in
  let uploading = pending_uploads > 0 || submission_phase = D.Preparing in
  let connected = provider.connected in
  let can_attempt = draft.format_selected && connected && capacity_ready && not busy && not uploading && blocking_validation = [] && L.length blocking_compatibility = 0 in
  let reasons =
    (if busy then ["Starting generation."] else []) @
    (if uploading then ["Uploading reference images."] else []) @
    (if not capacity_ready && connected then
      [match provider.capacity with | D.CapacityError format _ -> if format = g.output_format then "Could not determine the automatic worker count." else "Checking the automatic worker count." | _ -> "Checking the automatic worker count."] else []) @
    B.unique (L.map (fun issue -> issue.D.issue_message) blocking_validation) @
    B.unique (L.map (fun issue -> issue.D.reason) blocking_compatibility) @
    (if connected then [] else ["Connect OpenRouter."]) in
  let decision = if not can_attempt then D.CannotAttempt reasons else
    if validation_issues <> [] then D.IncompleteSelection else
    match admitted with | Some input -> D.ReadyToSubmit input | None -> D.IncompleteSelection in
  {D.validation_issues=L.filter (fun issue -> attempted || not issue.D.deferred) validation_issues;
   compatibility_issues=compatibility_issues;compatibility_cells=cells;decision=decision;selected_workers=workers}
