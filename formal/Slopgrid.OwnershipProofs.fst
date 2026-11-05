module Slopgrid.OwnershipProofs

module P = Slopgrid.Parameters
module I = Slopgrid.Input
module S = Slopgrid.CellSemantics
module L = FStar.List.Tot.Base
open Slopgrid.Domain

#set-options "--fuel 4 --ifuel 1"

(* The parameter API and cell semantics select exactly the same source for a
   common parameter. *)
let source_projection (sources:parameter_sources) (p:common_parameter)
  : Lemma (P.get_source sources p == S.source_for sources p) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality
  | PBackground | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* Reading a parameter from case values through the parameter API gives exactly
   the same optional value as the semantic projection, including variables. *)
let case_projection (values:case_values) (p:parameter)
  : Lemma (P.get_case_value values p == S.case_value values p) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality
  | PBackground | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem | PVariable -> ()

(* The two list lookup functions return the same optional case record at every
   index, including indices beyond the end of the list. *)
let rec entry_projection (values:list case_record) (index:nat)
  : Lemma (P.at values index == S.entry_at values index) =
  match values with
  | [] -> ()
  | _::rest -> if index=0 then () else entry_projection rest (index - 1)

(* Looking up an axis entry and then its parameter field agrees exactly with
   the semantic axis-value lookup, including missing entries or fields. *)
let axis_projection (input:layout) (side:axis) (index:nat) (p:parameter)
  : Lemma ((match P.at (P.entries input side) index with
      | None -> None | Some entry -> P.get_case_value entry.values p) ==
    S.axis_value input side index p) =
  entry_projection (P.entries input side) index;
  match P.at (P.entries input side) index with
  | None -> () | Some entry -> case_projection entry.values p

(* Parameter lookup agrees with source-directed semantic resolution at the
   given coordinates, regardless of the optional side argument. *)
let parameter_value_refines_resolve (input:layout) (p:common_parameter)
  (row:nat) (column:nat) (side:option axis)
  : Lemma (P.parameter_value input p row column side == S.resolve input row column p) =
  source_projection input.parameters p;
  match P.get_source input.parameters p with
  | None | Some (Common _) -> ()
  | Some (OnAxis owner) ->
    axis_projection input owner (if owner=Rows then row else column) p;
    match owner with | Rows | Columns -> ()

(* A parameter's source cannot be both common and axis-owned, nor can it be
   owned by both rows and columns. This is exclusivity of the source tag. *)
let exclusive_source (input:layout) (p:common_parameter)
  : Lemma (
    (forall (v:value_for p) (side:axis).
      S.source_for input.parameters p == Some (Common v) ==>
      S.source_for input.parameters p <> Some (OnAxis side)) /\
    (S.source_for input.parameters p == Some (OnAxis Rows) ==>
      S.source_for input.parameters p <> Some (OnAxis Columns))) = ()

(* When a parameter has a common value, replacing either list of cases leaves
   its resolved value unchanged at the given coordinates. *)
let common_ignores_all_cases (input:layout) (p:common_parameter) (v:value_for p)
  (rows:list case_record) (columns:list case_record) (row:nat) (column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (Common v)))
    (ensures (S.resolve {input with rows=rows; columns=columns} row column p ==
      S.resolve input row column p)) = ()

(* A row-owned parameter is unaffected by replacing all columns or changing
   the column coordinate while keeping the row coordinate fixed. *)
let row_owner_ignores_columns (input:layout) (p:common_parameter)
  (columns:list case_record) (row:nat) (column:nat) (other_column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis Rows)))
    (ensures (S.resolve {input with columns=columns} row other_column p ==
      S.resolve input row column p)) = ()

(* A column-owned parameter is unaffected by replacing all rows or changing
   the row coordinate while keeping the column coordinate fixed. *)
let column_owner_ignores_rows (input:layout) (p:common_parameter)
  (rows:list case_record) (row:nat) (column:nat) (other_row:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis Columns)))
    (ensures (S.resolve {input with rows=rows} other_row column p ==
      S.resolve input row column p)) = ()

