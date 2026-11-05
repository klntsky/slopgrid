module Slopgrid.SemanticTranspose

(* Axis swaps must move fields and rewrite references without changing which
   field a prompt or judge question reads. These proofs compare names and
   coordinate lookups, including unknown names. They do not execute generation.
   PRODUCT.md 3.1.4 and 3.3.7. *)

module Input = Slopgrid.Input
module Native = Slopgrid.Native
module Template = Slopgrid.Template
module TemplateProofs = Slopgrid.TemplateProofs
module List = FStar.List.Tot.Base
module VariableSemantics = Slopgrid.VariableSemantics
module Parameters = Slopgrid.Parameters
module TransposeLayoutProofs = Slopgrid.TransposeLayoutProofs
open Slopgrid.Domain
open Prims

type byte = Native.byte

let rec digits (bytes: list byte) : Tot bool =
  match bytes with
  | [] -> true
  | first :: rest -> first >= 48 && first <= 57 && digits rest

let positive_decimal (bytes: list byte) : Tot bool =
  match bytes with
  | [] -> false
  | first :: _ -> first <> 48 && digits bytes

let rec bounded_digits (fuel: nat) (bytes: list byte) : Tot bool =
  if fuel = 0 then
    true
  else
    match bytes with
    | [] -> false
    | first :: rest -> first >= 48 && first <= 57 && bounded_digits (fuel - 1) rest

let row_prefix : list byte = [82; 79; 87]

let column_prefix : list byte = [67; 79; 76; 85; 77; 78]

(* Only default-shaped names such as ROW12 exchange prefixes. ROW, ROW0, and
   ROW01 stay unchanged here. Explicit custom names need the later collision
   check even when they happen to look like a default. *)
let numeric_swap (bytes: list byte) : Tot (list byte) =
  let prefix, target =
    if Native.take_bytes 3 bytes = row_prefix then
      (row_prefix, column_prefix)
    else if Native.take_bytes 6 bytes = column_prefix then
      (column_prefix, row_prefix)
    else
      ([], [])
  in
  let suffix = Native.drop_bytes (List.length prefix) bytes in
  if prefix <> [] && positive_decimal suffix then
    List.append target suffix
  else
    bytes

(* Match the runtime digit scan to the byte model used to recognize numbered
   defaults. The starting offset skips the ROW or COLUMN prefix. *)
let rec decimal_digits_model (fuel: nat) (text: string) (position: nat)
  : Lemma
    (Input.decimal_digits fuel text position ==
      bounded_digits fuel (Native.drop_bytes position (Native.byte_view text)))
    (decreases fuel) =
  TemplateProofs.nth_drop (Native.byte_view text) position;
  if fuel = 0 then
    ()
  else
    match Native.drop_bytes position (Native.byte_view text) with
    | [] -> ()
    | first :: _ ->
      if first < 48 || first > 57 then
        ()
      else (
        TemplateProofs.drop_successor (Native.byte_view text) position;
        decimal_digits_model (fuel - 1) text (position + 1))

(* Scanning the whole suffix accepts exactly an all-decimal suffix.
   This rules out exchanging a prefix of a custom-looking name. *)
let rec full_digits (bytes: list byte)
  : Lemma (bounded_digits (List.length bytes) bytes == digits bytes) =
  match bytes with
  | [] -> ()
  | _ :: rest -> full_digits rest

(* A slice long enough for the remaining name retains its entire suffix. *)
let rec take_enough (count: nat) (bytes: list byte{count >= List.length bytes})
  : Lemma (Native.take_bytes count bytes == bytes) =
  match bytes with
  | [] -> ()
  | _ :: rest -> take_enough (count - 1) rest

#push-options "--fuel 6 --ifuel 2"
(* The runtime numeric-name rewrite agrees with the byte model. It exchanges
   ROW and COLUMN only with a nonzero-leading decimal suffix. This helper
   does not yet protect explicit custom names. *)
