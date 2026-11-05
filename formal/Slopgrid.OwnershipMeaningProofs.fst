module Slopgrid.OwnershipMeaningProofs

module Input = Slopgrid.Input
module Parameters = Slopgrid.Parameters
module OwnershipProofs = Slopgrid.OwnershipProofs
module CellSemantics = Slopgrid.CellSemantics
module VariableSemantics = Slopgrid.VariableSemantics
module CellMeaning = Slopgrid.CellMeaning
module CellMeaningProofs = Slopgrid.CellMeaningProofs
module Template = Slopgrid.Template
module Native = Slopgrid.Native
module List = FStar.List.Tot.Base
open Slopgrid.Domain

#set-options "--fuel 4 --ifuel 1"

let variable_fields (value: option (value_for PVariable)) : Tot (list (option variable_field)) =
  match value with
  | None -> []
  | Some (VariableValue fields) -> fields

(* The fields defining an axis's variable slots are exactly the variable
   value of its first case, with a missing case or value treated as no fields. *)
let first_variable_projection (input: layout) (side: axis)
  : Lemma (
    VariableSemantics.fields input side ==
      variable_fields (CellSemantics.axis_value input side 0 PVariable)) =
  match CellSemantics.axis_entries input side with
  | [] -> ()
  | _ :: _ -> ()

(* A coordinate's variable-field lookup is the indexed field in that axis
   case's variable value; a missing case, value, or field yields absence. *)
let variable_at_projection
  (input: layout) (row: nat) (column: nat) (side: axis) (index: nat)
  : Lemma (
    VariableSemantics.field_at input row column side index ==
      (match VariableSemantics.at
        (variable_fields
          (CellSemantics.axis_value input side (if side = Rows then row else column) PVariable))
        index with
       | None -> None
       | Some field -> field)) =
  match CellSemantics.entry_at (CellSemantics.axis_entries input side)
    (if side = Rows then row else column) with
  | None -> ()
  | Some entry ->
    match entry.values.variable_value with
    | None -> ()
    | Some _ -> ()

let namespace_frame (before: layout) (after: layout) : prop =
  before.case_ownership == after.case_ownership /\
  before.variable_names == after.variable_names /\
  (forall side index.
    Parameters.is_case_axis before side ==>
    CellSemantics.axis_value after side index PVariable ==
      CellSemantics.axis_value before side index PVariable)

let coordinate_frame
  (before: layout) (row: nat) (column: nat) (next_row: nat) (next_column: nat) : prop =
  forall side.
    Parameters.is_case_axis before side ==>
    (if side = Rows then next_row else next_column) == (if side = Rows then row else column)

(* Equal variable-name metadata makes the named-slot search identical for a
   fixed axis, field list, and starting index, including default names. *)
let rec slot_in_frame (before: layout) (after: layout) (side: axis)
  (fields: list (option variable_field)) (index: nat) (name: string)
  : Lemma
    (requires before.variable_names == after.variable_names)
    (ensures
      VariableSemantics.slot_in after side fields index name ==
        VariableSemantics.slot_in before side fields index name) =
  match fields with
  | [] -> ()
  | _ :: rest -> slot_in_frame before after side rest (index + 1) name

(* Preserving case ownership, variable names, and variable values on active
   case axes preserves named-slot lookup on this active axis. *)
let slot_on_frame (before: layout) (after: layout) (side: axis) (name: string)
  : Lemma
    (requires namespace_frame before after /\ Parameters.is_case_axis before side)
    (ensures
      VariableSemantics.slot_on after side name == VariableSemantics.slot_on before side name) =
  first_variable_projection before side;
  first_variable_projection after side;
  slot_in_frame before after side (VariableSemantics.fields before side) 0 name

(* Preserving case ownership, variable names, and active-axis variable values
   preserves global named-slot lookup, including precedence between axes. *)
let slot_for_frame (before: layout) (after: layout) (name: string)
  : Lemma
    (requires namespace_frame before after)
    (ensures VariableSemantics.slot_for after name == VariableSemantics.slot_for before name) =
  match before.case_ownership with
  | NoCaseAxes -> ()
  | OneCaseAxis side -> slot_on_frame before after side name
  | BothCaseAxes first ->
    slot_on_frame before after first name;
    slot_on_frame before after (VariableSemantics.other first) name

(* Any axis returned by a successful global variable-slot lookup is an
   active case axis of the layout. *)
let slot_for_active (input: layout) (name: string) (side: axis) (index: nat)
  : Lemma
    (requires VariableSemantics.slot_for input name == Some (side, index))
    (ensures Parameters.is_case_axis input side) =
  match input.case_ownership with
  | NoCaseAxes -> ()
  | OneCaseAxis owner ->
    (match VariableSemantics.slot_in input owner (VariableSemantics.fields input owner) 0 name with
     | None -> ()
     | Some _ -> ())
  | BothCaseAxes _ -> ()

(* Equal case ownership, names, and active-axis variable values preserve an
   identifier's exact optional field when the coordinates on active axes also
   stay fixed; coordinates on inactive axes need not agree. *)
let environment_frame (before: layout) (after: layout)
  (row: nat) (column: nat) (next_row: nat) (next_column: nat) (name: Template.identifier)
  : Lemma
    (requires
      namespace_frame before after /\ coordinate_frame before row column next_row next_column)
    (ensures
      VariableSemantics.field_for after next_row next_column name ==
        VariableSemantics.field_for before row column name) =
  slot_for_frame before after (Native.bytes_string name);
  match VariableSemantics.slot_for before (Native.bytes_string name) with
  | None -> ()
  | Some (side, index) ->
    slot_for_active before (Native.bytes_string name) side index;
    variable_at_projection before row column side index;
    variable_at_projection after next_row next_column side index

(* Taking ownership of a common parameter on a nonempty target axis leaves
   every axis's indexed variable value exactly unchanged. *)
let own_variable_projection
  (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (allocation: string & list string) (counter: nat) (axis: axis) (index: nat)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      Parameters.entries input side <> [])
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      CellSemantics.axis_value next axis index PVariable ==
        CellSemantics.axis_value input axis index PVariable)) =
  OwnershipProofs.source_projection input.parameters p;
  OwnershipProofs.own_existing_cases input p side v allocation counter;
  OwnershipProofs.own_preserves_opposite_axis_and_metadata input p side allocation counter;
  let next, _ = Input.own input p side allocation counter in
  OwnershipProofs.axis_projection input axis index PVariable;
  OwnershipProofs.axis_projection next axis index PVariable;
  if axis = side then
    OwnershipProofs.own_keeps_other_case_fields input p side v allocation counter PVariable index
  else
    match side, axis with
    | Rows, Rows
    | Rows, Columns
    | Columns, Rows
    | Columns, Columns -> ()

