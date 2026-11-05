module Slopgrid.PolicyImages

(* Image compatibility uses one cell's resolved settings and consumed images.
   A provider must accept the whole combination, not just one setting each
   across several providers. These results are advisory. PRODUCT.md 3.4.6 and 3.4.7. *)

module Domain = Slopgrid.Domain
module List = FStar.List.Tot.Base
open FStar.List.Tot.Base
module Native = Slopgrid.Native
module Number = Slopgrid.Number
module Parameters = Slopgrid.Parameters
module PolicyBase = Slopgrid.PolicyBase

type support_state =
  | Supported
  | Unsupported
  | Unknown

type setting =
  | Size
  | AspectRatio
  | Quality
  | Background
  | InputReferences

let all_settings = [Size; AspectRatio; Quality; Background; InputReferences]

(* Try alternative endpoints only after checking each endpoint's whole
   combination. A verified route wins. An uncertain route cannot turn a known
   failure on every other route into verified support. PRODUCT.md 3.4.6. *)
let provider_support (states: list support_state) : Tot support_state =
  if PolicyBase.member Supported states then Supported
  else if PolicyBase.member Unknown states then Unknown
  else Unsupported

let combination_support (states: list support_state) : Tot support_state =
  if PolicyBase.member Unsupported states then Unsupported
  else if PolicyBase.member Unknown states then Unknown
  else Supported

let parameter (kind: setting) : Tot Domain.parameter =
  match kind with
  | Size -> Domain.PSize
  | AspectRatio -> Domain.PAspectRatio
  | Quality -> Domain.PQuality
  | Background -> Domain.PBackground
  | InputReferences -> Domain.PInput

let setting_key (kind: setting) : Tot string =
  match kind with
  | InputReferences -> "input_references"
  | _ -> Parameters.parameter_key (parameter kind)

let parameter_name (kind: setting) : Tot string =
  match kind with
  | InputReferences -> "Input images"
  | AspectRatio -> "Aspect ratio"
  | Size -> "Size"
  | Quality -> "Quality"
  | Background -> "Background"

let setting_value (s: Domain.image_settings) (kind: setting) : Tot (option string) =
  match kind with
  | Size -> s.image_size
  | AspectRatio -> s.image_aspect_ratio
  | Quality -> s.image_quality
  | Background -> s.image_background
  | InputReferences -> None

let rec capability (parameters: list (string & Domain.capability)) (key: string)
  : Tot (option Domain.capability) (decreases parameters) =
  match parameters with
  | [] -> None
  | (k, v) :: rest -> if k = key then Some v else capability rest key