let numeric_swap_model (name: string)
  : Lemma
    (Native.byte_view (Input.swap_numeric_name name) == numeric_swap (Native.byte_view name)) =
  Native.ascii_byte_view "ROW";
  Native.ascii_byte_view "COLUMN";
  Native.empty_byte_view ();
  assert_norm (List.map Native.low_byte ['R'; 'O'; 'W'] == row_prefix);
  assert_norm (List.map Native.low_byte ['C'; 'O'; 'L'; 'U'; 'M'; 'N'] == column_prefix);
  let prefix, target =
    if Native.starts_with name "ROW" then
      ("ROW", "COLUMN")
    else if Native.starts_with name "COLUMN" then
      ("COLUMN", "ROW")
    else
      ("", "")
  in
  let suffix = Native.slice name (Native.length prefix) (Native.length name) in
  TemplateProofs.drop_length (Native.byte_view name) (Native.length prefix);
  take_enough (Native.length name)
    (Native.drop_bytes (Native.length prefix) (Native.byte_view name));
  decimal_digits_model (Native.length suffix) suffix 0;
  full_digits (Native.byte_view suffix);
  TemplateProofs.nth_drop (Native.byte_view suffix) 0;
  if Native.starts_with name "ROW" then
    (match Native.byte_view suffix with
     | [] -> ()
     | _ :: _ -> ())
  else if Native.starts_with name "COLUMN" then
    (match Native.byte_view suffix with
     | [] -> ()
     | _ :: _ -> ())
  else
    ()
#pop-options

(* Reattach the name prefix and suffix when reasoning about numeric exchange.
   No original name bytes disappear at the split. *)
let rec take_drop (count: nat) (bytes: list byte)
  : Lemma
    (List.append (Native.take_bytes count bytes) (Native.drop_bytes count bytes) == bytes) =
  match bytes with
  | [] -> ()
  | _ :: rest ->
    if count = 0 then () else take_drop (count - 1) rest

(* Exchanging numbered prefixes twice recovers every original byte name.
   Names outside that pattern stay unchanged on both calls. *)
let numeric_swap_involution (bytes: list byte)
  : Lemma (numeric_swap (numeric_swap bytes) == bytes) =
  if Native.take_bytes 3 bytes = row_prefix then (
    take_drop 3 bytes;
    if positive_decimal (Native.drop_bytes 3 bytes) then () else ())
  else if Native.take_bytes 6 bytes = column_prefix then (
    take_drop 6 bytes;
    if positive_decimal (Native.drop_bytes 6 bytes) then () else ())
  else
    ()

