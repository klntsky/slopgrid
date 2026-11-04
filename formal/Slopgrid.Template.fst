module Slopgrid.Template

module N = Slopgrid.Native
module L = FStar.List.Tot.Base
open Prims

type byte = N.byte
let name_byte (value:int) : Tot bool =
  (value >= 65 && value <= 90) || (value >= 48 && value <= 57) || value=95
let rec name_bytes (values:list byte) : Tot bool =
  match values with | [] -> true | first::rest -> name_byte first && name_bytes rest
let identifier = values:list byte{values<>[] /\ name_bytes values}
let rec no_dollar (values:list byte) : Tot bool =
  match values with | [] -> true | first::rest -> first<>36 && no_dollar rest
let stopped (values:list byte) : Tot bool =
  match values with | [] -> true | first::_ -> not (name_byte first)
let rec span_name (values:list byte)
  : Tot (result:(list byte & list byte){let name,tail=result in
    name_bytes name /\ stopped tail /\ L.append name tail=values /\
    L.length name + L.length tail = L.length values}) =
  match values with | [] -> ([],[]) | first::rest ->
    if name_byte first then let name,tail=span_name rest in (first::name,tail)
    else ([],values)
let rec split_dollar (values:list byte)
  : Tot (parts:list (list byte){parts<>[] /\ L.for_all no_dollar parts}) =
  match values with | [] -> [[]] | first::rest ->
    let parts=split_dollar rest in
    if first=36 then []::parts else match parts with
      | [] -> [[first]] | part::parts -> (first::part)::parts
let rec join_dollar (parts:list (list byte)) : Tot (list byte) =
  match parts with | [] -> [] | [part] -> part | part::rest -> L.append part (36::join_dollar rest)
let rec map_g #a #b (f:a -> GTot b) (values:list a) : GTot (list b) =
  match values with | [] -> [] | first::rest -> f first::map_g f rest
let reference_part (part:list byte) : GTot (option (identifier & list byte)) =
  let name,tail=span_name part in
  if name=[] || N.unicode_alphanumeric_prefix tail then None else Some (name,tail)
let rename_part (rename:identifier -> GTot identifier) (part:list byte) : GTot (list byte) =
  match reference_part part with | None -> part | Some (name,tail) ->
    if name<>[] && name_bytes name then L.append (rename name) tail else part
let rename_template (rename:identifier -> GTot identifier) (parts:list (list byte)) : GTot (list (list byte)) =
  match parts with | [] -> [] | literal::references -> literal::map_g (rename_part rename) references
let rec expand_parts (resolve:identifier -> GTot (list byte)) (parts:list (list byte)) : GTot (list byte) =
  match parts with | [] -> [] | part::rest ->
    let expanded=match reference_part part with | None -> 36::part | Some (name,tail) ->
      if name<>[] && name_bytes name then L.append (resolve name) tail else 36::part in
    L.append expanded (expand_parts resolve rest)
let expand_template (resolve:identifier -> GTot (list byte)) (parts:list (list byte)) : GTot (list byte) =
  match parts with | [] -> [] | literal::references -> L.append literal (expand_parts resolve references)

let rec span_append (name:list byte{name_bytes name}) (tail:list byte{stopped tail})
  : Lemma (span_name (L.append name tail) == (name,tail)) =
  match name with | [] -> (match tail with | [] -> () | _::_ -> ()) | _::rest -> span_append rest tail

let rename_reference (rename:identifier -> GTot identifier) (part:list byte)
  : Lemma
    (ensures (match reference_part part with
      | None -> rename_part rename part == part
      | Some (name,tail) ->
        reference_part (rename_part rename part) == Some (rename name,tail))) =
  let name,tail=span_name part in
  if name=[] || N.unicode_alphanumeric_prefix tail then () else span_append (rename name) tail

let rec expand_renamed_parts
  (rename:identifier -> GTot identifier)
  (before:identifier -> GTot (list byte))
  (after:identifier -> GTot (list byte))
  (parts:list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures expand_parts after (map_g (rename_part rename) parts) == expand_parts before parts) =
  match parts with | [] -> () | part::rest ->
    rename_reference rename part;
    expand_renamed_parts rename before after rest

let expansion_renaming
  (rename:identifier -> GTot identifier)
  (before:identifier -> GTot (list byte))
  (after:identifier -> GTot (list byte))
  (parts:list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures expand_template after (rename_template rename parts) == expand_template before parts) =
  match parts with | [] -> () | _::rest -> expand_renamed_parts rename before after rest

let rec name_has_no_dollar (name:list byte{name_bytes name})
  : Lemma (no_dollar name) =
  match name with | [] -> () | _::rest -> name_has_no_dollar rest

let rec no_dollar_append (left:list byte{no_dollar left}) (right:list byte{no_dollar right})
  : Lemma (no_dollar (L.append left right)) =
  match left with | [] -> () | _::rest -> no_dollar_append rest right