(* Setting a value in every case changes an indexed field only when that field
   is the value's parameter; an out-of-range lookup remains absent. *)
let rec mapped_set_value (values:list case_record) (v:value) (q:parameter) (index:nat)
  : Lemma ((match P.at (L.map (fun entry -> {entry with values=P.set_case_value entry.values v}) values) index with
      | None -> None | Some entry -> P.get_case_value entry.values q) ==
    (match P.at values index with | None -> None | Some entry ->
      if value_parameter v=q then Some v else P.get_case_value entry.values q)) =
  match values with
  | [] -> ()
  | entry::rest -> if index=0 then P.get_set_case_value entry.values v q
    else mapped_set_value rest v q (index - 1)

(* Removing a parameter from every case makes that indexed field absent and
   preserves every other field, with out-of-range lookups still absent. *)
let rec mapped_remove_value (values:list case_record) (p:parameter) (q:parameter) (index:nat)
  : Lemma ((match P.at (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) values) index with
      | None -> None | Some entry -> P.get_case_value entry.values q) ==
    (match P.at values index with | None -> None | Some entry ->
      if p=q then None else P.get_case_value entry.values q)) =
  match values with
  | [] -> ()
  | entry::rest -> if index=0 then P.get_remove_case_value entry.values p q
    else mapped_remove_value rest p q (index - 1)

(* Any index strictly below the case-list length has a present entry. *)
let rec entry_exists (values:list case_record) (index:nat)
  : Lemma
    (requires (index < L.length values))
    (ensures (P.at values index <> None)) =
  match values with
  | [] -> () | _::rest -> if index=0 then () else entry_exists rest (index - 1)

#push-options "--fuel 8 --ifuel 2"
(* For a common parameter and a nonempty target axis, taking ownership sets
   that axis as the source and copies the common value into every existing
   case, without advancing the allocation counter. *)
let own_existing_cases (input:layout) (p:common_parameter) (side:axis)
  (v:value_for p) (allocation:string & list string) (counter:nat)
  : Lemma
    (requires (P.get_source input.parameters p == Some (Common v) /\ P.entries input side <> []))
    (ensures (I.own input p side allocation counter ==
      (I.set_entries (I.set_source input p (OnAxis side)) side
        (L.map (fun entry -> {entry with values=P.set_case_value entry.values v}) (P.entries input side)),counter))) =
  match P.get_source input.parameters p with
  | Some (Common actual) ->
    assert (actual == v);
    match I.entries input side with | [] -> () | _::_ -> ()
  | _ -> ()
#pop-options

(* Moving a common value into an axis preserves every common parameter's
   resolved value at coordinates whose target-axis index already exists. *)
let own_preserves_every_parameter (input:layout) (p:common_parameter) (side:axis)
  (v:value_for p) (allocation:string & list string) (counter:nat)
  (q:common_parameter) (row:nat) (column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (Common v) /\
      (if side=Rows then row else column) < L.length (P.entries input side)))
    (ensures (let next,_ = I.own input p side allocation counter in
      S.resolve next row column q == S.resolve input row column q)) =
  source_projection input.parameters p;
  source_projection input.parameters q;
  let index = if side=Rows then row else column in
  entry_exists (P.entries input side) index;
  assert (P.entries input side <> []);
  own_existing_cases input p side v allocation counter;
  P.get_set_source input.parameters p (OnAxis side) q;
  mapped_set_value (P.entries input side) v q (if side=Rows then row else column);
  parameter_value_refines_resolve input q row column None;
  let next,_ = I.own input p side allocation counter in
  assert (next == I.set_entries (I.set_source input p (OnAxis side)) side
    (L.map (fun entry -> {entry with values=P.set_case_value entry.values v}) (P.entries input side)));
  source_projection next.parameters q;
  parameter_value_refines_resolve next q row column None;
  axis_projection next side index q;
  axis_projection input side index q;
  match side with
  | Rows | Columns ->
    if p=q then () else
    match P.get_source input.parameters q with
    | None | Some (Common _) -> ()
    | Some (OnAxis owner) -> match owner with | Rows | Columns -> ()

(* Taking ownership leaves the opposite axis exactly unchanged, as well as
   output format, case ownership, variable names, judging, and worker count. *)
