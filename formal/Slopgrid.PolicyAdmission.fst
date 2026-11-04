module Slopgrid.PolicyAdmission

module D = Slopgrid.Domain
open Slopgrid.Domain
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module Num = Slopgrid.Number
module P = Slopgrid.Parameters
module B = Slopgrid.PolicyBase
module V = Slopgrid.PolicyVariables

let deferred_issue (message:string) (path:list D.path_segment) : Tot D.validation_issue = {(B.issue message path) with deferred=true}
let criteria_issues (criteria:list D.criterion) : Tot (list D.validation_issue) =
  (if criteria = [] then [B.issue "Add at least one criterion." []] else []) @
  B.flatmap (fun (i,c) -> if B.nonempty c.D.criterion_text then [] else
    [B.issue "Enter a yes-or-no question for each criterion." [D.Index i;D.Property "text"]]) (B.indexed criteria)
let chat_issues (messages:list D.message) : Tot (list D.validation_issue) =
  if messages = [] then [B.issue "Add a message." []] else
  B.flatmap (fun (i,m) -> if B.option_list m.D.images <> [] && m.message_role <> D.UserRole then
    [B.issue "Images can only be attached to user messages." [D.Index i;D.Property "images"]] else []) (B.indexed messages) @
  B.flatmap (fun (i,m) -> if m.D.message_role <> D.UnfilledRole && not (B.nonempty m.content) && not (m.message_role = D.UserRole && B.option_list m.images <> []) then
    [B.issue "Enter a message or attach an image." [D.Index i;D.Property "content"]] else []) (B.indexed messages) @
  B.flatmap (fun (i,m) -> if m.D.message_role = D.UnfilledRole && m.content <> "" then
    [B.issue "Leave unfilled messages empty." [D.Index i;D.Property "content"]] else []) (B.indexed messages) @
  (match B.at messages 0 with | Some m -> if m.message_role = D.UnfilledRole then [B.issue "Add a message before the first unfilled message." [D.Index 0;D.Property "role"]] else [] | None -> [])
let prepend (path:list D.path_segment) (item:D.validation_issue) : Tot D.validation_issue = {item with issue_path=path @ item.issue_path}
let trim_kinds = [D.PModel;D.PJudgeModel;D.PSize;D.PAspectRatio;D.PQuality;D.PBackground]
let trim_criteria (cs:list D.criterion) : Tot (list D.criterion) = L.map (fun c -> {c with D.criterion_text=N.trim c.D.criterion_text}) cs
let normalize_value (v:D.value) : Tot (D.value_for (D.value_parameter v)) = match v with
  | D.ModelValue s -> D.ModelValue (N.trim s) | D.JudgeModelValue s -> D.JudgeModelValue (N.trim s)
  | D.SizeValue s -> D.SizeValue (N.trim s) | D.AspectRatioValue s -> D.AspectRatioValue (N.trim s)
  | D.QualityValue s -> D.QualityValue (N.trim s) | D.BackgroundValue s -> D.BackgroundValue (N.trim s)
  | _ -> v
let normalize (g:D.layout) : Tot D.layout =
  let parameters = L.fold_left (fun ps p -> match P.get_source ps p with
    | Some (D.Common v) -> P.set_source ps p (D.Common (normalize_value v)) | _ -> ps) g.parameters P.common_parameters in
  let parameters = if not g.judging then parameters else match parameters.judge_criteria_source with
    | Some (D.Common (D.JudgeCriteriaValue cs)) -> {parameters with judge_criteria_source=Some (D.Common (D.JudgeCriteriaValue (trim_criteria cs)))} | _ -> parameters in
  let g = {g with parameters=parameters} in
  L.fold_left (fun current side -> B.set_records current side (L.map (fun record ->
    let name = match record.D.case_name with | None -> None | Some s -> let s = N.trim s in if s = "" then None else Some s in
    let values = L.fold_left (fun vs p -> match P.get_case_value vs p with | None -> vs | Some v -> P.set_case_value vs (normalize_value v)) record.values trim_kinds in
    let values = if g.judging && B.source_axis g D.PJudgeCriteria = Some side then
      match values.judge_criteria_value with | None -> values | Some cs -> {values with judge_criteria_value=Some (trim_criteria cs)} else values in
    {record with case_name=name;values=values}) (B.records current side))) g B.sides
