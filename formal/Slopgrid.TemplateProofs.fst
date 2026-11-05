module Slopgrid.TemplateProofs

(* Connect Input's string scanner to Template's byte-list parser. Native's
   byte indexing, slicing, and Unicode contracts are trusted here, not proved.
   These lemmas let transpose proofs use the actual reference rewrite without
   treating literal field contents as templates. PRODUCT.md 3.3.4 and 3.3.7. *)

module Native = Slopgrid.Native
module Input = Slopgrid.Input
module Template = Slopgrid.Template
module List = FStar.List.Tot.Base
open Prims

type byte = Native.byte

let head_code (bytes: list byte) : Tot int =
  match bytes with
  | [] -> -1
  | first :: _ -> first

let rec bounded_name_count (fuel: nat) (bytes: list byte) : Tot nat =
  if fuel = 0 then
    0
  else
    match bytes with
    | [] -> 0
    | first :: rest ->
      if Template.name_byte first then
        1 + bounded_name_count (fuel - 1) rest
      else
        0

(* Relate the scanner's byte lookup to the remaining parser input.
   Both use -1 after the input ends, so an exhausted scan cannot find a name. *)
let rec nth_drop (bytes: list byte) (index: nat)
  : Lemma
    ((match List.nth bytes index with
      | None -> -1
      | Some value -> value) == head_code (Native.drop_bytes index bytes)) =
  match bytes with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then () else nth_drop rest (index - 1)

(* Moving the scanner one byte forward removes the parser input's head.
   At the end, both descriptions stay exhausted. *)
let rec drop_successor (bytes: list byte) (index: nat)
  : Lemma
    (Native.drop_bytes (index + 1) bytes ==
      (match Native.drop_bytes index bytes with
       | [] -> []
       | _ :: rest -> rest)) =
  match bytes with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then () else drop_successor rest (index - 1)

(* The string scanner reads the same uppercase name bytes as the parser.
   Both stop at the first byte outside the allowed name alphabet. *)
let rec token_length_model (fuel: nat) (text: string) (position: nat)
  : Lemma
    (Input.token_length fuel text position ==
      bounded_name_count fuel (Native.drop_bytes position (Native.byte_view text)))
    (decreases fuel) =
  nth_drop (Native.byte_view text) position;
  if fuel = 0 then
    ()
  else
    match Native.drop_bytes position (Native.byte_view text) with
    | [] -> ()
    | first :: _ ->
      if not (Template.name_byte first) then
        ()
      else
        (drop_successor (Native.byte_view text) position;
         token_length_model (fuel - 1) text (position + 1))

(* Input length supplies enough fuel to read the entire name prefix.
   Fuel must not cut ROW10 down to a shorter apparent name. *)
let rec count_span (fuel: nat) (bytes: list byte{fuel >= List.length bytes})
  : Lemma (bounded_name_count fuel bytes == List.length (fst (Template.span_name bytes))) =
  match bytes with
  | [] -> ()
  | first :: rest ->
    if not (Template.name_byte first) then () else count_span (fuel - 1) rest

(* A remaining scanner suffix fits within the original input-length fuel. *)
let rec drop_length (bytes: list byte) (index: nat)
  : Lemma (List.length (Native.drop_bytes index bytes) <= List.length bytes) =
  match bytes with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then () else drop_length rest (index - 1)

(* Slicing out the scanned name recovers its exact bytes, without its tail. *)
let rec take_append (prefix: list byte) (suffix: list byte)
  : Lemma (Native.take_bytes (List.length prefix) (List.append prefix suffix) == prefix) =
  match prefix with
  | [] -> ()
  | _ :: rest -> take_append rest suffix

