module Slopgrid.OwnershipProofs

(* These proofs follow stored settings through moves between common controls
   and row or column cases. A resolved input here is still a template. The
   expanded prompt also depends on its variable fields. The next ownership
   proof module handles that extra step. PRODUCT.md 3.1.10 and 3.3.9. *)

module Parameters = Slopgrid.Parameters
module Input = Slopgrid.Input
module CellSemantics = Slopgrid.CellSemantics
module List = FStar.List.Tot.Base
open Slopgrid.Domain

#set-options "--fuel 4 --ifuel 1"

(* The edit helpers and the cell model read the same source tag for a setting.
   This connection lets the proofs below reason about shared and case-owned
   values while using the actual edit functions. *)
let source_projection (sources: parameter_sources) (p: common_parameter)
  : Lemma (Parameters.get_source sources p == CellSemantics.source_for sources p) =
  match p with
  | PInput
  | PModel
  | PEffort
  | PSize
  | PAspectRatio
  | PQuality
  | PBackground
  | PJudgeModel
  | PJudgeEffort
  | PJudgeCriteria
  | PJudgeSystem -> ()

(* Both readers return the same stored value from a row or column case,
   including a missing field. Ownership edits use the parameter reader. The
   cell model uses the other reader, so the proofs need this agreement. *)
let case_projection (values: case_values) (p: parameter)
  : Lemma (Parameters.get_case_value values p == CellSemantics.case_value values p) =
  match p with
  | PInput
  | PModel
  | PEffort
  | PSize
  | PAspectRatio
  | PQuality
  | PBackground
  | PJudgeModel
  | PJudgeEffort
  | PJudgeCriteria
  | PJudgeSystem
  | PVariable -> ()

(* Cell coordinates use list positions to select cases. The two readers agree
   on the selected case and both return absence beyond the list, letting the
   later proofs use either reader without assuming a valid coordinate. *)
let rec entry_projection (values: list case_record) (index: nat)
  : Lemma (Parameters.at values index == CellSemantics.entry_at values index) =
  match values with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then
      ()
    else
      entry_projection rest (index - 1)

(* Choosing a case and then reading its setting gives the cell model's value
   for that axis position. Missing cases and missing fields stay absent.
   Neither reader silently supplies a default. *)
let axis_projection (input: layout) (side: axis) (index: nat) (p: parameter)
  : Lemma (
    (match Parameters.at (Parameters.entries input side) index with
     | None -> None
     | Some entry -> Parameters.get_case_value entry.values p) ==
    CellSemantics.axis_value input side index p) =
  entry_projection (Parameters.entries input side) index;
  match Parameters.at (Parameters.entries input side) index with
  | None -> ()
  | Some entry -> case_projection entry.values p

(* Shared settings ignore both coordinates. Row-owned settings use the row,
   and column-owned settings use the column. The optional side argument only
   matters for variable fields, which are excluded here. Both readers choose
   the same stored value before expansion. PRODUCT.md 3.3.9. *)
let parameter_value_refines_resolve (input: layout) (p: common_parameter)
  (row: nat) (column: nat) (side: option axis)
  : Lemma (
    Parameters.parameter_value input p row column side == CellSemantics.resolve input row column p) =
  source_projection input.parameters p;
  match Parameters.get_source input.parameters p with
  | None
  | Some (Common _) -> ()
  | Some (OnAxis owner) ->
    axis_projection input owner (if owner = Rows then row else column) p;
    match owner with
    | Rows
    | Columns -> ()

(* A present source tag chooses exactly one of common, rows, or columns.
   This proves exclusivity, not that an optional setting has a source or that
   every owning case contains its value. PRODUCT.md 3.1.10. *)
let exclusive_source (input: layout) (p: common_parameter)
  : Lemma (
    (forall (v: value_for p) (side: axis).
      CellSemantics.source_for input.parameters p == Some (Common v) ==>
      CellSemantics.source_for input.parameters p <> Some (OnAxis side)) /\
    (CellSemantics.source_for input.parameters p == Some (OnAxis Rows) ==>
      CellSemantics.source_for input.parameters p <> Some (OnAxis Columns))) =
  ()

(* Replacing either table of cases cannot change a shared stored setting.
   A shared prompt can still expand differently if those cases supply its
   variables. This law stops before template expansion. *)
