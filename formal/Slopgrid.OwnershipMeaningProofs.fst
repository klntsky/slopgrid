module Slopgrid.OwnershipMeaningProofs

module I = Slopgrid.Input
module P = Slopgrid.Parameters
module O = Slopgrid.OwnershipProofs
module S = Slopgrid.CellSemantics
module V = Slopgrid.VariableSemantics
module M = Slopgrid.CellMeaning
module MP = Slopgrid.CellMeaningProofs
module T = Slopgrid.Template
module L = FStar.List.Tot.Base
open Slopgrid.Domain

#set-options "--fuel 4 --ifuel 1"

let variable_fields (value:option (value_for PVariable)) : Tot (list (option variable_field)) =
  match value with | None -> [] | Some (VariableValue fields) -> fields

let first_variable_projection (input:layout) (side:axis)
  : Lemma (V.fields input side == variable_fields (S.axis_value input side 0 PVariable)) =
  match S.axis_entries input side with | [] -> () | _::_ -> ()

let variable_at_projection (input:layout) (row:nat) (column:nat) (side:axis) (index:nat)
  : Lemma (V.field_at input row column side index ==
    (match V.at (variable_fields (S.axis_value input side (if side=Rows then row else column) PVariable)) index with
      | None -> None | Some field -> field)) =
  match S.entry_at (S.axis_entries input side) (if side=Rows then row else column) with
  | None -> ()
  | Some entry -> match entry.values.variable_value with | None -> () | Some _ -> ()

let namespace_frame (before:layout) (after:layout) : prop =
  before.case_ownership == after.case_ownership /\ before.variable_names == after.variable_names /\
  (forall side index. P.is_case_axis before side ==>
    S.axis_value after side index PVariable == S.axis_value before side index PVariable)

let coordinate_frame (before:layout) (row:nat) (column:nat) (next_row:nat) (next_column:nat) : prop =
  forall side. P.is_case_axis before side ==>
    (if side=Rows then next_row else next_column) == (if side=Rows then row else column)

let rec slot_in_frame (before:layout) (after:layout) (side:axis)
  (fields:list (option variable_field)) (index:nat) (name:string)
  : Lemma
    (requires before.variable_names == after.variable_names)
    (ensures V.slot_in after side fields index name == V.slot_in before side fields index name) =
  match fields with | [] -> () | _::rest -> slot_in_frame before after side rest (index + 1) name

let slot_on_frame (before:layout) (after:layout) (side:axis) (name:string)
  : Lemma
    (requires namespace_frame before after /\ P.is_case_axis before side)
    (ensures V.slot_on after side name == V.slot_on before side name) =
  first_variable_projection before side;
  first_variable_projection after side;
  slot_in_frame before after side (V.fields before side) 0 name

let slot_for_frame (before:layout) (after:layout) (name:string)
  : Lemma
    (requires namespace_frame before after)
    (ensures V.slot_for after name == V.slot_for before name) =
  match before.case_ownership with
  | NoCaseAxes -> ()
  | OneCaseAxis side -> slot_on_frame before after side name
  | BothCaseAxes first ->
    slot_on_frame before after first name;
    slot_on_frame before after (V.other first) name

let slot_for_active (input:layout) (name:string) (side:axis) (index:nat)
  : Lemma
    (requires V.slot_for input name == Some (side,index))
    (ensures P.is_case_axis input side) =
  match input.case_ownership with
  | NoCaseAxes -> ()
  | OneCaseAxis owner -> (match V.slot_in input owner (V.fields input owner) 0 name with | None -> () | Some _ -> ())
  | BothCaseAxes _ -> ()

let environment_frame (before:layout) (after:layout) (row:nat) (column:nat) (next_row:nat) (next_column:nat) (name:T.identifier)
  : Lemma
    (requires namespace_frame before after /\ coordinate_frame before row column next_row next_column)
    (ensures V.field_for after next_row next_column name == V.field_for before row column name) =
  slot_for_frame before after (Slopgrid.Native.bytes_string name);
  match V.slot_for before (Slopgrid.Native.bytes_string name) with
  | None -> ()
  | Some (side,index) ->
    slot_for_active before (Slopgrid.Native.bytes_string name) side index;
    variable_at_projection before row column side index;
    variable_at_projection after next_row next_column side index