let rec join_split (bytes:list byte)
  : Lemma (join_dollar (split_dollar bytes) == bytes) =
  match bytes with | [] -> () | first::rest ->
    join_split rest;
    match split_dollar rest with | [] -> () | _::_ -> ()

let prepend_part (prefix:list byte) (parts:list (list byte)) : Tot (list (list byte)) =
  match parts with | [] -> [prefix] | first::rest -> L.append prefix first::rest

let rec split_prefix (prefix:list byte{no_dollar prefix}) (bytes:list byte)
  : Lemma (split_dollar (L.append prefix bytes) == prepend_part prefix (split_dollar bytes)) =
  match prefix with | [] -> (match split_dollar bytes with | [] -> () | _::_ -> ())
  | _::rest -> split_prefix rest bytes; match split_dollar bytes with | [] -> () | _::_ -> ()

let rec split_join (parts:list (list byte){parts<>[] /\ L.for_all no_dollar parts})
  : Lemma (split_dollar (join_dollar parts) == parts) =
  match parts with | [] -> () | [part] ->
    FStar.List.Tot.Properties.append_l_nil part; split_prefix part []
  | part::rest ->
    FStar.List.Tot.Properties.append_l_nil part;
    split_join rest; split_prefix part (36::join_dollar rest)

let rename_no_dollar (rename:identifier -> GTot identifier) (part:list byte{no_dollar part})
  : Lemma (no_dollar (rename_part rename part)) =
  let name,tail=span_name part in
  match reference_part part with | None -> () | Some (name,tail) ->
    name_has_no_dollar (rename name);
    let rec suffix_no_dollar (prefix:list byte) (suffix:list byte)
      : Lemma (requires no_dollar (L.append prefix suffix)) (ensures no_dollar suffix) =
      match prefix with | [] -> () | _::rest -> suffix_no_dollar rest suffix in
    suffix_no_dollar name tail;
    no_dollar_append (rename name) tail

let rec renamed_parts_no_dollar (rename:identifier -> GTot identifier)
  (parts:list (list byte){L.for_all no_dollar parts})
  : Lemma (L.for_all no_dollar (map_g (rename_part rename) parts)) =
  match parts with | [] -> () | part::rest ->
    rename_no_dollar rename part; renamed_parts_no_dollar rename rest

let renamed_template_roundtrip (rename:identifier -> GTot identifier)
  (parts:list (list byte){parts<>[] /\ L.for_all no_dollar parts})
  : Lemma
    (split_dollar (join_dollar (rename_template rename parts)) == rename_template rename parts) =
  match parts with | [] -> () | _::rest ->
    renamed_parts_no_dollar rename rest;
    split_join (rename_template rename parts)

let reference_delimited (part:list byte) (suffix:list byte)
  : Lemma
    (reference_part (L.append part (36::suffix)) ==
      (match reference_part part with | None -> None | Some (name,tail) -> Some (name,L.append tail (36::suffix)))) =
  let name,tail=span_name part in
  FStar.List.Tot.Properties.append_assoc name tail (36::suffix);
  (match tail with | [] -> () | _::_ -> ());
  span_append name (L.append tail (36::suffix));
  N.unicode_prefix_delimiter tail 36 suffix

let rec suffix_no_dollar (prefix:list byte) (suffix:list byte)
  : Lemma (requires no_dollar (L.append prefix suffix)) (ensures no_dollar suffix) =
  match prefix with | [] -> () | _::rest -> suffix_no_dollar rest suffix

let rec resolve_parts #a (resolve:identifier -> GTot a) (parts:list (list byte)) : GTot (list a) =
  match parts with | [] -> [] | part::rest ->
    let tail=resolve_parts resolve rest in
    match reference_part part with | None -> tail | Some (name,_) -> resolve name::tail

let resolve_template #a (resolve:identifier -> GTot a) (parts:list (list byte)) : GTot (list a) =
  match parts with | [] -> [] | _::references -> resolve_parts resolve references

let rec resolution_renamed_parts #a (rename:identifier -> GTot identifier)
  (before:identifier -> GTot a) (after:identifier -> GTot a) (parts:list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures resolve_parts after (map_g (rename_part rename) parts) == resolve_parts before parts) =
  match parts with | [] -> () | part::rest ->
    rename_reference rename part;
    resolution_renamed_parts rename before after rest

let resolution_renaming #a (rename:identifier -> GTot identifier)
  (before:identifier -> GTot a) (after:identifier -> GTot a) (parts:list (list byte))
  : Lemma
    (requires forall name. after (rename name) == before name)
    (ensures resolve_template after (rename_template rename parts) == resolve_template before parts) =
  match parts with | [] -> () | _::rest -> resolution_renamed_parts rename before after rest