(* Taking ownership of a common parameter on a nonempty target axis preserves
   the exact field resolved for any identifier at the same cell coordinates. *)
let own_environment (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat)
  (name: Template.identifier)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      Parameters.entries input side <> [])
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      VariableSemantics.field_for next row column name ==
        VariableSemantics.field_for input row column name)) =
  OwnershipProofs.own_preserves_opposite_axis_and_metadata input p side allocation counter;
  (* For this axis, ownership preserves variable values at every index. *)
  let for_axis axis =
    FStar.Classical.forall_intro (own_variable_projection input p side v allocation counter axis)
  in
  FStar.Classical.forall_intro for_axis;
  let next, _ = Input.own input p side allocation counter in
  environment_frame input next row column row column name

let collapse_stripped (input: layout) (p: common_parameter) (side: axis) : Tot layout =
  let value =
    if Input.differing input p then
      Parameters.parameter_default p
    else
      match Parameters.at (Parameters.entries input side) 0 with
      | None -> Parameters.parameter_default p
      | Some entry ->
        match Parameters.get_case_value entry.values p with
        | None -> Parameters.parameter_default p
        | Some value -> value
  in
  let base = Input.set_source input p (Common value) in
  let base = {
    base with
    parameters = {
      base.parameters with
      source_order = List.append
        (List.filter (fun (key: common_parameter) -> key <> p) base.parameters.source_order)
        [p]
    }
  } in
  Input.set_entries base side
    (List.map
      (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
      (Parameters.entries input side))

(* For an axis-owned parameter, collapse is exactly neutralization of the
   layout with a selected common value and that parameter's case fields
   removed, including the returned allocation counter. *)
let collapse_unfold (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat)
  : Lemma
    (requires CellSemantics.source_for input.parameters p == Some (OnAxis side))
    (ensures
      Input.collapse input p allocation counter ==
        Input.neutral_dimension (collapse_stripped input p side) side allocation counter) =
  OwnershipProofs.source_projection input.parameters p;
  assert (
    Input.collapse input p allocation counter ==
      Input.neutral_dimension (collapse_stripped input p side) side allocation counter)
    by (
      FStar.Tactics.norm [delta_only [`%Input.collapse; `%collapse_stripped]];
      FStar.Tactics.smt ())

(* Collapsing an axis-owned parameter preserves case ownership, variable
   names, output format, judging, and worker count exactly. *)
let collapse_metadata (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat)
  : Lemma
    (requires CellSemantics.source_for input.parameters p == Some (OnAxis side))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      next.case_ownership == input.case_ownership /\
      next.variable_names == input.variable_names /\
      next.output_format == input.output_format /\
      next.judging == input.judging /\
      next.parallel_workers == input.parallel_workers)) =
  collapse_unfold input p side allocation counter;
  OwnershipProofs.neutral_dimension_preserves_sources
    (collapse_stripped input p side) side allocation counter;
  match side with
  | Rows
  | Columns -> ()

