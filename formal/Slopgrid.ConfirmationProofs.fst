module Slopgrid.ConfirmationProofs

module Domain = Slopgrid.Domain
module Machine = Slopgrid.Machine
module Input = Slopgrid.Input
module List = FStar.List.Tot.Base
module Parameters = Slopgrid.Parameters
module Native = Slopgrid.Native

#set-options "--fuel 4 --ifuel 2"

(* A deferred proposal leaves the current draft and all unrelated state literally
   unchanged, records the complete proposal, sets the supplied case counter,
   increments the confirmation counter, and emits one confirmation command. *)
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

(* Committing clears confirmation and validation feedback while preserving active
   work. Draft equality here ignores source/value ordering metadata; persistence
   and the change classification depend on that semantic comparison. *)
let committed (model: Machine.state) (proposed: Domain.draft) (result: Machine.step) : prop =
  Machine.draft_equal result.next_state.draft proposed /\
  result.next_state.pending_confirmation == None /\
  result.next_state.active == model.active /\
  result.next_state.attempted == false /\ result.next_state.error == "" /\
  result.commands ==
    (if Machine.draft_equal proposed model.draft then [] else [Domain.PersistDraft proposed]) /\
  result.change ==
    (if Machine.draft_equal proposed model.draft then Domain.MetadataChanged else Domain.DraftChanged)

(* Proposing with confirmation text records the full proposed draft without
   replacing the current draft, and emits the corresponding confirmation. *)
let proposal_preserves_complete_draft (model: Machine.state) (proposed: Domain.draft)
  (counter: nat) (text: string)
  : Lemma
    (deferred model proposed counter text
      (Machine.propose_draft model proposed counter (Some text))) = ()

(* Every direct edit clears any pending confirmation. *)
let edit_invalidates_confirmation (model: Machine.state) (draft: Domain.draft) (counter: nat)
  : Lemma ((Machine.edit model draft counter).next_state.pending_confirmation == None) = ()

