module Slopgrid.PolicyAdmission

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module P = Slopgrid.Parameters
module B = Slopgrid.PolicyBase
module V = Slopgrid.PolicyVariables

let deferred_issue (message:string) (path:list D.json) : Tot D.json = D.set (B.issue message path) "deferred" (D.JBool true)
let criteria_issues (criteria:list D.json) : Tot (list D.json) =
  (if criteria = [] then [B.issue "Add at least one criterion." []] else []) @
  B.flatmap (fun (i,c) -> if B.nonempty (D.str (D.get c "text")) then [] else
    [B.issue "Enter a yes-or-no question for each criterion." [D.number i;D.string "text"]]) (B.indexed criteria)
let chat_issues (messages:list D.json) : Tot (list D.json) =
  if messages = [] then [B.issue "Add a message." []] else
  B.flatmap (fun (i,m) -> if B.has_items (D.get m "images") && D.str (D.get m "role") <> "user" then
    [B.issue "Images can only be attached to user messages." [D.number i;D.string "images"]] else []) (B.indexed messages) @
  B.flatmap (fun (i,m) -> let role = D.str (D.get m "role") in
    if role <> "unfilled" && not (B.nonempty (D.str (D.get m "content"))) && not (role = "user" && B.has_items (D.get m "images")) then
      [B.issue "Enter a message or attach an image." [D.number i;D.string "content"]] else []) (B.indexed messages) @
  B.flatmap (fun (i,m) -> if D.str (D.get m "role") = "unfilled" && D.str (D.get m "content") <> "" then
    [B.issue "Leave unfilled messages empty." [D.number i;D.string "content"]] else []) (B.indexed messages) @
  (if D.str (D.get (D.at messages 0) "role") = "unfilled" then [B.issue "Add a message before the first unfilled message." [D.number 0;D.string "role"]] else [])
let prepend (path:list D.json) (item:D.json) : Tot D.json = D.set item "path" (D.array (path @ D.items (D.get item "path")))
let trim_kinds = ["model";"judge_model";"size";"aspect_ratio";"quality";"background"]
let trim_criteria (value:D.json) : Tot D.json = D.array (L.map (fun c -> D.set c "text" (D.string (N.trim (D.str (D.get c "text"))))) (D.items value))
let normalize (input:D.json) : Tot D.json =
  let parameters = D.object (L.map (fun (kind,s) ->
    let s = if B.member kind trim_kinds && D.str (D.get s "kind") = "common" then D.set s "value" (D.string (N.trim (D.str (D.get s "value")))) else s in
    let s = if kind = "judge_criteria" && D.boolean (D.get input "judge") && D.str (D.get s "kind") = "common" then D.set s "value" (trim_criteria (D.get s "value")) else s in
    (kind,s)) (D.fields (D.get input "parameters"))) in
  let input = D.set input "parameters" parameters in
  L.fold_left (fun g side -> D.set g side (D.array (L.map (fun record ->
    let record = if D.has record "name" then
      let name = N.trim (D.str (D.get record "name")) in if name = "" then D.omit record "name" else D.set record "name" (D.string name) else record in
    let record = L.fold_left (fun r kind -> if D.has r kind then D.set r kind (D.string (N.trim (D.str (D.get r kind)))) else r) record trim_kinds in
    if D.boolean (D.get input "judge") && B.source_kind input "judge_criteria" = side && D.has record "judge_criteria" then D.set record "judge_criteria" (trim_criteria (D.get record "judge_criteria")) else record) (D.items (D.get g side))))) input B.sides
let applicable (input:D.json) (kind:string) : Tot bool =
  B.member kind ["input";"model";"variable"] ||
  (if D.str (D.get input "format") = "image" then B.member kind B.image_kinds else kind = "effort") ||
  (D.boolean (D.get input "judge") && B.member kind ["judge_model";"judge_effort";"judge_criteria";"judge_system"])