let common_ignores_all_cases (input: layout) (p: common_parameter) (v: value_for p)
  (rows: list case_record) (columns: list case_record) (row: nat) (column: nat)
  : Lemma
    (requires (CellSemantics.source_for input.parameters p == Some (Common v)))
    (ensures (
      CellSemantics.resolve {
        input with
        rows = rows;
        columns = columns
      } row column p ==
      CellSemantics.resolve input row column p)) =
  ()

(* A row-owned setting reads the same stored value across that row, even
   after replacing the columns. A row-owned prompt may reference COLUMN
   variables, so this does not make its expanded input independent of columns.
   PRODUCT.md 3.3.9. *)
let row_owner_ignores_columns (input: layout) (p: common_parameter)
  (columns: list case_record) (row: nat) (column: nat) (other_column: nat)
  : Lemma
    (requires (CellSemantics.source_for input.parameters p == Some (OnAxis Rows)))
    (ensures (
      CellSemantics.resolve {input with columns = columns} row other_column p ==
        CellSemantics.resolve input row column p)) =
  ()

(* A column-owned setting reads the same stored value down that column, even
   after replacing the rows. ROW references in a column-owned prompt can still
   change its expanded text or images. PRODUCT.md 3.3.9. *)
let column_owner_ignores_rows (input: layout) (p: common_parameter)
  (rows: list case_record) (row: nat) (column: nat) (other_row: nat)
  : Lemma
    (requires (CellSemantics.source_for input.parameters p == Some (OnAxis Columns)))
    (ensures (
      CellSemantics.resolve {input with rows = rows} other_row column p ==
        CellSemantics.resolve input row column p)) =
  ()

(* Copying a setting into every existing case changes only that setting's
   stored field. This indexed fact also covers missing coordinates, so moving
   ownership cannot manufacture a case through field lookup. *)
let rec mapped_set_value (values: list case_record) (v: value) (q: parameter) (index: nat)
  : Lemma (
    (match Parameters.at
      (List.map (fun entry -> {entry with values = Parameters.set_case_value entry.values v}) values)
      index with
     | None -> None
     | Some entry -> Parameters.get_case_value entry.values q) ==
    (match Parameters.at values index with
     | None -> None
     | Some entry ->
       if value_parameter v = q then Some v else Parameters.get_case_value entry.values q)) =
  match values with
  | [] -> ()
  | entry :: rest ->
    if index = 0 then
      Parameters.get_set_case_value entry.values v q
    else
      mapped_set_value rest v q (index - 1)

(* Stripping a returned-to-common setting from every case leaves each other
   stored field untouched. The indexed lookup remains absent outside the
   table. Later collapse proofs use this for unrelated settings. *)
let rec mapped_remove_value
  (values: list case_record) (p: parameter) (q: parameter) (index: nat)
  : Lemma (
    (match Parameters.at
      (List.map (fun entry -> {entry with values = Parameters.remove_case_value entry.values p}) values)
      index with
     | None -> None
     | Some entry -> Parameters.get_case_value entry.values q) ==
    (match Parameters.at values index with
     | None -> None
     | Some entry ->
       if p = q then None else Parameters.get_case_value entry.values q)) =
  match values with
  | [] -> ()
  | entry :: rest ->
    if index = 0 then
      Parameters.get_remove_case_value entry.values p q
    else
      mapped_remove_value rest p q (index - 1)

(* A valid row or column position selects an existing case. The copy proofs
   use this bound to avoid claiming that ownership preserves a common value
   at a destination position that never existed. *)
let rec entry_exists (values: list case_record) (index: nat)
  : Lemma
    (requires (index < List.length values))
    (ensures (Parameters.at values index <> None)) =
  match values with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then
      ()
    else
      entry_exists rest (index - 1)

#push-options "--fuel 8 --ifuel 2"
(* Moving a shared setting into a nonempty destination copies it into every
   existing case and changes its source tag. It creates no case IDs and does
   not advance the allocation counter. The destination already exists, as
   required for complete inputs and rubrics. PRODUCT.md 3.1.10. *)
