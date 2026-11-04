module Slopgrid.PolicyBase

module D = Slopgrid.Domain
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module Num = Slopgrid.Number
module P = Slopgrid.Parameters

let cat = N.concat
let sides = [D.Rows; D.Columns]
let image_kinds = [D.PSize; D.PAspectRatio; D.PQuality; D.PBackground]
let kinds = [D.PModel; D.PInput; D.PEffort; D.PJudgeModel; D.PJudgeEffort; D.PJudgeCriteria; D.PJudgeSystem; D.PVariable] @ image_kinds
let rec member (#a:eqtype) (x:a) (xs:list a) : Tot bool (decreases xs) =
  match xs with | [] -> false | h::t -> x = h || member x t
let rec mapi_from (#a:Type) (#b:Type) (f:nat -> a -> Tot b) (i:nat) (xs:list a) : Tot (list b) (decreases xs) =
  match xs with | [] -> [] | h::t -> f i h :: mapi_from f (i+1) t
let mapi (#a:Type) (#b:Type) (f:nat -> a -> Tot b) (xs:list a) : Tot (list b) = mapi_from f 0 xs
let flatmap (#a:Type) (#b:Type) (f:a -> Tot (list b)) (xs:list a) : Tot (list b) = L.flatten (L.map f xs)
let indexed (#a:Type) (xs:list a) : Tot (list (nat & a)) = mapi (fun i x -> (i,x)) xs
let rec at (#a:Type) (xs:list a) (index:nat) : Tot (option a) (decreases xs) =
  match xs with | [] -> None | h::t -> if index = 0 then Some h else at t (index-1)
let option_list (#a:Type) (xs:option (list a)) : Tot (list a) = match xs with | None -> [] | Some xs -> xs
let unique (#a:eqtype) (xs:list a) : Tot (list a) =
  let rec collect (rest:list a) (seen:list a) : Tot (list a) (decreases rest) =
    match rest with | [] -> [] | h::t -> if member h seen then collect t seen else h :: collect t (h::seen) in
  collect xs []
let rec join (separator:string) (xs:list string) : Tot string (decreases xs) =
  match xs with | [] -> "" | [x] -> x | h::t -> cat h (cat separator (join separator t))
let axis_key (side:D.axis) : Tot string = match side with | D.Rows -> "rows" | D.Columns -> "columns"
let records (g:D.layout) (side:D.axis) : Tot (list D.case_record) = match side with | D.Rows -> g.rows | D.Columns -> g.columns
let case_axes (g:D.layout) : Tot (list D.axis) = match g.case_ownership with
  | D.NoCaseAxes -> [] | D.OneCaseAxis s -> [s] | D.BothCaseAxes D.Rows -> sides | D.BothCaseAxes D.Columns -> [D.Columns;D.Rows]
let set_records (g:D.layout) (side:D.axis) (rs:list D.case_record) : Tot D.layout =
  match side with | D.Rows -> {g with rows=rs} | D.Columns -> {g with columns=rs}
let issue (message:string) (path:list D.path_segment) : Tot D.validation_issue =
  {D.issue_message=message; issue_path=path; deferred=false}
let source = P.get_source
let source_axis (g:D.layout) (p:D.common_parameter) : Tot (option D.axis) =
  match source g.parameters p with | Some (D.OnAxis side) -> Some side | _ -> None
let source_kind (g:D.layout) (p:D.common_parameter) : Tot string =
  match source g.parameters p with | None -> "" | Some (D.Common _) -> "common" | Some (D.OnAxis side) -> axis_key side
let value (g:D.layout) (p:D.parameter) (row:nat) (column:nat) : Tot (option (D.value_for p)) = P.parameter_value g p row column None
let value_path (g:D.layout) (p:D.parameter) (row:nat) (column:nat) : Tot (list D.path_segment) = P.parameter_value_path g p row column None
let values (g:D.layout) (p:D.common_parameter) : Tot (list (nat & option (D.value_for p))) =
  match source g.parameters p with
  | None -> []
  | Some (D.Common v) -> [(0,Some v)]
  | Some (D.OnAxis side) -> mapi (fun i (record:D.case_record) -> (i,P.get_case_value record.values p)) (records g side)
let messages (g:D.layout) (row:nat) (column:nat) : Tot (list D.message) =
  match value g D.PInput row column with | Some (D.InputValue ms) -> ms | None -> []
let criteria (g:D.layout) (row:nat) (column:nat) : Tot (list D.criterion) =
  match value g D.PJudgeCriteria row column with | Some (D.JudgeCriteriaValue cs) -> cs | None -> []
let text_value (v:D.value) : Tot string = match v with
  | D.ModelValue s | D.SizeValue s | D.AspectRatioValue s | D.QualityValue s | D.BackgroundValue s | D.JudgeModelValue s | D.JudgeSystemValue s -> s
  | _ -> ""
let text (g:D.layout) (p:D.parameter) (r:nat) (c:nat) : Tot string = match value g p r c with | Some v -> text_value v | None -> ""
let effort (g:D.layout) (p:D.parameter) (r:nat) (c:nat) : Tot D.effort =
  match value g p r c with | Some (D.EffortValue e) | Some (D.JudgeEffortValue e) -> e | _ -> D.DefaultEffort
let effort_key (e:D.effort) : Tot string = match e with
  | D.DefaultEffort -> "default" | D.NoEffort -> "none" | D.MinimalEffort -> "minimal" | D.LowEffort -> "low" | D.MediumEffort -> "medium" | D.HighEffort -> "high" | D.ExtraHighEffort -> "xhigh" | D.MaxEffort -> "max"
let role_key (r:D.role) : Tot string = match r with | D.SystemRole -> "system" | D.UserRole -> "user" | D.AssistantRole -> "assistant" | D.UnfilledRole -> "unfilled"
let nonempty (s:string) : Tot bool = N.trim s <> ""
let distinct_issues = unique #D.validation_issue
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
let valid_image (kind:D.parameter) (v:string) : Tot bool =
  if kind = D.PSize then
    member v ["auto";"512";"768";"1K";"1.5K";"2K";"4K"] ||
    (match pixels v with | Some (w,h) -> not (N.starts_with w "0") && not (N.starts_with h "0") | None -> false)
  else if kind = D.PQuality then member v ["auto";"low";"medium";"high";"xhigh";"max"]
  else if kind = D.PBackground then member v ["auto";"transparent";"opaque"]
  else if kind = D.PAspectRatio then member v ["auto";"1:1";"1:2";"1:4";"1:8";"2:1";"2:3";"2.35:1";"3:2";"3:4";"4:1";"4:3";"4:5";"5:2";"5:4";"5:7";"7:5";"8:1";"9:16";"16:9";"9:19.5";"19.5:9";"9:20";"20:9";"9:21";"21:9"]
  else false
let normalize_setting (v:option string) : Tot (option string) = match v with | Some s -> if s = "" || s = "auto" then None else v | None -> None
let normalize_settings (s:D.image_settings) : Tot D.image_settings =
  {D.image_size=normalize_setting s.image_size; image_aspect_ratio=normalize_setting s.image_aspect_ratio;
   image_quality=normalize_setting s.image_quality; image_background=normalize_setting s.image_background;
   input_references=(match s.input_references with | Some [] -> None | refs -> refs)}
let origin (g:D.layout) (cell:D.preview_cell) (p:D.common_parameter) : Tot D.origin =
  let side = source_axis g p in
  {D.origin_parameter=p; origin_source=(match side with | None -> D.CommonOrigin | Some s -> D.AxisOrigin s);
   case_index=(match side with | None -> None | Some D.Rows -> Some cell.cell_row | Some D.Columns -> Some cell.cell_column);
   field_index=None; message_index=None}