let applicable (g:D.layout) (p:D.parameter) : Tot bool =
  B.member p [D.PInput;D.PModel;D.PVariable] ||
  (if g.output_format = D.Image then B.member p B.image_kinds else p = D.PEffort) ||
  (g.judging && B.member p [D.PJudgeModel;D.PJudgeEffort;D.PJudgeCriteria;D.PJudgeSystem])
let axis_issues (g:D.layout) : Tot (list D.validation_issue) =
  B.flatmap (fun side -> if B.records g side <> [] then [] else
    if not (P.is_case_axis g side) && (B.source_axis g D.PModel = Some side || B.source_axis g D.PJudgeModel = Some side) then
      [deferred_issue "Select at least one model" [D.Property (B.axis_key side)]]
    else [B.issue "Too small: expected array to have >=1 items" [D.Property (B.axis_key side)]]) B.sides
let parameter_issues (g:D.layout) : Tot (list D.validation_issue) =
  (if g.judging && g.output_format = D.Html then [B.issue "Websites do not support a judge yet." [D.Property "judge"]] else []) @
  B.flatmap (fun (p:D.parameter) ->
    if p = D.PVariable then [] else
    let kind = P.parameter_key p in
    let path = [D.Property "parameters";D.Property kind] in
    match B.source g.parameters p with
    | None -> if applicable g p then [B.issue (B.cat "Choose a source for " (B.cat kind ".")) path] else []
    | Some _ -> if not (applicable g p) then [B.issue (B.cat kind " is not applicable to this grid.") path] else
      B.flatmap #(nat & option (D.value_for p)) #D.validation_issue (fun (index,value) ->
        let path = B.value_path g p index index in
        match value with
        | None -> [B.issue (B.cat (B.cat "Add " kind) (B.cat (B.cat " to every " (B.source_kind g p)) " case.")) path]
        | Some v -> if B.member p [D.PModel;D.PJudgeModel] && not (B.nonempty (B.text_value v)) then
          [B.issue (if p = D.PModel then "Select a model." else "Select a judge model.") path]
        else if B.member p B.image_kinds && not (B.valid_image p (B.text_value v)) then
          [B.issue (if p = D.PSize then "Use a resolution or a size such as 1536x1024" else "Unknown image setting") path] else []) (B.values g p)) B.kinds
let ownership_issues (g:D.layout) : Tot (list D.validation_issue) =
  B.flatmap (fun side ->
    let owned = P.axis_parameters g side @ (if P.is_case_axis g side then [D.PVariable] else []) in
    let rec records (rest:list D.case_record) (index:nat) (ids:list string) : Tot (list D.validation_issue) (decreases rest) =
      match rest with | [] -> [] | record::tail ->
      (if B.member record.case_id ids then [B.issue "Case IDs must be distinct within an axis." [D.Property (B.axis_key side);D.Index index;D.Property "id"]] else []) @
      B.flatmap (fun p -> if B.member p owned then [] else
        [B.issue (B.cat (P.parameter_key p) (B.cat " is not owned by " (B.cat (B.axis_key side) "."))) [D.Property (B.axis_key side);D.Index index;D.Property (P.parameter_key p)]]) record.values.value_order @
      records tail (index+1) (record.case_id::ids) in
    records (B.records g side) 0 []) B.sides
let first_path_index (path:list D.path_segment) : Tot nat = match path with | D.Index i::_ -> i | _ -> 0
let message_text (ms:list D.message) (i:nat) : Tot string = match B.at ms i with | None -> "" | Some m -> m.content
let raw_input_issues (g:D.layout) : Tot (list D.validation_issue) =
  B.flatmap #(nat & option (D.value_for D.PInput)) #D.validation_issue (fun (index,value) ->
    let messages = match value with | Some (D.InputValue ms) -> ms | None -> [] in
    let path = B.value_path g D.PInput index index in
    (if g.output_format <> D.ChatTemplate && (match messages with | [m] -> m.message_role <> D.UserRole | _ -> true) then
      [B.issue "Prompt formats require exactly one user message." path] else []) @
    L.map (prepend path) (L.filter (fun item ->
      not (B.member (D.Property "content") item.D.issue_path) ||
      (match B.at messages (first_path_index item.issue_path) with | Some m -> m.message_role = D.UnfilledRole | None -> false)) (chat_issues messages))) (B.values g D.PInput)