(* A direct edit installs a semantically equal draft and preserves active work;
   it need not replace ordering metadata with the proposal's literal metadata. *)
let edit_commits_semantically (model: Machine.state) (proposed: Domain.draft) (counter: nat)
  : Lemma (
    Machine.draft_equal (Machine.edit model proposed counter).next_state.draft proposed /\
    (Machine.edit model proposed counter).next_state.active == model.active) = ()

(* Cancelling the currently pending proposal changes only the pending-confirmation
   field, reports a metadata change, and emits no commands. *)
let matching_cancellation_preserves_complete_draft (model: Machine.state)
  (proposal: Machine.confirmation)
  : Lemma
    (requires (model.pending_confirmation == Some proposal))
    (ensures (
      let result =
        Machine.update_step model (Domain.ConfirmationResolved proposal.confirmation_id false) in
      result.next_state == {model with pending_confirmation = None} /\
      result.change == Domain.MetadataChanged /\ result.commands == [])) = ()

(* Accepting the currently pending proposal commits it under semantic draft
   equality, clears pending confirmation and feedback, and preserves active work.
   It persists only when the proposal differs semantically from the current draft. *)
let matching_acceptance_commits_atomically (model: Machine.state) (proposal: Machine.confirmation)
  : Lemma
    (requires (model.pending_confirmation == Some proposal))
    (ensures
      (committed model proposal.proposed_draft
        (Machine.update_step model (Domain.ConfirmationResolved proposal.confirmation_id true)))) =
  edit_commits_semantically model proposal.proposed_draft model.next_case

(* Resolving an ID not owned by the current pending confirmation leaves the
   entire state unchanged and emits neither a change nor commands. *)
let stale_confirmation_is_inert (model: Machine.state) (id: pos) (accepted: bool)
  : Lemma
    (requires (not (Machine.owns_confirmation model id)))
    (ensures (
      let result = Machine.update_step model (Domain.ConfirmationResolved id accepted) in
      result.next_state == model /\ result.change == Domain.NoChange /\ result.commands == [])) = ()

(* Proposing and then cancelling that proposal preserves the original draft
   literally, clears the pending confirmation, and emits no cancellation commands. *)
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

(* Proposing and then accepting that proposal commits a semantically equal draft,
   clears confirmation and feedback, and persists only a semantic draft change. *)
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

(* An input action without confirmation commits its reduced draft semantically.
   With confirmation, a semantic no-op preserves the literal draft and clears
   pending confirmation; a semantic change instead records a deferred proposal. *)
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

(* If the dropped-parameter detector reports loss, dispatch preserves the literal
   draft and active work, emitting either nothing or one confirmation command.
   This is an implication from a detector report, not completeness of detection. *)
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

(* Format selection commits the selected draft semantically when no loss is
   reported; any reported loss instead defers the full proposal for confirmation. *)
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

(* A nonempty loss report from format selection preserves the literal draft and
   active work and emits exactly one confirmation command. This does not claim
   that every possible format loss is detected. *)
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

(* A budget edit clears pending confirmation, so accepting any ID immediately
   afterward is a state-preserving no-op with no commands. *)
let budget_edit_invalidates_and_stale_acceptance_is_inert (model: Machine.state)
  (text: string) (id: pos)
  : Lemma (
    let edited = Machine.update_step model (Domain.ChangeBudget text) in
    let stale = Machine.update_step edited.next_state (Domain.ConfirmationResolved id true) in
    edited.next_state.pending_confirmation == None /\
    stale.next_state == edited.next_state /\ stale.commands == [] /\ stale.change == Domain.NoChange) =
  edit_invalidates_confirmation model
    {model.draft with editable = {model.draft.editable with budget_text = text}} model.next_case

(* When an input action requires no confirmation, its edit clears any pending
   proposal and a subsequent acceptance of any ID is inert. *)
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

(* Freshness means only that an outstanding proposal's ID is below the next
   confirmation counter; states without an outstanding proposal satisfy it too. *)
let confirmation_ids_are_fresh (model: Machine.state) : prop =
  match model.pending_confirmation with
  | None -> True
  | Some proposal -> proposal.confirmation_id < model.next_confirmation

(* Initialization satisfies the pending-confirmation ID freshness invariant. *)
let initial_confirmation_ids_are_fresh (initial: Domain.initial) (context: Domain.context)
  : Lemma (confirmation_ids_are_fresh (Machine.init initial context)) = ()

(* Every dispatched event preserves confirmation-ID freshness, assuming the
   incoming state's pending ID is already below its next-confirmation counter. *)
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

(* Given a pending proposal and fresh confirmation IDs, any later input action
   makes acceptance of that old proposal inert, even if the action proposes a
   new confirmation instead of immediately committing. *)
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

(* Given a pending proposal and fresh confirmation IDs, a later format selection
   makes acceptance of the old proposal a state-preserving, command-free no-op. *)
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

(* If an input conversion requests confirmation and changes the draft
   semantically, it defers the complete proposal. Cancelling preserves the
   original literal draft; accepting commits under semantic draft equality. *)
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

(* If format selection reports loss, it defers the selected draft without changing
   the original literal draft. Cancelling preserves that draft and clears the
   proposal; accepting commits the selected draft under semantic equality. *)
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

(* When the differing-value predicate holds for a common-capable parameter,
   moving it to common reports exactly that parameter as dropped and requests
   confirmation. This states one sufficient condition for detection. *)
let differing_common_return_is_detected (layout: Domain.layout) (p: Domain.common_parameter)
  : Lemma
    (requires (Input.differing layout p))
    (ensures
      (Input.dropped_parameters layout (Domain.MoveToCommon p) == [p] /\
        (exists text. Input.confirmation layout (Domain.MoveToCommon p) == Some text))) = ()

(* A list member satisfying a Boolean predicate witnesses that the list's
   existential predicate test succeeds. *)
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

(* A list member satisfying the filter predicate remains a member of the
   filtered list. *)
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

(* Any member of the right-hand list remains a member after a list is prepended. *)
let rec append_right_member (#a: eqtype) (left: list a) (right: list a) (witness: a)
  : Lemma
    (requires (List.mem witness right))
    (ensures (List.mem witness (List.append left right)))
    (decreases left) =
  match left with
  | [] -> ()
  | _ :: rest -> append_right_member rest right witness

let populated_field (field: option Domain.variable_field) : Tot bool =
  match field with
  | None -> false
  | Some field ->
    Native.length field.text > 0 || List.length (Input.option_list field.field_images) > 0

#push-options "--fuel 8"
(* A numbered field with nonempty text or images in an entry on the affected axis
   causes variable loss to be reported when collapsing that axis or selecting a
   common-capable replacement. This is a sufficient condition, not a converse. *)
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

(* Removing layout ordering metadata for comparison preserves the typed source
   of every common-capable parameter. *)
let comparison_preserves_typed_source (layout: Domain.layout) (p: Domain.common_parameter)
  : Lemma
    (Parameters.get_source (Input.layout_data layout).parameters p ==
      Parameters.get_source layout.parameters p) =
  match p with
  | Domain.PInput | Domain.PModel | Domain.PEffort | Domain.PSize | Domain.PAspectRatio
  | Domain.PQuality | Domain.PBackground | Domain.PJudgeModel | Domain.PJudgeEffort
  | Domain.PJudgeCriteria | Domain.PJudgeSystem -> ()

(* Replacing the source-order list does not change any typed parameter source. *)
let source_order_preserves_typed_source (sources: Domain.parameter_sources)
  (order: list Domain.common_parameter) (p: Domain.common_parameter)
  : Lemma
    (Parameters.get_source {sources with source_order = order} p ==
      Parameters.get_source sources p) =
  match p with
  | Domain.PInput | Domain.PModel | Domain.PEffort | Domain.PSize | Domain.PAspectRatio
  | Domain.PQuality | Domain.PBackground | Domain.PJudgeModel | Domain.PJudgeEffort
  | Domain.PJudgeCriteria | Domain.PJudgeSystem -> ()

(* Neutralizing a dimension preserves the entire parameter-source record,
   regardless of allocation inputs and the case counter. *)
let neutral_dimension_preserves_sources (layout: Domain.layout) (side: Domain.axis)
  (allocation: string & list string) (counter: nat)
  : Lemma (
    let after, _ = Input.neutral_dimension layout side allocation counter in
    after.parameters == layout.parameters) = ()

#push-options "--fuel 8"
(* If a common-capable parameter has differing axis values, reducing its move to
   common gives it a common source; this claim does not identify the stored value. *)
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

(* A differing common-capable parameter moved to common produces one deferred
   proposal containing the reduced draft, rather than immediately changing the
   current draft. *)
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
  comparison_preserves_typed_source before p;
  comparison_preserves_typed_source after p;
  input_conversion_dispatch model (Domain.MoveToCommon p)

(* An axis-owned common-capable parameter with differing values is reported as
   dropped by collapsing that axis or replacing its dimension with a different
   parameter. The conclusion is conditional on ownership and detected difference. *)
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

(* The input module's Boolean membership test agrees with list membership. *)
let rec membership_test_agrees (#a: eqtype) (value: a) (values: list a)
  : Lemma (Input.member value values == List.mem value values)
    (decreases values) =
  match values with
  | [] -> ()
  | _ :: rest -> membership_test_agrees value rest

(* Adding a parameter to the dropped-parameter list ensures it is recorded,
   whether it was already present or is newly appended. *)
let dropped_parameter_is_recorded (dropped: list Domain.parameter) (p: Domain.parameter)
  : Lemma (List.mem p (Input.add_dropped dropped p)) =
  membership_test_agrees p dropped;
  if Input.member p dropped then
    ()
  else
    append_right_member dropped [p] p

(* For a non-chat format, a common prompt history that is not exactly one user-role
   message is reset to the input default, and input loss is recorded. This covers
   this particular incompatibility rather than complete format validation. *)
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

(* The case-history normalization fold retains an existing input-loss report,
   or records one if a remaining entry's history is not exactly one user-role message. *)
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

(* For a non-chat format with axis-owned input, a history that is not exactly one
   user-role message in any entry of that axis causes normalization to report input loss. *)
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