(* Transfer numeric exchange's two-call result back to runtime strings,
   using Native's trusted byte equality contract. *)
let swap_numeric_name_involution (name: string)
  : Lemma (Input.swap_numeric_name (Input.swap_numeric_name name) == name) =
  numeric_swap_model name;
  numeric_swap_model (Input.swap_numeric_name name);
  numeric_swap_involution (Native.byte_view name);
  Native.byte_view_injective (Input.swap_numeric_name (Input.swap_numeric_name name)) name

(* Decimal suffix bytes are legal inside a template name. This lets the
   parser accept a default name after its ROW/COLUMN prefix changes. *)
let rec digits_are_name (bytes: list byte{digits bytes})
  : Lemma (Template.name_bytes bytes) =
  match bytes with
  | [] -> ()
  | _ :: rest -> digits_are_name rest

(* Joining the replacement prefix to its decimal suffix keeps legal name
   bytes. Nonemptiness comes from the prefix, not from this list helper. *)
let rec names_append (left: list byte{Template.name_bytes left})
  (right: list byte{Template.name_bytes right})
  : Lemma (Template.name_bytes (List.append left right)) =
  match left with
  | [] -> ()
  | _ :: rest -> names_append rest right

(* Numeric exchange still produces one valid identifier. It cannot add a
   delimiter that would change how a prompt is parsed. *)
let numeric_identifier (name: Template.identifier)
  : Lemma (numeric_swap name <> [] /\ Template.name_bytes (numeric_swap name)) =
  if Native.take_bytes 3 name = row_prefix then (
    let suffix = Native.drop_bytes 3 name in
    if positive_decimal suffix then (
      digits_are_name suffix;
      names_append column_prefix suffix)
    else
      ())
  else if Native.take_bytes 6 name = column_prefix then (
    let suffix = Native.drop_bytes 6 name in
    if positive_decimal suffix then (
      digits_are_name suffix;
      names_append row_prefix suffix)
    else
      ())
  else
    ()

(* Freeze this layout's custom-name set and apply its name map twice.
   A numeric exchange is blocked if either spelling is an active custom name.
   The actual two-swap result is EffectiveCellProofs.cell_double_swap. It
   compares cell meaning, not explicit-name bookkeeping. PRODUCT.md 3.3.7. *)
let swap_rename_involution (input: layout) (name: string)
  : Lemma (Input.swap_rename input (Input.swap_rename input name) == name) =
  swap_numeric_name_involution name;
  swap_numeric_name_involution (Input.swap_numeric_name name);
  if Input.member name (Input.custom_variable_names input) ||
     Input.member (Input.swap_numeric_name name) (Input.custom_variable_names input)
  then () else ()

(* With one fixed custom-name set, distinct old names cannot merge into one
   rewritten name. Field search uses this fact to keep its first match. *)
let swap_rename_injective (input: layout) (left: string) (right: string)
  : Lemma
    (requires Input.swap_rename input left == Input.swap_rename input right)
    (ensures left == right) =
  swap_rename_involution input left;
  swap_rename_involution input right

(* The collision check either keeps the old identifier or uses a valid numeric
   exchange. The runtime-to-byte adapter therefore gives the parser one name. *)
let swap_rename_identifier (input: layout) (name: Template.identifier)
  : Lemma
    (let renamed = TemplateProofs.runtime_rename (Input.swap_rename input) name in
     renamed <> [] /\ Template.name_bytes renamed) =
  let text = Native.bytes_string name in
  numeric_swap_model text;
  numeric_identifier name;
  if Input.member text (Input.custom_variable_names input) ||
     Input.member (Input.swap_numeric_name text) (Input.custom_variable_names input)
  then () else ()

(* Supply the parser rewrite proof's valid-renamer assumption for every name
   in this layout's swap, including names that do not resolve to a field. *)
let swap_rename_valid (input: layout)
  : Lemma (TemplateProofs.valid_renamer (Input.swap_rename input)) =
  FStar.Classical.forall_intro (swap_rename_identifier input)

(* Field-name lookup uses the same list index in Input and VariableSemantics.
   Both report absence past the end rather than inventing a field. *)
let rec at_independent #a (values: list a) (index: nat)
  : Lemma (VariableSemantics.at values index == Input.at values index) =
  match values with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then () else at_independent rest (index - 1)

(* Both modules read the same stored names for the chosen axis. An omitted
   name list means no explicit names, not no variable fields. *)
let names_independent (input: layout) (side: axis)
  : Lemma
    (VariableSemantics.names input side == Input.option_list (Input.name_fields input side)) =
  match input.variable_names with
  | None -> ()
  | Some names ->
    if side = Rows then
      (match names.row_names with
       | None -> ()
       | Some _ -> ())
    else
      (match names.column_names with
       | None -> ()
       | Some _ -> ())

(* The proof and implementation choose the same effective name at a field
   index, including the numbered default when no explicit name is stored. *)
let name_independent (input: layout) (side: axis) (index: nat)
  : Lemma (VariableSemantics.name_at input side index == Input.variable_name input side index) =
  names_independent input side;
  at_independent (VariableSemantics.names input side) index

(* Both modules use the first case's field list to find active field slots.
   This compares that lookup rule. It does not prove all cases have matching
   field lists. *)
let fields_independent (input: layout) (side: axis)
  : Lemma (VariableSemantics.fields input side == Input.variable_fields input side) =
  if side = Rows then
    (match input.rows with
     | [] -> ()
     | first :: _ ->
       match first.values.variable_value with
       | None -> ()
       | Some _ -> ())
  else
    (match input.columns with
     | [] -> ()
     | first :: _ ->
       match first.values.variable_value with
       | None -> ()
       | Some _ -> ())

(* A found field slot lies within the list that swap-name handling fills. *)
let rec at_bound (#a: eqtype) (values: list a) (index: nat)
  : Lemma (requires Input.at values index <> None) (ensures index < List.length values) =
  match values with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then () else at_bound rest (index - 1)

(* Fill missing name entries up to the field count without shifting names.
   A padded None still asks for that slot's numbered default. *)
let rec at_fill_to #a (count: nat) (values: list (option a)) (index: nat)
  : Lemma
    (index < count ==> Input.at (Input.fill_to count values) index ==
      Some (match Input.at values index with
        | None -> None
        | Some value -> value))
    (decreases count) =
  if count = 0 || index = 0 then
    ()
  else
    match values with
    | [] -> at_fill_to #a (count - 1) [] (index - 1)
    | _ :: rest -> at_fill_to (count - 1) rest (index - 1)

(* Building swapped names keeps each entry at its original field index.
   The mapping receives the absolute index needed for the numbered default. *)
let rec at_map_i_from #a #b (f: nat -> a -> Tot b) (start: nat) (values: list a)
  (index: nat)
  : Lemma
    (Input.at (Input.map_i_from f start values) index ==
      (match Input.at values index with
       | None -> None
       | Some value -> Some (f (start + index) value)))
    (decreases values) =
  match values with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then () else at_map_i_from f (start + 1) rest (index - 1)

let name_projection (values: list (option string)) (index: nat) : Tot (option string) =
  match Input.at values index with
  | Some (Some name) -> Some name
  | _ -> None

(* Dropping trailing None names cannot change any effective name lookup.
   Missing entries and stored None entries both select numbered defaults. *)
let rec trim_name_projection (values: list (option string)) (index: nat)
  : Lemma (name_projection (Input.trim_null_end values) index == name_projection values index) =
  match values with
  | [] -> ()
  | first :: rest ->
    if index > 0 then trim_name_projection rest (index - 1) else ();
    match Input.trim_null_end rest with
    | [] ->
      (match first with
       | None -> ()
       | Some _ -> ())
    | _ :: _ -> ()

(* For an active field on a case axis, destination metadata gives exactly
   the rewritten old name. A blocked default becomes explicit rather than
   stealing a custom name or choosing a new number. Inactive slots are outside
   this claim. PRODUCT.md 3.3.7. *)
let swapped_name_at (input: layout) (side: axis) (index: nat)
  : Lemma
    (requires Parameters.is_case_axis input side /\
      (match Input.at (Input.variable_fields input side) index with
       | Some (Some _) -> True
       | _ -> False))
    (ensures
      (match name_projection (Input.option_list (Input.swap_name_fields input side)) index with
       | Some name -> name
       | None -> Input.generated_name (Input.other_side side) index) ==
      Input.swap_rename input (Input.variable_name input side index)) =
  let fields = Input.variable_fields input side in
  let names =
    Input.fill_to (List.length fields) (Input.option_list (Input.name_fields input side))
  in
  at_bound fields index;
  at_fill_to (List.length fields) (Input.option_list (Input.name_fields input side)) index;
  at_map_i_from (Input.swapped_name_entry input side) 0 names index;
  trim_name_projection (Input.map_i (Input.swapped_name_entry input side) names) index;
  if Input.swap_rename input (Input.variable_name input side index) =
     Input.generated_name (Input.other_side side) index
  then () else ()

#push-options "--fuel 6 --ifuel 2"
(* The destination receives the names computed for the source axis.
   Non-case axes move their stored list without case-name processing.
   This compares one swap's stored lists, not two-swap metadata equality. *)
let swap_names_projection (input: layout) (side: axis)
  : Lemma
    (VariableSemantics.names (Input.swap input) (Input.other_side side) ==
      Input.option_list (Input.swap_name_fields input side)) =
  let rows = Input.swap_name_fields input Columns in
  let columns = Input.swap_name_fields input Rows in
  match rows, columns with
  | None, None -> ()
  | Some _, None -> if side = Rows then () else ()
  | None, Some _ -> if side = Rows then () else ()
  | Some _, Some _ -> if side = Rows then () else ()
#pop-options

(* An active field keeps its binding while moving to the opposite case axis.
   Its new effective name follows the collision rule, not just its new axis
   prefix. PRODUCT.md 3.3.7. *)
let active_name_swap (input: layout) (side: axis) (index: nat)
  : Lemma
    (requires Parameters.is_case_axis input side /\
      (match VariableSemantics.at (VariableSemantics.fields input side) index with
       | Some (Some _) -> True
       | _ -> False))
    (ensures
      VariableSemantics.name_at (Input.swap input) (Input.other_side side) index ==
        Input.swap_rename input (VariableSemantics.name_at input side index)) =
  fields_independent input side;
  at_independent (VariableSemantics.fields input side) index;
  name_independent input side index;
  swap_names_projection input side;
  at_independent (VariableSemantics.names (Input.swap input) (Input.other_side side)) index;
  swapped_name_at input side index

let rec field_suffix (fields: list (option variable_field)) (index: nat)
  : Tot (list (option variable_field)) =
  match fields with
  | [] -> []
  | _ :: rest ->
    if index = 0 then fields else field_suffix rest (index - 1)

(* Keep absolute field indexes while the name search advances through a
   suffix. Deleted slots still occupy their original numbered position. *)
let rec suffix_at (fields: list (option variable_field)) (start: nat) (index: nat)
  : Lemma
    (VariableSemantics.at (field_suffix fields start) index ==
      VariableSemantics.at fields (start + index)) =
  match fields with
  | [] -> ()
  | _ :: rest ->
    if start = 0 then () else suffix_at rest (start - 1) index

(* Searching a case axis after the swap finds the same field index.
   The search skips deleted slots and keeps the first matching active field.
   Injective renaming prevents a later field from becoming an earlier match. *)
let rec slot_in_swap (input: layout) (side: axis) (name: string) (start: nat)
  (fields: list (option variable_field){
    fields == field_suffix (VariableSemantics.fields input side) start})
  : Lemma
    (requires Parameters.is_case_axis input side)
    (ensures
      VariableSemantics.slot_in (Input.swap input) (Input.other_side side) fields start
        (Input.swap_rename input name) ==
      VariableSemantics.slot_in input side fields start name)
    (decreases fields) =
  match fields with
  | [] -> ()
  | field :: rest ->
    suffix_at (VariableSemantics.fields input side) start 0;
    if field <> None then (
      active_name_swap input side start;
      if Input.swap_rename input (VariableSemantics.name_at input side start) =
         Input.swap_rename input name
      then
        swap_rename_injective input (VariableSemantics.name_at input side start) name
      else
        ())
    else
      ();
    if field <> None && VariableSemantics.name_at input side start = name then
      ()
    else (
      (* Advance both name searches by one stored slot, even for a tombstone. *)
      let rec suffix_successor (values: list (option variable_field)) (index: nat)
        : Lemma
          (field_suffix values (index + 1) ==
            (match field_suffix values index with
             | [] -> []
             | _ :: tail -> tail)) =
        match values with
        | [] -> ()
        | _ :: tail ->
          if index = 0 then () else suffix_successor tail (index - 1)
      in
      suffix_successor (VariableSemantics.fields input side) start;
      slot_in_swap input side name (start + 1) rest)

let flip_slot (slot: option (axis & nat)) : Tot (option (axis & nat)) =
  match slot with
  | None -> None
  | Some (side, index) -> Some (Input.other_side side, index)

(* Move a case axis's name lookup to the other axis without changing its
   field index. A failed lookup stays failed after the name rewrite, so a
   deleted reference does not acquire a new field. PRODUCT.md 3.3.4 and 3.3.7. *)
let slot_on_swap (input: layout) (side: axis) (name: string)
  : Lemma
    (requires Parameters.is_case_axis input side)
    (ensures
      VariableSemantics.slot_on (Input.swap input) (Input.other_side side)
        (Input.swap_rename input name) ==
      flip_slot (VariableSemantics.slot_on input side name)) =
  TransposeLayoutProofs.variable_fields_swap input side;
  slot_in_swap input side name 0 (VariableSemantics.fields input side)

(* Lookup follows case_ownership's first axis, then the other axis on failure.
   Swapping flips that priority with the cases. It does not impose rows-first
   lookup. The field index or unknown result stays the same. This is lookup
   preservation, not full reference validation. PRODUCT.md 3.3.6 and 3.3.7. *)
let slot_for_swap (input: layout) (name: string)
  : Lemma
    (VariableSemantics.slot_for (Input.swap input) (Input.swap_rename input name) ==
      flip_slot (VariableSemantics.slot_for input name)) =
  match input.case_ownership with
  | NoCaseAxes -> ()
  | OneCaseAxis side -> slot_on_swap input side name
  | BothCaseAxes first ->
    slot_on_swap input first name;
    slot_on_swap input (Input.other_side first) name;
    match first with
    | Rows
    | Columns -> ()

(* Package the runtime swap result as the valid identifier required by the
   template parser. The byte spelling stays exactly the runtime spelling. *)
let renamed_identifier (input: layout) (name: Template.identifier)
  : GTot (result: Template.identifier{
      result == TemplateProofs.runtime_rename (Input.swap_rename input) name}) =
  swap_rename_valid input;
  TemplateProofs.runtime_rename (Input.swap_rename input) name

(* After finding a name's axis and slot, read its value from that cell's row
   case or column case. Exchanging coordinates returns the same optional
   field, including text and images. An unknown name stays unknown.
   PRODUCT.md 3.3.6 and 3.3.7. *)
let field_for_swap (input: layout) (row: nat) (column: nat) (name: Template.identifier)
  : Lemma
    (VariableSemantics.field_for (Input.swap input) column row (renamed_identifier input name) ==
      VariableSemantics.field_for input row column name) =
  let original = Native.bytes_string name in
  let renamed = renamed_identifier input name in
  Native.byte_view_injective (Native.bytes_string renamed) (Input.swap_rename input original);
  slot_for_swap input original;
  match VariableSemantics.slot_for input original with
  | None -> ()
  | Some (side, index) -> TransposeLayoutProofs.variable_field_at_swap input row column side index

(* An explicit name collected on either axis participates in the collision
   check over both axes. *)
let rec member_append (name: string) (left: list string) (right: list string)
  : Lemma
    (Input.member name (List.append left right) ==
      (Input.member name left || Input.member name right)) =
  match left with
  | [] -> ()
  | _ :: rest -> member_append name rest right

(* A stored custom name blocks collisions only when its field is present.
   This links the active field slot to the collected custom-name set. *)
let rec custom_names_member (fields: list (option variable_field)) (names: list (option string))
  (index: nat) (name: string)
  : Lemma
    (requires
      (match Input.at fields index with
       | Some (Some _) -> True
       | _ -> False) /\
      Input.at names index == Some (Some name))
    (ensures Input.member name (Input.custom_names_from fields names)) =
  match fields, names with
  | field :: fields, custom :: names ->
    if index = 0 then () else custom_names_member fields names (index - 1) name
  | _ -> ()

(* Keep an active custom name unchanged even if it is spelled ROW1 or COLUMN1.
   Default-looking spelling does not remove its explicit binding.
   PRODUCT.md 3.3.7. *)
let custom_name_fixed (input: layout) (side: axis) (index: nat) (name: string)
  : Lemma
    (requires Parameters.is_case_axis input side /\
      (match Input.at (Input.variable_fields input side) index with
       | Some (Some _) -> True
       | _ -> False) /\
      Input.at (Input.option_list (Input.name_fields input side)) index == Some (Some name))
    (ensures Input.swap_rename input name == name) =
  custom_names_member (Input.variable_fields input side)
    (Input.option_list (Input.name_fields input side)) index name;
  member_append name (Input.custom_names_on input Rows) (Input.custom_names_on input Columns);
  match side with
  | Rows
  | Columns -> ()

(* Move an active custom name as an explicit name, even when it equals the
   destination's normal default. Equal spelling must not silently turn that
   custom binding into a renamable default on the next swap.
   PRODUCT.md 3.3.7. *)
let explicit_custom_name_swap (input: layout) (side: axis) (index: nat) (name: string)
  : Lemma
    (requires Parameters.is_case_axis input side /\
      (match VariableSemantics.at (VariableSemantics.fields input side) index with
       | Some (Some _) -> True
       | _ -> False) /\
      VariableSemantics.at (VariableSemantics.names input side) index == Some (Some name))
    (ensures
      VariableSemantics.at (VariableSemantics.names (Input.swap input) (Input.other_side side))
        index == Some (Some name)) =
  names_independent input side;
  at_independent (VariableSemantics.names input side) index;
  fields_independent input side;
  at_independent (VariableSemantics.fields input side) index;
  custom_name_fixed input side index name;
  let fields = Input.variable_fields input side in
  let names =
    Input.fill_to (List.length fields) (Input.option_list (Input.name_fields input side))
  in
  at_bound fields index;
  at_fill_to (List.length fields) (Input.option_list (Input.name_fields input side)) index;
  at_map_i_from (Input.swapped_name_entry input side) 0 names index;
  trim_name_projection (Input.map_i (Input.swapped_name_entry input side) names) index;
  swap_names_projection input side;
  at_independent (VariableSemantics.names (Input.swap input) (Input.other_side side)) index
