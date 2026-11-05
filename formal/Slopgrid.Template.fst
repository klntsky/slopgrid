module Slopgrid.Template

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

(* Split off the maximal prefix of identifier-name bytes, leaving an empty tail
   or a tail starting with a non-name byte; concatenation and lengths are preserved. *)
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

(* Splitting at dollar bytes produces a nonempty list of dollar-free byte lists,
   including empty parts at consecutive or boundary delimiters. *)
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

(* A prefix consisting of name bytes is exactly the span returned when its tail
   is empty or starts with a non-name byte. *)
let rec span_append (name: list byte{name_bytes name}) (tail: list byte{stopped tail})
  : Lemma (span_name (List.append name tail) == (name, tail)) =
  match name with
  | [] ->
    (match tail with
     | [] -> ()
     | _ :: _ -> ())
  | _ :: rest -> span_append rest tail

(* Renaming leaves an unrecognized reference part unchanged. A recognized part
   still parses as a reference to the renamed identifier with the same tail. *)
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

(* Expanding renamed reference parts gives identical bytes when the new resolver
   agrees with the old resolver on every renamed identifier. *)
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

(* Renaming a template preserves its expanded bytes, including its literal
   prefix, provided corresponding old and renamed identifiers resolve identically. *)
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

(* A list consisting entirely of identifier-name bytes contains no dollar byte. *)
let rec name_has_no_dollar (name: list byte{name_bytes name})
  : Lemma (no_dollar name) =
  match name with
  | [] -> ()
  | _ :: rest -> name_has_no_dollar rest

(* Concatenating two dollar-free byte lists yields a dollar-free byte list. *)
let rec no_dollar_append (left: list byte{no_dollar left}) (right: list byte{no_dollar right})
  : Lemma (no_dollar (List.append left right)) =
  match left with
  | [] -> ()
  | _ :: rest -> no_dollar_append rest right

(* Joining the dollar-separated parts of any byte list reconstructs it exactly. *)
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

(* A dollar-free prefix merges into the first part when concatenated bytes are
   split at dollars; the remaining split parts are unchanged. *)
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

(* Splitting a joined nonempty list of dollar-free parts recovers those exact
   parts, including any empty parts. *)
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

(* Renaming a reference within a dollar-free part cannot introduce dollar bytes,
   since renamed identifiers also consist only of name bytes. *)
let rename_no_dollar (rename: identifier -> GTot identifier) (part: list byte{no_dollar part})
  : Lemma (no_dollar (rename_part rename part)) =
  let name, tail = span_name part in
  match reference_part part with
  | None -> ()
  | Some (name, tail) ->
    name_has_no_dollar (rename name);
    (* A suffix of a dollar-free concatenation is itself dollar-free. *)
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

(* Renaming each reference part preserves the property that every part is
   dollar-free. *)
let rec renamed_parts_no_dollar (rename: identifier -> GTot identifier)
  (parts: list (list byte){List.for_all no_dollar parts})
  : Lemma (List.for_all no_dollar (map_g (rename_part rename) parts)) =
  match parts with
  | [] -> ()
  | part :: rest ->
    rename_no_dollar rename part;
    renamed_parts_no_dollar rename rest

(* Renaming a nonempty list of dollar-free template parts preserves its exact
   representation through joining and splitting at dollars. *)
let renamed_template_roundtrip (rename: identifier -> GTot identifier)
  (parts: list (list byte){parts <> [] /\ List.for_all no_dollar parts})
  : Lemma
    (split_dollar (join_dollar (rename_template rename parts)) == rename_template rename parts) =
  match parts with
  | [] -> ()
  | _ :: rest ->
    renamed_parts_no_dollar rename rest;
    split_join (rename_template rename parts)

(* Appending a dollar delimiter and suffix does not change whether a part starts
   with a recognized reference or its name; only a recognized reference's tail grows. *)
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

(* A suffix of a dollar-free concatenation is itself dollar-free. *)
let rec suffix_no_dollar (prefix: list byte) (suffix: list byte)
  : Lemma (requires no_dollar (List.append prefix suffix)) (ensures no_dollar suffix) =
  match prefix with
  | [] -> ()
  | _ :: rest -> suffix_no_dollar rest suffix

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

(* Resolving renamed reference parts yields exactly the same ordered list of
   values when corresponding old and renamed identifiers resolve identically. *)
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

(* Renaming a template preserves its ordered list of resolved reference values
   under corresponding resolvers; the initial literal part contributes no value. *)
let resolution_renaming #a (rename: identifier -> GTot identifier)
  (before: identifier -> GTot a) (after: identifier -> GTot a) (parts: list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures
      resolve_template after (rename_template rename parts) == resolve_template before parts) =
  match parts with
  | [] -> ()
  | _ :: rest -> resolution_renamed_parts rename before after rest
