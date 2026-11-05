module Slopgrid.Template

(* Templates are prompt, Chat-message, or judge text split at dollar bytes.
   Field values enter the output as literal bytes, even if they contain tokens.
   This module models text and reference order, not image deduplication or
   generation validation. PRODUCT.md 3.3.4 and 3.3.5. *)

module Native = Slopgrid.Native
module List = FStar.List.Tot.Base
open Prims

type byte = Native.byte

let name_byte (value: int) : Tot bool =
  (value >= 65 && value <= 90) || (value >= 48 && value <= 57) || value = 95

let rec name_bytes (values: list byte) : Tot bool =
  match values with
  | [] -> true
  | first :: rest -> name_byte first && name_bytes rest

let identifier = values: list byte{values <> [] /\ name_bytes values}

let rec no_dollar (values: list byte) : Tot bool =
  match values with
  | [] -> true
  | first :: rest -> first <> 36 && no_dollar rest

let stopped (values: list byte) : Tot bool =
  match values with
  | [] -> true
  | first :: _ -> not (name_byte first)

(* After a dollar, read the whole uppercase name before deciding whether it is
   a reference. This keeps ROW1 distinct from ROW10. PRODUCT.md 3.3.4. *)
let rec span_name (values: list byte)
  : Tot (result: (list byte & list byte){
      let name, tail = result in
      name_bytes name /\ stopped tail /\ List.append name tail = values /\
      List.length name + List.length tail = List.length values}) =
  match values with
  | [] -> ([], [])
  | first :: rest ->
    if name_byte first then
      let name, tail = span_name rest in
      (first :: name, tail)
    else
      ([], values)

(* Keep empty parts so joining can recover leading, trailing, and repeated
   dollars. Only parts after the first can start a variable reference. *)
let rec split_dollar (values: list byte)
  : Tot (parts: list (list byte){parts <> [] /\ List.for_all no_dollar parts}) =
  match values with
  | [] -> [[]]
  | first :: rest ->
    let parts = split_dollar rest in
    if first = 36 then
      [] :: parts
    else
      match parts with
      | [] -> [[first]]
      | part :: parts -> (first :: part) :: parts

let rec join_dollar (parts: list (list byte)) : Tot (list byte) =
  match parts with
  | [] -> []
  | [part] -> part
  | part :: rest -> List.append part (36 :: join_dollar rest)

let rec map_g #a #b (f: a -> GTot b) (values: list a) : GTot (list b) =
  match values with
  | [] -> []
  | first :: rest -> f first :: map_g f rest

(* A lowercase or Unicode alphanumeric continuation makes the lookalike text
   literal, as in $ROW1suffix. Unicode classification comes from Native's
   trusted contract. This byte model does not prove that classifier correct.
   PRODUCT.md 3.3.4. *)
let reference_part (part: list byte) : GTot (option (identifier & list byte)) =
  let name, tail = span_name part in
  if name = [] || Native.unicode_alphanumeric_prefix tail then
    None
  else
    Some (name, tail)

let rename_part (rename: identifier -> GTot identifier) (part: list byte) : GTot (list byte) =
  match reference_part part with
  | None -> part
  | Some (name, tail) ->
    if name <> [] && name_bytes name then
      List.append (rename name) tail
    else
      part

let rename_template (rename: identifier -> GTot identifier) (parts: list (list byte))
  : GTot (list (list byte)) =
  match parts with
  | [] -> []
  | literal :: references -> literal :: map_g (rename_part rename) references

(* Resolve only names scanned from the original template. Append each field's
   text without scanning it again, so a field containing "$COLUMN1" inserts
   those bytes literally. The caller chooses the cell's input and resolver.
   PRODUCT.md 3.3.4. *)
let rec expand_parts (resolve: identifier -> GTot (list byte)) (parts: list (list byte))
  : GTot (list byte) =
  match parts with
  | [] -> []
  | part :: rest ->
    let expanded =
      match reference_part part with
      | None -> 36 :: part
      | Some (name, tail) ->
        if name <> [] && name_bytes name then
          List.append (resolve name) tail
        else
          36 :: part
    in
    List.append expanded (expand_parts resolve rest)

let expand_template (resolve: identifier -> GTot (list byte)) (parts: list (list byte))
  : GTot (list byte) =
  match parts with
  | [] -> []
  | literal :: references -> List.append literal (expand_parts resolve references)

(* The parser can read a renamed name followed by the old punctuation without
   swallowing that punctuation. The stopped-tail assumption matters here. *)