let axis_issues (input:D.json) : Tot (list D.json) =
  B.flatmap (fun side -> if D.items (D.get input side) <> [] then [] else
    if not (P.is_case_axis input side) && (B.source_kind input "model" = side || B.source_kind input "judge_model" = side) then
      [deferred_issue "Select at least one model" [D.string side]]
    else [B.issue "Too small: expected array to have >=1 items" [D.string side]]) B.sides
let parameter_issues (input:D.json) : Tot (list D.json) =
  (if D.boolean (D.get input "judge") && D.str (D.get input "format") = "html" then [B.issue "Websites do not support a judge yet." [D.string "judge"]] else []) @
  B.flatmap (fun kind ->
    if kind = "variable" then [] else
    let s = B.source input kind in
    let path = [D.string "parameters";D.string kind] in
    if not (applicable input kind) then
      if B.is_null s then [] else [B.issue (B.cat kind " is not applicable to this grid.") path]
    else if B.is_null s then [B.issue (B.cat "Choose a source for " (B.cat kind ".")) path]
    else B.flatmap (fun (index,value) ->
      let path = B.value_path input kind index index in
      if B.is_null value then [B.issue (B.cat (B.cat "Add " kind) (B.cat (B.cat " to every " (B.source_kind input kind)) " case.")) path]
      else if B.member kind ["model";"judge_model"] && not (B.nonempty (D.str value)) then
        [B.issue (if kind = "model" then "Select a model." else "Select a judge model.") path]
      else if B.member kind B.image_kinds && not (B.valid_image kind (D.str value)) then
        [B.issue (if kind = "size" then "Use a resolution or a size such as 1536x1024" else "Unknown image setting") path]
      else []) (B.values input kind)) B.kinds
let ownership_issues (input:D.json) : Tot (list D.json) =
  B.flatmap (fun side ->
    let owned = P.axis_parameters input side @ (if P.is_case_axis input side then ["variable"] else []) in
    let rec records (rest:list D.json) (index:nat) (ids:list string) : Tot (list D.json) (decreases rest) =
      match rest with | [] -> [] | record::tail ->
      let id = D.str (D.get record "id") in
      (if B.member id ids then [B.issue "Case IDs must be distinct within an axis." [D.string side;D.number index;D.string "id"]] else []) @
      B.flatmap (fun (key,_) -> if key = "id" || key = "name" || B.member key owned then [] else
        [B.issue (B.cat key (B.cat " is not owned by " (B.cat side "."))) [D.string side;D.number index;D.string key]]) (D.fields record) @
      records tail (index+1) (id::ids) in
    records (D.items (D.get input side)) 0 []) B.sides
let raw_input_issues (input:D.json) : Tot (list D.json) =
  B.flatmap (fun (index,value) ->
    let messages = D.items value in
    let path = B.value_path input "input" index index in
    (if D.str (D.get input "format") <> "chat-template" && (L.length messages <> 1 || D.str (D.get (D.at messages 0) "role") <> "user") then
      [B.issue "Prompt formats require exactly one user message." path] else []) @
    L.map (prepend path) (L.filter (fun item ->
      let p = D.items (D.get item "path") in
      not (B.member (D.string "content") p) || D.str (D.get (D.at messages (D.natural (D.at p 0))) "role") = "unfilled") (chat_issues messages))) (B.values input "input")
let raw_criteria_issues (input:D.json) : Tot (list D.json) =
  if not (D.boolean (D.get input "judge")) || B.is_null (B.source input "judge_criteria") then [] else
  B.flatmap (fun (index,criteria) -> L.map (prepend (B.value_path input "judge_criteria" index index)) (criteria_issues (D.items criteria))) (B.values input "judge_criteria")
let expanded_issue (input:D.json) (row:nat) (column:nat) (path:list D.json) (template:string) (item:D.json) : Tot (list D.json) =
  let item_path = D.items (D.get item "path") in
  [prepend path item] @
  (if B.member (D.string "content") item_path || B.member (D.string "text") item_path then
    L.map (fun reference -> B.issue (D.str (D.get item "message")) (D.items (D.get reference "path") @ [D.string "text"])) (V.references template input row column) else [])