(* Collapsing an axis-owned parameter preserves every indexed variable value
   and the entry count on each active case axis, even if the collapsed
   parameter belongs to that same axis. *)
let collapse_active_projection (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat) (active: axis) (index: nat)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      Parameters.is_case_axis input active)
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      CellSemantics.axis_value next active index PVariable ==
        CellSemantics.axis_value input active index PVariable /\
      List.length (Parameters.entries next active) ==
        List.length (Parameters.entries input active))) =
  collapse_unfold input p side allocation counter;
  let stripped = collapse_stripped input p side in
  OwnershipProofs.neutral_dimension_preserves_sources stripped side allocation counter;
  OwnershipProofs.mapped_remove_value (Parameters.entries input side) p PVariable index;
  OwnershipProofs.map_length
    (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
    (Parameters.entries input side);
  let next, _ = Input.collapse input p allocation counter in
  OwnershipProofs.axis_projection input active index PVariable;
  OwnershipProofs.axis_projection next active index PVariable;
  if active = side then (
    assert (Parameters.is_case_axis stripped side);
    assert (Input.neutral_dimension stripped side allocation counter == (stripped, counter));
    match side with
    | Rows
    | Columns -> ()
  ) else
    match side, active with
    | Rows, Rows
    | Rows, Columns
    | Columns, Rows
    | Columns, Columns -> ()

(* Collapsing an axis-owned parameter preserves indexed variable values on
   any axis that was active; the implication makes no claim for inactive axes. *)
let collapse_namespace_projection (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat) (active: axis) (index: nat)
  : Lemma
    (requires CellSemantics.source_for input.parameters p == Some (OnAxis side))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      Parameters.is_case_axis input active ==>
      CellSemantics.axis_value next active index PVariable ==
        CellSemantics.axis_value input active index PVariable)) =
  if Parameters.is_case_axis input active then
    collapse_active_projection input p side allocation counter active index
  else
    ()

(* After collapse of an axis-owned parameter, the corresponding coordinate
   on every originally active case axis is the original coordinate. *)
let collapse_coordinate_frame (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat) (active: axis)
  : Lemma
    (requires CellSemantics.source_for input.parameters p == Some (OnAxis side))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      Parameters.is_case_axis input active ==>
      (if active = Rows then
        OwnershipProofs.corresponding_row input next row
       else
        OwnershipProofs.corresponding_column input next column) ==
      (if active = Rows then row else column))) =
  if Parameters.is_case_axis input active then (
    collapse_active_projection input p side allocation counter active 0;
    match active with
    | Rows
    | Columns -> ()
  ) else
    ()

(* Collapsing an axis-owned parameter preserves each identifier's exact
   optional variable field at the corresponding coordinates, without requiring
   uniform parameter values or in-range coordinates. *)