let rec span_append (name: list byte{name_bytes name}) (tail: list byte{stopped tail})
  : Lemma (span_name (List.append name tail) == (name, tail)) =
  match name with
  | [] ->
    (match tail with
     | [] -> ()
     | _ :: _ -> ())
  | _ :: rest -> span_append rest tail

(* A rename changes the recognized name, not the text after it. Lookalike
   text that the parser rejected stays literal. PRODUCT.md 3.3.2. *)
let rename_reference (rename: identifier -> GTot identifier) (part: list byte)
  : Lemma
    (ensures (match reference_part part with
      | None -> rename_part rename part == part
      | Some (name, tail) ->
        reference_part (rename_part rename part) == Some (rename name, tail))) =
  let name, tail = span_name part in
  if name = [] || Native.unicode_alphanumeric_prefix tail then
    ()
  else
    span_append (rename name) tail

(* Walk the reference parts to compare expansion before and after a rename.
   Each renamed name must still resolve to its original field text. *)
let rec expand_renamed_parts
  (rename: identifier -> GTot identifier)
  (before: identifier -> GTot (list byte))
  (after: identifier -> GTot (list byte))
  (parts: list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures
      expand_parts after (map_g (rename_part rename) parts) == expand_parts before parts) =
  match parts with
  | [] -> ()
  | part :: rest ->
    rename_reference rename part;
    expand_renamed_parts rename before after rest

(* A rename leaves expanded template text unchanged when the new names find
   the same field values. The literal prefix stays byte-for-byte unchanged.
   This is the text part of reference-preserving renames. PRODUCT.md 3.3.2. *)
let expansion_renaming
  (rename: identifier -> GTot identifier)
  (before: identifier -> GTot (list byte))
  (after: identifier -> GTot (list byte))
  (parts: list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures
      expand_template after (rename_template rename parts) == expand_template before parts) =
  match parts with
  | [] -> ()
  | _ :: rest -> expand_renamed_parts rename before after rest

(* A valid renamed name cannot add a dollar and create another reference. *)
let rec name_has_no_dollar (name: list byte{name_bytes name})
  : Lemma (no_dollar name) =
  match name with
  | [] -> ()
  | _ :: rest -> name_has_no_dollar rest

(* Joining a renamed name to its dollar-free tail keeps one parser part. *)
let rec no_dollar_append (left: list byte{no_dollar left}) (right: list byte{no_dollar right})
  : Lemma (no_dollar (List.append left right)) =
  match left with
  | [] -> ()
  | _ :: rest -> no_dollar_append rest right

(* Splitting a template loses no literal bytes or dollar positions. *)
let rec join_split (bytes: list byte)
  : Lemma (join_dollar (split_dollar bytes) == bytes) =
  match bytes with
  | [] -> ()
  | first :: rest ->
    join_split rest;
    match split_dollar rest with
    | [] -> ()
    | _ :: _ -> ()

let prepend_part (prefix: list byte) (parts: list (list byte)) : Tot (list (list byte)) =
  match parts with
  | [] -> [prefix]
  | first :: rest -> List.append prefix first :: rest

(* Literal bytes before the next dollar stay in the first parser part.
   The later reference boundaries do not move. *)
let rec split_prefix (prefix: list byte{no_dollar prefix}) (bytes: list byte)
  : Lemma
    (split_dollar (List.append prefix bytes) == prepend_part prefix (split_dollar bytes)) =
  match prefix with
  | [] ->
    (match split_dollar bytes with
     | [] -> ()
     | _ :: _ -> ())
  | _ :: rest ->
    split_prefix rest bytes;
    match split_dollar bytes with
    | [] -> ()
    | _ :: _ -> ()

(* Rejoining parser parts and splitting again keeps their boundaries, even
   when consecutive dollars created empty parts. *)
let rec split_join (parts: list (list byte){parts <> [] /\ List.for_all no_dollar parts})
  : Lemma (split_dollar (join_dollar parts) == parts) =
  match parts with
  | [] -> ()
  | [part] ->
    FStar.List.Tot.Properties.append_l_nil part;
    split_prefix part []
  | part :: rest ->
    FStar.List.Tot.Properties.append_l_nil part;
    split_join rest;
    split_prefix part (36 :: join_dollar rest)

(* Renaming cannot put a dollar inside a parser part. The renamed identifier
   uses name bytes only, and the old tail already contains no dollar. *)