let own_preserves_opposite_axis_and_metadata (input:layout) (p:common_parameter)
  (side:axis) (allocation:string & list string) (counter:nat)
  : Lemma (let next,_ = I.own input p side allocation counter in
    P.entries next (I.other_side side) == P.entries input (I.other_side side) /\
    next.output_format == input.output_format /\ next.case_ownership == input.case_ownership /\
    next.variable_names == input.variable_names /\ next.judging == input.judging /\
    next.parallel_workers == input.parallel_workers) =
  match P.get_source input.parameters p with
  | Some (OnAxis _) -> ()
  | _ -> match side with | Rows | Columns -> ()

(* The MoveToAxis reducer preserves every common parameter's resolved value
   when the moved parameter is common and the target-axis index exists;
   a target that is not a case axis is left unchanged by the reducer. *)
let move_to_axis_preserves_every_parameter (input:layout) (p:common_parameter)
  (side:axis) (v:value_for p) (prefix:string) (counter:nat)
  (q:common_parameter) (row:nat) (column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (Common v) /\
      (if side=Rows then row else column) < L.length (P.entries input side)))
    (ensures (let next,_ = I.reduce input (MoveToAxis p side) prefix counter in
      S.resolve next row column q == S.resolve input row column q)) =
  source_projection input.parameters p;
  if P.is_case_axis input side then
    own_preserves_every_parameter input p side v (prefix,I.case_ids input) counter q row column
  else ()

(* Input and semantic message normalization agree exactly: absent and empty
   image lists both normalize to an absent image list. *)
let rec message_normalization_refines (messages:list message)
  : Lemma (I.normalize_messages messages == S.normalize_messages messages) =
  match messages with
  | [] -> ()
  | message::rest ->
    message_normalization_refines rest;
    match message.images with | None -> () | Some images -> match images with | [] | _::_ -> ()

(* Input and semantic variable-field normalization agree exactly, preserving
   absent fields and treating empty image lists like absent image lists. *)
let rec field_normalization_refines (fields:list (option variable_field))
  : Lemma (I.normalize_fields fields == S.normalize_fields fields) =
  match fields with
  | [] -> ()
  | field::rest ->
    field_normalization_refines rest;
    match field with | None -> () | Some field ->
      match field.field_images with | None -> () | Some images -> match images with | [] | _::_ -> ()

(* The input comparison representation is exactly the semantic canonical
   value, normalizing image-list emptiness for messages and variable fields. *)
let comparison_refines_canonical_value (v:value)
  : Lemma (I.comparison_value v == S.canonical_value v) =
  match v with
  | InputValue messages -> message_normalization_refines messages
  | VariableValue fields -> field_normalization_refines fields
  | _ -> ()

(* The input's optional-value equality test is precisely semantic equivalence:
   presence must match and present values are compared after canonicalization. *)
let optional_equality_refines_equivalence (p:parameter)
  (left:option (value_for p)) (right:option (value_for p))
  : Lemma (I.optional_values_equal p left right == S.equivalent p left right) =
  match left,right with
  | Some left,Some right -> comparison_refines_canonical_value left; comparison_refines_canonical_value right
  | _ -> ()

let rec complete_uniform (values:list case_record) (p:common_parameter) (v:value_for p) : Tot bool =
  match values with
  | [] -> true
  | entry::rest -> S.equivalent p (S.case_value entry.values p) (Some v) &&
    complete_uniform rest p v

(* If every case value is equivalent to the same present value and the
   reference is also equivalent to it, no case differs from that reference. *)
let rec uniform_comparison (values:list case_record) (p:common_parameter)
  (v:value_for p) (reference:option (value_for p))
  : Lemma
    (requires (complete_uniform values p v /\ S.equivalent p reference (Some v)))
    (ensures (not (I.differs_from p reference values))) =
  match values with
  | [] -> ()
  | entry::rest ->
    case_projection entry.values p;
    optional_equality_refines_equivalence p (P.get_case_value entry.values p) reference;
    uniform_comparison rest p v reference