let own_existing_cases (input: layout) (p: common_parameter) (side: axis)
  (v: value_for p) (allocation: string & list string) (counter: nat)
  : Lemma
    (requires (
      Parameters.get_source input.parameters p == Some (Common v) /\
      Parameters.entries input side <> []))
    (ensures (
      Input.own input p side allocation counter ==
        (Input.set_entries (Input.set_source input p (OnAxis side)) side
          (List.map
            (fun entry -> {entry with values = Parameters.set_case_value entry.values v})
            (Parameters.entries input side)), counter))) =
  match Parameters.get_source input.parameters p with
  | Some (Common actual) ->
    assert (actual == v);
    match Input.entries input side with
    | [] -> ()
    | _ :: _ -> ()
  | _ -> ()
#pop-options

(* Copying a shared setting into cases keeps each chosen parameter value at
   this cell. For example, moving the prompt must not change its model.
   The destination case must exist. Variable expansion comes in a later
   proof. PRODUCT.md 3.1.10. *)
let own_preserves_every_parameter (input: layout) (p: common_parameter) (side: axis)
  (v: value_for p) (allocation: string & list string) (counter: nat)
  (q: common_parameter) (row: nat) (column: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side)))
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      CellSemantics.resolve next row column q == CellSemantics.resolve input row column q)) =
  source_projection input.parameters p;
  source_projection input.parameters q;
  let index = if side = Rows then row else column in
  entry_exists (Parameters.entries input side) index;
  assert (Parameters.entries input side <> []);
  own_existing_cases input p side v allocation counter;
  Parameters.get_set_source input.parameters p (OnAxis side) q;
  mapped_set_value (Parameters.entries input side) v q (if side = Rows then row else column);
  parameter_value_refines_resolve input q row column None;
  let next, _ = Input.own input p side allocation counter in
  assert (
    next == Input.set_entries (Input.set_source input p (OnAxis side)) side
      (List.map
        (fun entry -> {entry with values = Parameters.set_case_value entry.values v})
        (Parameters.entries input side)));
  source_projection next.parameters q;
  parameter_value_refines_resolve next q row column None;
  axis_projection next side index q;
  axis_projection input side index q;
  match side with
  | Rows
  | Columns ->
    if p = q then
      ()
    else
      match Parameters.get_source input.parameters q with
      | None
      | Some (Common _) -> ()
      | Some (OnAxis owner) ->
        match owner with
        | Rows
        | Columns -> ()

(* Moving one setting does not edit the opposite table or change which axes
   are case tables. Format, variable names, judging and worker count also stay
   as they were. This is not a claim about every layout field. *)
let own_preserves_opposite_axis_and_metadata (input: layout) (p: common_parameter)
  (side: axis) (allocation: string & list string) (counter: nat)
  : Lemma (
    let next, _ = Input.own input p side allocation counter in
    Parameters.entries next (Input.other_side side) ==
      Parameters.entries input (Input.other_side side) /\
    next.output_format == input.output_format /\
    next.case_ownership == input.case_ownership /\
    next.variable_names == input.variable_names /\
    next.judging == input.judging /\
    next.parallel_workers == input.parallel_workers) =
  match Parameters.get_source input.parameters p with
  | Some (OnAxis _) -> ()
  | _ ->
    match side with
    | Rows
    | Columns -> ()

(* The MoveToAxis action keeps stored settings unchanged at existing
   destination positions when the moved value was shared. If the destination
   is not in case mode, the reducer does nothing. This covers the pure action,
   not destination-menu behavior. PRODUCT.md 3.1.10. *)
let move_to_axis_preserves_every_parameter (input: layout) (p: common_parameter)
  (side: axis) (v: value_for p) (prefix: string) (counter: nat)
  (q: common_parameter) (row: nat) (column: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side)))
    (ensures (
      let next, _ = Input.reduce input (MoveToAxis p side) prefix counter in
      CellSemantics.resolve next row column q == CellSemantics.resolve input row column q)) =
  source_projection input.parameters p;
  if Parameters.is_case_axis input side then
    own_preserves_every_parameter input p side v (prefix, Input.case_ids input) counter q row column
  else
    ()

(* Collapse compares complete messages with absent and empty image lists
   treated alike. The edit helper and cell model make that same normalization
   without changing message roles, text, or order. PRODUCT.md 3.3.9. *)
let rec message_normalization_refines (messages: list message)
  : Lemma (Input.normalize_messages messages == CellSemantics.normalize_messages messages) =
  match messages with
  | [] -> ()
  | message :: rest ->
    message_normalization_refines rest;
    match message.images with
    | None -> ()
    | Some images ->
      match images with
      | []
      | _ :: _ -> ()

