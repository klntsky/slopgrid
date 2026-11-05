module Slopgrid.VariableSemantics

module CellSemantics = Slopgrid.CellSemantics
module Native = Slopgrid.Native
module Template = Slopgrid.Template
open Slopgrid.Domain
open Prims

(* Find a variable's field without calling the form's lookup code. The proofs
   use this separate description to check that renaming and swapping keep the
   same field bound to each prompt reference. PRODUCT.md 3.3.2 and 3.3.7. *)

let other (side: axis) : Tot axis =
  match side with
  | Rows -> Columns
  | Columns -> Rows

let names (input: layout) (side: axis) : Tot (list (option string)) =
  match input.variable_names with
  | None -> []
  | Some names ->
    match (if side = Rows then names.row_names else names.column_names) with
    | None -> []
    | Some names -> names

let default_name (side: axis) (index: nat) : Tot string =
  Native.concat (if side = Rows then "ROW" else "COLUMN") (Native.nat_string (index + 1))

let rec at #a (values: list a) (index: nat) : Tot (option a) =
  match values with
  | [] -> None
  | first :: rest -> if index = 0 then Some first else at rest (index - 1)

let name_at (input: layout) (side: axis) (index: nat) : Tot string =
  match at (names input side) index with
  | Some (Some name) -> name
  | _ -> default_name side index

(* All cases on a valid axis have the same active field slots. The first case
   supplies that slot list. The selected cell's case supplies each field's
   text and images. A None slot is a deleted field, not an empty live field.
   PRODUCT.md 3.3.4 and 3.3.6. *)

let fields (input: layout) (side: axis) : Tot (list (option variable_field)) =
  match CellSemantics.axis_entries input side with
  | [] -> []
  | first :: _ ->
    match first.values.variable_value with
    | None -> []
    | Some fields -> fields

let rec slot_in
  (input: layout)
  (side: axis)
  (fields: list (option variable_field))
  (index: nat)
  (name: string)
  : Tot (option nat) =
  match fields with
  | [] -> None
  | field :: rest ->
    if field <> None && name_at input side index = name
    then Some index
    else slot_in input side rest (index + 1) name

let slot_on (input: layout) (side: axis) (name: string) : Tot (option (axis & nat)) =
  match slot_in input side (fields input side) 0 name with
  | None -> None
  | Some index -> Some (side, index)

(* Search active case axes in their saved order. Generation rejects duplicate
   names, but a proof must still describe lookup in an unfinished or invalid
   draft. In that draft, the first matching slot wins. PRODUCT.md 3.3.2. *)

let slot_for (input: layout) (name: string) : Tot (option (axis & nat)) =
  match input.case_ownership with
  | NoCaseAxes -> None
  | OneCaseAxis side -> slot_on input side name
  | BothCaseAxes first ->
    (match slot_on input first name with
     | None -> slot_on input (other first) name
     | Some slot -> Some slot)

(* After finding the named slot, read its value from this cell's row or column
   case. A field on another case must not supply replacement text here.
   PRODUCT.md 3.3.4 and 3.3.9. *)

let field_at (input: layout) (row: nat) (column: nat) (side: axis) (index: nat)
  : Tot (option variable_field) =
  match CellSemantics.entry_at (CellSemantics.axis_entries input side)
    (if side = Rows then row else column) with
  | None -> None
  | Some entry ->
    (match entry.values.variable_value with
     | None -> None
     | Some fields ->
       match at fields index with
       | None -> None
       | Some field -> field)

let field_for (input: layout) (row: nat) (column: nat) (name: Template.identifier)
  : GTot (option variable_field) =
  match slot_for input (Native.bytes_string name) with
  | None -> None
  | Some (side, index) -> field_at input row column side index