let collapse_environment (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat)
  (name: Template.identifier)
  : Lemma
    (requires CellSemantics.source_for input.parameters p == Some (OnAxis side))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      VariableSemantics.field_for next
        (OwnershipProofs.corresponding_row input next row)
        (OwnershipProofs.corresponding_column input next column) name ==
      VariableSemantics.field_for input row column name)) =
  collapse_metadata input p side allocation counter;
  (* For this axis, collapse preserves variable values at every index if the
     axis was active in the original layout. *)
  let for_axis axis =
    FStar.Classical.forall_intro
      (collapse_namespace_projection input p side allocation counter axis)
  in
  FStar.Classical.forall_intro for_axis;
  FStar.Classical.forall_intro (collapse_coordinate_frame input p side allocation counter row column);
  let next, _ = Input.collapse input p allocation counter in
  environment_frame input next row column
    (OwnershipProofs.corresponding_row input next row)
    (OwnershipProofs.corresponding_column input next column) name

(* Semantically equivalent resolved values give identical effective parameter
   meanings when every identifier resolves to exactly the same field. *)
let parameter_frame (before: layout) (after: layout)
  (row: nat) (column: nat) (next_row: nat) (next_column: nat) (p: common_parameter)
  : Lemma
    (requires
      CellSemantics.equivalent p
        (CellSemantics.resolve after next_row next_column p)
        (CellSemantics.resolve before row column p) /\
      (forall name.
        VariableSemantics.field_for after next_row next_column name ==
          VariableSemantics.field_for before row column name))
    (ensures
      CellMeaning.parameter after next_row next_column p ==
        CellMeaning.parameter before row column p) =
  CellMeaningProofs.equivalent_values
    (VariableSemantics.field_for after next_row next_column)
    (VariableSemantics.field_for before row column) p
    (CellSemantics.resolve after next_row next_column p)
    (CellSemantics.resolve before row column p)

(* Equivalent resolution of every common parameter and pointwise equal
   variable environments give identical ordered parameter-meaning pairs for
   the supplied parameter list. *)
let rec parameters_frame (before: layout) (after: layout)
  (row: nat) (column: nat) (next_row: nat) (next_column: nat)
  (parameters: list common_parameter)
  : Lemma
    (requires
      (forall p.
        CellSemantics.equivalent p
          (CellSemantics.resolve after next_row next_column p)
          (CellSemantics.resolve before row column p)) /\
      (forall name.
        VariableSemantics.field_for after next_row next_column name ==
          VariableSemantics.field_for before row column name))
    (ensures
      Template.map_g (fun p -> (p, CellMeaning.parameter after next_row next_column p)) parameters ==
        Template.map_g (fun p -> (p, CellMeaning.parameter before row column p)) parameters) =
  match parameters with
  | [] -> ()
  | p :: rest ->
    parameter_frame before after row column next_row next_column p;
    parameters_frame before after row column next_row next_column rest

(* Equivalent common-parameter values and pointwise equal variable
   environments give identical effective cell meanings when output format,
   judging, and worker count also agree exactly. *)
let cell_frame (before: layout) (after: layout)
  (row: nat) (column: nat) (next_row: nat) (next_column: nat)
  : Lemma
    (requires
      before.output_format == after.output_format /\
      before.judging == after.judging /\
      before.parallel_workers == after.parallel_workers /\
      (forall p.
        CellSemantics.equivalent p
          (CellSemantics.resolve after next_row next_column p)
          (CellSemantics.resolve before row column p)) /\
      (forall name.
        VariableSemantics.field_for after next_row next_column name ==
          VariableSemantics.field_for before row column name))
    (ensures CellMeaning.cell after next_row next_column == CellMeaning.cell before row column) =
  parameters_frame before after row column next_row next_column CellMeaning.all_parameters;
  assert_norm (
    (CellMeaning.cell after next_row next_column).cell_parameters ==
      Template.map_g (fun p -> (p, CellMeaning.parameter after next_row next_column p))
        CellMeaning.all_parameters);
  assert_norm (
    (CellMeaning.cell before row column).cell_parameters ==
      Template.map_g (fun p -> (p, CellMeaning.parameter before row column p))
        CellMeaning.all_parameters)

(* Taking ownership of a common value preserves each common parameter up to
   semantic equivalence at the same coordinates when the target index exists. *)
let own_equivalent_parameter
  (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat) (q: common_parameter)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side))
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      CellSemantics.equivalent q
        (CellSemantics.resolve next row column q) (CellSemantics.resolve input row column q))) =
  OwnershipProofs.own_preserves_every_parameter input p side v allocation counter q row column;
  match CellSemantics.resolve input row column q with
  | None
  | Some _ -> ()