let expanded_issues (input:D.json) : Tot (list D.json) =
  B.flatmap (fun (row,_) -> B.flatmap (fun (column,_) ->
    let raw = B.messages input row column in
    let messages = V.expand_messages input row column in
    let path = B.value_path input "input" row column in
    B.flatmap (fun item ->
      let index = D.natural (D.at (D.items (D.get item "path")) 0) in
      expanded_issue input row column path (D.str (D.get (D.at raw index) "content")) item) (chat_issues messages) @
    (if D.str (D.get input "format") = "image" && not (B.nonempty (D.str (D.get (D.at messages 0) "content"))) then
      expanded_issue input row column path (D.str (D.get (D.at raw 0) "content")) (B.issue "Enter a prompt." (if messages = [] then [] else [D.number 0;D.string "content"])) else []) @
    (if not (D.boolean (D.get input "judge")) then [] else
      let criteria,_ = V.resolve_criteria input row column in
      B.flatmap (fun item ->
        let index = D.natural (D.at (D.items (D.get item "path")) 0) in
        expanded_issue input row column (B.value_path input "judge_criteria" row column) (D.str (D.get (D.at (B.criteria input row column) index) "text")) item) (criteria_issues criteria)))
    (B.indexed (D.items (D.get input "columns")))) (B.indexed (D.items (D.get input "rows")))
let semantic_issues (input:D.json) : Tot (list D.json) =
  B.distinct_issues (axis_issues input @ parameter_issues input @ P.parameter_layout_issues input @ ownership_issues input @ raw_input_issues input @
    (if D.items (D.get input "rows") = [] || D.items (D.get input "columns") = [] then raw_criteria_issues input else []) @
    V.prompt_issues input @ expanded_issues input)
let budget_value (input:D.json) : Tot D.json =
  let text = D.str (D.get input "budgetUsd") in
  if N.trim text = "" then D.JNull else match N.parse_number text with | None -> D.JNull | Some n -> D.JNumber n
let budget_issues (input:D.json) (budget:D.json) : Tot (list D.json) =
  if D.str (D.get input "format") = "image" then [] else
  match budget with
  | D.JNumber n -> if N.positive_number n then [] else [B.issue "Too small: expected number to be >0" [D.string "budgetUsd"]]
  | _ ->
    let text = D.str (D.get input "budgetUsd") in
    let received =
      if N.trim text <> "" && N.number_kind text = "infinite"
      then (if N.compare_number text "0" < 0 then "-Infinity" else "Infinity")
      else "NaN" in
    [B.issue (N.concat "Invalid input: expected number, received " received) [D.string "budgetUsd"]]
let admit_input (input:D.json) : Tot (D.json & D.json & list D.json) =
  let budget = budget_value input in
  let candidate = D.set input "budgetUsd" budget in
  let axes = D.strings (D.get input "caseAxes") in
  let base_errors = (if L.length axes = L.length (D.unique_strings axes) then [] else [B.issue "Case axes must be distinct." [D.string "caseAxes"]]) @ budget_issues input budget in
  let admitted_budget = if D.str (D.get input "format") = "image" && (B.is_null budget || (match budget with | D.JNumber n -> not (N.positive_number n) | _ -> true)) then D.number 3 else budget in
  let normalized = normalize (D.set input "budgetUsd" admitted_budget) in
  (candidate, normalized, (if base_errors = [] then semantic_issues normalized else base_errors))
let preview (input:D.json) : Tot D.json =
  L.fold_left (fun current side -> if D.items (D.get current side) <> [] then current else
    let record = L.fold_left (fun r kind -> D.set r kind (P.parameter_default kind)) (D.object [("id",D.string (B.cat "compatibility-preview-" side))]) (P.axis_parameters input side) in
    D.set current side (D.array [record])) input B.sides