(* Variable fields use the same empty-image normalization in both readers.
   Deleted slots stay absent, and field text stays literal. This helper
   connects their equality checks. It does not perform variable expansion. *)
let rec field_normalization_refines (fields: list (option variable_field))
  : Lemma (Input.normalize_fields fields == CellSemantics.normalize_fields fields) =
  match fields with
  | [] -> ()
  | field :: rest ->
    field_normalization_refines rest;
    match field with
    | None -> ()
    | Some field ->
      match field.field_images with
      | None -> ()
      | Some images ->
        match images with
        | []
        | _ :: _ -> ()

(* The edit code compares values exactly as the cell model does, after
   normalizing empty image lists in messages and variable fields.
   This allows collapse to retain identical inputs despite that storage
   difference. PRODUCT.md 3.3.9. *)
let comparison_refines_canonical_value (v: value)
  : Lemma (Input.comparison_value v == CellSemantics.canonical_value v) =
  match v with
  | InputValue messages -> message_normalization_refines messages
  | VariableValue fields -> field_normalization_refines fields
  | _ -> ()

(* The collapse equality check agrees with equality of the stored setting's
   meaning. Missing and present values differ. Two present values compare
   after empty-image normalization. This is not an order-metadata comparison. *)
let optional_equality_refines_equivalence (p: parameter)
  (left: option (value_for p)) (right: option (value_for p))
  : Lemma (Input.optional_values_equal p left right == CellSemantics.equivalent p left right) =
  match left, right with
  | Some left, Some right ->
    comparison_refines_canonical_value left;
    comparison_refines_canonical_value right
  | _ -> ()

(* Every case must contain a value, and each must equal the supplied value
   after empty-image normalization. Equal missing fields are not enough for
   the preservation laws below. The empty list satisfies this scan, so those
   laws separately require an existing owner position. *)
let rec complete_uniform (values: list case_record) (p: common_parameter) (v: value_for p)
  : Tot bool =
  match values with
  | [] -> true
  | entry :: rest ->
    CellSemantics.equivalent p (CellSemantics.case_value entry.values p) (Some v) &&
    complete_uniform rest p v

(* If every case contains the same value as a present reference, the edit
   scan finds no differing case. This helper connects the complete-value
   premise to the comparison that decides how collapse chooses a common value. *)
let rec uniform_comparison (values: list case_record) (p: common_parameter)
  (v: value_for p) (reference: option (value_for p))
  : Lemma
    (requires (complete_uniform values p v /\ CellSemantics.equivalent p reference (Some v)))
    (ensures (not (Input.differs_from p reference values))) =
  match values with
  | [] -> ()
  | entry :: rest ->
    case_projection entry.values p;
    optional_equality_refines_equivalence p (Parameters.get_case_value entry.values p) reference;
    uniform_comparison rest p v reference

#push-options "--fuel 8 --ifuel 2"
(* Equal, present values on the owning axis do not trigger the differing-value
   branch of collapse. An empty table also reports no differences, but that
   alone cannot justify preserving a value because there is no case to read. *)
let uniform_not_differing (input: layout) (p: common_parameter) (side: axis) (v: value_for p)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (Parameters.entries input side) p v))
    (ensures (not (Input.differing input p))) =
  source_projection input.parameters p;
  match Parameters.entries input side with
  | [] -> ()
  | first :: rest ->
    case_projection first.values p;
    assert (Input.entries input side == first :: rest);
    uniform_comparison (first :: rest) p v (Parameters.get_case_value first.values p)
#pop-options

