open Js_of_ocaml

type scalar = float
type finite = scalar
type positive = scalar
type nonnegative = scalar

let is_finite value = match classify_float value with FP_nan | FP_infinite -> false | _ -> true
let is_nan value = value <> value
let lt left right = left < right
let ieee_equal left right = left = right
let number_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(s){return Number(s)})"
let string_fn : Js.Unsafe.any = Js.Unsafe.js_expr "(function(n){return String(n)})"
let parse value =
  Js.float_of_number (Js.Unsafe.coerce (Js.Unsafe.fun_call number_fn [|Js.Unsafe.inject (Js.string value)|]))
let render value =
  Js.to_string (Js.Unsafe.coerce (Js.Unsafe.fun_call string_fn [|Js.Unsafe.inject (Js.number_of_float value)|]))
let multiply left right = left *. right
let to_nat value =
  if not (is_finite value) || value < 0. || floor value <> value then None
  else Some (Z.of_float value)
let from_nat value = Z.to_float value
let zero = 0.
let small_positive value =
  if Z.sign value <= 0 || Z.gt value (Z.of_int 2147483647) then invalid_arg "Expected bounded positive integer.";
  Z.to_float value