let own_variable_projection (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (allocation:string & list string) (counter:nat) (axis:axis) (index:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (Common v) /\ P.entries input side <> [])
    (ensures (let next,_ = I.own input p side allocation counter in
      S.axis_value next axis index PVariable == S.axis_value input axis index PVariable)) =
  O.source_projection input.parameters p;
  O.own_existing_cases input p side v allocation counter;
  O.own_preserves_opposite_axis_and_metadata input p side allocation counter;
  let next,_ = I.own input p side allocation counter in
  O.axis_projection input axis index PVariable;
  O.axis_projection next axis index PVariable;
  if axis=side then O.own_keeps_other_case_fields input p side v allocation counter PVariable index
  else match side,axis with | Rows,Rows | Rows,Columns | Columns,Rows | Columns,Columns -> ()

let own_environment (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat) (name:T.identifier)
  : Lemma
    (requires S.source_for input.parameters p == Some (Common v) /\ P.entries input side <> [])
    (ensures (let next,_ = I.own input p side allocation counter in
      V.field_for next row column name == V.field_for input row column name)) =
  O.own_preserves_opposite_axis_and_metadata input p side allocation counter;
  let for_axis axis = FStar.Classical.forall_intro (own_variable_projection input p side v allocation counter axis) in
  FStar.Classical.forall_intro for_axis;
  let next,_ = I.own input p side allocation counter in
  environment_frame input next row column row column name

let collapse_stripped (input:layout) (p:common_parameter) (side:axis) : Tot layout =
  let value = if I.differing input p then P.parameter_default p else
    match P.at (P.entries input side) 0 with | None -> P.parameter_default p | Some entry ->
      match P.get_case_value entry.values p with | None -> P.parameter_default p | Some value -> value in
  let base=I.set_source input p (Common value) in
  let base={base with parameters={base.parameters with source_order=
    L.append (L.filter (fun (key:common_parameter) -> key<>p) base.parameters.source_order) [p]}} in
  I.set_entries base side (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side))

let collapse_unfold (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side))
    (ensures I.collapse input p allocation counter == I.neutral_dimension (collapse_stripped input p side) side allocation counter) =
  O.source_projection input.parameters p;
  assert (I.collapse input p allocation counter == I.neutral_dimension (collapse_stripped input p side) side allocation counter)
    by (FStar.Tactics.norm [delta_only [`%I.collapse; `%collapse_stripped]]; FStar.Tactics.smt ())

let collapse_metadata (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side))
    (ensures (let next,_ = I.collapse input p allocation counter in
      next.case_ownership == input.case_ownership /\ next.variable_names == input.variable_names /\
      next.output_format == input.output_format /\ next.judging == input.judging /\
      next.parallel_workers == input.parallel_workers)) =
  collapse_unfold input p side allocation counter;
  O.neutral_dimension_preserves_sources (collapse_stripped input p side) side allocation counter;
  match side with | Rows | Columns -> ()

let collapse_active_projection (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat) (active:axis) (index:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side) /\ P.is_case_axis input active)
    (ensures (let next,_ = I.collapse input p allocation counter in
      S.axis_value next active index PVariable == S.axis_value input active index PVariable /\
      L.length (P.entries next active) == L.length (P.entries input active))) =
  collapse_unfold input p side allocation counter;
  let stripped=collapse_stripped input p side in
  O.neutral_dimension_preserves_sources stripped side allocation counter;
  O.mapped_remove_value (P.entries input side) p PVariable index;
  O.map_length (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side);
  let next,_=I.collapse input p allocation counter in
  O.axis_projection input active index PVariable;
  O.axis_projection next active index PVariable;
  if active=side then (
    assert (P.is_case_axis stripped side);
    assert (I.neutral_dimension stripped side allocation counter == (stripped,counter));
    match side with | Rows | Columns -> ()
  ) else match side,active with | Rows,Rows | Rows,Columns | Columns,Rows | Columns,Columns -> ()

let collapse_namespace_projection (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat) (active:axis) (index:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side))
    (ensures (let next,_=I.collapse input p allocation counter in
      P.is_case_axis input active ==>
      S.axis_value next active index PVariable == S.axis_value input active index PVariable)) =
  if P.is_case_axis input active then collapse_active_projection input p side allocation counter active index else ()

let collapse_coordinate_frame (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat) (active:axis)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side))
    (ensures (let next,_=I.collapse input p allocation counter in
      P.is_case_axis input active ==>
      (if active=Rows then O.corresponding_row input next row else O.corresponding_column input next column) ==
      (if active=Rows then row else column))) =
  if P.is_case_axis input active then (
    collapse_active_projection input p side allocation counter active 0;
    match active with | Rows | Columns -> ()
  ) else ()

let collapse_environment (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat) (name:T.identifier)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side))
    (ensures (let next,_=I.collapse input p allocation counter in
      V.field_for next (O.corresponding_row input next row) (O.corresponding_column input next column) name ==
      V.field_for input row column name)) =
  collapse_metadata input p side allocation counter;
  let for_axis axis=FStar.Classical.forall_intro (collapse_namespace_projection input p side allocation counter axis) in
  FStar.Classical.forall_intro for_axis;
  FStar.Classical.forall_intro (collapse_coordinate_frame input p side allocation counter row column);
  let next,_=I.collapse input p allocation counter in
  environment_frame input next row column (O.corresponding_row input next row) (O.corresponding_column input next column) name

let parameter_frame (before:layout) (after:layout) (row:nat) (column:nat) (next_row:nat) (next_column:nat) (p:common_parameter)
  : Lemma
    (requires S.equivalent p (S.resolve after next_row next_column p) (S.resolve before row column p) /\
      (forall name. V.field_for after next_row next_column name == V.field_for before row column name))
    (ensures M.parameter after next_row next_column p == M.parameter before row column p) =
  MP.equivalent_values (V.field_for after next_row next_column) (V.field_for before row column) p
    (S.resolve after next_row next_column p) (S.resolve before row column p)