#push-options "--fuel 8 --ifuel 2"
(* An axis-owned parameter is not reported as differing when every case on
   its owner axis is equivalent to the same present value, even vacuously
   when the axis is empty. *)
let uniform_not_differing (input:layout) (p:common_parameter) (side:axis) (v:value_for p)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (P.entries input side) p v))
    (ensures (not (I.differing input p))) =
  source_projection input.parameters p;
  match P.entries input side with
  | [] -> ()
  | first::rest ->
    case_projection first.values p;
    assert (I.entries input side == first::rest);
    uniform_comparison (first::rest) p v (P.get_case_value first.values p)
#pop-options

(* In a uniformly valued case list, every in-range lookup is semantically
   equivalent to the specified present value. *)
let rec uniform_at (values:list case_record) (p:common_parameter) (v:value_for p) (index:nat)
  : Lemma
    (requires (complete_uniform values p v /\ index < L.length values))
    (ensures (S.equivalent p
      (match P.at values index with | None -> None | Some entry -> P.get_case_value entry.values p)
      (Some v))) =
  match values with
  | [] -> ()
  | entry::rest -> if index=0 then case_projection entry.values p else uniform_at rest p v (index - 1)

(* Neutralizing an axis preserves parameter sources, the exact opposite-axis
   entries, and output format, case ownership, variable names, judging, and
   worker count; the selected axis itself may change. *)
let neutral_dimension_preserves_sources (input:layout) (side:axis)
  (allocation:string & list string) (counter:nat)
  : Lemma (let next,_ = I.neutral_dimension input side allocation counter in
    next.parameters == input.parameters /\
    P.entries next (I.other_side side) == P.entries input (I.other_side side) /\
    next.output_format == input.output_format /\ next.case_ownership == input.case_ownership /\
    next.variable_names == input.variable_names /\ next.judging == input.judging /\
    next.parallel_workers == input.parallel_workers) =
  match side with | Rows | Columns -> ()

(* Collapsing an axis-owned parameter whose cases all have a value equivalent
   to v preserves that parameter up to semantic equivalence. An in-range
   original owner coordinate is required; the new coordinates are arbitrary. *)
let collapse_retains_complete_uniform_value (input:layout) (p:common_parameter)
  (side:axis) (v:value_for p) (allocation:string & list string) (counter:nat)
  (row:nat) (column:nat) (next_row:nat) (next_column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side)))
    (ensures (let next,_ = I.collapse input p allocation counter in
      S.equivalent p (S.resolve next next_row next_column p) (S.resolve input row column p))) =
  source_projection input.parameters p;
  uniform_not_differing input p side v;
  uniform_at (P.entries input side) p v (if side=Rows then row else column);
  match P.entries input side with
  | [] -> ()
  | first::rest ->
    case_projection first.values p;
    match P.get_case_value first.values p with
    | None -> ()
    | Some u ->
      let base = I.set_source input p (Common u) in
      P.get_set_source input.parameters p (Common u) p;
      let base = {base with parameters={base.parameters with source_order=
        L.append (L.filter (fun (key:common_parameter) -> key<>p) base.parameters.source_order) [p]}} in
      let stripped = I.set_entries base side
        (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side)) in
      neutral_dimension_preserves_sources stripped side allocation counter;
      let next,_ = I.collapse input p allocation counter in
      source_projection next.parameters p;
      axis_projection input side (if side=Rows then row else column) p;
      match side with | Rows | Columns -> ()

(* MoveToCommon retains the moved parameter up to semantic equivalence when
   all owner-axis cases are equivalent to v and the original owner coordinate
   exists, regardless of the coordinates used after the move. *)
let move_to_common_retains_complete_uniform_value (input:layout) (p:common_parameter)
  (side:axis) (v:value_for p) (prefix:string) (counter:nat)
  (row:nat) (column:nat) (next_row:nat) (next_column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side)))
    (ensures (let next,_ = I.reduce input (MoveToCommon p) prefix counter in
      S.equivalent p (S.resolve next next_row next_column p) (S.resolve input row column p))) =
  collapse_retains_complete_uniform_value input p side v (prefix,I.case_ids input) counter
    row column next_row next_column