(* Taking ownership of a common value preserves both the effective cell
   meaning and its template-validity-gated observable meaning at the same
   coordinates, provided the target-axis index exists. *)
let own_cell (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side))
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      CellMeaning.cell next row column == CellMeaning.cell input row column /\
      CellMeaning.observable_cell next row column == CellMeaning.observable_cell input row column)) =
  OwnershipProofs.entry_exists
    (Parameters.entries input side) (if side = Rows then row else column);
  assert (Parameters.entries input side <> []);
  OwnershipProofs.own_preserves_opposite_axis_and_metadata input p side allocation counter;
  FStar.Classical.forall_intro (own_environment input p side v allocation counter row column);
  FStar.Classical.forall_intro
    (own_equivalent_parameter input p side v allocation counter row column);
  let next, _ = Input.own input p side allocation counter in
  cell_frame input next row column row column

(* Collapsing an axis-owned parameter preserves every common parameter up to
   semantic equivalence at corresponding coordinates when all owner-axis
   values are equivalent to v and the original owner index exists. *)
let collapse_equivalent_parameter
  (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat) (q: common_parameter)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      OwnershipProofs.complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      CellSemantics.equivalent q
        (CellSemantics.resolve next
          (OwnershipProofs.corresponding_row input next row)
          (OwnershipProofs.corresponding_column input next column) q)
        (CellSemantics.resolve input row column q))) =
  OwnershipProofs.collapse_preserves_every_parameter input p side v allocation counter q row column

(* Collapsing an axis-owned parameter preserves effective and
   template-validity-gated observable cell meanings at corresponding
   coordinates if its cases are uniformly equivalent to v and its index exists. *)
let collapse_cell (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      OwnershipProofs.complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      CellMeaning.cell next
        (OwnershipProofs.corresponding_row input next row)
        (OwnershipProofs.corresponding_column input next column) ==
      CellMeaning.cell input row column /\
      CellMeaning.observable_cell next
        (OwnershipProofs.corresponding_row input next row)
        (OwnershipProofs.corresponding_column input next column) ==
      CellMeaning.observable_cell input row column)) =
  collapse_metadata input p side allocation counter;
  FStar.Classical.forall_intro (collapse_environment input p side allocation counter row column);
  FStar.Classical.forall_intro
    (collapse_equivalent_parameter input p side v allocation counter row column);
  let next, _ = Input.collapse input p allocation counter in
  cell_frame input next row column
    (OwnershipProofs.corresponding_row input next row)
    (OwnershipProofs.corresponding_column input next column)

(* MoveToAxis preserves effective and template-validity-gated observable cell
   meanings at the same coordinates when the parameter is common and the
   target index exists; an inactive target axis is left unchanged. *)
let move_to_axis_cell (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (prefix: string) (counter: nat) (row: nat) (column: nat)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side))
    (ensures (
      let next, _ = Input.reduce input (MoveToAxis p side) prefix counter in
      CellMeaning.cell next row column == CellMeaning.cell input row column /\
      CellMeaning.observable_cell next row column == CellMeaning.observable_cell input row column)) =
  OwnershipProofs.source_projection input.parameters p;
  if Parameters.is_case_axis input side then
    own_cell input p side v (prefix, Input.case_ids input) counter row column
  else
    ()

(* MoveToCommon preserves effective and template-validity-gated observable
   cell meanings at corresponding coordinates when the parameter is axis-owned,
   its cases are uniformly equivalent to v, and the original owner index exists. *)
let move_to_common_cell (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  (prefix: string) (counter: nat) (row: nat) (column: nat)
  : Lemma
    (requires
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      OwnershipProofs.complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side))
    (ensures (
      let next, _ = Input.reduce input (MoveToCommon p) prefix counter in
      CellMeaning.cell next
        (OwnershipProofs.corresponding_row input next row)
        (OwnershipProofs.corresponding_column input next column) ==
      CellMeaning.cell input row column /\
      CellMeaning.observable_cell next
        (OwnershipProofs.corresponding_row input next row)
        (OwnershipProofs.corresponding_column input next column) ==
      CellMeaning.observable_cell input row column)) =
  collapse_cell input p side v (prefix, Input.case_ids input) counter row column
