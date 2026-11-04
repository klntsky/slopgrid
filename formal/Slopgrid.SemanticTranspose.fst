module Slopgrid.SemanticTranspose

module I = Slopgrid.Input
module N = Slopgrid.Native
module T = Slopgrid.Template
module TP = Slopgrid.TemplateProofs
module L = FStar.List.Tot.Base
module V = Slopgrid.VariableSemantics
module P = Slopgrid.Parameters
module F = Slopgrid.TransposeLayoutProofs
open Slopgrid.Domain
open Prims

type byte = N.byte
let rec digits (bytes:list byte) : Tot bool =
  match bytes with | [] -> true | first::rest -> first>=48 && first<=57 && digits rest
let positive_decimal (bytes:list byte) : Tot bool =
  match bytes with | [] -> false | first::_ -> first<>48 && digits bytes
let rec bounded_digits (fuel:nat) (bytes:list byte) : Tot bool =
  if fuel=0 then true else match bytes with | [] -> false | first::rest ->
    first>=48 && first<=57 && bounded_digits (fuel - 1) rest
let row_prefix : list byte = [82;79;87]
let column_prefix : list byte = [67;79;76;85;77;78]
let numeric_swap (bytes:list byte) : Tot (list byte) =
  let prefix,target = if N.take_bytes 3 bytes=row_prefix then (row_prefix,column_prefix)
    else if N.take_bytes 6 bytes=column_prefix then (column_prefix,row_prefix) else ([],[]) in
  let suffix=N.drop_bytes (L.length prefix) bytes in
  if prefix<>[] && positive_decimal suffix then L.append target suffix else bytes

let rec decimal_digits_model (fuel:nat) (text:string) (position:nat)
  : Lemma (I.decimal_digits fuel text position == bounded_digits fuel (N.drop_bytes position (N.byte_view text)))
    (decreases fuel) =
  TP.nth_drop (N.byte_view text) position;
  if fuel=0 then () else match N.drop_bytes position (N.byte_view text) with
  | [] -> () | first::_ ->
    if first<48 || first>57 then () else (
      TP.drop_successor (N.byte_view text) position;
      decimal_digits_model (fuel - 1) text (position + 1))

let rec full_digits (bytes:list byte)
  : Lemma (bounded_digits (L.length bytes) bytes == digits bytes) =
  match bytes with | [] -> () | _::rest -> full_digits rest

let rec take_enough (count:nat) (bytes:list byte{count >= L.length bytes})
  : Lemma (N.take_bytes count bytes == bytes) =
  match bytes with | [] -> () | _::rest -> take_enough (count - 1) rest

#push-options "--fuel 6 --ifuel 2"
let numeric_swap_model (name:string)
  : Lemma (N.byte_view (I.swap_numeric_name name) == numeric_swap (N.byte_view name)) =
  N.ascii_byte_view "ROW";
  N.ascii_byte_view "COLUMN";
  N.empty_byte_view ();
  assert_norm (L.map N.low_byte ['R';'O';'W'] == row_prefix);
  assert_norm (L.map N.low_byte ['C';'O';'L';'U';'M';'N'] == column_prefix);
  let prefix,target=if N.starts_with name "ROW" then ("ROW","COLUMN") else
    if N.starts_with name "COLUMN" then ("COLUMN","ROW") else ("","") in
  let suffix=N.slice name (N.length prefix) (N.length name) in
  TP.drop_length (N.byte_view name) (N.length prefix);
  take_enough (N.length name) (N.drop_bytes (N.length prefix) (N.byte_view name));
  decimal_digits_model (N.length suffix) suffix 0;
  full_digits (N.byte_view suffix);
  TP.nth_drop (N.byte_view suffix) 0;
  if N.starts_with name "ROW" then (match N.byte_view suffix with | [] -> () | _::_ -> ())
  else if N.starts_with name "COLUMN" then (match N.byte_view suffix with | [] -> () | _::_ -> ())
  else ()
 #pop-options

let rec take_drop (count:nat) (bytes:list byte)
  : Lemma (L.append (N.take_bytes count bytes) (N.drop_bytes count bytes) == bytes) =
  match bytes with | [] -> () | _::rest -> if count=0 then () else take_drop (count - 1) rest

