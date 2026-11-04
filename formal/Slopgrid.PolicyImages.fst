module Slopgrid.PolicyImages

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module B = Slopgrid.PolicyBase

let provider_support (states:list string) : Tot string =
  if B.member "supported" states then "supported" else if B.member "unknown" states then "unknown" else "unsupported"
let combination_support (states:list string) : Tot string =
  if B.member "unsupported" states then "unsupported" else if B.member "unknown" states then "unknown" else "supported"
let parameter_name (kind:string) : Tot string =
  if kind = "input_references" then "Input images" else if kind = "aspect_ratio" then "Aspect ratio"
  else if kind = "size" then "Size" else if kind = "quality" then "Quality" else "Background"
let parameter_support (parameters:D.json) (kind:string) (settings:D.json) : Tot string =
  let setting = D.get settings kind in
  let refs = kind = "input_references" in
  let count = L.length (D.items setting) in
  if not refs && B.is_null setting then "supported" else
  let pixels = kind = "size" && (match B.pixels (D.str setting) with | Some _ -> true | None -> false) in
  let capability = D.get parameters (if kind = "size" && not pixels then "resolution" else kind) in
  if not (B.truth capability) then
    if refs && count = 0 then "supported"
    else if pixels && (B.truth (D.get parameters "resolution") || B.truth (D.get parameters "aspect_ratio")) then "unknown"
    else "unsupported"
  else let typ = D.str (D.get capability "type") in
  if typ = "enum" && D.has capability "values" then
    if B.member (if refs then N.nat_string count else D.str setting) (D.strings (D.get capability "values")) then "supported" else "unsupported"
  else if typ = "range" && D.has capability "min" then
    if refs && N.compare_number (N.nat_string count) (match D.get capability "min" with | D.JNumber n -> n | _ -> "NaN") >= 0 &&
      N.compare_number (N.nat_string count) (match D.get capability "max" with | D.JNumber n -> n | _ -> "NaN") <= 0 then "supported" else "unsupported"
  else if typ = "boolean" then "supported" else "unknown"
let conflict (kinds:list string) (state:string) (reason:string) (dependent:bool) : Tot D.json =
  D.object [("parameters",D.array (L.map D.string kinds));("support",D.string state);("reason",D.string reason);("modelDependent",D.JBool dependent)]
let rec mask_kinds (mask:nat) (kinds:list string) : Tot (list string) (decreases kinds) =
  match kinds with | [] -> [] | h::t -> (if mask % 2 = 1 then [h] else []) @ mask_kinds (mask / 2) t
let rec masks (count:nat) (first:nat) : Tot (list nat) (decreases count) = if count = 0 then [] else first :: masks (count-1) (first+1)
let subset (a:list string) (b:list string) : Tot bool = L.for_all (fun x -> B.member x b) a
let describe (settings:D.json) (kind:string) : Tot string =
  B.cat (B.cat (parameter_name kind) ": ")
    (if kind = "input_references" then B.cat (N.nat_string (L.length (D.items (D.get settings kind)))) " images"
      else if B.is_null (D.get settings kind) then "Auto" else D.str (D.get settings kind))
let image_conflicts (endpoints:list D.json) (settings:D.json) : Tot (list D.json) =
  let settings = B.normalize_settings settings in
  let states = L.map (fun endpoint ->
    L.map (fun kind -> (kind,parameter_support (D.get endpoint "supported_parameters") kind settings)) B.provider_image_kinds) endpoints in
  let active = L.filter (fun kind -> not (B.is_null (D.get settings kind)) ||
    (kind = "input_references" && L.existsb (fun ss -> L.existsb (fun (k,s) -> k = kind && s <> "supported") ss) states)) B.provider_image_kinds in
  let provider_conflicts = if states = [] then
    L.map (fun kind -> conflict [kind] "unknown" (B.cat (parameter_name kind) " support is unknown.") true) active
  else let rec process (remaining:list nat) (incompatible:list (list string)) (uncertain:list (list string)) : Tot (list D.json) (decreases remaining) =
    match remaining with | [] -> [] | mask::tail ->
    let kinds = mask_kinds mask B.provider_image_kinds in
    if L.existsb (fun prior -> subset prior kinds) incompatible || not (subset kinds active) then process tail incompatible uncertain else
    let state = provider_support (L.map (fun ss -> combination_support (B.flatmap (fun (kind,s) -> if B.member kind kinds then [s] else []) ss)) states) in
    if state = "supported" || (state = "unknown" && L.existsb (fun prior -> subset prior kinds) uncertain) then process tail incompatible uncertain else
    let description = D.join "; " (L.map (describe settings) kinds) in
    let reason = if state = "unknown" then B.cat "Support unknown for " (B.cat description ".")
      else if L.length kinds = 1 then B.cat "Unsupported " (B.cat (B.cat (N.lower (N.char_at description 0)) (N.slice description 1 (N.length description))) ".")
      else B.cat description " cannot be used together on one provider." in
    conflict kinds state reason true :: process tail (if state = "unsupported" then kinds::incompatible else incompatible) (if state = "unknown" then kinds::uncertain else uncertain) in
    process (masks 31 1) [] [] in
  let ratio_conflicts = match B.pixels (D.str (D.get settings "size")), B.split (D.str (D.get settings "aspect_ratio")) ":" with
    | Some (width,height), [rw;rh] ->
      let left = N.multiply_number width rh in
      let right = N.multiply_number height rw in
      if rw <> "" && rh <> "" && B.all_chars rw "0123456789." && B.all_chars rh "0123456789." &&
        (left = "NaN" || right = "NaN" || left <> right) then
        [conflict ["size";"aspect_ratio"] "unsupported" (B.cat (B.cat (B.cat "Size " (D.str (D.get settings "size"))) " does not match aspect ratio ") (B.cat (D.str (D.get settings "aspect_ratio")) ".")) false] else []
    | _ -> [] in
  provider_conflicts @ ratio_conflicts
