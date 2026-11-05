module Slopgrid.Policy

(* Combine pure validation and per-cell capability feedback into a form
   decision. Provider connection, upload count, and submission phase arrive as
   facts from the caller. This function performs no upload or provider request.
   PRODUCT.md 3.4.1. *)

module Domain = Slopgrid.Domain
open Slopgrid.Domain
module List = FStar.List.Tot.Base
open FStar.List.Tot.Base
module PolicyBase = Slopgrid.PolicyBase
module PolicyAdmission = Slopgrid.PolicyAdmission
module PolicyCompatibility = Slopgrid.PolicyCompatibility

let evaluate (draft: Domain.draft) (attempted: bool) (pending_uploads: nat)
  (submission_phase: Domain.submission_phase) (context: Domain.context) : Tot Domain.policy =
  let input = draft.editable in
  let g = input.draft_layout in
  let provider = context.provider in
  (* Capacity belongs to an output format. A reply for the previous format
     cannot make the current draft ready after a format change. *)
  let capacity_ready =
    match provider.capacity with
    | Domain.CapacityReady format _ -> format = g.output_format
    | _ -> false
  in
  (* For Image, cap the supplied available count at the number of cells and
     retain at least one worker. Text concurrency and monetary allowance
     planning are not implemented by this choice. *)
  let workers : option pos =
    if g.output_format = Domain.Image && capacity_ready then
      let cells = List.length g.rows * List.length g.columns in
      let available =
        match provider.capacity with
        | Domain.CapacityReady _ (Some n) -> n
        | _ -> 1
      in
      let chosen = if cells < available then cells else available in
      Some (if chosen < 1 then 1 else chosen)
    else None
  in
  let editable = {input with draft_layout = {g with parallel_workers = workers}} in
  let candidate, budget, admitted, validation_issues = PolicyAdmission.admit_input editable in
  let cells, compatibility_issues =
    PolicyCompatibility.analyze (PolicyAdmission.preview candidate) budget context.catalog
  in
  (* Keep advisory compatibility feedback visible without blocking an attempt.
     Required image-input capability and judge eligibility arrive as blocking
     issues from the per-cell checks. PRODUCT.md 3.4.7 and 3.8.5. *)
  let blocking_validation = List.filter (fun issue -> not issue.Domain.deferred) validation_issues in
  let blocking_compatibility = List.filter (fun issue -> issue.Domain.blocking) compatibility_issues in
  let busy = submission_phase = Domain.Submitting || submission_phase = Domain.Completed in
  let uploading = pending_uploads > 0 || submission_phase = Domain.Preparing in
  let connected = provider.connected in
  let can_attempt =
    draft.format_selected && connected && capacity_ready && not busy && not uploading &&
    blocking_validation = [] && List.length blocking_compatibility = 0
  in
  let reasons =
    (if busy then ["Starting generation."] else []) @
    (if uploading then ["Uploading reference images."] else []) @
    (if not capacity_ready && connected then
       [match provider.capacity with
        | Domain.CapacityError format _ ->
          if format = g.output_format then "Could not determine the automatic worker count."
          else "Checking the automatic worker count."
        | _ -> "Checking the automatic worker count."]
     else []) @
    PolicyBase.unique (List.map (fun issue -> issue.Domain.issue_message) blocking_validation) @
    PolicyBase.unique (List.map (fun issue -> issue.Domain.reason) blocking_compatibility) @
    (if connected then [] else ["Connect OpenRouter."])
  in
  (* An attempt can reveal deferred missing selections without submitting.
     Only a fully valid candidate reaches ReadyToSubmit. Enabling an attempt
     and admitting a submission are different decisions. *)
  let decision =
    if not can_attempt then Domain.CannotAttempt reasons
    else
      if validation_issues <> [] then Domain.IncompleteSelection
      else
        match admitted with
        | Some input -> Domain.ReadyToSubmit input
        | None -> Domain.IncompleteSelection
  in
  {
    Domain.validation_issues =
      List.filter (fun issue -> attempted || not issue.Domain.deferred) validation_issues;
    compatibility_issues = compatibility_issues;
    compatibility_cells = cells;
    decision = decision;
    selected_workers = workers
  }
