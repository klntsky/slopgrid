module Slopgrid.ConfirmationProofs

module D = Slopgrid.Domain
module M = Slopgrid.Machine
module I = Slopgrid.Input
module L = FStar.List.Tot.Base
module P = Slopgrid.Parameters
module N = Slopgrid.Native

#set-options "--fuel 4 --ifuel 2"

let deferred (model:M.state) (proposed:D.draft) (counter:nat) (text:string)
  (result:M.step) : prop =
  result.next_state == {model with next_case=counter;
    next_confirmation=model.next_confirmation + 1;
    pending_confirmation=Some {M.confirmation_id=model.next_confirmation; proposed_draft=proposed}} /\
  result.change == D.MetadataChanged /\
  result.commands == [D.Confirm model.next_confirmation text]

let committed (model:M.state) (proposed:D.draft) (result:M.step) : prop =
  M.draft_equal result.next_state.draft proposed /\
  result.next_state.pending_confirmation == None /\
  result.next_state.active == model.active /\
  result.next_state.attempted == false /\ result.next_state.error == "" /\
  result.commands == (if M.draft_equal proposed model.draft then [] else [D.PersistDraft proposed]) /\
  result.change == (if M.draft_equal proposed model.draft then D.MetadataChanged else D.DraftChanged)

let proposal_preserves_complete_draft (model:M.state) (proposed:D.draft)
  (counter:nat) (text:string)
  : Lemma (deferred model proposed counter text
      (M.propose_draft model proposed counter (Some text))) = ()

let edit_invalidates_confirmation (model:M.state) (draft:D.draft) (counter:nat)
  : Lemma ((M.edit model draft counter).next_state.pending_confirmation == None) = ()

let edit_commits_semantically (model:M.state) (proposed:D.draft) (counter:nat)
  : Lemma (
    M.draft_equal (M.edit model proposed counter).next_state.draft proposed /\
    (M.edit model proposed counter).next_state.active == model.active) = ()

let matching_cancellation_preserves_complete_draft (model:M.state) (proposal:M.confirmation)
  : Lemma
    (requires (model.pending_confirmation == Some proposal))
    (ensures (
      let result = M.update_step model (D.ConfirmationResolved proposal.confirmation_id false) in
      result.next_state == {model with pending_confirmation=None} /\
      result.change == D.MetadataChanged /\ result.commands == [])) = ()

let matching_acceptance_commits_atomically (model:M.state) (proposal:M.confirmation)
  : Lemma
    (requires (model.pending_confirmation == Some proposal))
    (ensures (committed model proposal.proposed_draft
      (M.update_step model (D.ConfirmationResolved proposal.confirmation_id true)))) =
  edit_commits_semantically model proposal.proposed_draft model.next_case

let stale_confirmation_is_inert (model:M.state) (id:pos) (accepted:bool)
  : Lemma
    (requires (not (M.owns_confirmation model id)))
    (ensures (
      let result = M.update_step model (D.ConfirmationResolved id accepted) in
      result.next_state == model /\ result.change == D.NoChange /\ result.commands == [])) = ()

let proposal_cancel_trace (model:M.state) (proposed:D.draft) (counter:nat) (text:string)
  : Lemma (
    let pending = (M.propose_draft model proposed counter (Some text)).next_state in
    let cancelled = M.update_step pending (D.ConfirmationResolved model.next_confirmation false) in
    cancelled.next_state.draft == model.draft /\
    cancelled.next_state.pending_confirmation == None /\ cancelled.commands == []) =
  let pending = (M.propose_draft model proposed counter (Some text)).next_state in
  matching_cancellation_preserves_complete_draft pending
    {M.confirmation_id=model.next_confirmation; proposed_draft=proposed}

let proposal_accept_trace (model:M.state) (proposed:D.draft) (counter:nat) (text:string)
  : Lemma (
    let pending = (M.propose_draft model proposed counter (Some text)).next_state in
    committed pending proposed
      (M.update_step pending (D.ConfirmationResolved model.next_confirmation true))) =
  let pending = (M.propose_draft model proposed counter (Some text)).next_state in
  matching_acceptance_commits_atomically pending
    {M.confirmation_id=model.next_confirmation; proposed_draft=proposed}

