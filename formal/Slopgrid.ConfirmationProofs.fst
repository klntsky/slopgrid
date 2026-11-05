module Slopgrid.ConfirmationProofs

(* A destructive form edit first builds a complete proposed draft. The current
   prompts, Chat histories, attachments, and rubrics stay in place until the
   matching dialog accepts it. These proofs cover pure state transitions and
   emitted commands, not browser dialogs or storage writes. PRODUCT.md 3.1.12. *)

module Domain = Slopgrid.Domain
module Machine = Slopgrid.Machine
module Input = Slopgrid.Input
module List = FStar.List.Tot.Base
module Parameters = Slopgrid.Parameters
module Native = Slopgrid.Native

#set-options "--fuel 4 --ifuel 2"

(* A pending loss dialog stores the whole proposed setup without changing the
   current draft or active request. It sets the supplied case counter and takes
   the next dialog ID, then emits one confirmation command. *)
let deferred (model: Machine.state) (proposed: Domain.draft) (counter: nat) (text: string)
  (result: Machine.step) : prop =
  result.next_state == {
    model with
    next_case = counter;
    next_confirmation = model.next_confirmation + 1;
    pending_confirmation = Some {
      Machine.confirmation_id = model.next_confirmation;
      proposed_draft = proposed
    }
  } /\
  result.change == Domain.MetadataChanged /\
  result.commands == [Domain.Confirm model.next_confirmation text]

(* Acceptance clears the dialog and attempt feedback. An active Generate
   request keeps its accepted setup. Compare draft values without their
   parameter-order lists, and request a save only when those values change.
   The controller can still fail to save. PRODUCT.md 3.1.10 and 3.1.12. *)
let committed (model: Machine.state) (proposed: Domain.draft) (result: Machine.step) : prop =
  Machine.draft_equal result.next_state.draft proposed /\
  result.next_state.pending_confirmation == None /\
  result.next_state.active == model.active /\
  result.next_state.attempted == false /\ result.next_state.error == "" /\
  result.commands ==
    (if Machine.draft_equal proposed model.draft then [] else [Domain.PersistDraft proposed]) /\
  result.change ==
    (if Machine.draft_equal proposed model.draft then Domain.MetadataChanged else Domain.DraftChanged)

(* Opening a loss dialog keeps the complete current setup and stores the complete
   replacement separately. No prompt, attachment, or rubric changes yet.
   This is the deferral step for PRODUCT.md 3.1.10 and 3.1.12. *)
let proposal_preserves_complete_draft (model: Machine.state) (proposed: Domain.draft)
  (counter: nat) (text: string)
  : Lemma
    (deferred model proposed counter text
      (Machine.propose_draft model proposed counter (Some text))) = ()

(* A direct edit dismisses the old loss proposal instead of leaving a dialog
   whose later acceptance could overwrite that edit. *)
let edit_invalidates_confirmation (model: Machine.state) (draft: Domain.draft) (counter: nat)
  : Lemma ((Machine.edit model draft counter).next_state.pending_confirmation == None) = ()

