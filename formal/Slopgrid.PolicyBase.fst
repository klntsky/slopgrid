module Slopgrid.PolicyBase

(* Policy reads a cell's settings from their common, row, or column owner.
   These helpers also keep the owning control separate from the cell where a
   conflict appears. PRODUCT.md 3.3.9 and 3.4.2. *)

module Domain = Slopgrid.Domain
module List = FStar.List.Tot.Base
open FStar.List.Tot.Base
module Native = Slopgrid.Native
module Number = Slopgrid.Number
module Parameters = Slopgrid.Parameters

let cat = Native.concat

let sides = [Domain.Rows; Domain.Columns]

let image_kinds = [Domain.PSize; Domain.PAspectRatio; Domain.PQuality; Domain.PBackground]

let kinds =
  [Domain.PModel; Domain.PInput; Domain.PEffort; Domain.PJudgeModel; Domain.PJudgeEffort;
   Domain.PJudgeCriteria; Domain.PJudgeSystem; Domain.PVariable] @ image_kinds

let rec member (#a: eqtype) (x: a) (xs: list a) : Tot bool (decreases xs) =
  match xs with
  | [] -> false
  | h :: t -> x = h || member x t

let rec mapi_from (#a: Type) (#b: Type) (f: nat -> a -> Tot b) (i: nat) (xs: list a)
  : Tot (list b) (decreases xs) =
  match xs with
  | [] -> []
  | h :: t -> f i h :: mapi_from f (i + 1) t

let mapi (#a: Type) (#b: Type) (f: nat -> a -> Tot b) (xs: list a) : Tot (list b) =
  mapi_from f 0 xs

let flatmap (#a: Type) (#b: Type) (f: a -> Tot (list b)) (xs: list a) : Tot (list b) =
  List.flatten (List.map f xs)

let indexed (#a: Type) (xs: list a) : Tot (list (nat & a)) =
  mapi (fun i x -> (i, x)) xs

let rec at (#a: Type) (xs: list a) (index: nat) : Tot (option a) (decreases xs) =
  match xs with
  | [] -> None
  | h :: t -> if index = 0 then Some h else at t (index - 1)

let option_list (#a: Type) (xs: option (list a)) : Tot (list a) =
  match xs with
  | None -> []
  | Some xs -> xs

let unique (#a: eqtype) (xs: list a) : Tot (list a) =
  let rec collect (rest: list a) (seen: list a) : Tot (list a) (decreases rest) =
    match rest with
    | [] -> []
    | h :: t ->
      if member h seen then collect t seen
      else h :: collect t (h :: seen)
  in
  collect xs []

let rec join (separator: string) (xs: list string) : Tot string (decreases xs) =
  match xs with
  | [] -> ""
  | [x] -> x
  | h :: t -> cat h (cat separator (join separator t))

let axis_key (side: Domain.axis) : Tot string =
  match side with
  | Domain.Rows -> "rows"
  | Domain.Columns -> "columns"

let records (g: Domain.layout) (side: Domain.axis) : Tot (list Domain.case_record) =
  match side with
  | Domain.Rows -> g.rows
  | Domain.Columns -> g.columns

let case_axes (g: Domain.layout) : Tot (list Domain.axis) =
  match g.case_ownership with
  | Domain.NoCaseAxes -> []
  | Domain.OneCaseAxis s -> [s]
  | Domain.BothCaseAxes Domain.Rows -> sides
  | Domain.BothCaseAxes Domain.Columns -> [Domain.Columns; Domain.Rows]

let set_records (g: Domain.layout) (side: Domain.axis) (rs: list Domain.case_record)
  : Tot Domain.layout =
  match side with
  | Domain.Rows -> {g with rows = rs}
  | Domain.Columns -> {g with columns = rs}

let issue (message: string) (path: list Domain.path_segment) : Tot Domain.validation_issue =
  {Domain.issue_message = message; issue_path = path; deferred = false}

let source = Parameters.get_source

let source_axis (g: Domain.layout) (p: Domain.common_parameter) : Tot (option Domain.axis) =
  match source g.parameters p with
  | Some (Domain.OnAxis side) -> Some side
  | _ -> None

let source_kind (g: Domain.layout) (p: Domain.common_parameter) : Tot string =
  match source g.parameters p with
  | None -> ""
  | Some (Domain.Common _) -> "common"
  | Some (Domain.OnAxis side) -> axis_key side

(* Choose the complete owned value first. A row-owned prompt can still mention
   column fields, so this lookup alone does not determine its expanded text.
   PRODUCT.md 3.3.9. *)
let value (g: Domain.layout) (p: Domain.parameter) (row: nat) (column: nat)
  : Tot (option (Domain.value_for p)) =
  Parameters.parameter_value g p row column None

let value_path (g: Domain.layout) (p: Domain.parameter) (row: nat) (column: nat)
  : Tot (list Domain.path_segment) =
  Parameters.parameter_value_path g p row column None

let values (g: Domain.layout) (p: Domain.common_parameter)
  : Tot (list (nat & option (Domain.value_for p))) =
  match source g.parameters p with
  | None -> []
  | Some (Domain.Common v) -> [(0, Some v)]
  | Some (Domain.OnAxis side) ->
    mapi
      (fun i (record: Domain.case_record) -> (i, Parameters.get_case_value record.values p))
      (records g side)

let messages (g: Domain.layout) (row: nat) (column: nat) : Tot (list Domain.message) =
  match value g Domain.PInput row column with
  | Some (Domain.InputValue ms) -> ms
  | None -> []

let criteria (g: Domain.layout) (row: nat) (column: nat) : Tot (list Domain.criterion) =
  match value g Domain.PJudgeCriteria row column with
  | Some (Domain.JudgeCriteriaValue cs) -> cs
  | None -> []

let text_value (v: Domain.value) : Tot string =
  match v with
  | Domain.ModelValue s
  | Domain.SizeValue s
  | Domain.AspectRatioValue s
  | Domain.QualityValue s
  | Domain.BackgroundValue s
  | Domain.JudgeModelValue s
  | Domain.JudgeSystemValue s -> s
  | _ -> ""

let text (g: Domain.layout) (p: Domain.parameter) (r: nat) (c: nat) : Tot string =
  match value g p r c with
  | Some v -> text_value v
  | None -> ""

let effort (g: Domain.layout) (p: Domain.parameter) (r: nat) (c: nat) : Tot Domain.effort =
  match value g p r c with
  | Some (Domain.EffortValue e)
  | Some (Domain.JudgeEffortValue e) -> e
  | _ -> Domain.DefaultEffort

let effort_key (e: Domain.effort) : Tot string =
  match e with
  | Domain.DefaultEffort -> "default"
  | Domain.NoEffort -> "none"
  | Domain.MinimalEffort -> "minimal"
  | Domain.LowEffort -> "low"
  | Domain.MediumEffort -> "medium"
  | Domain.HighEffort -> "high"
  | Domain.ExtraHighEffort -> "xhigh"
  | Domain.MaxEffort -> "max"

let role_key (r: Domain.role) : Tot string =
  match r with
  | Domain.SystemRole -> "system"
  | Domain.UserRole -> "user"
  | Domain.AssistantRole -> "assistant"
  | Domain.UnfilledRole -> "unfilled"

let nonempty (s: string) : Tot bool = Native.trim s <> ""

(* Keep issues distinct by their full record here, including their field path.
   Equal messages on different controls must remain separate. Grouping messages
   by text within a control belongs to the feedback consumer. PRODUCT.md 3.4.2. *)
let distinct_issues = unique #Domain.validation_issue

let rec scan_all (text: string) (chars: string) (fuel: nat) (offset: nat)
  : Tot bool (decreases fuel) =
  if fuel = 0 then true
  else
    let c = Native.char_at text offset in
    let rec contains (n: nat) : Tot bool (decreases n) =
      if n = 0 then false
      else Native.char_at chars (n - 1) = c || contains (n - 1)
    in
    contains (Native.length chars) && scan_all text chars (fuel - 1) (offset + 1)

let all_chars (text: string) (chars: string) : Tot bool =
  scan_all text chars (Native.length text) 0

let rec split_from (text: string) (separator: string) (fuel: nat) (offset: nat) (start: nat)
  : Tot (list string) (decreases fuel) =
  if fuel = 0 then [Native.slice text start (Native.length text)]
  else if Native.char_at text offset = separator then
    Native.slice text start (if offset >= start then offset - start else 0) ::
    split_from text separator (fuel - 1) (offset + 1) (offset + 1)
  else split_from text separator (fuel - 1) (offset + 1) start

let split (text: string) (separator: string) : Tot (list string) =
  split_from text separator (Native.length text) 0 0

let pixels (text: string) : Tot (option (string & string)) =
  match split text "x" with
  | [w; h] ->
    if w <> "" && h <> "" && all_chars w "0123456789" && all_chars h "0123456789" then
      Some (w, h)
    else None
  | _ -> None

let valid_image (kind: Domain.parameter) (v: string) : Tot bool =
  if kind = Domain.PSize then
    member v ["auto"; "512"; "768"; "1K"; "1.5K"; "2K"; "4K"] ||
    (match pixels v with
     | Some (w, h) -> not (Native.starts_with w "0") && not (Native.starts_with h "0")
     | None -> false)
  else if kind = Domain.PQuality then
    member v ["auto"; "low"; "medium"; "high"; "xhigh"; "max"]
  else if kind = Domain.PBackground then
    member v ["auto"; "transparent"; "opaque"]
  else if kind = Domain.PAspectRatio then
    member v
      ["auto"; "1:1"; "1:2"; "1:4"; "1:8"; "2:1"; "2:3"; "2.35:1"; "3:2"; "3:4";
       "4:1"; "4:3"; "4:5"; "5:2"; "5:4"; "5:7"; "7:5"; "8:1"; "9:16"; "16:9";
       "9:19.5"; "19.5:9"; "9:20"; "20:9"; "9:21"; "21:9"]
  else false

(* Auto leaves the setting to the provider. Treat an empty image list as no
   explicit attachment selection. Endpoint checks still examine the consumed
   count, including zero. PRODUCT.md 3.7.9 and 3.4.6. *)
let normalize_setting (v: option string) : Tot (option string) =
  match v with
  | Some s -> if s = "" || s = "auto" then None else v
  | None -> None

let normalize_settings (s: Domain.image_settings) : Tot Domain.image_settings =
  {
    Domain.image_size = normalize_setting s.image_size;
    image_aspect_ratio = normalize_setting s.image_aspect_ratio;
    image_quality = normalize_setting s.image_quality;
    image_background = normalize_setting s.image_background;
    input_references =
      (match s.input_references with
       | Some [] -> None
       | refs -> refs)
  }

(* A conflict keeps its cell coordinates elsewhere. This records the setting's
   actual owner, so a shared model and a case-owned input can both receive
   feedback for the same cell. PRODUCT.md 3.4.2. *)
let origin (g: Domain.layout) (cell: Domain.preview_cell) (p: Domain.common_parameter)
  : Tot Domain.origin =
  let side = source_axis g p in
  {
    Domain.origin_parameter = p;
    origin_source =
      (match side with
       | None -> Domain.CommonOrigin
       | Some s -> Domain.AxisOrigin s);
    case_index =
      (match side with
       | None -> None
       | Some Domain.Rows -> Some cell.cell_row
       | Some Domain.Columns -> Some cell.cell_column);
    field_index = None;
    message_index = None
  }