(* In a table where every case contains the same setting, a valid coordinate
   reads that value up to empty-image normalization. Collapse uses this to
   relate the user's original case to the value returned to common. *)
let rec uniform_at (values: list case_record) (p: common_parameter) (v: value_for p) (index: nat)
  : Lemma
    (requires (complete_uniform values p v /\ index < List.length values))
    (ensures (
      CellSemantics.equivalent p
        (match Parameters.at values index with
         | None -> None
         | Some entry -> Parameters.get_case_value entry.values p)
        (Some v))) =
  match values with
  | [] -> ()
  | entry :: rest ->
    if index = 0 then
      case_projection entry.values p
    else
      uniform_at rest p v (index - 1)

(* Replacing an ownerless ordinary dimension with a neutral position changes
   neither parameter sources nor the opposite table. It also leaves format,
   case ownership, variable names, judging and worker count alone. This
   supports the single-position rule in PRODUCT.md 3.1.10. *)
let neutral_dimension_preserves_sources (input: layout) (side: axis)
  (allocation: string & list string) (counter: nat)
  : Lemma (
    let next, _ = Input.neutral_dimension input side allocation counter in
    next.parameters == input.parameters /\
    Parameters.entries next (Input.other_side side) ==
      Parameters.entries input (Input.other_side side) /\
    next.output_format == input.output_format /\
    next.case_ownership == input.case_ownership /\
    next.variable_names == input.variable_names /\
    next.judging == input.judging /\
    next.parallel_workers == input.parallel_workers) =
  match side with
  | Rows
  | Columns -> ()

(* Returning a setting to common retains its value when every owning case
   contains the same complete value. The original owner coordinate must exist.
   The new common value can be read at any coordinates. Equality allows absent
   versus empty image lists. PRODUCT.md 3.1.10 and 3.3.9. *)
let collapse_retains_complete_uniform_value (input: layout) (p: common_parameter)
  (side: axis) (v: value_for p) (allocation: string & list string) (counter: nat)
  (row: nat) (column: nat) (next_row: nat) (next_column: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side)))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      CellSemantics.equivalent p
        (CellSemantics.resolve next next_row next_column p)
        (CellSemantics.resolve input row column p))) =
  source_projection input.parameters p;
  uniform_not_differing input p side v;
  uniform_at (Parameters.entries input side) p v (if side = Rows then row else column);
  match Parameters.entries input side with
  | [] -> ()
  | first :: rest ->
    case_projection first.values p;
    match Parameters.get_case_value first.values p with
    | None -> ()
    | Some u ->
      let base = Input.set_source input p (Common u) in
      Parameters.get_set_source input.parameters p (Common u) p;
      let base = {
        base with
        parameters = {
          base.parameters with
          source_order = List.append
            (List.filter (fun (key: common_parameter) -> key <> p) base.parameters.source_order)
            [p]
        }
      } in
      let stripped =
        Input.set_entries base side
          (List.map
            (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
            (Parameters.entries input side))
      in
      neutral_dimension_preserves_sources stripped side allocation counter;
      let next, _ = Input.collapse input p allocation counter in
      source_projection next.parameters p;
      axis_projection input side (if side = Rows then row else column) p;
      match side with
      | Rows
      | Columns -> ()

(* MoveToCommon retains the setting when all its owning cases contain the
   same complete value and the original owner position exists. The returned
   shared value no longer depends on coordinates. This covers the non-lossy
   branch, not confirmation of differing values. PRODUCT.md 3.1.10. *)
let move_to_common_retains_complete_uniform_value (input: layout) (p: common_parameter)
  (side: axis) (v: value_for p) (prefix: string) (counter: nat)
  (row: nat) (column: nat) (next_row: nat) (next_column: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side)))
    (ensures (
      let next, _ = Input.reduce input (MoveToCommon p) prefix counter in
      CellSemantics.equivalent p
        (CellSemantics.resolve next next_row next_column p)
        (CellSemantics.resolve input row column p))) =
  collapse_retains_complete_uniform_value input p side v (prefix, Input.case_ids input) counter
    row column next_row next_column