(* Mapping any total function over a list preserves its length. *)
let rec map_length #a #b (f:a -> Tot b) (values:list a)
  : Lemma (L.length (L.map f values) == L.length values) =
  match values with | [] -> () | _::rest -> map_length f rest

let corresponding_row (before:layout) (after:layout) (row:nat) : Tot nat =
  if L.length before.rows = L.length after.rows then row else 0

let corresponding_column (before:layout) (after:layout) (column:nat) : Tot nat =
  if L.length before.columns = L.length after.columns then column else 0

(* Collapsing an axis-owned parameter leaves every different common parameter
   exactly resolved as before at the corresponding coordinates: retain each
   coordinate when its dimension's length is unchanged, otherwise use zero. *)
let collapse_preserves_other_parameter (input:layout) (p:common_parameter)
  (side:axis) (allocation:string & list string) (counter:nat) (q:common_parameter)
  (row:nat) (column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis side) /\ p<>q))
    (ensures (let next,_ = I.collapse input p allocation counter in
      S.resolve next (corresponding_row input next row) (corresponding_column input next column) q ==
      S.resolve input row column q)) =
  source_projection input.parameters p;
  source_projection input.parameters q;
  let value = if I.differing input p then P.parameter_default p else
    match P.at (P.entries input side) 0 with | None -> P.parameter_default p | Some entry ->
      match P.get_case_value entry.values p with | None -> P.parameter_default p | Some value -> value in
  let base = I.set_source input p (Common value) in
  P.get_set_source input.parameters p (Common value) q;
  let base = {base with parameters={base.parameters with source_order=
    L.append (L.filter (fun (key:common_parameter) -> key<>p) base.parameters.source_order) [p]}} in
  let stripped = I.set_entries base side
    (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side)) in
  assert (P.get_source stripped.parameters q == P.get_source input.parameters q);
  neutral_dimension_preserves_sources stripped side allocation counter;
  let next,_ = I.collapse input p allocation counter in
  assert (I.collapse input p allocation counter == I.neutral_dimension stripped side allocation counter);
  source_projection next.parameters q;
  mapped_remove_value (P.entries input side) p q (if side=Rows then row else column);
  map_length (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side);
  parameter_value_refines_resolve input q row column None;
  parameter_value_refines_resolve next q (corresponding_row input next row) (corresponding_column input next column) None;
  match P.get_source input.parameters q with
  | None | Some (Common _) -> ()
  | Some (OnAxis owner) ->
    if owner=side then (
      P.axis_owner_prevents_neutralization stripped q side;
      assert (next == stripped);
      axis_projection next side (if side=Rows then row else column) q;
      match side with | Rows | Columns -> ()
    ) else (
      match side,owner with | Rows,Rows | Rows,Columns | Columns,Rows | Columns,Columns -> ()
    )

(* If the owner-axis cases are uniformly equivalent to v and the original
   owner coordinate exists, collapse preserves every common parameter up to
   semantic equivalence at the corresponding coordinates. *)
let collapse_preserves_every_parameter (input:layout) (p:common_parameter)
  (side:axis) (v:value_for p) (allocation:string & list string) (counter:nat)
  (q:common_parameter) (row:nat) (column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side)))
    (ensures (let next,_ = I.collapse input p allocation counter in
      S.equivalent q
        (S.resolve next (corresponding_row input next row) (corresponding_column input next column) q)
        (S.resolve input row column q))) =
  let next,_ = I.collapse input p allocation counter in
  if p=q then collapse_retains_complete_uniform_value input p side v allocation counter row column
    (corresponding_row input next row) (corresponding_column input next column)
  else collapse_preserves_other_parameter input p side allocation counter q row column

(* MoveToCommon preserves every common parameter up to semantic equivalence
   at the corresponding coordinates, provided the moved parameter is
   axis-owned, its cases are uniformly equivalent to v, and its index exists. *)
