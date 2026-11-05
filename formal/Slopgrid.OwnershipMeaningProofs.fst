module Slopgrid.OwnershipMeaningProofs

(* Keeping the same stored prompt is not enough: it may use variables from
   either axis. These proofs also keep each referenced field so ownership
   moves preserve expanded inputs and judge text. The result is a pure cell
   description, not a claim about browser state or inference execution.
   PRODUCT.md 3.1.10 and 3.3.9. *)

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

(* Variable names are looked up using the first case's slot layout on an
   axis. This helper relates that lookup to the ordinary case-value reader.
   It does not claim that all later cases contain the same fields. A missing
   first case or variable value gives no slots. *)
let first_variable_projection (input: layout) (side: axis)
  : Lemma (
    VariableSemantics.fields input side ==
      variable_fields (CellSemantics.axis_value input side 0 PVariable)) =
  match CellSemantics.axis_entries input side with
  | [] -> ()
  | _ :: _ -> ()

(* After finding a variable's axis and slot, read its text and images from
   the case at this cell's row or column. A missing case, missing variable
   value, deleted slot or out-of-range slot gives no field. *)
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

(* Preserve the axes in case mode, their variable names, and every indexed
   variable value on those axes. These are the facts needed to keep a token
   bound to the same field after moving an unrelated setting. *)
let namespace_frame (before: layout) (after: layout) : prop =
  before.case_ownership == after.case_ownership /\
  before.variable_names == after.variable_names /\
  (forall side index.
    Parameters.is_case_axis before side ==>
    CellSemantics.axis_value after side index PVariable ==
      CellSemantics.axis_value before side index PVariable)

(* A cell must keep its position on each active case axis to read the same
   variables. An ordinary axis can become one neutral position without
   changing any variable lookup. *)
let coordinate_frame
  (before: layout) (row: nat) (column: nat) (next_row: nat) (next_column: nat) : prop =
  forall side.
    Parameters.is_case_axis before side ==>
    (if side = Rows then next_row else next_column) == (if side = Rows then row else column)

(* Searching the same slots with the same variable-name metadata finds the
   same slot. This includes numbered defaults, whose names depend on the
   axis and slot index rather than a stored custom name. *)
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

(* If an active axis keeps its names and variable values, looking up a token
   on that axis still finds the same slot. The proof needs the first case's
   fields because they determine which slots the name search visits. *)
let slot_on_frame (before: layout) (after: layout) (side: axis) (name: string)
  : Lemma
    (requires namespace_frame before after /\ Parameters.is_case_axis before side)
    (ensures
      VariableSemantics.slot_on after side name == VariableSemantics.slot_on before side name) =
  first_variable_projection before side;
  first_variable_projection after side;
  slot_in_frame before after side (VariableSemantics.fields before side) 0 name

(* Keeping case ownership, names and active-axis fields leaves token lookup
   unchanged across the whole grid. Case ownership also records which axis
   is searched first, so this covers that order rather than assuming names
   are unique. Unknown tokens remain unknown. *)
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

(* A found token always belongs to an axis in case mode. This lets the
   environment proof ignore coordinate changes on ordinary axes, which
   cannot supply a variable even if they contain stray stored fields. *)
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

(* A token still reads the same optional text-and-image field when its names
   and active-axis fields stay unchanged and the cell keeps its active-axis
   coordinates. Coordinates on ordinary axes may differ. This includes
   unresolved names, not just successful substitutions. *)
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

(* Copying a shared setting into a nonempty table does not edit numbered or
   custom variable fields on either axis. Every indexed variable value stays
   the same, including missing values outside the table. *)
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

(* Moving a shared setting into existing cases keeps every token's field
   at the same cell coordinates. This matters even for a row-owned prompt
   that reads COLUMN variables, or a column-owned prompt that reads ROW
   variables. Stored-input equality alone would not establish this. *)
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
  (* Give the environment proof unchanged variable values for every axis
     and index, not just the variables used by one selected template. *)
  let for_axis axis =
    FStar.Classical.forall_intro (own_variable_projection input p side v allocation counter axis)
  in
  FStar.Classical.forall_intro for_axis;
  let next, _ = Input.own input p side allocation counter in
  environment_frame input next row column row column name