(* Adding or removing one field in each case does not change the number of
   cases. This general list fact lets the collapse proofs keep coordinates
   when the edit leaves a dimension's positions in place. *)
let rec map_length #a #b (f: a -> Tot b) (values: list a)
  : Lemma (List.length (List.map f values) == List.length values) =
  match values with
  | [] -> ()
  | _ :: rest -> map_length f rest

(* A surviving dimension keeps its coordinate. If removing its last setting
   replaces an ordinary dimension with one neutral position, use position
   zero instead. These helpers relate cells before and after that shape
   change. They do not search by case ID. PRODUCT.md 3.1.10. *)
let corresponding_row (before: layout) (after: layout) (row: nat) : Tot nat =
  if List.length before.rows = List.length after.rows then row else 0

let corresponding_column (before: layout) (after: layout) (column: nat) : Tot nat =
  if List.length before.columns = List.length after.columns then column else 0

(* Returning one setting to a shared control leaves the other parameter
   values unchanged at the corresponding cell. Keep a coordinate when its
   dimension length stays the same. Otherwise use the neutral position.
   This still holds when the returned setting loses differing values. *)
let collapse_preserves_other_parameter (input: layout) (p: common_parameter)
  (side: axis) (allocation: string & list string) (counter: nat) (q: common_parameter)
  (row: nat) (column: nat)
  : Lemma
    (requires (CellSemantics.source_for input.parameters p == Some (OnAxis side) /\ p <> q))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      CellSemantics.resolve next
        (corresponding_row input next row) (corresponding_column input next column) q ==
      CellSemantics.resolve input row column q)) =
  source_projection input.parameters p;
  source_projection input.parameters q;
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
  Parameters.get_set_source input.parameters p (Common value) q;
  let base = {
    base with
    parameters = {
      base.parameters with
      source_order = List.append
        (List.filter (fun (key: common_parameter) -> key <> p) base.parameters.source_order)
        [p]
    }
  } in
  let stripped =
    Input.set_entries base side
      (List.map
        (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
        (Parameters.entries input side))
  in
  assert (Parameters.get_source stripped.parameters q == Parameters.get_source input.parameters q);
  neutral_dimension_preserves_sources stripped side allocation counter;
  let next, _ = Input.collapse input p allocation counter in
  assert (
    Input.collapse input p allocation counter ==
      Input.neutral_dimension stripped side allocation counter);
  source_projection next.parameters q;
  mapped_remove_value (Parameters.entries input side) p q (if side = Rows then row else column);
  map_length (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
    (Parameters.entries input side);
  parameter_value_refines_resolve input q row column None;
  parameter_value_refines_resolve next q
    (corresponding_row input next row) (corresponding_column input next column) None;
  match Parameters.get_source input.parameters q with
  | None
  | Some (Common _) -> ()
  | Some (OnAxis owner) ->
    if owner = side then (
      Parameters.axis_owner_prevents_neutralization stripped q side;
      assert (next == stripped);
      axis_projection next side (if side = Rows then row else column) q;
      match side with
      | Rows
      | Columns -> ()
    ) else (
      match side, owner with
      | Rows, Rows
      | Rows, Columns
      | Columns, Rows
      | Columns, Columns -> ()
    )

(* If all owning cases contain the same complete value and this cell's owning
   case exists, returning to a shared control keeps every chosen parameter
   value. An empty image list can become an absent list. No attachment is
   lost. PRODUCT.md 3.1.10 and 3.3.9. *)
let collapse_preserves_every_parameter (input: layout) (p: common_parameter)
  (side: axis) (v: value_for p) (allocation: string & list string) (counter: nat)
  (q: common_parameter) (row: nat) (column: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side)))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      CellSemantics.equivalent q
        (CellSemantics.resolve next
          (corresponding_row input next row) (corresponding_column input next column) q)
        (CellSemantics.resolve input row column q))) =
  let next, _ = Input.collapse input p allocation counter in
  if p = q then
    collapse_retains_complete_uniform_value input p side v allocation counter row column
      (corresponding_row input next row) (corresponding_column input next column)
  else
    collapse_preserves_other_parameter input p side allocation counter q row column

(* Dispatching MoveToCommon keeps each chosen parameter value when every
   owning case contains the same complete value. The old cell must have an
   owning case. The later proof also checks how those templates read
   variable fields. PRODUCT.md 3.1.10. *)
let move_to_common_preserves_every_parameter (input: layout) (p: common_parameter)
  (side: axis) (v: value_for p) (prefix: string) (counter: nat)
  (q: common_parameter) (row: nat) (column: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (Parameters.entries input side) p v /\
      (if side = Rows then row else column) < List.length (Parameters.entries input side)))
    (ensures (
      let next, _ = Input.reduce input (MoveToCommon p) prefix counter in
      CellSemantics.equivalent q
        (CellSemantics.resolve next
          (corresponding_row input next row) (corresponding_column input next column) q)
        (CellSemantics.resolve input row column q))) =
  collapse_preserves_every_parameter input p side v (prefix, Input.case_ids input) counter q row column

(* Changing another setting's shared value or owner cannot change this
   setting's stored value at the same cell. Ownership proofs use this to
   separate a source-tag edit from the settings it does not address. *)