(* A direct edit installs the proposed setup values without touching the active
   request. Equal setups may retain the current ordering metadata rather than
   copying the proposal's bookkeeping literally. *)
let edit_commits_semantically (model: Machine.state) (proposed: Domain.draft) (counter: nat)
  : Lemma (
    Machine.draft_equal (Machine.edit model proposed counter).next_state.draft proposed /\
    (Machine.edit model proposed counter).next_state.active == model.active) = ()

(* Cancel only the currently pending dialog. The complete setup and all other
   state stay unchanged, and cancellation emits no save command.
   This is the cancellation rule in PRODUCT.md 3.1.10 and 3.1.12. *)
let matching_cancellation_preserves_complete_draft (model: Machine.state)
  (proposal: Machine.confirmation)
  : Lemma
    (requires (model.pending_confirmation == Some proposal))
    (ensures (
      let result =
        Machine.update_step model (Domain.ConfirmationResolved proposal.confirmation_id false) in
      result.next_state == {model with pending_confirmation = None} /\
      result.change == Domain.MetadataChanged /\ result.commands == [])) = ()

(* Accept only the currently pending dialog, then install its complete proposal
   in one step. Clear the dialog and feedback without changing an active request.
   Emit a save command only for changed setup values. This is the state-transition
   part of atomic acceptance in PRODUCT.md 3.1.12. *)
let matching_acceptance_commits_atomically (model: Machine.state) (proposal: Machine.confirmation)
  : Lemma
    (requires (model.pending_confirmation == Some proposal))
    (ensures
      (committed model proposal.proposed_draft
        (Machine.update_step model (Domain.ConfirmationResolved proposal.confirmation_id true)))) =
  edit_commits_semantically model proposal.proposed_draft model.next_case

(* An answer from a closed or superseded dialog cannot edit the setup.
   With no matching pending ID, both acceptance and cancellation do nothing. *)
let stale_confirmation_is_inert (model: Machine.state) (id: pos) (accepted: bool)
  : Lemma
    (requires (not (Machine.owns_confirmation model id)))
    (ensures (
      let result = Machine.update_step model (Domain.ConfirmationResolved id accepted) in
      result.next_state == model /\ result.change == Domain.NoChange /\ result.commands == [])) = ()

(* Open a loss dialog and cancel that same ID. The original draft survives
   literally, the dialog closes, and cancellation emits no commands.
   PRODUCT.md 3.1.10 and 3.1.12. *)
let proposal_cancel_trace (model: Machine.state) (proposed: Domain.draft) (counter: nat) (text: string)
  : Lemma (
    let pending = (Machine.propose_draft model proposed counter (Some text)).next_state in
    let cancelled =
      Machine.update_step pending (Domain.ConfirmationResolved model.next_confirmation false) in
    cancelled.next_state.draft == model.draft /\
    cancelled.next_state.pending_confirmation == None /\ cancelled.commands == []) =
  let pending = (Machine.propose_draft model proposed counter (Some text)).next_state in
  matching_cancellation_preserves_complete_draft pending {
    Machine.confirmation_id = model.next_confirmation;
    proposed_draft = proposed
  }

(* Open a loss dialog, then accept that same ID. Install the waiting setup
   in one update and clear attempt feedback. If its values changed, ask the
   controller to save them. PRODUCT.md 3.1.12. *)
let proposal_accept_trace (model: Machine.state) (proposed: Domain.draft) (counter: nat) (text: string)
  : Lemma (
    let pending = (Machine.propose_draft model proposed counter (Some text)).next_state in
    committed pending proposed
      (Machine.update_step pending (Domain.ConfirmationResolved model.next_confirmation true))) =
  let pending = (Machine.propose_draft model proposed counter (Some text)).next_state in
  matching_acceptance_commits_atomically pending {
    Machine.confirmation_id = model.next_confirmation;
    proposed_draft = proposed
  }

(* Compute the proposed case or parameter conversion. If stored setup values
   did not change, dismiss an old dialog and reset attempt feedback. Otherwise
   commit an edit with no loss warning, or wait for the warning's dialog.
   PRODUCT.md 3.1.10. *)
let input_conversion_dispatch (model: Machine.state) (action: Domain.input_action)
  : Lemma (
    let before = model.draft.editable.draft_layout in
    let after, counter = Input.reduce before action model.case_prefix model.next_case in
    let proposed = {
      model.draft with
      editable = {model.draft.editable with draft_layout = after}
    } in
    let result = Machine.update_step model (Domain.InputAction action) in
    match Input.confirmation before action with
    | None ->
      result.next_state.pending_confirmation == None /\
      Machine.draft_equal result.next_state.draft proposed
    | Some text ->
      if Machine.draft_equal model.draft proposed then
        result.next_state.draft == model.draft /\ result.commands == [] /\
        result.next_state.pending_confirmation == None
      else
        deferred model proposed counter text result) =
  let before = model.draft.editable.draft_layout in
  let after, counter = Input.reduce before action model.case_prefix model.next_case in
  let proposed = {
    model.draft with
    editable = {model.draft.editable with draft_layout = after}
  } in
  if Machine.draft_equal model.draft proposed then
    edit_commits_semantically model model.draft model.next_case
  else
    match Input.confirmation before action with
    | None -> edit_commits_semantically model proposed counter
    | Some text -> proposal_preserves_complete_draft model proposed counter text

(* When the detector reports dropped parameters, keep the current setup and
   active Generate request. Open a new dialog only if the proposal changes
   the stored setup values. PRODUCT.md 3.1.10. *)
let detected_ownership_loss_is_deferred (model: Machine.state) (action: Domain.input_action)
  : Lemma
    (requires (Input.dropped_parameters model.draft.editable.draft_layout action <> []))
    (ensures (
      let result = Machine.update_step model (Domain.InputAction action) in
      result.next_state.draft == model.draft /\
      result.next_state.active == model.active /\
      (result.commands == [] \/
        (exists text. result.commands == [Domain.Confirm model.next_confirmation text])))) =
  input_conversion_dispatch model action;
  match Input.dropped_parameters model.draft.editable.draft_layout action with
  | [] -> ()
  | _ :: _ -> ()

(* Format selection commits the prepared setup when its loss list is empty.
   A reported loss instead opens one dialog holding the complete proposal.
   This proves dispatch conditional on that loss list. PRODUCT.md 3.1.12. *)
let format_conversion_dispatch (model: Machine.state) (format: Domain.format)
  : Lemma (
    let proposed, counter, dropped =
      Input.select_format model.draft format model.context.catalog
        model.case_prefix model.next_case in
    let result = Machine.update_step model (Domain.SelectFormat format) in
    match dropped with
    | [] ->
      result.next_state.pending_confirmation == None /\
      Machine.draft_equal result.next_state.draft proposed
    | _ :: _ -> exists text. deferred model proposed counter text result) =
  let proposed, counter, dropped =
    Input.select_format model.draft format model.context.catalog
      model.case_prefix model.next_case in
  match dropped with
  | [] -> edit_commits_semantically model proposed counter
  | _ :: _ -> ()

(* A reported format loss leaves the current prompt/history, attachments, and
   other draft values untouched while one confirmation command is pending.
   This proves deferral, not complete loss detection. PRODUCT.md 3.1.12. *)
let detected_format_loss_is_deferred (model: Machine.state) (format: Domain.format)
  : Lemma (
    let _, _, dropped =
      Input.select_format model.draft format model.context.catalog
        model.case_prefix model.next_case in
    dropped <> [] ==>
      (let result = Machine.update_step model (Domain.SelectFormat format) in
       result.next_state.draft == model.draft /\ result.next_state.active == model.active /\
       (exists text. result.commands == [Domain.Confirm model.next_confirmation text]))) =
  format_conversion_dispatch model format

(* Editing the budget dismisses any pending loss dialog. A late acceptance of
   any old ID then cannot restore the proposal over the new budget. *)
let budget_edit_invalidates_and_stale_acceptance_is_inert (model: Machine.state)
  (text: string) (id: pos)
  : Lemma (
    let edited = Machine.update_step model (Domain.ChangeBudget text) in
    let stale = Machine.update_step edited.next_state (Domain.ConfirmationResolved id true) in
    edited.next_state.pending_confirmation == None /\
    stale.next_state == edited.next_state /\ stale.commands == [] /\ stale.change == Domain.NoChange) =
  edit_invalidates_confirmation model
    {model.draft with editable = {model.draft.editable with budget_text = text}} model.next_case

(* An input action that needs no dialog dismisses the old proposal as it edits
   the setup. A late acceptance cannot overwrite that edit. *)
let input_edit_invalidates_and_stale_acceptance_is_inert (model: Machine.state)
  (action: Domain.input_action) (id: pos)
  : Lemma
    (requires (Input.confirmation model.draft.editable.draft_layout action == None))
    (ensures (
      let edited = Machine.update_step model (Domain.InputAction action) in
      let stale = Machine.update_step edited.next_state (Domain.ConfirmationResolved id true) in
      edited.next_state.pending_confirmation == None /\
      stale.next_state == edited.next_state /\ stale.commands == [] /\
      stale.change == Domain.NoChange)) =
  input_conversion_dispatch model action

(* A pending dialog's ID must be below the next dialog counter. With no pending
   dialog there is no ID to check. This alone does not describe valid draft data. *)
let confirmation_ids_are_fresh (model: Machine.state) : prop =
  match model.pending_confirmation with
  | None -> True
  | Some proposal -> proposal.confirmation_id < model.next_confirmation

(* A newly initialized form has no pending dialog with a reused future ID. *)
let initial_confirmation_ids_are_fresh (initial: Domain.initial) (context: Domain.context)
  : Lemma (confirmation_ids_are_fresh (Machine.init initial context)) = ()

(* Every form event keeps the pending ID below the next counter, provided that
   was already true before the event. This is dialog bookkeeping only. *)
let dispatch_preserves_confirmation_id_freshness (model: Machine.state) (event: Domain.event)
  : Lemma
    (requires (confirmation_ids_are_fresh model))
    (ensures (confirmation_ids_are_fresh (Machine.update_step model event).next_state)) =
  match event with
  | Domain.InputAction action ->
    let before = model.draft.editable.draft_layout in
    let after, counter = Input.reduce before action model.case_prefix model.next_case in
    let proposed = {
      model.draft with
      editable = {model.draft.editable with draft_layout = after}
    } in
    if Machine.draft_equal model.draft proposed then
      edit_invalidates_confirmation model model.draft model.next_case
    else
      (match Input.confirmation before action with
       | None -> edit_invalidates_confirmation model proposed counter
       | Some text -> proposal_preserves_complete_draft model proposed counter text)
  | Domain.SelectFormat format -> format_conversion_dispatch model format
  | _ -> ()

(* A later input edit makes the old dialog's acceptance inert, even when that
   edit opens a new loss dialog. The freshness assumption keeps the new dialog
   from reusing the old ID. *)
let later_input_action_prevents_old_acceptance (model: Machine.state)
  (proposal: Machine.confirmation) (action: Domain.input_action)
  : Lemma
    (requires (confirmation_ids_are_fresh model /\ model.pending_confirmation == Some proposal))
    (ensures (
      let edited = Machine.update_step model (Domain.InputAction action) in
      let stale =
        Machine.update_step edited.next_state
          (Domain.ConfirmationResolved proposal.confirmation_id true) in
      stale.next_state == edited.next_state /\ stale.change == Domain.NoChange /\
      stale.commands == [])) =
  input_conversion_dispatch model action;
  let edited = (Machine.update_step model (Domain.InputAction action)).next_state in
  assert (not (Machine.owns_confirmation edited proposal.confirmation_id));
  stale_confirmation_is_inert edited proposal.confirmation_id true

(* Selecting another format invalidates acceptance of the previous proposal.
   Fresh dialog IDs distinguish the replacement dialog from the old one. *)
let later_format_selection_prevents_old_acceptance (model: Machine.state)
  (proposal: Machine.confirmation) (format: Domain.format)
  : Lemma
    (requires (confirmation_ids_are_fresh model /\ model.pending_confirmation == Some proposal))
    (ensures (
      let edited = Machine.update_step model (Domain.SelectFormat format) in
      let stale =
        Machine.update_step edited.next_state
          (Domain.ConfirmationResolved proposal.confirmation_id true) in
      stale.next_state == edited.next_state /\ stale.change == Domain.NoChange /\
      stale.commands == [])) =
  format_conversion_dispatch model format;
  let edited = (Machine.update_step model (Domain.SelectFormat format)).next_state in
  let _, _, dropped =
    Input.select_format model.draft format model.context.catalog
      model.case_prefix model.next_case in
  (match dropped with
   | [] -> assert (edited.pending_confirmation == None)
   | _ :: _ ->
     assert (exists proposed. edited.pending_confirmation ==
       Some {
         Machine.confirmation_id = model.next_confirmation;
         proposed_draft = proposed
       }));
  assert (not (Machine.owns_confirmation edited proposal.confirmation_id));
  stale_confirmation_is_inert edited proposal.confirmation_id true

(* For a changed input conversion that requests confirmation, cancel keeps the
   complete original setup and accept commits the whole proposal's setup values.
   These traces use the matching dialog ID. They prove atomic handling, not
   complete loss detection for PRODUCT.md 3.1.10. *)
let input_conversion_atomic_resolution_trace (model: Machine.state) (action: Domain.input_action)
  : Lemma (
    let before = model.draft.editable.draft_layout in
    let after, counter = Input.reduce before action model.case_prefix model.next_case in
    let proposed = {
      model.draft with
      editable = {model.draft.editable with draft_layout = after}
    } in
    match Input.confirmation before action with
    | None -> True
    | Some text ->
      not (Machine.draft_equal model.draft proposed) ==>
        (let pending = Machine.update_step model (Domain.InputAction action) in
         let cancelled =
           Machine.update_step pending.next_state
             (Domain.ConfirmationResolved model.next_confirmation false) in
         let accepted =
           Machine.update_step pending.next_state
             (Domain.ConfirmationResolved model.next_confirmation true) in
         deferred model proposed counter text pending /\
         cancelled.next_state.draft == model.draft /\ cancelled.commands == [] /\
         cancelled.next_state.pending_confirmation == None /\
         committed pending.next_state proposed accepted)) =
  input_conversion_dispatch model action;
  let before = model.draft.editable.draft_layout in
  let after, counter = Input.reduce before action model.case_prefix model.next_case in
  let proposed = {
    model.draft with
    editable = {model.draft.editable with draft_layout = after}
  } in
  match Input.confirmation before action with
  | None -> ()
  | Some text ->
    if Machine.draft_equal model.draft proposed then
      ()
    else
      let pending = (Machine.update_step model (Domain.InputAction action)).next_state in
      let proposal = {
        Machine.confirmation_id = model.next_confirmation;
        proposed_draft = proposed
      } in
      matching_cancellation_preserves_complete_draft pending proposal;
      matching_acceptance_commits_atomically pending proposal

(* When format selection reports loss, the current setup stays untouched until
   the matching dialog resolves. Cancel keeps it literally. Accept installs the
   proposal's setup values together. This proves conditional atomic handling,
   not complete history-loss detection. PRODUCT.md 3.1.12 and 3.3.9. *)
let format_conversion_atomic_resolution_trace (model: Machine.state) (format: Domain.format)
  : Lemma (
    let proposed, counter, dropped =
      Input.select_format model.draft format model.context.catalog
        model.case_prefix model.next_case in
    dropped <> [] ==>
      (let pending = Machine.update_step model (Domain.SelectFormat format) in
       let cancelled =
         Machine.update_step pending.next_state
           (Domain.ConfirmationResolved model.next_confirmation false) in
       let accepted =
         Machine.update_step pending.next_state
           (Domain.ConfirmationResolved model.next_confirmation true) in
       pending.next_state.draft == model.draft /\
       (exists text. deferred model proposed counter text pending) /\
       cancelled.next_state.draft == model.draft /\ cancelled.commands == [] /\
       cancelled.next_state.pending_confirmation == None /\
       committed pending.next_state proposed accepted)) =
  format_conversion_dispatch model format;
  let proposed, counter, dropped =
    Input.select_format model.draft format model.context.catalog
      model.case_prefix model.next_case in
  match dropped with
  | [] -> ()
  | _ :: _ ->
    let pending = (Machine.update_step model (Domain.SelectFormat format)).next_state in
    let proposal = {
      Machine.confirmation_id = model.next_confirmation;
      proposed_draft = proposed
    } in
    matching_cancellation_preserves_complete_draft pending proposal;
    matching_acceptance_commits_atomically pending proposal

(* If the differing-value check rejects returning a parameter to common, that
   parameter appears in the loss list and requests a dialog. This covers that
   detection condition, not every conversion loss. PRODUCT.md 3.1.10. *)
let differing_common_return_is_detected (layout: Domain.layout) (p: Domain.common_parameter)
  : Lemma
    (requires (Input.differing layout p))
    (ensures
      (Input.dropped_parameters layout (Domain.MoveToCommon p) == [p] /\
        (exists text. Input.confirmation layout (Domain.MoveToCommon p) == Some text))) = ()

(* A witnessed list member makes the detector's existential scan succeed.
   Later proofs use this to turn one populated field into a loss report. *)
let rec existsb_witness (#a: eqtype) (predicate: a -> Tot bool)
  (values: list a) (witness: a)
  : Lemma
    (requires (List.mem witness values /\ predicate witness))
    (ensures (List.existsb predicate values))
    (decreases values) =
  match values with
  | [] -> ()
  | first :: rest ->
    if first = witness then
      ()
    else
      existsb_witness predicate rest witness

(* A witnessed loss survives filtering when it meets the filter's condition.
   This lets the detector discard unrelated parameter keys without losing it. *)
let rec filter_witness (#a: eqtype) (predicate: a -> Tot bool)
  (values: list a) (witness: a)
  : Lemma
    (requires (List.mem witness values /\ predicate witness))
    (ensures (List.mem witness (List.filter predicate values)))
    (decreases values) =
  match values with
  | [] -> ()
  | first :: rest ->
    if first = witness then
      ()
    else
      filter_witness predicate rest witness

(* A loss already present in the later list survives prepending earlier entries. *)
let rec append_right_member (#a: eqtype) (left: list a) (right: list a) (witness: a)
  : Lemma
    (requires (List.mem witness right))
    (ensures (List.mem witness (List.append left right)))
    (decreases left) =
  match left with
  | [] -> ()
  | _ :: rest -> append_right_member rest right witness

(* Count actual field text or images, not the number of cases. Several identical
   cases still lose their numbered fields when the axis leaves case mode. *)
let populated_field (field: option Domain.variable_field) : Tot bool =
  match field with
  | None -> false
  | Some field ->
    Native.length field.text > 0 || List.length (Input.option_list field.field_images) > 0

#push-options "--fuel 8"
(* One numbered field with text or images is enough to report variable loss
   when leaving its axis's case mode. No differing case values are required,
   even for a single case. This is a sufficient detection condition, not a
   converse or a complete conversion proof. PRODUCT.md 3.1.10. *)
let populated_numbered_fields_are_detected (layout: Domain.layout) (side: Domain.axis)
  (entry: Domain.case_record) (fields: list (option Domain.variable_field))
  (field: Domain.variable_field) (replacement: Domain.common_parameter)
  : Lemma
    (requires
      (List.mem entry (Input.entries layout side) /\
        entry.values.variable_value == Some fields /\ List.mem (Some field) fields /\
        populated_field (Some field)))
    (ensures (
      List.mem Domain.PVariable (Input.dropped_parameters layout (Domain.SingleDimension side)) /\
      List.mem Domain.PVariable
        (Input.dropped_parameters layout (Domain.SelectDimension side replacement)))) =
  existsb_witness
    (fun (field: option Domain.variable_field) ->
      match field with
      | None -> false
      | Some field ->
        Native.length field.text > 0 || List.length (Input.option_list field.field_images) > 0)
    fields (Some field);
  (match fields with
   | [] -> ()
   | _ :: _ -> ());
  existsb_witness
    (fun (entry: Domain.case_record) ->
      match entry.values.variable_value with
      | None -> false
      | Some fields -> List.length fields > 0)
    (Input.entries layout side) entry;
  assert (Parameters.axis_has_variables layout side);
  Parameters.axis_variable_is_enumerated layout side;
  existsb_witness
    (fun (entry: Domain.case_record) ->
      List.existsb
        (fun (field: option Domain.variable_field) ->
          match field with
          | None -> false
          | Some field ->
            Native.length field.text > 0 || List.length (Input.option_list field.field_images) > 0)
        (Input.option_list entry.values.variable_value))
    (Input.entries layout side) entry;
  filter_witness (fun (key: Domain.parameter) -> key <> replacement)
    (Parameters.axis_parameters layout side) Domain.PVariable;
  filter_witness
    (fun (p: Domain.parameter) ->
      if p <> Domain.PVariable then
        Input.differing layout p
      else
        List.existsb
          (fun (entry: Domain.case_record) ->
            List.existsb
              (fun (field: option Domain.variable_field) ->
                match field with
                | None -> false
                | Some field ->
                  Native.length field.text > 0 ||
                  List.length (Input.option_list field.field_images) > 0)
              (Input.option_list entry.values.variable_value))
          (Input.entries layout side))
    (Parameters.axis_parameters layout side) Domain.PVariable;
  filter_witness
    (fun (p: Domain.parameter) ->
      if p <> Domain.PVariable then
        Input.differing layout p
      else
        List.existsb
          (fun (entry: Domain.case_record) ->
            List.existsb
              (fun (field: option Domain.variable_field) ->
                match field with
                | None -> false
                | Some field ->
                  Native.length field.text > 0 ||
                  List.length (Input.option_list field.field_images) > 0)
              (Input.option_list entry.values.variable_value))
          (Input.entries layout side))
    (List.filter (fun (key: Domain.parameter) -> key <> replacement)
      (Parameters.axis_parameters layout side)) Domain.PVariable
#pop-options

(* Ignoring layout ordering for draft comparison keeps each parameter's actual
   common, row, or column owner. An ownership change cannot hide in that metadata. *)
let comparison_preserves_typed_source (layout: Domain.layout) (p: Domain.common_parameter)
  : Lemma
    (Parameters.get_source (Input.layout_data layout).parameters p ==
      Parameters.get_source layout.parameters p) =
  match p with
  | Domain.PInput | Domain.PModel | Domain.PEffort | Domain.PSize | Domain.PAspectRatio
  | Domain.PQuality | Domain.PBackground | Domain.PJudgeModel | Domain.PJudgeEffort
  | Domain.PJudgeCriteria | Domain.PJudgeSystem -> ()

(* Reordering parameter headers does not change which source owns each setting. *)
let source_order_preserves_typed_source (sources: Domain.parameter_sources)
  (order: list Domain.common_parameter) (p: Domain.common_parameter)
  : Lemma
    (Parameters.get_source {sources with source_order = order} p ==
      Parameters.get_source sources p) =
  match p with
  | Domain.PInput | Domain.PModel | Domain.PEffort | Domain.PSize | Domain.PAspectRatio
  | Domain.PQuality | Domain.PBackground | Domain.PJudgeModel | Domain.PJudgeEffort
  | Domain.PJudgeCriteria | Domain.PJudgeSystem -> ()

(* Restoring a neutral position on an empty dimension leaves parameter ownership
   untouched. This helper does not return any case values to common itself. *)
let neutral_dimension_preserves_sources (layout: Domain.layout) (side: Domain.axis)
  (allocation: string & list string) (counter: nat)
  : Lemma (
    let after, _ = Input.neutral_dimension layout side allocation counter in
    after.parameters == layout.parameters) = ()

#push-options "--fuel 8"
(* Returning a parameter with differing case values gives it a common owner.
   This proves the ownership change only, not which default value was stored.
   It is one step of PRODUCT.md 3.1.10. *)
let differing_common_return_changes_source (layout: Domain.layout) (p: Domain.common_parameter)
  (prefix: string) (counter: nat)
  : Lemma
    (requires (Input.differing layout p))
    (ensures (
      let after, _ = Input.reduce layout (Domain.MoveToCommon p) prefix counter in
      match Parameters.get_source after.parameters p with
      | Some (Domain.Common _) -> True
      | _ -> False)) =
  match Parameters.get_source layout.parameters p with
  | Some (Domain.OnAxis side) ->
    let common = Input.set_source layout p (Domain.Common (Parameters.parameter_default p)) in
    let order =
      List.append
        (List.filter (fun (key: Domain.common_parameter) -> key <> p)
          common.parameters.source_order) [p] in
    let reordered = {
      common with
      parameters = {common.parameters with source_order = order}
    } in
    let stripped =
      Input.set_entries reordered side
        (List.map
          (fun (entry: Domain.case_record) ->
            {entry with values = Parameters.remove_case_value entry.values p})
          (Input.entries layout side)) in
    Parameters.get_set_source layout.parameters p (Domain.Common (Parameters.parameter_default p)) p;
    source_order_preserves_typed_source common.parameters order p;
    neutral_dimension_preserves_sources stripped side (prefix, Input.case_ids layout) counter
  | _ -> ()
#pop-options

(* Returning differing case values to common opens exactly one loss proposal,
   rather than replacing the current setup immediately. The proposal contains
   the whole reduced draft, including unaffected prompts and judge settings.
   This is the confirmation step of PRODUCT.md 3.1.10 and 3.8.9. *)
let differing_common_return_proposes_once (model: Machine.state) (p: Domain.common_parameter)
  : Lemma
    (requires (Input.differing model.draft.editable.draft_layout p))
    (ensures (
      let after, counter =
        Input.reduce model.draft.editable.draft_layout (Domain.MoveToCommon p)
          model.case_prefix model.next_case in
      let proposed = {
        model.draft with
        editable = {model.draft.editable with draft_layout = after}
      } in
      exists text.
        deferred model proposed counter text
          (Machine.update_step model (Domain.InputAction (Domain.MoveToCommon p))))) =
  let before = model.draft.editable.draft_layout in
  let after, _ = Input.reduce before (Domain.MoveToCommon p) model.case_prefix model.next_case in
  differing_common_return_is_detected before p;
  differing_common_return_changes_source before p model.case_prefix model.next_case;
  (* Returning a case-owned setting to a shared control changes stored data
     even when we ignore header order. It cannot take the unchanged branch. *)
  comparison_preserves_typed_source before p;
  comparison_preserves_typed_source after p;
  input_conversion_dispatch model (Domain.MoveToCommon p)

(* A differing parameter owned by the affected axis appears in the loss list
   when that axis becomes single or changes to another parameter. Ownership,
   detected difference, and a different replacement key are assumptions here.
   This covers those detector conditions in PRODUCT.md 3.1.10. *)
let differing_axis_parameters_are_detected (layout: Domain.layout) (side: Domain.axis)
  (p: Domain.common_parameter) (replacement: Domain.parameter)
  : Lemma
    (requires
      (Parameters.get_source layout.parameters p == Some (Domain.OnAxis side) /\
        Input.differing layout p /\ p <> replacement))
    (ensures (
      List.mem (p <: Domain.parameter)
        (Input.dropped_parameters layout (Domain.SingleDimension side)) /\
      List.mem (p <: Domain.parameter)
        (Input.dropped_parameters layout (Domain.SelectDimension side replacement)))) =
  Parameters.axis_owner_is_enumerated layout p side;
  filter_witness
    (fun (key: Domain.parameter) ->
      if key <> Domain.PVariable then
        Input.differing layout key
      else
        List.existsb
          (fun (entry: Domain.case_record) ->
            List.existsb
              (fun (field: option Domain.variable_field) ->
                match field with
                | None -> false
                | Some field ->
                  Native.length field.text > 0 ||
                  List.length (Input.option_list field.field_images) > 0)
              (Input.option_list entry.values.variable_value))
          (Input.entries layout side))
    (Parameters.axis_parameters layout side) (p <: Domain.parameter);
  filter_witness (fun (key: Domain.parameter) -> key <> replacement)
    (Parameters.axis_parameters layout side) (p <: Domain.parameter);
  filter_witness
    (fun (key: Domain.parameter) ->
      if key <> Domain.PVariable then
        Input.differing layout key
      else
        List.existsb
          (fun (entry: Domain.case_record) ->
            List.existsb
              (fun (field: option Domain.variable_field) ->
                match field with
                | None -> false
                | Some field ->
                  Native.length field.text > 0 ||
                  List.length (Input.option_list field.field_images) > 0)
              (Input.option_list entry.values.variable_value))
          (Input.entries layout side))
    (List.filter (fun (key: Domain.parameter) -> key <> replacement)
      (Parameters.axis_parameters layout side)) (p <: Domain.parameter)

(* The detector's membership function agrees with the list fact used in proofs. *)
let rec membership_test_agrees (#a: eqtype) (value: a) (values: list a)
  : Lemma (Input.member value values == List.mem value values)
    (decreases values) =
  match values with
  | [] -> ()
  | _ :: rest -> membership_test_agrees value rest

(* Recording a dropped parameter retains it whether the loss list already
   contains it or needs to append it. Duplicate reports need no duplicate entry. *)
let dropped_parameter_is_recorded (dropped: list Domain.parameter) (p: Domain.parameter)
  : Lemma (List.mem p (Input.add_dropped dropped p)) =
  membership_test_agrees p dropped;
  if Input.member p dropped then
    ()
  else
    append_right_member dropped [p] p

(* Anything other than one user-role message cannot become a prompt unchanged.
   For a non-Chat format, normalization resets that shared input and records loss.
   This covers one incompatibility, not dialog dispatch or every format rule.
   PRODUCT.md 3.3.9. *)
let incompatible_common_history_is_detected (layout: Domain.layout) (format: Domain.format)
  (messages: list Domain.message) (dropped: list Domain.parameter)
  : Lemma
    (requires
      (layout.parameters.input_source == Domain.Common (Domain.InputValue messages) /\
        format <> Domain.ChatTemplate /\ not (Input.valid_prompt_messages messages)))
    (ensures (
      let after, loss = Input.normalize_prompt_format layout format dropped in
      List.mem Domain.PInput loss /\
      after.parameters.input_source == Domain.Common (Parameters.parameter_default Domain.PInput))) =
  dropped_parameter_is_recorded dropped Domain.PInput

(* While walking case-owned histories, keep any earlier input-loss report.
   A remaining history that cannot fit a single-user prompt also records loss.
   One incompatible case is enough to require it. *)
let rec case_history_fold_records_loss (entries: list Domain.case_record)
  (cases: list Domain.case_record) (dropped: list Domain.parameter) (witness: Domain.case_record)
  : Lemma
    (requires
      (List.mem Domain.PInput dropped \/
        (List.mem witness entries /\
          not (Input.valid_prompt_messages (Input.option_list witness.values.input_value)))))
    (ensures (
      let _, loss =
        Input.fold
          (fun (cases, dropped) (entry: Domain.case_record) ->
            if Input.valid_prompt_messages (Input.option_list entry.values.input_value) then
              (List.append cases [entry], dropped)
            else
              (List.append cases [{
                entry with
                values = Parameters.set_case_value entry.values
                  (Parameters.parameter_default Domain.PInput)
              }], Input.add_dropped dropped Domain.PInput))
          (cases, dropped) entries in
      List.mem Domain.PInput loss))
    (decreases entries) =
  match entries with
  | [] -> ()
  | entry :: rest ->
    if Input.valid_prompt_messages (Input.option_list entry.values.input_value) then
      case_history_fold_records_loss rest (List.append cases [entry]) dropped witness
    else (
      dropped_parameter_is_recorded dropped Domain.PInput;
      case_history_fold_records_loss rest
        (List.append cases [{
          entry with
          values = Parameters.set_case_value entry.values (Parameters.parameter_default Domain.PInput)
        }])
        (Input.add_dropped dropped Domain.PInput) witness)

(* When complete inputs belong to an axis, one case history that cannot fit a
   single-user prompt makes non-Chat normalization report input loss.
   This is sufficient detection, not a proof of every conversion rule or of the
   confirmation dialog itself. PRODUCT.md 3.3.9. *)
let incompatible_case_history_is_detected (layout: Domain.layout) (format: Domain.format)
  (side: Domain.axis) (entry: Domain.case_record) (dropped: list Domain.parameter)
  : Lemma
    (requires
      (layout.parameters.input_source == Domain.OnAxis side /\ format <> Domain.ChatTemplate /\
        List.mem entry (Input.entries layout side) /\
        not (Input.valid_prompt_messages (Input.option_list entry.values.input_value))))
    (ensures (
      let _, loss = Input.normalize_prompt_format layout format dropped in
      List.mem Domain.PInput loss)) =
  case_history_fold_records_loss (Input.entries layout side) [] dropped entry
