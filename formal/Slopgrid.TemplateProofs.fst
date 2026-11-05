module Slopgrid.TemplateProofs

module N = Slopgrid.Native
module I = Slopgrid.Input
module T = Slopgrid.Template
module L = FStar.List.Tot.Base
open Prims

type byte = N.byte
let head_code (bytes:list byte) : Tot int = match bytes with | [] -> -1 | first::_ -> first
let rec bounded_name_count (fuel:nat) (bytes:list byte) : Tot nat =
  if fuel=0 then 0 else match bytes with | [] -> 0 | first::rest ->
    if T.name_byte first then 1 + bounded_name_count (fuel - 1) rest else 0

(* Indexing a byte list agrees with taking the head after dropping that many
   bytes, using -1 for an absent element in either representation. *)
let rec nth_drop (bytes:list byte) (index:nat)
  : Lemma ((match L.nth bytes index with | None -> -1 | Some value -> value) == head_code (N.drop_bytes index bytes)) =
  match bytes with | [] -> () | _::rest -> if index=0 then () else nth_drop rest (index - 1)

(* Dropping one more byte removes the head of the already-dropped list, or leaves
   an exhausted list empty. *)
let rec drop_successor (bytes:list byte) (index:nat)
  : Lemma (N.drop_bytes (index + 1) bytes == (match N.drop_bytes index bytes with | [] -> [] | _::rest -> rest)) =
  match bytes with | [] -> () | _::rest -> if index=0 then () else drop_successor rest (index - 1)

(* The runtime token-length scan counts exactly the leading name bytes in the
   suffix at the given byte position, bounded by the same fuel. *)
let rec token_length_model (fuel:nat) (text:string) (position:nat)
  : Lemma (I.token_length fuel text position == bounded_name_count fuel (N.drop_bytes position (N.byte_view text)))
  (decreases fuel) =
  nth_drop (N.byte_view text) position;
  if fuel=0 then () else
  match N.drop_bytes position (N.byte_view text) with | [] -> () | first::_ ->
    if not (T.name_byte first) then () else
    (drop_successor (N.byte_view text) position; token_length_model (fuel - 1) text (position + 1))

(* With fuel at least the byte-list length, bounded name counting returns the
   full length of the name prefix selected by the template model. *)
let rec count_span (fuel:nat) (bytes:list byte{fuel >= L.length bytes})
  : Lemma (bounded_name_count fuel bytes == L.length (fst (T.span_name bytes))) =
  match bytes with | [] -> () | first::rest ->
    if not (T.name_byte first) then () else count_span (fuel - 1) rest