let numeric_swap_involution (bytes:list byte)
  : Lemma (numeric_swap (numeric_swap bytes) == bytes) =
  if N.take_bytes 3 bytes=row_prefix then (
    take_drop 3 bytes;
    if positive_decimal (N.drop_bytes 3 bytes) then () else ())
  else if N.take_bytes 6 bytes=column_prefix then (
    take_drop 6 bytes;
    if positive_decimal (N.drop_bytes 6 bytes) then () else ())
  else ()

let swap_numeric_name_involution (name:string)
  : Lemma (I.swap_numeric_name (I.swap_numeric_name name) == name) =
  numeric_swap_model name;
  numeric_swap_model (I.swap_numeric_name name);
  numeric_swap_involution (N.byte_view name);
  N.byte_view_injective (I.swap_numeric_name (I.swap_numeric_name name)) name

let rec digits_are_name (bytes:list byte{digits bytes})
  : Lemma (T.name_bytes bytes) =
  match bytes with | [] -> () | _::rest -> digits_are_name rest

let rec names_append (left:list byte{T.name_bytes left}) (right:list byte{T.name_bytes right})
  : Lemma (T.name_bytes (L.append left right)) =
  match left with | [] -> () | _::rest -> names_append rest right

let numeric_identifier (name:T.identifier)
  : Lemma (numeric_swap name <> [] /\ T.name_bytes (numeric_swap name)) =
  if N.take_bytes 3 name=row_prefix then (
    let suffix=N.drop_bytes 3 name in
    if positive_decimal suffix then (
      digits_are_name suffix; names_append column_prefix suffix) else ())
  else if N.take_bytes 6 name=column_prefix then (
    let suffix=N.drop_bytes 6 name in
    if positive_decimal suffix then (
      digits_are_name suffix; names_append row_prefix suffix) else ())
  else ()

let swap_rename_involution (input:layout) (name:string)
  : Lemma (I.swap_rename input (I.swap_rename input name) == name) =
  swap_numeric_name_involution name;
  swap_numeric_name_involution (I.swap_numeric_name name);
  if I.member name (I.custom_variable_names input) || I.member (I.swap_numeric_name name) (I.custom_variable_names input)
  then () else ()

let swap_rename_injective (input:layout) (left:string) (right:string)
  : Lemma
    (requires I.swap_rename input left == I.swap_rename input right)
    (ensures left == right) =
  swap_rename_involution input left;
  swap_rename_involution input right

let swap_rename_identifier (input:layout) (name:T.identifier)
  : Lemma
    (let renamed=TP.runtime_rename (I.swap_rename input) name in renamed<>[] /\ T.name_bytes renamed) =
  let text=N.bytes_string name in
  numeric_swap_model text;
  numeric_identifier name;
  if I.member text (I.custom_variable_names input) || I.member (I.swap_numeric_name text) (I.custom_variable_names input)
  then () else ()

let swap_rename_valid (input:layout)
  : Lemma (TP.valid_renamer (I.swap_rename input)) =
  FStar.Classical.forall_intro (swap_rename_identifier input)

let rec at_independent #a (values:list a) (index:nat)
  : Lemma (V.at values index == I.at values index) =
  match values with | [] -> () | _::rest -> if index=0 then () else at_independent rest (index - 1)

let names_independent (input:layout) (side:axis)
  : Lemma (V.names input side == I.option_list (I.name_fields input side)) =
  match input.variable_names with | None -> () | Some names ->
    if side=Rows then (match names.row_names with | None -> () | Some _ -> ())
    else (match names.column_names with | None -> () | Some _ -> ())

let name_independent (input:layout) (side:axis) (index:nat)
  : Lemma (V.name_at input side index == I.variable_name input side index) =
  names_independent input side;
  at_independent (V.names input side) index

let fields_independent (input:layout) (side:axis)
  : Lemma (V.fields input side == I.variable_fields input side) =
  if side=Rows then (match input.rows with | [] -> () | first::_ ->
    match first.values.variable_value with | None -> () | Some _ -> ())
  else (match input.columns with | [] -> () | first::_ ->
    match first.values.variable_value with | None -> () | Some _ -> ())