let input_conversion_dispatch (model:M.state) (action:D.input_action)
  : Lemma (
    let before = model.draft.editable.draft_layout in
    let after,counter = I.reduce before action model.case_prefix model.next_case in
    let proposed = {model.draft with editable={model.draft.editable with draft_layout=after}} in
    let result = M.update_step model (D.InputAction action) in
    match I.confirmation before action with
    | None -> result.next_state.pending_confirmation == None /\
        M.draft_equal result.next_state.draft proposed
    | Some text ->
        if M.draft_equal model.draft proposed then
          result.next_state.draft == model.draft /\ result.commands == [] /\
          result.next_state.pending_confirmation == None
        else deferred model proposed counter text result) =
  let before = model.draft.editable.draft_layout in
  let after,counter = I.reduce before action model.case_prefix model.next_case in
  let proposed = {model.draft with editable={model.draft.editable with draft_layout=after}} in
  if M.draft_equal model.draft proposed then
    edit_commits_semantically model model.draft model.next_case
  else match I.confirmation before action with
    | None -> edit_commits_semantically model proposed counter
    | Some text -> proposal_preserves_complete_draft model proposed counter text

let detected_ownership_loss_is_deferred (model:M.state) (action:D.input_action)
  : Lemma
    (requires (I.dropped_parameters model.draft.editable.draft_layout action <> []))
    (ensures (
      let result = M.update_step model (D.InputAction action) in
      result.next_state.draft == model.draft /\
      result.next_state.active == model.active /\
      (result.commands == [] \/
        (exists text. result.commands == [D.Confirm model.next_confirmation text])))) =
  input_conversion_dispatch model action;
  match I.dropped_parameters model.draft.editable.draft_layout action with
  | [] -> ()
  | _::_ -> ()

let format_conversion_dispatch (model:M.state) (format:D.format)
  : Lemma (
    let proposed,counter,dropped = I.select_format model.draft format model.context.catalog
      model.case_prefix model.next_case in
    let result = M.update_step model (D.SelectFormat format) in
    match dropped with
    | [] -> result.next_state.pending_confirmation == None /\
        M.draft_equal result.next_state.draft proposed
    | _::_ -> exists text. deferred model proposed counter text result) =
  let proposed,counter,dropped = I.select_format model.draft format model.context.catalog
    model.case_prefix model.next_case in
  match dropped with
  | [] -> edit_commits_semantically model proposed counter
  | _::_ -> ()

let detected_format_loss_is_deferred (model:M.state) (format:D.format)
  : Lemma (
    let _,_,dropped = I.select_format model.draft format model.context.catalog
      model.case_prefix model.next_case in
    dropped <> [] ==>
      (let result = M.update_step model (D.SelectFormat format) in
      result.next_state.draft == model.draft /\ result.next_state.active == model.active /\
      (exists text. result.commands == [D.Confirm model.next_confirmation text]))) =
  format_conversion_dispatch model format

let budget_edit_invalidates_and_stale_acceptance_is_inert (model:M.state) (text:string) (id:pos)
  : Lemma (
    let edited = M.update_step model (D.ChangeBudget text) in
    let stale = M.update_step edited.next_state (D.ConfirmationResolved id true) in
    edited.next_state.pending_confirmation == None /\
    stale.next_state == edited.next_state /\ stale.commands == [] /\ stale.change == D.NoChange) =
  edit_invalidates_confirmation model
    {model.draft with editable={model.draft.editable with budget_text=text}} model.next_case

let input_edit_invalidates_and_stale_acceptance_is_inert (model:M.state)
  (action:D.input_action) (id:pos)
  : Lemma
    (requires (I.confirmation model.draft.editable.draft_layout action == None))
    (ensures (
      let edited = M.update_step model (D.InputAction action) in
      let stale = M.update_step edited.next_state (D.ConfirmationResolved id true) in
      edited.next_state.pending_confirmation == None /\
      stale.next_state == edited.next_state /\ stale.commands == [] /\ stale.change == D.NoChange)) =
  input_conversion_dispatch model action

let confirmation_ids_are_fresh (model:M.state) : prop =
  match model.pending_confirmation with
  | None -> True
  | Some proposal -> proposal.confirmation_id < model.next_confirmation

let initial_confirmation_ids_are_fresh (initial:D.initial) (context:D.context)
  : Lemma (confirmation_ids_are_fresh (M.init initial context)) = ()

