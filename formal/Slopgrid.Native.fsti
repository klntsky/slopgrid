module Slopgrid.Native

module L = FStar.List.Tot.Base

type byte = n:nat{n < 256}
val byte_view : string -> GTot (list byte)
val bytes_string : bytes:list byte -> GTot (text:string{byte_view text == bytes})
let rec take_bytes (count:nat) (bytes:list byte) : Tot (list byte) =
  match bytes with | [] -> [] | first::rest -> if count=0 then [] else first::take_bytes (count - 1) rest
let rec drop_bytes (count:nat) (bytes:list byte) : Tot (list byte) =
  match bytes with | [] -> [] | _::rest -> if count=0 then bytes else drop_bytes (count - 1) rest
val byte_view_injective : left:string -> right:string ->
  Lemma (requires byte_view left == byte_view right) (ensures left == right)
val empty_byte_view : unit -> Lemma (byte_view "" == [])
let low_byte (character:FStar.Char.char) : Tot byte = FStar.Char.int_of_char character % 256
val ascii_byte_view : text:string ->
  Lemma
    (requires L.for_all (fun character -> FStar.Char.int_of_char character < 128) (FStar.String.list_of_string text))
    (ensures byte_view text == L.map low_byte (FStar.String.list_of_string text))
val length : text:string -> Tot (count:nat{count == L.length (byte_view text)})
val slice : text:string -> start:nat -> count:nat ->
  Tot (result:string{byte_view result == take_bytes count (drop_bytes start (byte_view text))})
val char_at : text:string -> index:nat ->
  Tot (result:string{byte_view result == take_bytes 1 (drop_bytes index (byte_view text))})
val byte_at : text:string -> index:nat ->
  Tot (result:int{result == (match L.nth (byte_view text) index with | None -> -1 | Some value -> value)})
val trim : string -> Tot string
val lower : string -> Tot string
val replace_all : string -> string -> string -> Tot string
val starts_with : text:string -> prefix:string ->
  Tot (result:bool{result == (take_bytes (L.length (byte_view prefix)) (byte_view text) == byte_view prefix)})
val ends_with : string -> string -> Tot bool
val parse_nat : string -> Tot (option nat)
val nat_string : nat -> Tot string
val concat : left:string -> right:string ->
  Tot (result:string{byte_view result == L.append (byte_view left) (byte_view right)})
val unicode_nonascii_alphanumeric_prefix : list byte -> GTot bool
let unicode_alphanumeric_prefix (bytes:list byte) : GTot bool =
  match bytes with | [] -> false | first::_ ->
    if first < 128 then
      (first >= 48 && first <= 57) || (first >= 65 && first <= 90) || (first >= 97 && first <= 122)
    else unicode_nonascii_alphanumeric_prefix bytes
val unicode_prefix_delimiter : prefix:list byte ->
  delimiter:byte{delimiter < 128 /\
    not ((delimiter >= 48 && delimiter <= 57) || (delimiter >= 65 && delimiter <= 90) || (delimiter >= 97 && delimiter <= 122))} ->
  suffix:list byte ->
  Lemma (unicode_alphanumeric_prefix (L.append prefix (delimiter::suffix)) == unicode_alphanumeric_prefix prefix)
val unicode_alphanumeric_at : text:string -> index:nat ->
  Tot (result:bool{result == unicode_alphanumeric_prefix (drop_bytes index (byte_view text))})