let move_to_common_preserves_every_parameter (input:layout) (p:common_parameter)
  (side:axis) (v:value_for p) (prefix:string) (counter:nat)
  (q:common_parameter) (row:nat) (column:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (OnAxis side) /\
      complete_uniform (P.entries input side) p v /\
      (if side=Rows then row else column) < L.length (P.entries input side)))
    (ensures (let next,_ = I.reduce input (MoveToCommon p) prefix counter in
      S.equivalent q
        (S.resolve next (corresponding_row input next row) (corresponding_column input next column) q)
        (S.resolve input row column q))) =
  collapse_preserves_every_parameter input p side v (prefix,I.case_ids input) counter q row column

(* Updating a different common parameter's source leaves this parameter's
   resolved value exactly unchanged at the same coordinates. *)
let resolve_ignores_other_source (input:layout) (p:common_parameter)
  (q:common_parameter) (source:source q) (row:nat) (column:nat)
  : Lemma
    (requires (p<>q))
    (ensures (S.resolve (I.set_source input q source) row column p == S.resolve input row column p)) =
  P.get_set_source input.parameters q source p;
  source_projection input.parameters p;
  source_projection (P.set_source input.parameters q source) p

(* Writing a value for a different parameter into every case on one axis
   leaves this common parameter's resolved value exactly unchanged. *)
let resolve_ignores_other_case_fields (input:layout) (p:common_parameter)
  (v:value) (side:axis) (row:nat) (column:nat)
  : Lemma
    (requires (value_parameter v<>p))
    (ensures (let next = I.set_entries input side
      (L.map (fun entry -> {entry with values=P.set_case_value entry.values v}) (P.entries input side)) in
      S.resolve next row column p == S.resolve input row column p)) =
  let next = I.set_entries input side
    (L.map (fun entry -> {entry with values=P.set_case_value entry.values v}) (P.entries input side)) in
  mapped_set_value (P.entries input side) v p (if side=Rows then row else column);
  parameter_value_refines_resolve input p row column None;
  parameter_value_refines_resolve next p row column None;
  match side with
  | Rows | Columns ->
    match P.get_source input.parameters p with
    | None | Some (Common _) -> ()
    | Some (OnAxis owner) -> match owner with | Rows | Columns -> ()

(* A message with no image list and the same message with an explicitly empty
   image list are semantically equivalent as input values. *)
let empty_message_images_are_equivalent (role:role) (content:string) (rest:list message)
  : Lemma (S.equivalent PInput
    (Some (InputValue ({message_role=role; content=content; images=None}::rest)))
    (Some (InputValue ({message_role=role; content=content; images=Some []}::rest)))) = ()

(* Canonicalization is the identity for values other than generator input and
   variable fields; these other kinds are compared without normalization. *)
let non_image_values_are_exact (v:value)
  : Lemma
    (requires (value_parameter v<>PInput /\ value_parameter v<>PVariable))
    (ensures (S.canonical_value v == v)) =
  match v with
  | InputValue _ | VariableValue _ -> ()
  | _ -> ()

(* Taking ownership of a common value on a nonempty axis preserves every
   different parameter's indexed case field exactly, including missing fields
   and out-of-range lookups. *)
let own_keeps_other_case_fields (input:layout) (p:common_parameter) (side:axis)
  (v:value_for p) (allocation:string & list string) (counter:nat) (q:parameter) (index:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (Common v) /\
      P.entries input side <> [] /\ p<>q))
    (ensures (let next,_ = I.own input p side allocation counter in
      (match P.at (P.entries next side) index with
        | None -> None | Some entry -> P.get_case_value entry.values q) ==
      (match P.at (P.entries input side) index with
        | None -> None | Some entry -> P.get_case_value entry.values q))) =
  source_projection input.parameters p;
  own_existing_cases input p side v allocation counter;
  mapped_set_value (P.entries input side) v q index;
  match side with | Rows | Columns -> ()

(* Neutralizing an axis either preserves its entries exactly or leaves a
   singleton axis, and always preserves the opposite axis exactly. *)
let neutral_dimension_shape (input:layout) (side:axis)
  (allocation:string & list string) (counter:nat)
  : Lemma (let next,_ = I.neutral_dimension input side allocation counter in
    (P.entries next side == P.entries input side \/ L.length (P.entries next side) == 1) /\
    P.entries next (I.other_side side) == P.entries input (I.other_side side)) =
  if P.is_case_axis input side || L.length (P.axis_parameters input side)>0 then ()
  else match P.entries input side with
  | [] -> (match side with | Rows | Columns -> ())
  | _::_ -> (match side with | Rows | Columns -> ())