let rename_no_dollar (rename: identifier -> GTot identifier) (part: list byte{no_dollar part})
  : Lemma (no_dollar (rename_part rename part)) =
  let name, tail = span_name part in
  match reference_part part with
  | None -> ()
  | Some (name, tail) ->
    name_has_no_dollar (rename name);
    (* Text after the parsed variable name cannot hide another dollar sign. *)
    let rec suffix_no_dollar (prefix: list byte) (suffix: list byte)
      : Lemma
        (requires no_dollar (List.append prefix suffix))
        (ensures no_dollar suffix) =
      match prefix with
      | [] -> ()
      | _ :: rest -> suffix_no_dollar rest suffix
    in
    suffix_no_dollar name tail;
    no_dollar_append (rename name) tail

(* Check every renamed reference part before rebuilding the template string.
   None can introduce an extra dollar boundary. *)
let rec renamed_parts_no_dollar (rename: identifier -> GTot identifier)
  (parts: list (list byte){List.for_all no_dollar parts})
  : Lemma (List.for_all no_dollar (map_g (rename_part rename) parts)) =
  match parts with
  | [] -> ()
  | part :: rest ->
    rename_no_dollar rename part;
    renamed_parts_no_dollar rename rest

(* Reparse the renamed string without changing its parts. The runtime rewrite
   proof uses this to compare later expansion with the original template. *)
let renamed_template_roundtrip (rename: identifier -> GTot identifier)
  (parts: list (list byte){parts <> [] /\ List.for_all no_dollar parts})
  : Lemma
    (split_dollar (join_dollar (rename_template rename parts)) == rename_template rename parts) =
  match parts with
  | [] -> ()
  | _ :: rest ->
    renamed_parts_no_dollar rename rest;
    split_join (rename_template rename parts)

(* A later dollar cannot turn an earlier literal part into a reference or
   change an earlier reference's name. Native supplies the Unicode delimiter
   assumption used when the preceding tail contains non-ASCII bytes. *)
let reference_delimited (part: list byte) (suffix: list byte)
  : Lemma
    (reference_part (List.append part (36 :: suffix)) ==
      (match reference_part part with
       | None -> None
       | Some (name, tail) -> Some (name, List.append tail (36 :: suffix)))) =
  let name, tail = span_name part in
  FStar.List.Tot.Properties.append_assoc name tail (36 :: suffix);
  (match tail with
   | [] -> ()
   | _ :: _ -> ());
  span_append name (List.append tail (36 :: suffix));
  Native.unicode_prefix_delimiter tail 36 suffix

(* Recover the dollar-free tail needed to rewrite the next reference boundary. *)
let rec suffix_no_dollar (prefix: list byte) (suffix: list byte)
  : Lemma (requires no_dollar (List.append prefix suffix)) (ensures no_dollar suffix) =
  match prefix with
  | [] -> ()
  | _ :: rest -> suffix_no_dollar rest suffix

(* Collect resolver results from this template only. Repeated mentions remain
   repeated here. Attachment merging must deduplicate images elsewhere.
   Separate calls let generator and judge text use their own references.
   PRODUCT.md 3.3.4 and 3.3.5. *)
let rec resolve_parts #a (resolve: identifier -> GTot a) (parts: list (list byte))
  : GTot (list a) =
  match parts with
  | [] -> []
  | part :: rest ->
    let tail = resolve_parts resolve rest in
    match reference_part part with
    | None -> tail
    | Some (name, _) -> resolve name :: tail

let resolve_template #a (resolve: identifier -> GTot a) (parts: list (list byte))
  : GTot (list a) =
  match parts with
  | [] -> []
  | _ :: references -> resolve_parts resolve references

(* Match each old reference with its renamed reference in template order.
   This keeps the same resolver results, including repeated mentions. *)
let rec resolution_renamed_parts #a (rename: identifier -> GTot identifier)
  (before: identifier -> GTot a) (after: identifier -> GTot a) (parts: list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures
      resolve_parts after (map_g (rename_part rename) parts) == resolve_parts before parts) =
  match parts with
  | [] -> ()
  | part :: rest ->
    rename_reference rename part;
    resolution_renamed_parts rename before after rest

(* A reference-preserving rename keeps the same ordered resolver results.
   The literal prefix contributes no field, and this theorem does not merge
   images or validate unknown names. PRODUCT.md 3.3.2. *)
let resolution_renaming #a (rename: identifier -> GTot identifier)
  (before: identifier -> GTot a) (after: identifier -> GTot a) (parts: list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures
      resolve_template after (rename_template rename parts) == resolve_template before parts) =
  match parts with
  | [] -> ()
  | _ :: rest -> resolution_renamed_parts rename before after rest