(* Collapse retains the first case's value only if it is present and no case
   differs. Otherwise it restores the normal common default. Moving the
   setting to the end of source_order changes its control order, not its value.
   This helper stops before neutralizing an axis. PRODUCT.md 3.1.10. *)
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

(* Returning an axis-owned setting to common first chooses its shared value
   and removes that field from the cases, then checks whether the dimension
   needs one neutral position. This helper matches that sequence exactly,
   including case-ID allocation, so later proofs can treat the steps apart. *)
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

(* Returning a setting to common does not change which axes are case tables
   or rename their variables. It also leaves format, judging and worker count
   alone. This supplies the non-value parts of the cell-equality proof. *)
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

(* Returning a setting to common never shrinks an active case table, even
   when it removes that table's last non-variable setting. Its variable values
   stay at the same indices. This keeps equal or blank cases distinct as
   required by PRODUCT.md 3.1.10. *)
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

(* Variable values stay unchanged on every axis that was in case mode before
   collapse. This implication packages that fact for token lookup. It makes
   no claim about stray fields stored on ordinary axes. *)
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

(* Collapse leaves active case tables the same length, so their corresponding
   row or column coordinates do not move. Only an ownerless ordinary dimension
   can redirect a former coordinate to the neutral position. *)
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

(* Returning a setting to common keeps every token's optional field at the
   corresponding cell. This holds even when that setting's values differ or
   the supplied coordinates are out of range. It preserves variable lookup,
   not the moved setting's value in those cases. *)
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
  (* Supply unchanged fields for every originally active axis. The separate
     coordinate fact below keeps each lookup on its original case. *)
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

(* To keep an expanded setting unchanged, preserve both its stored value up
   to empty-image normalization and every token's optional field. This covers
   prompt messages and judge templates. Preserving only the source template
   would miss changes in referenced text or images. PRODUCT.md 3.3.9. *)
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

(* Apply the preceding argument to each requested setting in the supplied
   order. The result keeps that exact ordered list of expanded values.
   It does not compare the layout's source_order or case-header metadata. *)
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

(* The pure cell description stays the same when stored settings are
   equivalent, token lookups match, and format, judging and worker count agree.
   Its setting list has a fixed order, independent of editor bookkeeping.
   This says nothing about executing a request or validating the whole form. *)
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

(* Copying a shared setting into existing cases keeps the stored value chosen
   for each parameter at this cell. Empty image lists count as no images.
   The destination case must exist. The following proof also checks what
   happens when these stored templates read variable fields. *)
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

(* Copying a shared setting into existing cases preserves the expanded
   generator input, judge templates and other settings at the same cell.
   The target index must already exist. The optional cell result also keeps
   the same template-validity decision, not all form validation or inference
   behavior. PRODUCT.md 3.1.10 and 3.3.9. *)
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

(* Every owning case must contain the same complete value, and the old cell
   must have an owning case. Returning the setting to a shared control then
   keeps each chosen parameter value at the corresponding cell. Empty image
   lists may differ. The expanded-cell proof checks variable fields next. *)
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

(* Returning equal, complete case values to common preserves the expanded
   cell description and its template-validity decision. The old owner index
   must exist. An unchanged dimension keeps its coordinate, while a reduced
   ordinary dimension uses zero. Differing or missing case values do not
   satisfy this preservation law. PRODUCT.md 3.1.10 and 3.3.9. *)
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

(* MoveToAxis keeps the expanded cell description and its template-validity
   decision when the setting was shared and the target position exists.
   A destination outside case mode is a no-op. This proves the pure edit's
   behavior, not the browser's destination chooser. PRODUCT.md 3.1.10. *)
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

(* MoveToCommon keeps the expanded cell description and its template-validity
   decision at corresponding coordinates when every owning case contains the
   same complete value and the old owner position exists. The law covers
   retaining equal values, not confirmation or resetting differing ones.
   PRODUCT.md 3.1.10 and 3.3.9. *)
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