(* Advancing past the scanned name leaves exactly the parser's old tail. *)
let rec drop_append (prefix: list byte) (suffix: list byte)
  : Lemma (Native.drop_bytes (List.length prefix) (List.append prefix suffix) == suffix) =
  match prefix with
  | [] -> ()
  | _ :: rest -> drop_append rest suffix

(* Combine the dollar step and name step into the scanner's next byte offset. *)
let rec drop_add (bytes: list byte) (first: nat) (second: nat)
  : Lemma
    (Native.drop_bytes (first + second) bytes ==
      Native.drop_bytes second (Native.drop_bytes first bytes)) =
  match bytes with
  | [] -> ()
  | _ :: rest ->
    if first = 0 then () else drop_add rest (first - 1) second

(* The runtime scanner recognizes exactly the parser's whole token at a dollar,
   with the same name and next byte offset. Lowercase or Unicode alphanumeric
   continuations reject a partial match under Native's trusted classifier.
   PRODUCT.md 3.3.4. *)
let token_at_model (text: string) (position: nat)
  : Lemma
    (ensures (match Input.token_at text position with
      | None ->
        (match Native.drop_bytes position (Native.byte_view text) with
         | 36 :: rest -> Template.reference_part rest == None
         | _ -> True)
      | Some (name, count) ->
        (match Native.drop_bytes position (Native.byte_view text) with
         | 36 :: rest ->
           (match Template.reference_part rest with
            | None -> False
            | Some (reference, tail) ->
              Native.byte_view name == reference /\ count == List.length reference + 1 /\
              Native.drop_bytes (position + count) (Native.byte_view text) == tail)
         | _ -> False))) =
  nth_drop (Native.byte_view text) position;
  match Native.drop_bytes position (Native.byte_view text) with
  | [] -> ()
  | first :: rest ->
    if first <> 36 then
      ()
    else (
      drop_successor (Native.byte_view text) position;
      token_length_model (Native.length text) text (position + 1);
      drop_length (Native.byte_view text) (position + 1);
      count_span (Native.length text) rest;
      let name, tail = Template.span_name rest in
      take_append name tail;
      drop_append name tail;
      drop_add (Native.byte_view text) (position + 1) (List.length name);
      nth_drop (Native.byte_view text) (position + 1 + List.length name);
      match tail with
      | [] -> ()
      | next :: _ -> ())

(* Model a rename as a scan of the old bytes. Replacement bytes go straight
   into the result. The recursive call resumes at the old token's tail. *)
let rec rewrite_bytes (fuel: nat) (rename: Template.identifier -> GTot (list byte))
  (bytes: list byte)
  : GTot (list byte) (decreases fuel) =
  if fuel = 0 then
    []
  else
    match bytes with
    | [] -> []
    | first :: rest ->
      if first = 36 then
        match Template.reference_part rest with
        | Some (name, tail) ->
          List.append (36 :: rename name) (rewrite_bytes (fuel - 1) rename tail)
        | None -> first :: rewrite_bytes (fuel - 1) rename rest
      else
        first :: rewrite_bytes (fuel - 1) rename rest

let valid_renamer (rename: string -> Tot string) : prop =
  forall (name: Template.identifier).
    let renamed = Native.byte_view (rename (Native.bytes_string name)) in
    renamed <> [] /\ Template.name_bytes renamed

(* Adapt a string renamer to the byte parser. The valid_renamer assumption is
   essential: a replacement must remain one nonempty identifier. *)
let runtime_rename (rename: string -> Tot string) (name: Template.identifier)
  : GTot (result: list byte{
      valid_renamer rename ==> (result <> [] /\ Template.name_bytes result)}) =
  Native.byte_view (rename (Native.bytes_string name))

(* Each runtime scan step copies a literal byte or rewrites one whole token,
   just like the byte model. Both continue through the original input only. *)
let rec rewrite_scan_model (fuel: nat) (rename: string -> Tot string) (text: string)
  (position: nat)
  : Lemma
    (Native.byte_view (Input.rewrite_scan fuel rename text position) ==
      rewrite_bytes fuel (runtime_rename rename)
        (Native.drop_bytes position (Native.byte_view text)))
    (decreases fuel) =
  Native.empty_byte_view ();
  Native.ascii_byte_view "$";
  if fuel = 0 || position >= Native.length text then (
    (* Once the byte offset reaches the end, the parser has no input left. *)
    let rec exhausted (bytes: list byte) (index: nat)
      : Lemma
        (requires index >= List.length bytes)
        (ensures Native.drop_bytes index bytes == []) =
      match bytes with
      | [] -> ()
      | _ :: rest -> exhausted rest (index - 1)
    in
    if position >= Native.length text then
      exhausted (Native.byte_view text) position
    else
      ())
  else (
    token_at_model text position;
    nth_drop (Native.byte_view text) position;
    match Input.token_at text position with
    | None ->
      drop_successor (Native.byte_view text) position;
      rewrite_scan_model (fuel - 1) rename text (position + 1);
      (match Native.drop_bytes position (Native.byte_view text) with
       | [] -> ()
       | _ :: _ -> ())
    | Some (name, count) ->
      (match Native.drop_bytes position (Native.byte_view text) with
       | [] -> ()
       | first :: rest ->
         match Template.reference_part rest with
         | None -> ()
         | Some (reference, tail) ->
           Native.byte_view_injective name (Native.bytes_string reference);
           rewrite_scan_model (fuel - 1) rename text (position + count)))

(* A whole-string rewrite uses its original byte length as fuel and matches
   the byte scanner from offset zero. *)
let rewrite_text_model (rename: string -> Tot string) (text: string)
  : Lemma
    (Native.byte_view (Input.rewrite_text rename text) ==
      rewrite_bytes (List.length (Native.byte_view text)) (runtime_rename rename)
        (Native.byte_view text)) =
  rewrite_scan_model (Native.length text) rename text 0

let rec rewrite_complete (rename: Template.identifier -> GTot (list byte)) (bytes: list byte)
  : GTot (list byte) (decreases (List.length bytes)) =
  match bytes with
  | [] -> []
  | first :: rest ->
    if first = 36 then
      match Template.reference_part rest with
      | Some (name, tail) ->
        List.append (36 :: rename name) (rewrite_complete rename tail)
      | None -> first :: rewrite_complete rename rest
    else
      first :: rewrite_complete rename rest

(* Original input length is enough fuel even if renamed names grow. Inserted
   bytes are never scanned, so their length cannot exhaust the fuel. *)
let rec complete_fuel (fuel: nat) (rename: Template.identifier -> GTot (list byte))
  (bytes: list byte{fuel >= List.length bytes})
  : Lemma (rewrite_bytes fuel rename bytes == rewrite_complete rename bytes)
    (decreases (List.length bytes)) =
  match bytes with
  | [] -> ()
  | first :: rest ->
    if first = 36 then
      match Template.reference_part rest with
      | Some (_, tail) -> complete_fuel (fuel - 1) rename tail
      | None -> complete_fuel (fuel - 1) rename rest
    else
      complete_fuel (fuel - 1) rename rest

(* Copy literal text up to the next dollar without consulting the renamer.
   Only the remaining suffix can contain a reference. *)
let rec rewrite_literal_prefix (rename: Template.identifier -> GTot (list byte))
  (prefix: list byte{Template.no_dollar prefix}) (suffix: list byte)
  : Lemma
    (rewrite_complete rename (List.append prefix suffix) ==
      List.append prefix (rewrite_complete rename suffix)) =
  match prefix with
  | [] -> ()
  | _ :: rest -> rewrite_literal_prefix rename rest suffix

(* Rewriting one dollar-separated part agrees with renaming its parsed name.
   The next dollar starts a separate scan step, even after a rejected token. *)
let rewrite_join_parts (rename: Template.identifier -> GTot Template.identifier)
  (part: list byte{Template.no_dollar part}) (suffix: list byte)
  : Lemma
    (rewrite_complete rename (36 :: List.append part (36 :: suffix)) ==
      List.append (36 :: Template.rename_part rename part)
        (rewrite_complete rename (36 :: suffix))) =
  Template.reference_delimited part suffix;
  match Template.reference_part part with
  | None -> rewrite_literal_prefix rename part (36 :: suffix)
  | Some (name, tail) ->
    Template.suffix_no_dollar name tail;
    rewrite_literal_prefix rename tail (36 :: suffix);
    FStar.List.Tot.Properties.append_assoc (36 :: rename name) tail
      (rewrite_complete rename (36 :: suffix))

(* Handle the last dollar-separated part, where there is no later delimiter.
   Keep its dollar and rename only the name recognized by the parser. *)
let rewrite_last_part (rename: Template.identifier -> GTot Template.identifier)
  (part: list byte{Template.no_dollar part})
  : Lemma
    (rewrite_complete rename (36 :: part) == 36 :: Template.rename_part rename part) =
  match Template.reference_part part with
  | None ->
    FStar.List.Tot.Properties.append_l_nil part;
    rewrite_literal_prefix rename part []
  | Some (name, tail) ->
    Template.suffix_no_dollar name tail;
    FStar.List.Tot.Properties.append_l_nil tail;
    rewrite_literal_prefix rename tail []

(* Repeat the per-part argument through all references. Rebuilding the string
   preserves the original dollar boundaries rather than rescanning new names. *)
let rec rewrite_references_parts (rename: Template.identifier -> GTot Template.identifier)
  (parts: list (list byte){List.for_all Template.no_dollar parts})
  : Lemma
    (rewrite_complete rename (36 :: Template.join_dollar parts) ==
      36 :: Template.join_dollar (Template.map_g (Template.rename_part rename) parts)) =
  match parts with
  | [] -> ()
  | [part] -> rewrite_last_part rename part
  | part :: rest ->
    rewrite_join_parts rename part (Template.join_dollar rest);
    rewrite_references_parts rename rest

(* The complete byte scanner and the split-parts parser produce the same
   renamed string. Both leave text before the first dollar untouched. *)
let rewrite_template_parts (rename: Template.identifier -> GTot Template.identifier)
  (parts: list (list byte){parts <> [] /\ List.for_all Template.no_dollar parts})
  : Lemma
    (rewrite_complete rename (Template.join_dollar parts) ==
      Template.join_dollar (Template.rename_template rename parts)) =
  match parts with
  | [] -> ()
  | [literal] ->
    FStar.List.Tot.Properties.append_l_nil literal;
    rewrite_literal_prefix rename literal []
  | literal :: rest ->
    rewrite_literal_prefix rename literal (36 :: Template.join_dollar rest);
    rewrite_references_parts rename rest

(* Reparse Input's rewritten text and obtain exactly the parser's renamed
   parts. This requires valid replacement identifiers, not arbitrary strings.
   The transpose proof uses this bridge before comparing expanded cells. *)
let rewrite_text_parses (rename: string -> Tot string{valid_renamer rename}) (text: string)
  : Lemma
    (Template.split_dollar (Native.byte_view (Input.rewrite_text rename text)) ==
      Template.rename_template (runtime_rename rename)
        (Template.split_dollar (Native.byte_view text))) =
  rewrite_text_model rename text;
  complete_fuel (List.length (Native.byte_view text)) (runtime_rename rename)
    (Native.byte_view text);
  Template.join_split (Native.byte_view text);
  rewrite_template_parts (runtime_rename rename) (Template.split_dollar (Native.byte_view text));
  Template.renamed_template_roundtrip (runtime_rename rename)
    (Template.split_dollar (Native.byte_view text))

let effective_text (resolve: Template.identifier -> GTot (list byte)) (text: string)
  : GTot (list byte) =
  Template.expand_template resolve (Template.split_dollar (Native.byte_view text))

(* Rewriting references preserves expanded text if each new name resolves to
   the old field text. Expansion inserts that text literally once, not as
   another template. This is conditional, not validation of arbitrary renames.
   PRODUCT.md 3.3.2 and 3.3.4. *)
let rewrite_expansion (rename: string -> Tot string{valid_renamer rename})
  (before: Template.identifier -> GTot (list byte))
  (after: Template.identifier -> GTot (list byte)) (text: string)
  : Lemma
    (requires forall name. after (runtime_rename rename name) == before name)
    (ensures
      effective_text after (Input.rewrite_text rename text) == effective_text before text) =
  rewrite_text_parses rename text;
  Template.expansion_renaming (runtime_rename rename) before after
    (Template.split_dollar (Native.byte_view text))

let effective_references #a (resolve: Template.identifier -> GTot a) (text: string)
  : GTot (list a) =
  Template.resolve_template resolve (Template.split_dollar (Native.byte_view text))

(* Rewriting keeps the same resolver results in mention order when new names
   still find the old fields. This supports separate generator and judge
   reference comparisons. It does not deduplicate their images.
   PRODUCT.md 3.3.2 and 3.3.5. *)
let rewrite_resolution #a (rename: string -> Tot string{valid_renamer rename})
  (before: Template.identifier -> GTot a) (after: Template.identifier -> GTot a) (text: string)
  : Lemma
    (requires forall name. after (runtime_rename rename name) == before name)
    (ensures
      effective_references after (Input.rewrite_text rename text) ==
        effective_references before text) =
  rewrite_text_parses rename text;
  Template.resolution_renaming (runtime_rename rename) before after
    (Template.split_dollar (Native.byte_view text))