let resolve_ignores_other_source (input: layout) (p: common_parameter)
  (q: common_parameter) (source: source q) (row: nat) (column: nat)
  : Lemma
    (requires (p <> q))
    (ensures (
      CellSemantics.resolve (Input.set_source input q source) row column p ==
        CellSemantics.resolve input row column p)) =
  Parameters.get_set_source input.parameters q source p;
  source_projection input.parameters p;
  source_projection (Parameters.set_source input.parameters q source) p

(* Writing another setting into all cases on an axis leaves this setting's
   stored value unchanged at the same cell. This helper reasons about fields,
   not expanded templates that might consume variable fields. *)
let resolve_ignores_other_case_fields (input: layout) (p: common_parameter)
  (v: value) (side: axis) (row: nat) (column: nat)
  : Lemma
    (requires (value_parameter v <> p))
    (ensures (
      let next =
        Input.set_entries input side
          (List.map
            (fun entry -> {entry with values = Parameters.set_case_value entry.values v})
            (Parameters.entries input side))
      in
      CellSemantics.resolve next row column p == CellSemantics.resolve input row column p)) =
  let next =
    Input.set_entries input side
      (List.map
        (fun entry -> {entry with values = Parameters.set_case_value entry.values v})
        (Parameters.entries input side))
  in
  mapped_set_value (Parameters.entries input side) v p (if side = Rows then row else column);
  parameter_value_refines_resolve input p row column None;
  parameter_value_refines_resolve next p row column None;
  match side with
  | Rows
  | Columns ->
    match Parameters.get_source input.parameters p with
    | None
    | Some (Common _) -> ()
    | Some (OnAxis owner) ->
      match owner with
      | Rows
      | Columns -> ()

(* A message without images means the same input as the otherwise identical
   message with an empty image list. This storage distinction must not make
   equal complete inputs appear different on return to common.
   PRODUCT.md 3.3.9. *)
let empty_message_images_are_equivalent (role: role) (content: string) (rest: list message)
  : Lemma (
    CellSemantics.equivalent PInput
      (Some (InputValue ({
        message_role = role;
        content = content;
        images = None
      } :: rest)))
      (Some (InputValue ({
        message_role = role;
        content = content;
        images = Some []
      } :: rest)))) =
  ()

(* Only generator inputs and variable fields receive empty-image
   normalization. Other values, such as model IDs and judge criteria, compare
   exactly as stored. Collapse cannot use that normalization to erase a real
   difference in those settings. *)
let non_image_values_are_exact (v: value)
  : Lemma
    (requires (value_parameter v <> PInput /\ value_parameter v <> PVariable))
    (ensures (CellSemantics.canonical_value v == v)) =
  match v with
  | InputValue _
  | VariableValue _ -> ()
  | _ -> ()

(* Copying a shared setting into a nonempty table leaves each other case field
   unchanged, including its absence. The proof covers every list index,
   so missing coordinates remain missing too. This is the field-level fact
   needed to show that variable bindings survive the move. *)
let own_keeps_other_case_fields (input: layout) (p: common_parameter) (side: axis)
  (v: value_for p) (allocation: string & list string) (counter: nat) (q: parameter) (index: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      Parameters.entries input side <> [] /\ p <> q))
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      (match Parameters.at (Parameters.entries next side) index with
       | None -> None
       | Some entry -> Parameters.get_case_value entry.values q) ==
      (match Parameters.at (Parameters.entries input side) index with
       | None -> None
       | Some entry -> Parameters.get_case_value entry.values q))) =
  source_projection input.parameters p;
  own_existing_cases input p side v allocation counter;
  mapped_set_value (Parameters.entries input side) v q index;
  match side with
  | Rows
  | Columns -> ()

(* Neutralization keeps the selected axis's existing cases or leaves exactly
   one position. The opposite axis stays untouched. The code only reduces an
   ordinary axis with no remaining setting, never an active case table.
   PRODUCT.md 3.1.10. *)
let neutral_dimension_shape (input: layout) (side: axis)
  (allocation: string & list string) (counter: nat)
  : Lemma (
    let next, _ = Input.neutral_dimension input side allocation counter in
    (Parameters.entries next side == Parameters.entries input side \/
      List.length (Parameters.entries next side) == 1) /\
    Parameters.entries next (Input.other_side side) ==
      Parameters.entries input (Input.other_side side)) =
  if Parameters.is_case_axis input side || List.length (Parameters.axis_parameters input side) > 0 then
    ()
  else
    match Parameters.entries input side with
    | [] ->
      (match side with
       | Rows
       | Columns -> ())
    | _ :: _ ->
      (match side with
       | Rows
       | Columns -> ())