let rec parameters_frame (before:layout) (after:layout) (row:nat) (column:nat) (next_row:nat) (next_column:nat)
  (parameters:list common_parameter)
  : Lemma
    (requires (forall p. S.equivalent p (S.resolve after next_row next_column p) (S.resolve before row column p)) /\
      (forall name. V.field_for after next_row next_column name == V.field_for before row column name))
    (ensures T.map_g (fun p -> (p,M.parameter after next_row next_column p)) parameters ==
      T.map_g (fun p -> (p,M.parameter before row column p)) parameters) =
  match parameters with | [] -> () | p::rest ->
    parameter_frame before after row column next_row next_column p;
    parameters_frame before after row column next_row next_column rest

let cell_frame (before:layout) (after:layout) (row:nat) (column:nat) (next_row:nat) (next_column:nat)
  : Lemma
    (requires before.output_format == after.output_format /\ before.judging == after.judging /\
      before.parallel_workers == after.parallel_workers /\
      (forall p. S.equivalent p (S.resolve after next_row next_column p) (S.resolve before row column p)) /\
      (forall name. V.field_for after next_row next_column name == V.field_for before row column name))
    (ensures M.cell after next_row next_column == M.cell before row column) =
  parameters_frame before after row column next_row next_column M.all_parameters;
  assert_norm ((M.cell after next_row next_column).cell_parameters ==
    T.map_g (fun p -> (p,M.parameter after next_row next_column p)) M.all_parameters);
  assert_norm ((M.cell before row column).cell_parameters ==
    T.map_g (fun p -> (p,M.parameter before row column p)) M.all_parameters)

let own_equivalent_parameter (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat) (q:common_parameter)
  : Lemma
    (requires S.source_for input.parameters p == Some (Common v) /\
      (if side=Rows then row else column) < L.length (P.entries input side))
    (ensures (let next,_=I.own input p side allocation counter in
      S.equivalent q (S.resolve next row column q) (S.resolve input row column q))) =
  O.own_preserves_every_parameter input p side v allocation counter q row column;
  match S.resolve input row column q with | None | Some _ -> ()

let own_cell (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (Common v) /\
      (if side=Rows then row else column) < L.length (P.entries input side))
    (ensures (let next,_=I.own input p side allocation counter in
      M.cell next row column == M.cell input row column /\
      M.observable_cell next row column == M.observable_cell input row column)) =
  O.entry_exists (P.entries input side) (if side=Rows then row else column);
  assert (P.entries input side <> []);
  O.own_preserves_opposite_axis_and_metadata input p side allocation counter;
  FStar.Classical.forall_intro (own_environment input p side v allocation counter row column);
  FStar.Classical.forall_intro (own_equivalent_parameter input p side v allocation counter row column);
  let next,_=I.own input p side allocation counter in
  cell_frame input next row column row column

let collapse_equivalent_parameter (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat) (q:common_parameter)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side) /\
      O.complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side))
    (ensures (let next,_=I.collapse input p allocation counter in
      S.equivalent q
        (S.resolve next (O.corresponding_row input next row) (O.corresponding_column input next column) q)
        (S.resolve input row column q))) =
  O.collapse_preserves_every_parameter input p side v allocation counter q row column

let collapse_cell (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side) /\
      O.complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side))
    (ensures (let next,_=I.collapse input p allocation counter in
      M.cell next (O.corresponding_row input next row) (O.corresponding_column input next column) == M.cell input row column /\
      M.observable_cell next (O.corresponding_row input next row) (O.corresponding_column input next column) ==
        M.observable_cell input row column)) =
  collapse_metadata input p side allocation counter;
  FStar.Classical.forall_intro (collapse_environment input p side allocation counter row column);
  FStar.Classical.forall_intro (collapse_equivalent_parameter input p side v allocation counter row column);
  let next,_=I.collapse input p allocation counter in
  cell_frame input next row column (O.corresponding_row input next row) (O.corresponding_column input next column)

let move_to_axis_cell (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (prefix:string) (counter:nat) (row:nat) (column:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (Common v) /\
      (if side=Rows then row else column) < L.length (P.entries input side))
    (ensures (let next,_=I.reduce input (MoveToAxis p side) prefix counter in
      M.cell next row column == M.cell input row column /\
      M.observable_cell next row column == M.observable_cell input row column)) =
  O.source_projection input.parameters p;
  if P.is_case_axis input side then
    own_cell input p side v (prefix,I.case_ids input) counter row column
  else ()

let move_to_common_cell (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  (prefix:string) (counter:nat) (row:nat) (column:nat)
  : Lemma
    (requires S.source_for input.parameters p == Some (OnAxis side) /\
      O.complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side))
    (ensures (let next,_=I.reduce input (MoveToCommon p) prefix counter in
      M.cell next (O.corresponding_row input next row) (O.corresponding_column input next column) == M.cell input row column /\
      M.observable_cell next (O.corresponding_row input next row) (O.corresponding_column input next column) ==
        M.observable_cell input row column)) =
  collapse_cell input p side v (prefix,I.case_ids input) counter row column