let dispatch_preserves_confirmation_id_freshness (model:M.state) (event:D.event)
  : Lemma
    (requires (confirmation_ids_are_fresh model))
    (ensures (confirmation_ids_are_fresh (M.update_step model event).next_state)) =
  match event with
  | D.InputAction action ->
    let before = model.draft.editable.draft_layout in
    let after,counter = I.reduce before action model.case_prefix model.next_case in
    let proposed = {model.draft with editable={model.draft.editable with draft_layout=after}} in
    if M.draft_equal model.draft proposed then edit_invalidates_confirmation model model.draft model.next_case
    else (match I.confirmation before action with
      | None -> edit_invalidates_confirmation model proposed counter
      | Some text -> proposal_preserves_complete_draft model proposed counter text)
  | D.SelectFormat format -> format_conversion_dispatch model format
  | _ -> ()

let later_input_action_prevents_old_acceptance (model:M.state) (proposal:M.confirmation)
  (action:D.input_action)
  : Lemma
    (requires (confirmation_ids_are_fresh model /\ model.pending_confirmation == Some proposal))
    (ensures (
      let edited = M.update_step model (D.InputAction action) in
      let stale = M.update_step edited.next_state (D.ConfirmationResolved proposal.confirmation_id true) in
      stale.next_state == edited.next_state /\ stale.change == D.NoChange /\ stale.commands == [])) =
  input_conversion_dispatch model action;
  let edited = (M.update_step model (D.InputAction action)).next_state in
  assert (not (M.owns_confirmation edited proposal.confirmation_id));
  stale_confirmation_is_inert edited proposal.confirmation_id true

let later_format_selection_prevents_old_acceptance (model:M.state) (proposal:M.confirmation)
  (format:D.format)
  : Lemma
    (requires (confirmation_ids_are_fresh model /\ model.pending_confirmation == Some proposal))
    (ensures (
      let edited = M.update_step model (D.SelectFormat format) in
      let stale = M.update_step edited.next_state (D.ConfirmationResolved proposal.confirmation_id true) in
      stale.next_state == edited.next_state /\ stale.change == D.NoChange /\ stale.commands == [])) =
  format_conversion_dispatch model format;
  let edited = (M.update_step model (D.SelectFormat format)).next_state in
  let _,_,dropped = I.select_format model.draft format model.context.catalog model.case_prefix model.next_case in
  (match dropped with
   | [] -> assert (edited.pending_confirmation == None)
   | _::_ -> assert (exists proposed. edited.pending_confirmation ==
       Some {M.confirmation_id=model.next_confirmation; proposed_draft=proposed}));
  assert (not (M.owns_confirmation edited proposal.confirmation_id));
  stale_confirmation_is_inert edited proposal.confirmation_id true

let input_conversion_atomic_resolution_trace (model:M.state) (action:D.input_action)
  : Lemma (
    let before = model.draft.editable.draft_layout in
    let after,counter = I.reduce before action model.case_prefix model.next_case in
    let proposed = {model.draft with editable={model.draft.editable with draft_layout=after}} in
    match I.confirmation before action with
    | None -> True
    | Some text -> not (M.draft_equal model.draft proposed) ==>
      (let pending = M.update_step model (D.InputAction action) in
       let cancelled = M.update_step pending.next_state (D.ConfirmationResolved model.next_confirmation false) in
       let accepted = M.update_step pending.next_state (D.ConfirmationResolved model.next_confirmation true) in
       deferred model proposed counter text pending /\
       cancelled.next_state.draft == model.draft /\ cancelled.commands == [] /\
       cancelled.next_state.pending_confirmation == None /\
       committed pending.next_state proposed accepted)) =
  input_conversion_dispatch model action;
  let before = model.draft.editable.draft_layout in
  let after,counter = I.reduce before action model.case_prefix model.next_case in
  let proposed = {model.draft with editable={model.draft.editable with draft_layout=after}} in
  match I.confirmation before action with
  | None -> ()
  | Some text ->
    if M.draft_equal model.draft proposed then () else
    let pending = (M.update_step model (D.InputAction action)).next_state in
    let proposal = {M.confirmation_id=model.next_confirmation; proposed_draft=proposed} in
    matching_cancellation_preserves_complete_draft pending proposal;
    matching_acceptance_commits_atomically pending proposal