(* Every cell that existed before collapse has valid corresponding
   coordinates afterward. Unchanged dimensions keep their indices. A dimension
   reduced to one neutral position uses zero. This proves coordinate validity,
   not equality of values after a lossy collapse. PRODUCT.md 3.1.10. *)
let collapse_correspondence_is_valid (input: layout) (p: common_parameter)
  (allocation: string & list string) (counter: nat) (row: nat) (column: nat)
  : Lemma
    (requires (row < List.length input.rows /\ column < List.length input.columns))
    (ensures (
      let next, _ = Input.collapse input p allocation counter in
      corresponding_row input next row < List.length next.rows /\
      corresponding_column input next column < List.length next.columns)) =
  match Parameters.get_source input.parameters p with
  | None
  | Some (Common _) -> ()
  | Some (OnAxis side) ->
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
    let stripped =
      Input.set_entries base side
        (List.map
          (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
          (Parameters.entries input side))
    in
    map_length (fun entry -> {entry with values = Parameters.remove_case_value entry.values p})
      (Parameters.entries input side);
    neutral_dimension_shape stripped side allocation counter;
    let next, _ = Input.collapse input p allocation counter in
    assert (
      Input.collapse input p allocation counter ==
        Input.neutral_dimension stripped side allocation counter)
      by (
        FStar.Tactics.norm [delta_only [`%Input.collapse]];
        FStar.Tactics.smt ());
    match side with
    | Rows
    | Columns -> ()

(* Copying a setting into cases leaves each case ID and user-assigned name
   at the same list position. This indexed helper connects the field update
   to the identity-preservation law below. *)
let rec mapped_set_identity (values: list case_record) (v: value) (index: nat)
  : Lemma (
    (match Parameters.at
      (List.map (fun entry -> {entry with values = Parameters.set_case_value entry.values v}) values)
      index with
     | None -> None
     | Some entry -> Some (entry.case_id, entry.case_name)) ==
    (match Parameters.at values index with
     | None -> None
     | Some entry -> Some (entry.case_id, entry.case_name))) =
  match values with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then
      ()
    else
      mapped_set_identity rest v (index - 1)

(* Moving a shared setting into an existing, nonempty table does not replace
   its cases or rename them. IDs and names stay at their original positions,
   and out-of-range lookups stay absent. PRODUCT.md 3.1.10. *)
let own_keeps_case_identity (input: layout) (p: common_parameter) (side: axis)
  (v: value_for p) (allocation: string & list string) (counter: nat) (index: nat)
  : Lemma
    (requires (
      CellSemantics.source_for input.parameters p == Some (Common v) /\
      Parameters.entries input side <> []))
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      (match Parameters.at (Parameters.entries next side) index with
       | None -> None
       | Some entry -> Some (entry.case_id, entry.case_name)) ==
      (match Parameters.at (Parameters.entries input side) index with
       | None -> None
       | Some entry -> Some (entry.case_id, entry.case_name)))) =
  source_projection input.parameters p;
  own_existing_cases input p side v allocation counter;
  mapped_set_identity (Parameters.entries input side) v index;
  match side with
  | Rows
  | Columns -> ()

(* Moving one setting to cases leaves every other setting's source tag
   alone. A neighboring setting therefore stays shared or keeps its own row
   or column owner rather than following the moved setting. *)
let own_keeps_other_sources (input: layout) (p: common_parameter) (side: axis)
  (allocation: string & list string) (counter: nat) (q: common_parameter)
  : Lemma
    (requires (p <> q))
    (ensures (
      let next, _ = Input.own input p side allocation counter in
      CellSemantics.source_for next.parameters q == CellSemantics.source_for input.parameters q)) =
  Parameters.get_set_source input.parameters p (OnAxis side) q;
  source_projection input.parameters q;
  let next, _ = Input.own input p side allocation counter in
  source_projection next.parameters q;
  match Parameters.get_source input.parameters p with
  | Some (OnAxis _) -> ()
  | None
  | Some (Common _) ->
    match side with
    | Rows
    | Columns -> ()