let present (#a: Type) (v: option a) : Tot bool =
  match v with
  | None -> false
  | Some _ -> true

(* Missing scalar choices mean Auto, so they impose no explicit setting.
   Input images instead use the consumed count, including a provider's declared
   lower bound. Pixel sizes need size support rather than a resolution label. *)
let parameter_support (parameters: list (string & Domain.capability)) (kind: setting)
  (settings: Domain.image_settings) : Tot support_state =
  let setting = setting_value settings kind in
  let text =
    match setting with
    | None -> ""
    | Some s -> s
  in
  let refs = kind = InputReferences in
  let count = List.length (PolicyBase.option_list settings.input_references) in
  if not refs && not (present setting) then Supported
  else
    let pixels =
      kind = Size &&
      (match PolicyBase.pixels text with
       | Some _ -> true
       | None -> false)
    in
    match capability parameters
      (if kind = Size && not pixels then "resolution" else setting_key kind) with
    | None ->
      if refs && count = 0 then Supported
      else if pixels &&
        (present (capability parameters "resolution") ||
         present (capability parameters "aspect_ratio")) then
        Unknown
      else Unsupported
    | Some (Domain.EnumCapability values) ->
      if PolicyBase.member (if refs then Native.nat_string count else text) values then Supported
      else Unsupported
    | Some (Domain.RangeCapability minimum maximum) ->
      let n = Number.from_nat count in
      if refs && not (Number.lt n minimum) && not (Number.lt maximum n) then Supported
      else Unsupported
    | Some Domain.BooleanCapability -> Supported
    | Some (Domain.OtherCapability _) -> Unknown

type conflict = {
  parameters: list setting;
  support: support_state;
  reason: string;
  model_dependent: bool
}

let make_conflict (kinds: list setting) (state: support_state) (reason: string)
  (dependent: bool) : Tot conflict =
  {parameters = kinds; support = state; reason = reason; model_dependent = dependent}

let rec mask_kinds (mask: nat) (kinds: list setting)
  : Tot (list setting) (decreases kinds) =
  match kinds with
  | [] -> []
  | h :: t -> (if mask % 2 = 1 then [h] else []) @ mask_kinds (mask / 2) t

let rec masks (count: nat) (first: nat) : Tot (list nat) (decreases count) =
  if count = 0 then []
  else first :: masks (count - 1) (first + 1)

let subset (a: list setting) (b: list setting) : Tot bool =
  List.for_all (fun x -> PolicyBase.member x b) a

let describe (settings: Domain.image_settings) (kind: setting) : Tot string =
  PolicyBase.cat (PolicyBase.cat (parameter_name kind) ": ")
    (if kind = InputReferences then
       PolicyBase.cat
         (Native.nat_string (List.length (PolicyBase.option_list settings.input_references)))
         " images"
     else
       match setting_value settings kind with
       | None -> "Auto"
       | Some s -> s)

let image_conflicts (endpoints: list Domain.image_endpoint) (settings: Domain.image_settings)
  : Tot (list conflict) =
  let settings = PolicyBase.normalize_settings settings in
  let states =
    List.map
      (fun endpoint ->
        List.map
          (fun kind -> (kind, parameter_support endpoint.Domain.capabilities kind settings))
          all_settings)
      endpoints
  in
  let active =
    List.filter
      (fun kind ->
        (if kind = InputReferences then present settings.input_references
         else present (setting_value settings kind)) ||
        (kind = InputReferences &&
         List.existsb
           (fun ss -> List.existsb (fun (k, s) -> k = kind && s <> Supported) ss)
           states))
      all_settings
  in
  let provider_conflicts =
    if List.length states = 0 then
      List.map
        (fun kind ->
          make_conflict [kind] Unknown
            (PolicyBase.cat (parameter_name kind) " support is unknown.") true)
        active
    else
      (* Enumerate setting subsets to find which choices conflict together.
         Once a smaller subset fails, omit larger failures that only repeat it.
         Keep uncertain subsets separate from known failures. PRODUCT.md 3.4.6. *)
      let rec process (remaining: list nat) (incompatible: list (list setting))
        (uncertain: list (list setting)) : Tot (list conflict) (decreases remaining) =
        match remaining with
        | [] -> []
        | mask :: tail ->
          let kinds = mask_kinds mask all_settings in
          if List.existsb (fun prior -> subset prior kinds) incompatible ||
            not (subset kinds active) then
            process tail incompatible uncertain
          else
            let state =
              provider_support
                (List.map
                  (fun ss ->
                    combination_support
                      (PolicyBase.flatmap
                        (fun (kind, s) -> if PolicyBase.member kind kinds then [s] else [])
                        ss))
                  states)
            in
            if state = Supported ||
              (state = Unknown && List.existsb (fun prior -> subset prior kinds) uncertain) then
              process tail incompatible uncertain
            else
              let description = PolicyBase.join "; " (List.map (describe settings) kinds) in
              let reason =
                if state = Unknown then
                  PolicyBase.cat "Support unknown for " (PolicyBase.cat description ".")
                else if List.length kinds = 1 then
                  PolicyBase.cat "Unsupported "
                    (PolicyBase.cat
                      (PolicyBase.cat (Native.lower (Native.char_at description 0))
                        (Native.slice description 1 (Native.length description)))
                      ".")
                else PolicyBase.cat description " cannot be used together on one provider."
              in
              make_conflict kinds state reason true ::
              process tail
                (if state = Unsupported then kinds :: incompatible else incompatible)
                (if state = Unknown then kinds :: uncertain else uncertain)
      in
      process (masks 31 1) [] []
  in
  (* A size/aspect mismatch depends only on these two values, not the model or
     any unfinished prompt. Keep it separate from endpoint metadata so the
     feedback remains available during editing. PRODUCT.md 3.4.6. *)
  let ratio_conflicts =
    match settings.image_size, settings.image_aspect_ratio with
    | Some size, Some ratio ->
      (match PolicyBase.pixels size, PolicyBase.split ratio ":" with
       | Some (width, height), [rw; rh] ->
         let left = Number.multiply (Number.parse width) (Number.parse rh) in
         let right = Number.multiply (Number.parse height) (Number.parse rw) in
         if rw <> "" && rh <> "" && PolicyBase.all_chars rw "0123456789." &&
           PolicyBase.all_chars rh "0123456789." && not (Number.ieee_equal left right) then
           [make_conflict [Size; AspectRatio] Unsupported
             (PolicyBase.cat
               (PolicyBase.cat (PolicyBase.cat "Size " size) " does not match aspect ratio ")
               (PolicyBase.cat ratio "."))
             false]
         else []
       | _ -> [])
    | _ -> []
  in
  provider_conflicts @ ratio_conflicts
