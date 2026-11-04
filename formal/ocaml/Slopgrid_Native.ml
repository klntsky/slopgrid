open Js_of_ocaml

let js_call function_ arguments = Js.Unsafe.fun_call function_ arguments
let string_arg value = Js.Unsafe.inject (Js.string value)
let string_result value = Js.to_string (Js.Unsafe.coerce value)
let bool_result value = Js.to_bool (Js.Unsafe.coerce value)

let length value = Z.of_int (String.length value)

let bounded_index value bound =
  if Z.sign value <= 0 then 0
  else if Z.geq value (Z.of_int bound) then bound
  else Z.to_int value

let slice value start count =
  let start = bounded_index start (String.length value) in
  let count = bounded_index count (String.length value - start) in
  String.sub value start count

let char_at value index = slice value index Z.one

let trim_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s){return s.trim()})"
let lower_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s){return s.toLowerCase()})"
let replace_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s,n,r){return s.replaceAll(n,function(){return r})})"
let starts_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s,p){return s.startsWith(p)})"
let ends_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s,p){return s.endsWith(p)})"
let natural_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s){var n=Number(s);return Number.isFinite(n)&&Number.isInteger(n)&&n>=0?BigInt(n).toString():''})"
let unicode_alphanumeric_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s){return /^[\\p{L}\\p{N}]/u.test(s)})"

let trim value = string_result (js_call trim_fn [|string_arg value|])
let lower value = string_result (js_call lower_fn [|string_arg value|])
let replace_all value needle replacement =
  string_result (js_call replace_fn [|string_arg value; string_arg needle; string_arg replacement|])
let starts_with value prefix = bool_result (js_call starts_fn [|string_arg value; string_arg prefix|])
let ends_with value suffix = bool_result (js_call ends_fn [|string_arg value; string_arg suffix|])
let parse_nat value =
  match string_result (js_call natural_fn [|string_arg value|]) with
  | "" -> None
  | number -> Some (Z.of_string number)
let nat_string = Z.to_string
let concat left right = left ^ right
let unicode_alphanumeric_at value index =
  let size = String.length value in
  let start = bounded_index index size in
  if start = size then false
  else
    let first = Char.code value.[start] in
    let width =
      if first < 0x80 then 1
      else if first land 0xe0 = 0xc0 then 2
      else if first land 0xf0 = 0xe0 then 3
      else if first land 0xf8 = 0xf0 then 4
      else 1
    in
    let codepoint = String.sub value start (min width (size - start)) in
    bool_result (js_call unicode_alphanumeric_fn [|string_arg codepoint|])
