module Slopgrid.Native

module List = FStar.List.Tot.Base

type byte = n: nat { n < 256 }

(* Template proofs read OCaml strings as byte lists. The OCaml and JavaScript
   code supplies these operations. F* assumes the contracts below. It does
   not check those native implementations. *)
val byte_view : string -> GTot (list byte)

(* Turn a byte list back into the same string bytes. The proof model also
   needs this for byte slices that are not complete UTF-8 characters. *)
val bytes_string : bytes: list byte -> GTot (text: string { byte_view text == bytes })

let rec take_bytes (count: nat) (bytes: list byte) : Tot (list byte) =
  match bytes with
  | [] -> []
  | first :: rest ->
    if count = 0 then [] else first :: take_bytes (count - 1) rest

let rec drop_bytes (count: nat) (bytes: list byte) : Tot (list byte) =
  match bytes with
  | [] -> []
  | _ :: rest ->
    if count = 0 then bytes else drop_bytes (count - 1) rest

(* The proofs can recover the same string from equal byte lists. This is an
   assumption about native strings, not a theorem proved in this module. *)
val byte_view_injective : left: string -> right: string ->
  Lemma
    (requires byte_view left == byte_view right)
    (ensures left == right)

(* An empty prompt contributes no bytes to the scanner. Native strings must
   satisfy this base case. *)
val empty_byte_view : unit -> Lemma (byte_view "" == [])

let low_byte (character: FStar.Char.char) : Tot byte =
  FStar.Char.int_of_char character % 256

(* ASCII names use their character codes as bytes. The rename proofs rely on
   this for ROW and COLUMN. It does not make Unicode characters one byte long. *)
val ascii_byte_view : text: string ->
  Lemma
    (requires List.for_all
      (fun character -> FStar.Char.int_of_char character < 128)
      (FStar.String.list_of_string text))
    (ensures byte_view text == List.map low_byte (FStar.String.list_of_string text))

(* The scanner's offsets count UTF-8 bytes. JavaScript string length counts
   UTF-16 code units instead, so it cannot replace this operation. *)
val length : text: string -> Tot (count: nat { count == List.length (byte_view text) })

(* Read at most count bytes after the start offset. A slice near the end of
   the prompt may be shorter, and an offset past the end gives an empty slice. *)
val slice : text: string -> start: nat -> count: nat ->
  Tot (result: string { byte_view result == take_bytes count (drop_bytes start (byte_view text)) })

(* Despite its name, this reads one byte, not one Unicode character. Rewriting
   walks those bytes without changing literal prompt text. Past the end it
   returns an empty string. *)
val char_at : text: string -> index: nat ->
  Tot (result: string { byte_view result == take_bytes 1 (drop_bytes index (byte_view text)) })

(* The token scanner gets a byte code here. Past the end it gets -1, so a
   reference at the end of the prompt needs no extra character after it. *)
val byte_at : text: string -> index: nat ->
  Tot (result: int {
    result ==
      (match List.nth (byte_view text) index with
       | None -> -1
       | Some value -> value)
  })

val trim : string -> Tot string

val lower : string -> Tot string

val replace_all : string -> string -> string -> Tot string

(* Prefix tests compare the actual bytes. An empty prefix matches. A longer
   prefix cannot match a shorter string. *)
val starts_with : text: string -> prefix: string ->
  Tot (result: bool {
    result == (take_bytes (List.length (byte_view prefix)) (byte_view text) == byte_view prefix)
  })

val ends_with : string -> string -> Tot bool

val parse_nat : string -> Tot (option nat)

val nat_string : nat -> Tot string

(* Join string bytes without decoding or rewriting them. The template proofs
   use this contract when they rebuild literal text around a renamed token. *)
val concat : left: string -> right: string ->
  Tot (result: string { byte_view result == List.append (byte_view left) (byte_view right) })

val unicode_nonascii_alphanumeric_prefix : list byte -> GTot bool

let unicode_alphanumeric_prefix (bytes: list byte) : GTot bool =
  match bytes with
  | [] -> false
  | first :: _ ->
    if first < 128 then
      (first >= 48 && first <= 57) ||
      (first >= 65 && first <= 90) ||
      (first >= 97 && first <= 122)
    else unicode_nonascii_alphanumeric_prefix bytes

(* Appending an ASCII separator and more text cannot change whether the prefix
   starts with a letter or digit. This assumed rule lets the proofs inspect
   one dollar-delimited part without depending on the later template text. *)
val unicode_prefix_delimiter : prefix: list byte ->
  delimiter: byte {
    delimiter < 128 /\
    not ((delimiter >= 48 && delimiter <= 57) ||
      (delimiter >= 65 && delimiter <= 90) ||
      (delimiter >= 97 && delimiter <= 122))
  } ->
  suffix: list byte ->
  Lemma (
    unicode_alphanumeric_prefix (List.append prefix (delimiter :: suffix)) ==
      unicode_alphanumeric_prefix prefix
  )

(* Check the text after a candidate token with the native Unicode classifier.
   This is how the scanner leaves lookalikes such as $ROW1suffix as literal
   text rather than replacing only their ROW1 prefix. PRODUCT.md 3.3.4.
   The agreement with the byte model remains a trusted contract. *)
val unicode_alphanumeric_at : text: string -> index: nat ->
  Tot (result: bool {
    result == unicode_alphanumeric_prefix (drop_bytes index (byte_view text))
  })