let format_conversion_atomic_resolution_trace (model:M.state) (format:D.format)
  : Lemma (
    let proposed,counter,dropped = I.select_format model.draft format model.context.catalog
      model.case_prefix model.next_case in
    dropped <> [] ==>
      (let pending = M.update_step model (D.SelectFormat format) in
       let cancelled = M.update_step pending.next_state (D.ConfirmationResolved model.next_confirmation false) in
       let accepted = M.update_step pending.next_state (D.ConfirmationResolved model.next_confirmation true) in
       pending.next_state.draft == model.draft /\
       (exists text. deferred model proposed counter text pending) /\
       cancelled.next_state.draft == model.draft /\ cancelled.commands == [] /\
       cancelled.next_state.pending_confirmation == None /\
       committed pending.next_state proposed accepted)) =
  format_conversion_dispatch model format;
  let proposed,counter,dropped = I.select_format model.draft format model.context.catalog
    model.case_prefix model.next_case in
  match dropped with
  | [] -> ()
  | _::_ ->
    let pending = (M.update_step model (D.SelectFormat format)).next_state in
    let proposal = {M.confirmation_id=model.next_confirmation; proposed_draft=proposed} in
    matching_cancellation_preserves_complete_draft pending proposal;
    matching_acceptance_commits_atomically pending proposal

let differing_common_return_is_detected (layout:D.layout) (p:D.common_parameter)
  : Lemma
    (requires (I.differing layout p))
    (ensures (I.dropped_parameters layout (D.MoveToCommon p) == [p] /\
      (exists text. I.confirmation layout (D.MoveToCommon p) == Some text))) = ()

