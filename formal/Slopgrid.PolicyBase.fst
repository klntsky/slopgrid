module Slopgrid.PolicyBase

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module P = Slopgrid.Parameters

let cat = N.concat
let sides = ["rows"; "columns"]
let image_kinds = ["size"; "aspect_ratio"; "quality"; "background"]
let provider_image_kinds = image_kinds @ ["input_references"]
let kinds = ["model"; "input"; "effort"; "judge_model"; "judge_effort"; "judge_criteria"; "judge_system"; "variable"] @ image_kinds
let rec member (#a:eqtype) (x:a) (xs:list a) : Tot bool (decreases xs) =
  match xs with | [] -> false | h::t -> x = h || member x t
let rec mapi_from (#a:Type) (#b:Type) (f:nat -> a -> Tot b) (i:nat) (xs:list a) : Tot (list b) (decreases xs) =
  match xs with | [] -> [] | h::t -> f i h :: mapi_from f (i+1) t
let mapi (#a:Type) (#b:Type) (f:nat -> a -> Tot b) (xs:list a) : Tot (list b) = mapi_from f 0 xs
let flatmap (#a:Type) (#b:Type) (f:a -> Tot (list b)) (xs:list a) : Tot (list b) = L.flatten (L.map f xs)
let indexed (xs:list D.json) : Tot (list (nat & D.json)) = mapi (fun i x -> (i,x)) xs
let issue (message:string) (path:list D.json) : Tot D.json =
  D.object [("message",D.string message); ("path",D.array path)]
let source (input:D.json) (kind:string) : Tot D.json = D.get (D.get input "parameters") kind
let source_kind (input:D.json) (kind:string) : Tot string = D.str (D.get (source input kind) "kind")
let value = P.parameter_value
let value_path = P.parameter_value_path
let value_default (input:D.json) (kind:string) (row:nat) (column:nat) (fallback:D.json) : Tot D.json =
  let v = value input kind row column in if v = D.JNull then fallback else v
let values (input:D.json) (kind:string) : Tot (list (nat & D.json)) =
  let s = source input kind in let side = D.str (D.get s "kind") in
  if side = "common" then [(0,D.get s "value")]
  else mapi (fun i record -> (i,D.get record kind)) (D.items (D.get input side))
let messages (input:D.json) (row:nat) (column:nat) : Tot (list D.json) = D.items (value input "input" row column)
let criteria (input:D.json) (row:nat) (column:nat) : Tot (list D.json) = D.items (value input "judge_criteria" row column)
let is_null (v:D.json) : Tot bool = match v with | D.JNull -> true | _ -> false
let nonempty (s:string) : Tot bool = N.trim s <> ""
let has_items (v:D.json) : Tot bool = L.length (D.items v) > 0
let truth (v:D.json) : Tot bool = match v with
  | D.JNull -> false | D.JBool b -> b | D.JString s -> s <> "" | D.JNumber n -> N.compare_number n "0" <> 0 | _ -> true
let unique_json (xs:list D.json) : Tot (list D.json) =
  let rec collect (rest:list D.json) (seen:list D.json) : Tot (list D.json) (decreases rest) =
    match rest with | [] -> [] | h::t ->
    if L.existsb (D.equal h) seen then collect t seen else h :: collect t (h::seen) in
  collect xs []
let distinct_issues (xs:list D.json) : Tot (list D.json) = unique_json xs
let rec scan_all (text:string) (chars:string) (fuel:nat) (offset:nat) : Tot bool (decreases fuel) =
  if fuel = 0 then true else
  let c = N.char_at text offset in
  let rec contains (n:nat) : Tot bool (decreases n) =
    if n = 0 then false else N.char_at chars (n-1) = c || contains (n-1) in
  contains (N.length chars) && scan_all text chars (fuel-1) (offset+1)
let all_chars (text:string) (chars:string) : Tot bool = scan_all text chars (N.length text) 0
let rec split_from (text:string) (separator:string) (fuel:nat) (offset:nat) (start:nat) : Tot (list string) (decreases fuel) =
  if fuel = 0 then [N.slice text start (N.length text)]
  else if N.char_at text offset = separator then
    N.slice text start (if offset >= start then offset-start else 0) :: split_from text separator (fuel-1) (offset+1) (offset+1)
  else split_from text separator (fuel-1) (offset+1) start
let split (text:string) (separator:string) : Tot (list string) = split_from text separator (N.length text) 0 0
let pixels (text:string) : Tot (option (string & string)) =
  match split text "x" with
  | [w;h] -> if w <> "" && h <> "" && all_chars w "0123456789" && all_chars h "0123456789" then Some (w,h) else None
  | _ -> None
let valid_image (kind:string) (v:string) : Tot bool =
  if kind = "size" then
    member v ["auto";"512";"768";"1K";"1.5K";"2K";"4K"] ||
    (match pixels v with | Some (w,h) -> not (N.starts_with w "0") && not (N.starts_with h "0") | None -> false)
  else if kind = "quality" then member v ["auto";"low";"medium";"high";"xhigh";"max"]
  else if kind = "background" then member v ["auto";"transparent";"opaque"]
  else if kind = "aspect_ratio" then member v ["auto";"1:1";"1:2";"1:4";"1:8";"2:1";"2:3";"2.35:1";"3:2";"3:4";"4:1";"4:3";"4:5";"5:2";"5:4";"5:7";"7:5";"8:1";"9:16";"16:9";"9:19.5";"19.5:9";"9:20";"20:9";"9:21";"21:9"]
  else false
let normalize_settings (settings:D.json) : Tot D.json =
  D.object (L.filter (fun (_,v) -> match v with | D.JArray xs -> L.length xs > 0 | _ -> truth v && v <> D.string "auto") (D.fields settings))
let origin (input:D.json) (cell:D.json) (kind:string) : Tot D.json =
  let s = source_kind input kind in let s = if s = "" then "common" else s in
  D.object ([("parameter",D.string kind);("source",D.string s)] @
    (if s = "common" then [] else [("caseIndex",D.get cell (if s = "rows" then "row" else "column"))]))