let rec at_bound (#a:eqtype) (values:list a) (index:nat)
  : Lemma (requires I.at values index <> None) (ensures index < L.length values) =
  match values with | [] -> () | _::rest -> if index=0 then () else at_bound rest (index - 1)

let rec at_fill_to #a (count:nat) (values:list (option a)) (index:nat)
  : Lemma
    (index < count ==> I.at (I.fill_to count values) index ==
      Some (match I.at values index with | None -> None | Some value -> value))
    (decreases count) =
  if count=0 || index=0 then () else
  match values with | [] -> at_fill_to #a (count - 1) [] (index - 1)
  | _::rest -> at_fill_to (count - 1) rest (index - 1)

let rec at_map_i_from #a #b (f:nat -> a -> Tot b) (start:nat) (values:list a) (index:nat)
  : Lemma
    (I.at (I.map_i_from f start values) index ==
      (match I.at values index with | None -> None | Some value -> Some (f (start + index) value)))
    (decreases values) =
  match values with | [] -> () | _::rest ->
    if index=0 then () else at_map_i_from f (start + 1) rest (index - 1)

let name_projection (values:list (option string)) (index:nat) : Tot (option string) =
  match I.at values index with | Some (Some name) -> Some name | _ -> None

let rec trim_name_projection (values:list (option string)) (index:nat)
  : Lemma (name_projection (I.trim_null_end values) index == name_projection values index) =
  match values with | [] -> () | first::rest ->
    if index>0 then trim_name_projection rest (index - 1) else ();
    match I.trim_null_end rest with | [] -> (match first with | None -> () | Some _ -> ()) | _::_ -> ()

let swapped_name_at (input:layout) (side:axis) (index:nat)
  : Lemma
    (requires P.is_case_axis input side /\ (match I.at (I.variable_fields input side) index with | Some (Some _) -> True | _ -> False))
    (ensures
      (match name_projection (I.option_list (I.swap_name_fields input side)) index with
       | Some name -> name | None -> I.generated_name (I.other_side side) index) ==
      I.swap_rename input (I.variable_name input side index)) =
  let fields=I.variable_fields input side in
  let names=I.fill_to (L.length fields) (I.option_list (I.name_fields input side)) in
  at_bound fields index;
  at_fill_to (L.length fields) (I.option_list (I.name_fields input side)) index;
  at_map_i_from (I.swapped_name_entry input side) 0 names index;
  trim_name_projection (I.map_i (I.swapped_name_entry input side) names) index;
  if I.swap_rename input (I.variable_name input side index)=I.generated_name (I.other_side side) index then () else ()

#push-options "--fuel 6 --ifuel 2"
let swap_names_projection (input:layout) (side:axis)
  : Lemma (V.names (I.swap input) (I.other_side side) == I.option_list (I.swap_name_fields input side)) =
  let rows=I.swap_name_fields input Columns in
  let columns=I.swap_name_fields input Rows in
  match rows,columns with
  | None,None -> ()
  | Some _,None -> if side=Rows then () else ()
  | None,Some _ -> if side=Rows then () else ()
  | Some _,Some _ -> if side=Rows then () else ()
#pop-options

let active_name_swap (input:layout) (side:axis) (index:nat)
  : Lemma
    (requires P.is_case_axis input side /\ (match V.at (V.fields input side) index with | Some (Some _) -> True | _ -> False))
    (ensures V.name_at (I.swap input) (I.other_side side) index == I.swap_rename input (V.name_at input side index)) =
  fields_independent input side;
  at_independent (V.fields input side) index;
  name_independent input side index;
  swap_names_projection input side;
  at_independent (V.names (I.swap input) (I.other_side side)) index;
  swapped_name_at input side index

let rec field_suffix (fields:list (option variable_field)) (index:nat)
  : Tot (list (option variable_field)) =
  match fields with | [] -> [] | _::rest -> if index=0 then fields else field_suffix rest (index - 1)

let rec suffix_at (fields:list (option variable_field)) (start:nat) (index:nat)
  : Lemma (V.at (field_suffix fields start) index == V.at fields (start + index)) =
  match fields with | [] -> () | _::rest -> if start=0 then () else suffix_at rest (start - 1) index

let rec slot_in_swap (input:layout) (side:axis) (name:string) (start:nat)
  (fields:list (option variable_field){fields == field_suffix (V.fields input side) start})
  : Lemma
    (requires P.is_case_axis input side)
    (ensures V.slot_in (I.swap input) (I.other_side side) fields start (I.swap_rename input name) ==
      V.slot_in input side fields start name)
    (decreases fields) =
  match fields with | [] -> () | field::rest ->
    suffix_at (V.fields input side) start 0;
    if field<>None then (
      active_name_swap input side start;
      if I.swap_rename input (V.name_at input side start)=I.swap_rename input name
      then swap_rename_injective input (V.name_at input side start) name else ()) else ();
    if field<>None && V.name_at input side start=name then () else (
      let rec suffix_successor (values:list (option variable_field)) (index:nat)
        : Lemma (field_suffix values (index + 1) == (match field_suffix values index with | [] -> [] | _::tail -> tail)) =
        match values with | [] -> () | _::tail -> if index=0 then () else suffix_successor tail (index - 1) in
      suffix_successor (V.fields input side) start;
      slot_in_swap input side name (start + 1) rest)

let flip_slot (slot:option (axis & nat)) : Tot (option (axis & nat)) =
  match slot with | None -> None | Some (side,index) -> Some (I.other_side side,index)

let slot_on_swap (input:layout) (side:axis) (name:string)
  : Lemma
    (requires P.is_case_axis input side)
    (ensures V.slot_on (I.swap input) (I.other_side side) (I.swap_rename input name) ==
      flip_slot (V.slot_on input side name)) =
  F.variable_fields_swap input side;
  slot_in_swap input side name 0 (V.fields input side)

let slot_for_swap (input:layout) (name:string)
  : Lemma (V.slot_for (I.swap input) (I.swap_rename input name) == flip_slot (V.slot_for input name)) =
  match input.case_ownership with
  | NoCaseAxes -> ()
  | OneCaseAxis side -> slot_on_swap input side name
  | BothCaseAxes first ->
    slot_on_swap input first name;
    slot_on_swap input (I.other_side first) name;
    match first with | Rows | Columns -> ()

let renamed_identifier (input:layout) (name:T.identifier)
  : GTot (result:T.identifier{result == TP.runtime_rename (I.swap_rename input) name}) =
  swap_rename_valid input;
  TP.runtime_rename (I.swap_rename input) name

let field_for_swap (input:layout) (row:nat) (column:nat) (name:T.identifier)
  : Lemma
    (V.field_for (I.swap input) column row (renamed_identifier input name) ==
      V.field_for input row column name) =
  let original=N.bytes_string name in
  let renamed=renamed_identifier input name in
  N.byte_view_injective (N.bytes_string renamed) (I.swap_rename input original);
  slot_for_swap input original;
  match V.slot_for input original with
  | None -> ()
  | Some (side,index) -> F.variable_field_at_swap input row column side index

let rec member_append (name:string) (left:list string) (right:list string)
  : Lemma (I.member name (L.append left right) == (I.member name left || I.member name right)) =
  match left with | [] -> () | _::rest -> member_append name rest right

let rec custom_names_member (fields:list (option variable_field)) (names:list (option string))
  (index:nat) (name:string)
  : Lemma
    (requires (match I.at fields index with | Some (Some _) -> True | _ -> False) /\
      I.at names index == Some (Some name))
    (ensures I.member name (I.custom_names_from fields names)) =
  match fields,names with
  | field::fields,custom::names ->
    if index=0 then () else custom_names_member fields names (index - 1) name
  | _ -> ()

let custom_name_fixed (input:layout) (side:axis) (index:nat) (name:string)
  : Lemma
    (requires P.is_case_axis input side /\
      (match I.at (I.variable_fields input side) index with | Some (Some _) -> True | _ -> False) /\
      I.at (I.option_list (I.name_fields input side)) index == Some (Some name))
    (ensures I.swap_rename input name == name) =
  custom_names_member (I.variable_fields input side) (I.option_list (I.name_fields input side)) index name;
  member_append name (I.custom_names_on input Rows) (I.custom_names_on input Columns);
  match side with | Rows | Columns -> ()

let explicit_custom_name_swap (input:layout) (side:axis) (index:nat) (name:string)
  : Lemma
    (requires P.is_case_axis input side /\
      (match V.at (V.fields input side) index with | Some (Some _) -> True | _ -> False) /\
      V.at (V.names input side) index == Some (Some name))
    (ensures V.at (V.names (I.swap input) (I.other_side side)) index == Some (Some name)) =
  names_independent input side;
  at_independent (V.names input side) index;
  fields_independent input side;
  at_independent (V.fields input side) index;
  custom_name_fixed input side index name;
  let fields=I.variable_fields input side in
  let names=I.fill_to (L.length fields) (I.option_list (I.name_fields input side)) in
  at_bound fields index;
  at_fill_to (L.length fields) (I.option_list (I.name_fields input side)) index;
  at_map_i_from (I.swapped_name_entry input side) 0 names index;
  trim_name_projection (I.map_i (I.swapped_name_entry input side) names) index;
  swap_names_projection input side;
  at_independent (V.names (I.swap input) (I.other_side side)) index
