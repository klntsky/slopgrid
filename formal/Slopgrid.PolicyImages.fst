module Slopgrid.PolicyImages

module D = Slopgrid.Domain
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module Num = Slopgrid.Number
module P = Slopgrid.Parameters
module B = Slopgrid.PolicyBase

type support_state = | Supported | Unsupported | Unknown
type setting = | Size | AspectRatio | Quality | Background | InputReferences
let all_settings = [Size;AspectRatio;Quality;Background;InputReferences]
let provider_support (states:list support_state) : Tot support_state =
  if B.member Supported states then Supported else if B.member Unknown states then Unknown else Unsupported
let combination_support (states:list support_state) : Tot support_state =
  if B.member Unsupported states then Unsupported else if B.member Unknown states then Unknown else Supported
let parameter (kind:setting) : Tot D.parameter = match kind with
  | Size -> D.PSize | AspectRatio -> D.PAspectRatio | Quality -> D.PQuality | Background -> D.PBackground | InputReferences -> D.PInput
let setting_key (kind:setting) : Tot string = match kind with | InputReferences -> "input_references" | _ -> P.parameter_key (parameter kind)
let parameter_name (kind:setting) : Tot string = match kind with
  | InputReferences -> "Input images" | AspectRatio -> "Aspect ratio" | Size -> "Size" | Quality -> "Quality" | Background -> "Background"
let setting_value (s:D.image_settings) (kind:setting) : Tot (option string) = match kind with
  | Size -> s.image_size | AspectRatio -> s.image_aspect_ratio | Quality -> s.image_quality | Background -> s.image_background | InputReferences -> None
let rec capability (parameters:list (string & D.capability)) (key:string) : Tot (option D.capability) (decreases parameters) =
  match parameters with | [] -> None | (k,v)::rest -> if k = key then Some v else capability rest key
let present (#a:Type) (v:option a) : Tot bool = match v with | None -> false | Some _ -> true
let parameter_support (parameters:list (string & D.capability)) (kind:setting) (settings:D.image_settings) : Tot support_state =
  let setting = setting_value settings kind in
  let text = match setting with | None -> "" | Some s -> s in
  let refs = kind = InputReferences in
  let count = L.length (B.option_list settings.input_references) in
  if not refs && not (present setting) then Supported else
  let pixels = kind = Size && (match B.pixels text with | Some _ -> true | None -> false) in
  match capability parameters (if kind = Size && not pixels then "resolution" else setting_key kind) with
  | None -> if refs && count = 0 then Supported
    else if pixels && (present (capability parameters "resolution") || present (capability parameters "aspect_ratio")) then Unknown
    else Unsupported
  | Some (D.EnumCapability values) -> if B.member (if refs then N.nat_string count else text) values then Supported else Unsupported
  | Some (D.RangeCapability minimum maximum) ->
    let n = Num.from_nat count in
    if refs && not (Num.lt n minimum) && not (Num.lt maximum n) then Supported else Unsupported
  | Some D.BooleanCapability -> Supported
  | Some (D.OtherCapability _) -> Unknown
type conflict = { parameters:list setting; support:support_state; reason:string; model_dependent:bool }
let make_conflict (kinds:list setting) (state:support_state) (reason:string) (dependent:bool) : Tot conflict =
  {parameters=kinds;support=state;reason=reason;model_dependent=dependent}
let rec mask_kinds (mask:nat) (kinds:list setting) : Tot (list setting) (decreases kinds) =
  match kinds with | [] -> [] | h::t -> (if mask % 2 = 1 then [h] else []) @ mask_kinds (mask / 2) t
let rec masks (count:nat) (first:nat) : Tot (list nat) (decreases count) = if count = 0 then [] else first :: masks (count-1) (first+1)
let subset (a:list setting) (b:list setting) : Tot bool = L.for_all (fun x -> B.member x b) a
let describe (settings:D.image_settings) (kind:setting) : Tot string =
  B.cat (B.cat (parameter_name kind) ": ")
    (if kind = InputReferences then B.cat (N.nat_string (L.length (B.option_list settings.input_references))) " images"
      else match setting_value settings kind with | None -> "Auto" | Some s -> s)
let image_conflicts (endpoints:list D.image_endpoint) (settings:D.image_settings) : Tot (list conflict) =
  let settings = B.normalize_settings settings in
  let states = L.map (fun endpoint ->
    L.map (fun kind -> (kind,parameter_support endpoint.D.capabilities kind settings)) all_settings) endpoints in
  let active = L.filter (fun kind -> (if kind = InputReferences then present settings.input_references else present (setting_value settings kind)) ||
    (kind = InputReferences && L.existsb (fun ss -> L.existsb (fun (k,s) -> k = kind && s <> Supported) ss) states)) all_settings in
  let provider_conflicts = if L.length states = 0 then
    L.map (fun kind -> make_conflict [kind] Unknown (B.cat (parameter_name kind) " support is unknown.") true) active
  else let rec process (remaining:list nat) (incompatible:list (list setting)) (uncertain:list (list setting)) : Tot (list conflict) (decreases remaining) =
    match remaining with | [] -> [] | mask::tail ->
    let kinds = mask_kinds mask all_settings in
    if L.existsb (fun prior -> subset prior kinds) incompatible || not (subset kinds active) then process tail incompatible uncertain else
    let state = provider_support (L.map (fun ss -> combination_support (B.flatmap (fun (kind,s) -> if B.member kind kinds then [s] else []) ss)) states) in
    if state = Supported || (state = Unknown && L.existsb (fun prior -> subset prior kinds) uncertain) then process tail incompatible uncertain else
    let description = B.join "; " (L.map (describe settings) kinds) in
    let reason = if state = Unknown then B.cat "Support unknown for " (B.cat description ".")
      else if L.length kinds = 1 then B.cat "Unsupported " (B.cat (B.cat (N.lower (N.char_at description 0)) (N.slice description 1 (N.length description))) ".")
      else B.cat description " cannot be used together on one provider." in
    make_conflict kinds state reason true :: process tail (if state = Unsupported then kinds::incompatible else incompatible) (if state = Unknown then kinds::uncertain else uncertain) in
    process (masks 31 1) [] [] in
  let ratio_conflicts = match settings.image_size,settings.image_aspect_ratio with
    | Some size,Some ratio -> (match B.pixels size, B.split ratio ":" with
      | Some (width,height), [rw;rh] ->
        let left = Num.multiply (Num.parse width) (Num.parse rh) in
        let right = Num.multiply (Num.parse height) (Num.parse rw) in
        if rw <> "" && rh <> "" && B.all_chars rw "0123456789." && B.all_chars rh "0123456789." && not (Num.ieee_equal left right) then
          [make_conflict [Size;AspectRatio] Unsupported (B.cat (B.cat (B.cat "Size " size) " does not match aspect ratio ") (B.cat ratio ".")) false] else []
      | _ -> [])
    | _ -> [] in
  provider_conflicts @ ratio_conflicts