(* Dropping any number of bytes cannot increase a byte list's length. *)
let rec drop_length (bytes:list byte) (index:nat)
  : Lemma (L.length (N.drop_bytes index bytes) <= L.length bytes) =
  match bytes with | [] -> () | _::rest -> if index=0 then () else drop_length rest (index - 1)

(* Taking as many bytes as a concatenated prefix contains recovers that prefix. *)
let rec take_append (prefix:list byte) (suffix:list byte)
  : Lemma (N.take_bytes (L.length prefix) (L.append prefix suffix) == prefix) =
  match prefix with | [] -> () | _::rest -> take_append rest suffix

(* Dropping as many bytes as a concatenated prefix contains recovers its suffix. *)
let rec drop_append (prefix:list byte) (suffix:list byte)
  : Lemma (N.drop_bytes (L.length prefix) (L.append prefix suffix) == suffix) =
  match prefix with | [] -> () | _::rest -> drop_append rest suffix

(* Dropping two byte counts in sequence equals dropping their sum at once. *)
let rec drop_add (bytes:list byte) (first:nat) (second:nat)
  : Lemma (N.drop_bytes (first + second) bytes == N.drop_bytes second (N.drop_bytes first bytes)) =
  match bytes with | [] -> () | _::rest -> if first=0 then () else drop_add rest (first - 1) second

(* A runtime token match at a byte position agrees with the model after a dollar:
   its name bytes, consumed count (including the dollar), and remaining suffix coincide.
   If no token is found at a dollar, the model also rejects that reference. *)
let token_at_model (text:string) (position:nat)
  : Lemma
    (ensures (match I.token_at text position with
      | None -> (match N.drop_bytes position (N.byte_view text) with
        | 36::rest -> T.reference_part rest == None | _ -> True)
      | Some (name,count) ->
        (match N.drop_bytes position (N.byte_view text) with
        | 36::rest -> (match T.reference_part rest with | None -> False | Some (reference,tail) ->
          N.byte_view name == reference /\ count == L.length reference + 1 /\
          N.drop_bytes (position + count) (N.byte_view text) == tail)
        | _ -> False))) =
  nth_drop (N.byte_view text) position;
  match N.drop_bytes position (N.byte_view text) with
  | [] -> ()
  | first::rest -> if first<>36 then () else (
    drop_successor (N.byte_view text) position;
    token_length_model (N.length text) text (position + 1);
    drop_length (N.byte_view text) (position + 1);
    count_span (N.length text) rest;
    let name,tail=T.span_name rest in
    take_append name tail;
    drop_append name tail;
    drop_add (N.byte_view text) (position + 1) (L.length name);
    nth_drop (N.byte_view text) (position + 1 + L.length name);
    match tail with | [] -> () | next::_ -> ())

let rec rewrite_bytes (fuel:nat) (rename:T.identifier -> GTot (list byte)) (bytes:list byte)
  : GTot (list byte) (decreases fuel) =
  if fuel=0 then [] else match bytes with | [] -> [] | first::rest ->
    if first=36 then match T.reference_part rest with
      | Some (name,tail) -> L.append (36::rename name) (rewrite_bytes (fuel - 1) rename tail)
      | None -> first::rewrite_bytes (fuel - 1) rename rest
    else first::rewrite_bytes (fuel - 1) rename rest

let valid_renamer (rename:string -> Tot string) : prop =
  forall (name:T.identifier).
    let renamed=N.byte_view (rename (N.bytes_string name)) in renamed<>[] /\ T.name_bytes renamed

(* Converting a runtime-renamed identifier to bytes yields a nonempty name-byte
   list whenever the runtime renamer satisfies valid_renamer. *)
let runtime_rename (rename:string -> Tot string) (name:T.identifier)
  : GTot (result:list byte{valid_renamer rename ==> (result<>[] /\ T.name_bytes result)}) =
  N.byte_view (rename (N.bytes_string name))

(* At any byte position and with the same fuel, the runtime rewrite scanner's
   output bytes equal the bounded byte-list rewrite of the remaining suffix. *)
let rec rewrite_scan_model (fuel:nat) (rename:string -> Tot string) (text:string) (position:nat)
  : Lemma
    (N.byte_view (I.rewrite_scan fuel rename text position) ==
      rewrite_bytes fuel (runtime_rename rename) (N.drop_bytes position (N.byte_view text)))
    (decreases fuel) =
  N.empty_byte_view ();
  N.ascii_byte_view "$";
  if fuel=0 || position >= N.length text then (
    (* Dropping at least a byte list's length leaves the empty list. *)
    let rec exhausted (bytes:list byte) (index:nat)
      : Lemma (requires index >= L.length bytes) (ensures N.drop_bytes index bytes == []) =
      match bytes with | [] -> () | _::rest -> exhausted rest (index - 1) in
    if position >= N.length text then exhausted (N.byte_view text) position else ())
  else (
    token_at_model text position;
    nth_drop (N.byte_view text) position;
    match I.token_at text position with
    | None ->
      drop_successor (N.byte_view text) position;
      rewrite_scan_model (fuel - 1) rename text (position + 1);
      (match N.drop_bytes position (N.byte_view text) with | [] -> () | _::_ -> ())
    | Some (name,count) ->
      (match N.drop_bytes position (N.byte_view text) with
       | [] -> () | first::rest ->
         match T.reference_part rest with | None -> () | Some (reference,tail) ->
           N.byte_view_injective name (N.bytes_string reference);
           rewrite_scan_model (fuel - 1) rename text (position + count)))

(* Rewriting a whole runtime string produces exactly the bounded byte-list
   rewrite, using the original byte length as fuel. *)
let rewrite_text_model (rename:string -> Tot string) (text:string)
  : Lemma
    (N.byte_view (I.rewrite_text rename text) ==
      rewrite_bytes (L.length (N.byte_view text)) (runtime_rename rename) (N.byte_view text)) =
  rewrite_scan_model (N.length text) rename text 0

let rec rewrite_complete (rename:T.identifier -> GTot (list byte)) (bytes:list byte)
  : GTot (list byte) (decreases (L.length bytes)) =
  match bytes with | [] -> [] | first::rest ->
    if first=36 then match T.reference_part rest with
      | Some (name,tail) -> L.append (36::rename name) (rewrite_complete rename tail)
      | None -> first::rewrite_complete rename rest
    else first::rewrite_complete rename rest

(* Fuel at least the input byte length suffices for the bounded byte rewrite to
   equal the complete rewrite, regardless of the replacement byte lengths. *)
let rec complete_fuel (fuel:nat) (rename:T.identifier -> GTot (list byte))
  (bytes:list byte{fuel >= L.length bytes})
  : Lemma (rewrite_bytes fuel rename bytes == rewrite_complete rename bytes)
    (decreases (L.length bytes)) =
  match bytes with | [] -> () | first::rest ->
    if first=36 then match T.reference_part rest with
      | Some (_,tail) -> complete_fuel (fuel - 1) rename tail
      | None -> complete_fuel (fuel - 1) rename rest
    else complete_fuel (fuel - 1) rename rest

(* Complete rewriting copies a dollar-free prefix literally and rewrites only
   the suffix that follows it. *)
let rec rewrite_literal_prefix (rename:T.identifier -> GTot (list byte))
  (prefix:list byte{T.no_dollar prefix}) (suffix:list byte)
  : Lemma
    (rewrite_complete rename (L.append prefix suffix) == L.append prefix (rewrite_complete rename suffix)) =
  match prefix with | [] -> () | _::rest -> rewrite_literal_prefix rename rest suffix

(* For a dollar-free part between dollar delimiters, complete rewriting renames
   that part as the template model does and independently rewrites the next suffix. *)
let rewrite_join_parts (rename:T.identifier -> GTot T.identifier)
  (part:list byte{T.no_dollar part}) (suffix:list byte)
  : Lemma
    (rewrite_complete rename (36::L.append part (36::suffix)) ==
      L.append (36::T.rename_part rename part) (rewrite_complete rename (36::suffix))) =
  T.reference_delimited part suffix;
  match T.reference_part part with
  | None -> rewrite_literal_prefix rename part (36::suffix)
  | Some (name,tail) ->
    T.suffix_no_dollar name tail;
    rewrite_literal_prefix rename tail (36::suffix);
    FStar.List.Tot.Properties.append_assoc (36::rename name) tail (rewrite_complete rename (36::suffix))

(* For a final dollar-free part after a dollar, complete rewriting preserves the
   dollar and gives exactly the model's renamed part. *)
let rewrite_last_part (rename:T.identifier -> GTot T.identifier)
  (part:list byte{T.no_dollar part})
  : Lemma (rewrite_complete rename (36::part) == 36::T.rename_part rename part) =
  match T.reference_part part with
  | None ->
    FStar.List.Tot.Properties.append_l_nil part;
    rewrite_literal_prefix rename part []
  | Some (name,tail) ->
    T.suffix_no_dollar name tail;
    FStar.List.Tot.Properties.append_l_nil tail;
    rewrite_literal_prefix rename tail []

(* Joining dollar-free reference parts behind a leading dollar and rewriting
   equals renaming each part and then joining, with that leading dollar preserved. *)
let rec rewrite_references_parts (rename:T.identifier -> GTot T.identifier)
  (parts:list (list byte){L.for_all T.no_dollar parts})
  : Lemma
    (rewrite_complete rename (36::T.join_dollar parts) ==
      36::T.join_dollar (T.map_g (T.rename_part rename) parts)) =
  match parts with
  | [] -> ()
  | [part] -> rewrite_last_part rename part
  | part::rest ->
    rewrite_join_parts rename part (T.join_dollar rest);
    rewrite_references_parts rename rest

(* Complete rewriting of joined nonempty, dollar-free template parts agrees
   byte-for-byte with joining the renamed parts, leaving the initial literal intact. *)
let rewrite_template_parts (rename:T.identifier -> GTot T.identifier)
  (parts:list (list byte){parts<>[] /\ L.for_all T.no_dollar parts})
  : Lemma
    (rewrite_complete rename (T.join_dollar parts) ==
      T.join_dollar (T.rename_template rename parts)) =
  match parts with
  | [] -> ()
  | [literal] ->
    FStar.List.Tot.Properties.append_l_nil literal;
    rewrite_literal_prefix rename literal []
  | literal::rest ->
    rewrite_literal_prefix rename literal (36::T.join_dollar rest);
    rewrite_references_parts rename rest

(* When the runtime renamer returns valid identifiers, parsing its rewritten
   text yields exactly the model-renamed original dollar-separated parts. *)
let rewrite_text_parses (rename:string -> Tot string{valid_renamer rename}) (text:string)
  : Lemma
    (T.split_dollar (N.byte_view (I.rewrite_text rename text)) ==
      T.rename_template (runtime_rename rename) (T.split_dollar (N.byte_view text))) =
  rewrite_text_model rename text;
  complete_fuel (L.length (N.byte_view text)) (runtime_rename rename) (N.byte_view text);
  T.join_split (N.byte_view text);
  rewrite_template_parts (runtime_rename rename) (T.split_dollar (N.byte_view text));
  T.renamed_template_roundtrip (runtime_rename rename) (T.split_dollar (N.byte_view text))

let effective_text (resolve:T.identifier -> GTot (list byte)) (text:string) : GTot (list byte) =
  T.expand_template resolve (T.split_dollar (N.byte_view text))

(* Runtime rewriting preserves the literal-expanded byte sequence when renames
   are valid and the new resolver returns the old value for every renamed identifier. *)
let rewrite_expansion (rename:string -> Tot string{valid_renamer rename})
  (before:T.identifier -> GTot (list byte)) (after:T.identifier -> GTot (list byte)) (text:string)
  : Lemma
    (requires forall name. after (runtime_rename rename name) == before name)
    (ensures effective_text after (I.rewrite_text rename text) == effective_text before text) =
  rewrite_text_parses rename text;
  T.expansion_renaming (runtime_rename rename) before after (T.split_dollar (N.byte_view text))

let effective_references #a (resolve:T.identifier -> GTot a) (text:string) : GTot (list a) =
  T.resolve_template resolve (T.split_dollar (N.byte_view text))

(* Runtime rewriting preserves the exact ordered list of resolved references
   when renames are valid and old and renamed identifiers have equal resolver values. *)
let rewrite_resolution #a (rename:string -> Tot string{valid_renamer rename})
  (before:T.identifier -> GTot a) (after:T.identifier -> GTot a) (text:string)
  : Lemma
    (requires forall name. after (runtime_rename rename name) == before name)
    (ensures effective_references after (I.rewrite_text rename text) == effective_references before text) =
  rewrite_text_parses rename text;
  T.resolution_renaming (runtime_rename rename) before after (T.split_dollar (N.byte_view text))