let rec existsb_witness (#a:eqtype) (predicate:a -> Tot bool)
  (values:list a) (witness:a)
  : Lemma
    (requires (L.mem witness values /\ predicate witness))
    (ensures (L.existsb predicate values))
    (decreases values) =
  match values with
  | [] -> ()
  | first::rest -> if first=witness then () else existsb_witness predicate rest witness

let rec filter_witness (#a:eqtype) (predicate:a -> Tot bool)
  (values:list a) (witness:a)
  : Lemma
    (requires (L.mem witness values /\ predicate witness))
    (ensures (L.mem witness (L.filter predicate values)))
    (decreases values) =
  match values with
  | [] -> ()
  | first::rest -> if first=witness then () else filter_witness predicate rest witness

let rec append_right_member (#a:eqtype) (left:list a) (right:list a) (witness:a)
  : Lemma
    (requires (L.mem witness right))
    (ensures (L.mem witness (L.append left right)))
    (decreases left) =
  match left with | [] -> () | _::rest -> append_right_member rest right witness

let populated_field (field:option D.variable_field) : Tot bool =
  match field with
  | None -> false
  | Some field -> N.length field.text > 0 || L.length (I.option_list field.field_images) > 0

#push-options "--fuel 8"
let populated_numbered_fields_are_detected (layout:D.layout) (side:D.axis)
  (entry:D.case_record) (fields:list (option D.variable_field)) (field:D.variable_field)
  (replacement:D.common_parameter)
  : Lemma
    (requires (L.mem entry (I.entries layout side) /\
      entry.values.variable_value == Some fields /\ L.mem (Some field) fields /\
      populated_field (Some field)))
    (ensures (
      L.mem D.PVariable (I.dropped_parameters layout (D.SingleDimension side)) /\
      L.mem D.PVariable (I.dropped_parameters layout (D.SelectDimension side replacement)))) =
  existsb_witness (fun (field:option D.variable_field) -> match field with | None -> false | Some field ->
    N.length field.text > 0 || L.length (I.option_list field.field_images) > 0) fields (Some field);
  (match fields with | [] -> () | _::_ -> ());
  existsb_witness
    (fun (entry:D.case_record) -> match entry.values.variable_value with
      | None -> false | Some fields -> L.length fields > 0)
    (I.entries layout side) entry;
  assert (P.axis_has_variables layout side);
  P.axis_variable_is_enumerated layout side;
  existsb_witness
    (fun (entry:D.case_record) -> L.existsb (fun (field:option D.variable_field) -> match field with | None -> false | Some field ->
      N.length field.text > 0 || L.length (I.option_list field.field_images) > 0) (I.option_list entry.values.variable_value))
    (I.entries layout side) entry;
  filter_witness (fun (key:D.parameter) -> key<>replacement) (P.axis_parameters layout side) D.PVariable;
  filter_witness
    (fun (p:D.parameter) -> if p<>D.PVariable then I.differing layout p else
      L.existsb (fun (entry:D.case_record) -> L.existsb (fun (field:option D.variable_field) -> match field with | None -> false | Some field ->
        N.length field.text > 0 || L.length (I.option_list field.field_images) > 0) (I.option_list entry.values.variable_value))
        (I.entries layout side))
    (P.axis_parameters layout side) D.PVariable;
  filter_witness
    (fun (p:D.parameter) -> if p<>D.PVariable then I.differing layout p else
      L.existsb (fun (entry:D.case_record) -> L.existsb (fun (field:option D.variable_field) -> match field with | None -> false | Some field ->
        N.length field.text > 0 || L.length (I.option_list field.field_images) > 0) (I.option_list entry.values.variable_value))
        (I.entries layout side))
    (L.filter (fun (key:D.parameter) -> key<>replacement) (P.axis_parameters layout side)) D.PVariable
#pop-options

let comparison_preserves_typed_source (layout:D.layout) (p:D.common_parameter)
  : Lemma (P.get_source (I.layout_data layout).parameters p == P.get_source layout.parameters p) =
  match p with
  | D.PInput | D.PModel | D.PEffort | D.PSize | D.PAspectRatio | D.PQuality
  | D.PBackground | D.PJudgeModel | D.PJudgeEffort | D.PJudgeCriteria | D.PJudgeSystem -> ()

let source_order_preserves_typed_source (sources:D.parameter_sources)
  (order:list D.common_parameter) (p:D.common_parameter)
  : Lemma (P.get_source {sources with source_order=order} p == P.get_source sources p) =
  match p with
  | D.PInput | D.PModel | D.PEffort | D.PSize | D.PAspectRatio | D.PQuality
  | D.PBackground | D.PJudgeModel | D.PJudgeEffort | D.PJudgeCriteria | D.PJudgeSystem -> ()

let neutral_dimension_preserves_sources (layout:D.layout) (side:D.axis)
  (allocation:string & list string) (counter:nat)
  : Lemma (
    let after,_ = I.neutral_dimension layout side allocation counter in
    after.parameters == layout.parameters) = ()

#push-options "--fuel 8"
let differing_common_return_changes_source (layout:D.layout) (p:D.common_parameter)
  (prefix:string) (counter:nat)
  : Lemma
    (requires (I.differing layout p))
    (ensures (
      let after,_ = I.reduce layout (D.MoveToCommon p) prefix counter in
      match P.get_source after.parameters p with
      | Some (D.Common _) -> True | _ -> False)) =
  match P.get_source layout.parameters p with
  | Some (D.OnAxis side) ->
    let common = I.set_source layout p (D.Common (P.parameter_default p)) in
    let order = L.append (L.filter (fun (key:D.common_parameter) -> key<>p)
      common.parameters.source_order) [p] in
    let reordered = {common with parameters={common.parameters with source_order=order}} in
    let stripped = I.set_entries reordered side
      (L.map (fun (entry:D.case_record) -> {entry with values=P.remove_case_value entry.values p}) (I.entries layout side)) in
    P.get_set_source layout.parameters p (D.Common (P.parameter_default p)) p;
    source_order_preserves_typed_source common.parameters order p;
    neutral_dimension_preserves_sources stripped side (prefix,I.case_ids layout) counter
  | _ -> ()
#pop-options

let differing_common_return_proposes_once (model:M.state) (p:D.common_parameter)
  : Lemma
    (requires (I.differing model.draft.editable.draft_layout p))
    (ensures (
      let after,counter = I.reduce model.draft.editable.draft_layout (D.MoveToCommon p)
        model.case_prefix model.next_case in
      let proposed = {model.draft with editable={model.draft.editable with draft_layout=after}} in
      exists text. deferred model proposed counter text (M.update_step model (D.InputAction (D.MoveToCommon p))))) =
  let before = model.draft.editable.draft_layout in
  let after,_ = I.reduce before (D.MoveToCommon p) model.case_prefix model.next_case in
  differing_common_return_is_detected before p;
  differing_common_return_changes_source before p model.case_prefix model.next_case;
  comparison_preserves_typed_source before p;
  comparison_preserves_typed_source after p;
  input_conversion_dispatch model (D.MoveToCommon p)

let differing_axis_parameters_are_detected (layout:D.layout) (side:D.axis)
  (p:D.common_parameter) (replacement:D.parameter)
  : Lemma
    (requires (P.get_source layout.parameters p == Some (D.OnAxis side) /\
      I.differing layout p /\ p<>replacement))
    (ensures (
      L.mem (p <: D.parameter) (I.dropped_parameters layout (D.SingleDimension side)) /\
      L.mem (p <: D.parameter) (I.dropped_parameters layout (D.SelectDimension side replacement)))) =
  P.axis_owner_is_enumerated layout p side;
  filter_witness
    (fun (key:D.parameter) -> if key<>D.PVariable then I.differing layout key else
      L.existsb (fun (entry:D.case_record) -> L.existsb
        (fun (field:option D.variable_field) -> match field with | None -> false | Some field ->
          N.length field.text > 0 || L.length (I.option_list field.field_images) > 0)
        (I.option_list entry.values.variable_value)) (I.entries layout side))
    (P.axis_parameters layout side) (p <: D.parameter);
  filter_witness (fun (key:D.parameter) -> key<>replacement) (P.axis_parameters layout side) (p <: D.parameter);
  filter_witness
    (fun (key:D.parameter) -> if key<>D.PVariable then I.differing layout key else
      L.existsb (fun (entry:D.case_record) -> L.existsb
        (fun (field:option D.variable_field) -> match field with | None -> false | Some field ->
          N.length field.text > 0 || L.length (I.option_list field.field_images) > 0)
        (I.option_list entry.values.variable_value)) (I.entries layout side))
    (L.filter (fun (key:D.parameter) -> key<>replacement) (P.axis_parameters layout side)) (p <: D.parameter)

let rec membership_test_agrees (#a:eqtype) (value:a) (values:list a)
  : Lemma (I.member value values == L.mem value values)
    (decreases values) =
  match values with | [] -> () | _::rest -> membership_test_agrees value rest

let dropped_parameter_is_recorded (dropped:list D.parameter) (p:D.parameter)
  : Lemma (L.mem p (I.add_dropped dropped p)) =
  membership_test_agrees p dropped;
  if I.member p dropped then () else append_right_member dropped [p] p

let incompatible_common_history_is_detected (layout:D.layout) (format:D.format)
  (messages:list D.message) (dropped:list D.parameter)
  : Lemma
    (requires (layout.parameters.input_source == D.Common (D.InputValue messages) /\
      format<>D.ChatTemplate /\ not (I.valid_prompt_messages messages)))
    (ensures (
      let after,loss = I.normalize_prompt_format layout format dropped in
      L.mem D.PInput loss /\ after.parameters.input_source == D.Common (P.parameter_default D.PInput))) =
  dropped_parameter_is_recorded dropped D.PInput

let rec case_history_fold_records_loss (entries:list D.case_record) (cases:list D.case_record)
  (dropped:list D.parameter) (witness:D.case_record)
  : Lemma
    (requires (L.mem D.PInput dropped \/
      (L.mem witness entries /\ not (I.valid_prompt_messages (I.option_list witness.values.input_value)))))
    (ensures (
      let _,loss = I.fold (fun (cases,dropped) (entry:D.case_record) ->
        if I.valid_prompt_messages (I.option_list entry.values.input_value) then (L.append cases [entry],dropped)
        else (L.append cases [{entry with values=P.set_case_value entry.values (P.parameter_default D.PInput)}],
          I.add_dropped dropped D.PInput)) (cases,dropped) entries in
      L.mem D.PInput loss))
    (decreases entries) =
  match entries with
  | [] -> ()
  | entry::rest ->
    if I.valid_prompt_messages (I.option_list entry.values.input_value) then
      case_history_fold_records_loss rest (L.append cases [entry]) dropped witness
    else (
      dropped_parameter_is_recorded dropped D.PInput;
      case_history_fold_records_loss rest
        (L.append cases [{entry with values=P.set_case_value entry.values (P.parameter_default D.PInput)}])
        (I.add_dropped dropped D.PInput) witness)

let incompatible_case_history_is_detected (layout:D.layout) (format:D.format)
  (side:D.axis) (entry:D.case_record) (dropped:list D.parameter)
  : Lemma
    (requires (layout.parameters.input_source == D.OnAxis side /\ format<>D.ChatTemplate /\
      L.mem entry (I.entries layout side) /\
      not (I.valid_prompt_messages (I.option_list entry.values.input_value))))
    (ensures (
      let _,loss = I.normalize_prompt_format layout format dropped in
      L.mem D.PInput loss)) =
  case_history_fold_records_loss (I.entries layout side) [] dropped entry