let raw_criteria_issues (g:D.layout) : Tot (list D.validation_issue) =
  if not g.judging then [] else
  B.flatmap #(nat & option (D.value_for D.PJudgeCriteria)) #D.validation_issue (fun (index,criteria) ->
    let cs = match criteria with | Some (D.JudgeCriteriaValue cs) -> cs | None -> [] in
    L.map (prepend (B.value_path g D.PJudgeCriteria index index)) (criteria_issues cs)) (B.values g D.PJudgeCriteria)
let expanded_issue (g:D.layout) (row:nat) (column:nat) (path:list D.path_segment) (template:string) (item:D.validation_issue) : Tot (list D.validation_issue) =
  [prepend path item] @
  (if B.member (D.Property "content") item.issue_path || B.member (D.Property "text") item.issue_path then
    L.map (fun r -> B.issue item.issue_message (V.reference_path r @ [D.Property "text"])) (V.references template g row column) else [])
let expanded_issues (g:D.layout) : Tot (list D.validation_issue) =
  B.flatmap (fun (row,_) -> B.flatmap (fun (column,_) ->
    let raw = B.messages g row column in
    let messages = V.expand_messages g row column in
    let path = B.value_path g D.PInput row column in
    B.flatmap (fun item -> expanded_issue g row column path (message_text raw (first_path_index item.D.issue_path)) item) (chat_issues messages) @
    (if g.output_format = D.Image && not (B.nonempty (message_text messages 0)) then
      expanded_issue g row column path (message_text raw 0) (B.issue "Enter a prompt." (if messages = [] then [] else [D.Index 0;D.Property "content"])) else []) @
    (if not g.judging then [] else
      let criteria,_ = V.resolve_criteria g row column in
      B.flatmap (fun item ->
        let template = match B.at (B.criteria g row column) (first_path_index item.D.issue_path) with | None -> "" | Some c -> c.criterion_text in
        expanded_issue g row column (B.value_path g D.PJudgeCriteria row column) template item) (criteria_issues criteria)))
    (B.indexed g.columns)) (B.indexed g.rows)
let semantic_issues (g:D.layout) : Tot (list D.validation_issue) =
  B.distinct_issues (axis_issues g @ parameter_issues g @ P.parameter_layout_issues g @ ownership_issues g @ raw_input_issues g @
    (if g.rows = [] || g.columns = [] then raw_criteria_issues g else []) @ V.prompt_issues g @ expanded_issues g)
let budget_value (text:string) : Tot (option Num.finite) =
  let n = Num.parse text in if N.trim text <> "" && Num.is_finite n then Some n else None
let budget_issues (g:D.layout) (text:string) (budget:option Num.finite) : Tot (list D.validation_issue) =
  if g.output_format = D.Image then [] else match budget with
  | Some n -> if Num.lt Num.zero n then [] else [B.issue "Too small: expected number to be >0" [D.Property "budgetUsd"]]
  | None ->
    let parsed = Num.parse text in
    let received = if N.trim text = "" || Num.is_nan parsed then "NaN" else if Num.lt parsed Num.zero then "-Infinity" else "Infinity" in
    [B.issue (B.cat "Invalid input: expected number, received " received) [D.Property "budgetUsd"]]
let admit_input (input:D.draft_input) : Tot (D.layout & option Num.finite & option D.admitted_input & list D.validation_issue) =
  let g = input.draft_layout in
  let budget = budget_value input.budget_text in
  let base_errors = budget_issues g input.budget_text budget in
  let normalized = normalize g in
  let positive_budget : option Num.positive = match budget with
    | Some n -> if Num.lt Num.zero n then Some n else if g.output_format = D.Image then Some (Num.small_positive 3) else None
    | None -> if g.output_format = D.Image then Some (Num.small_positive 3) else None in
  let issues = if base_errors = [] then semantic_issues normalized else base_errors in
  let admitted = match positive_budget with
    | Some n -> if normalized.rows <> [] && normalized.columns <> [] then Some {D.admitted_layout=normalized;budget_usd=n} else None
    | None -> None in
  (g,budget,admitted,issues)
let preview (g:D.layout) : Tot D.layout =
  L.fold_left (fun current side -> if B.records current side <> [] then current else
    let values = L.fold_left (fun vs p -> P.set_case_value vs (P.parameter_default p)) P.empty_case_values (P.axis_parameters g side) in
    B.set_records current side [{D.case_id=B.cat "compatibility-preview-" (B.axis_key side);case_name=None;values=values}]) g B.sides
