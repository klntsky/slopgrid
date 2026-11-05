module Slopgrid.Native

module L = FStar.List.Tot.Base

type byte = n:nat{n < 256}
(* Trusted native model: strings are represented by byte sequences. The
   contracts below are assumptions about native bindings, not checked proofs. *)
val byte_view : string -> GTot (list byte)
(* Trusted inverse contract: constructing a string from bytes recovers exactly
   those bytes, including sequences that are not valid UTF-8. *)
val bytes_string : bytes:list byte -> GTot (text:string{byte_view text == bytes})
let rec take_bytes (count:nat) (bytes:list byte) : Tot (list byte) =
  match bytes with | [] -> [] | first::rest -> if count=0 then [] else first::take_bytes (count - 1) rest
let rec drop_bytes (count:nat) (bytes:list byte) : Tot (list byte) =
  match bytes with | [] -> [] | _::rest -> if count=0 then bytes else drop_bytes (count - 1) rest
(* Trusted injectivity assumption: strings with the same bytes are equal. *)
val byte_view_injective : left:string -> right:string ->
  Lemma (requires byte_view left == byte_view right) (ensures left == right)
(* Trusted encoding assumption: the empty string has no bytes. *)
val empty_byte_view : unit -> Lemma (byte_view "" == [])
let low_byte (character:FStar.Char.char) : Tot byte = FStar.Char.int_of_char character % 256
(* Trusted ASCII encoding assumption: an all-ASCII string's byte view is its
   character-code list, without a multibyte encoding change. *)
val ascii_byte_view : text:string ->
  Lemma
    (requires L.for_all (fun character -> FStar.Char.int_of_char character < 128) (FStar.String.list_of_string text))
    (ensures byte_view text == L.map low_byte (FStar.String.list_of_string text))
(* Trusted length contract: native length counts bytes, not Unicode characters
   or JavaScript UTF-16 code units. *)
val length : text:string -> Tot (count:nat{count == L.length (byte_view text)})
(* Trusted slicing contract: slicing takes the requested bytes after dropping
   the start offset, with list-style truncation at either bound. *)
val slice : text:string -> start:nat -> count:nat ->
  Tot (result:string{byte_view result == take_bytes count (drop_bytes start (byte_view text))})
(* Trusted indexing contract: character access returns a one-byte string, or
   the empty string when the byte index is past the end. *)
val char_at : text:string -> index:nat ->
  Tot (result:string{byte_view result == take_bytes 1 (drop_bytes index (byte_view text))})
(* Trusted byte lookup contract: an in-range index returns that byte's code;
   an out-of-range index returns -1. *)
val byte_at : text:string -> index:nat ->
  Tot (result:int{result == (match L.nth (byte_view text) index with | None -> -1 | Some value -> value)})
val trim : string -> Tot string
val lower : string -> Tot string
val replace_all : string -> string -> string -> Tot string
(* Trusted prefix contract: prefix testing agrees with equality of the leading
   bytes, including the empty-prefix and too-short-string cases. *)
val starts_with : text:string -> prefix:string ->
  Tot (result:bool{result == (take_bytes (L.length (byte_view prefix)) (byte_view text) == byte_view prefix)})
val ends_with : string -> string -> Tot bool
val parse_nat : string -> Tot (option nat)
val nat_string : nat -> Tot string
(* Trusted concatenation contract: concatenating strings appends their byte
   sequences without changing either operand's bytes. *)
val concat : left:string -> right:string ->
  Tot (result:string{byte_view result == L.append (byte_view left) (byte_view right)})
val unicode_nonascii_alphanumeric_prefix : list byte -> GTot bool
let unicode_alphanumeric_prefix (bytes:list byte) : GTot bool =
  match bytes with | [] -> false | first::_ ->
    if first < 128 then
      (first >= 48 && first <= 57) || (first >= 65 && first <= 90) || (first >= 97 && first <= 122)
    else unicode_nonascii_alphanumeric_prefix bytes
(* Trusted Unicode locality assumption: adding an ASCII non-alphanumeric
   delimiter and any suffix cannot change whether a byte sequence starts with
   an alphanumeric character. *)
val unicode_prefix_delimiter : prefix:list byte ->
  delimiter:byte{delimiter < 128 /\
    not ((delimiter >= 48 && delimiter <= 57) || (delimiter >= 65 && delimiter <= 90) || (delimiter >= 97 && delimiter <= 122))} ->
  suffix:list byte ->
  Lemma (unicode_alphanumeric_prefix (L.append prefix (delimiter::suffix)) == unicode_alphanumeric_prefix prefix)
(* Trusted classifier contract: native alphanumeric testing at a byte offset
   agrees with the Unicode prefix model for the remaining bytes. *)
val unicode_alphanumeric_at : text:string -> index:nat ->
  Tot (result:bool{result == unicode_alphanumeric_prefix (drop_bytes index (byte_view text))})