(* Every originally valid row and column maps to valid coordinates after
   collapse, keeping each index when that dimension's length is unchanged
   and using zero otherwise. *)
let collapse_correspondence_is_valid (input:layout) (p:common_parameter)
  (allocation:string & list string) (counter:nat) (row:nat) (column:nat)
  : Lemma
    (requires (row<L.length input.rows /\ column<L.length input.columns))
    (ensures (let next,_ = I.collapse input p allocation counter in
      corresponding_row input next row < L.length next.rows /\
      corresponding_column input next column < L.length next.columns)) =
  match P.get_source input.parameters p with
  | None | Some (Common _) -> ()
  | Some (OnAxis side) ->
    let value = if I.differing input p then P.parameter_default p else
      match P.at (P.entries input side) 0 with | None -> P.parameter_default p | Some entry ->
        match P.get_case_value entry.values p with | None -> P.parameter_default p | Some value -> value in
    let base = I.set_source input p (Common value) in
    let base = {base with parameters={base.parameters with source_order=
      L.append (L.filter (fun (key:common_parameter) -> key<>p) base.parameters.source_order) [p]}} in
    let stripped = I.set_entries base side
      (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side)) in
    map_length (fun entry -> {entry with values=P.remove_case_value entry.values p}) (P.entries input side);
    neutral_dimension_shape stripped side allocation counter;
    let next,_ = I.collapse input p allocation counter in
    assert (I.collapse input p allocation counter == I.neutral_dimension stripped side allocation counter)
      by (FStar.Tactics.norm [delta_only [`%I.collapse]]; FStar.Tactics.smt ());
    match side with | Rows | Columns -> ()

(* Setting a value throughout a case list preserves the optional case ID and
   name pair at every index, including absent out-of-range entries. *)
let rec mapped_set_identity (values:list case_record) (v:value) (index:nat)
  : Lemma (
    (match P.at (L.map (fun entry -> {entry with values=P.set_case_value entry.values v}) values) index with
      | None -> None | Some entry -> Some (entry.case_id,entry.case_name)) ==
    (match P.at values index with | None -> None | Some entry -> Some (entry.case_id,entry.case_name))) =
  match values with
  | [] -> ()
  | _::rest -> if index=0 then () else mapped_set_identity rest v (index - 1)

(* Taking ownership of a common value on a nonempty axis preserves the exact
   case ID and name at each index; out-of-range lookups remain absent. *)
let own_keeps_case_identity (input:layout) (p:common_parameter) (side:axis)
  (v:value_for p) (allocation:string & list string) (counter:nat) (index:nat)
  : Lemma
    (requires (S.source_for input.parameters p == Some (Common v) /\ P.entries input side <> []))
    (ensures (let next,_ = I.own input p side allocation counter in
      (match P.at (P.entries next side) index with
        | None -> None | Some entry -> Some (entry.case_id,entry.case_name)) ==
      (match P.at (P.entries input side) index with
        | None -> None | Some entry -> Some (entry.case_id,entry.case_name)))) =
  source_projection input.parameters p;
  own_existing_cases input p side v allocation counter;
  mapped_set_identity (P.entries input side) v index;
  match side with | Rows | Columns -> ()

(* Taking ownership of one parameter leaves the semantic source of every
   different common parameter exactly unchanged. *)
let own_keeps_other_sources (input:layout) (p:common_parameter) (side:axis)
  (allocation:string & list string) (counter:nat) (q:common_parameter)
  : Lemma
    (requires (p<>q))
    (ensures (let next,_ = I.own input p side allocation counter in
      S.source_for next.parameters q == S.source_for input.parameters q)) =
  P.get_set_source input.parameters p (OnAxis side) q;
  source_projection input.parameters q;
  let next,_ = I.own input p side allocation counter in
  source_projection next.parameters q;
  match P.get_source input.parameters p with
  | Some (OnAxis _) -> ()
  | None | Some (Common _) -> match side with | Rows | Columns -> ()
