module Slopgrid.PolicyVariables

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module P = Slopgrid.Parameters
module I = Slopgrid.Input
module B = Slopgrid.PolicyBase

let variable_name = I.variable_name
let variable_index = I.variable_index
let tokens = I.variable_tokens
let rec find_slot (name:string) (index:list (string & string & nat)) : Tot (option (string & nat)) (decreases index) =
  match index with
  | [] -> None
  | (n,s,i)::rest -> if n = name then Some (s,i) else find_slot name rest
let field_for (input:D.json) (side:string) (field:nat) (row:nat) (column:nat) : Tot D.json =
  D.at (D.items (D.get (D.at (D.items (D.get input side)) (if side = "rows" then row else column)) "variable")) field
let resolve (input:D.json) (name:string) (row:nat) (column:nat) : Tot D.json =
  match find_slot name (variable_index input) with | None -> D.JNull | Some (s,i) -> field_for input s i row column
let merge_images (groups:list (list D.json)) : Tot (list D.json) =
  let rec loop (xs:list D.json) (seen:list string) : Tot (list D.json) (decreases xs) =
    match xs with | [] -> [] | h::t ->
    let id = D.str (D.get h "id") in
    if B.member id seen then loop t seen else h :: loop t (id::seen) in
  loop (L.flatten groups) []
let references (text:string) (input:D.json) (row:nat) (column:nat) : Tot (list D.json) =
  let refs = B.flatmap (fun name ->
    match find_slot name (variable_index input) with
    | None -> []
    | Some (s,i) ->
      let field = field_for input s i row column in
      if B.is_null field then [] else
      [D.object [("field",field);("path",D.array [D.string s;D.number (if s = "rows" then row else column);D.string "variable";D.number i])]]) (tokens text) in
  B.unique_json refs
let interpolate (text:string) (input:D.json) (row:nat) (column:nat) : Tot (string & list D.json) =
  let rec expand (fuel:nat) (offset:nat) : Tot string (decreases fuel) =
    if fuel = 0 || offset >= N.length text then "" else
    match I.token_at text offset with
    | None -> B.cat (N.char_at text offset) (expand (fuel-1) (offset+1))
    | Some (name,count) ->
      let field = resolve input name row column in
      B.cat (if B.is_null field then B.cat "$" name else D.str (D.get field "text"))
        (expand (fuel-1) (offset + (if count = 0 then 1 else count))) in
  let expanded = expand (N.length text) 0 in
  let images = merge_images (L.map (fun reference -> D.items (D.get (D.get reference "field") "images")) (references text input row column)) in
  (expanded,images)
let expand_messages (input:D.json) (row:nat) (column:nat) : Tot (list D.json) =
  L.map (fun message ->
    let text,images = interpolate (D.str (D.get message "content")) input row column in
    let merged = merge_images [D.items (D.get message "images"); if D.str (D.get message "role") = "user" then images else []] in
    let message = D.set message "content" (D.string text) in
    if merged = [] then message else D.set message "images" (D.array merged)) (B.messages input row column)
let resolve_criteria (input:D.json) (row:nat) (column:nat) : Tot (list D.json & list D.json) =
  let expanded = L.map (fun criterion ->
    let text,images = interpolate (D.str (D.get criterion "text")) input row column in
    (D.set criterion "text" (D.string text),images)) (B.criteria input row column) in
  (L.map (fun (c,_) -> c) expanded,merge_images (L.map (fun (_,images) -> images) expanded))
let name_issues (input:D.json) : Tot (list D.json) =
  let invalid = B.flatmap (fun side -> B.flatmap (fun (index,name) ->
    if B.is_null name || (D.str name <> "" && B.all_chars (D.str name) "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") then []
    else [B.issue "Variable names must contain only A-Z, digits, or underscore." [D.string "variableNames";D.string side;D.number index]])
    (B.indexed (D.items (D.get (D.get input "variableNames") side)))) B.sides in
  let slots = B.flatmap (fun side ->
    if not (P.is_case_axis input side) then [] else
    B.flatmap (fun (i,field) -> if B.is_null field then [] else [(variable_name input side i,side,i)])
      (B.indexed (D.items (D.get (D.at (D.items (D.get input side)) 0) "variable")))) B.sides in
  let names = D.unique_strings (L.map (fun (name,_,_) -> name) slots) in
  invalid @ B.flatmap (fun name ->
    let matching = L.filter (fun (n,_,_) -> n = name) slots in
    if L.length matching < 2 then [] else
    L.map (fun (_,side,index) -> B.issue (B.cat (B.cat "Variable name " name) " is already in use.") [D.string "variableNames";D.string side;D.number index]) matching) names
let shape_issues (input:D.json) : Tot (list D.json) =
  B.flatmap (fun side ->
    if not (P.axis_has_variables input side) then [] else
    let fields = D.get (D.at (D.items (D.get input side)) 0) "variable" in
    B.flatmap (fun (case_index,record) ->
      let variable = D.get record "variable" in
      let path = [D.string side;D.number case_index;D.string "variable"] in
      let msg = "Variable values must have the same active fields." in
      (if B.is_null fields || B.is_null variable || L.length (D.items variable) <> L.length (D.items fields) then [B.issue msg path] else []) @
      (if B.is_null fields || B.is_null variable then [] else
        B.flatmap (fun (field_index,field) ->
          if B.is_null field = (field_index < L.length (D.items fields) && B.is_null (D.at (D.items fields) field_index)) then [] else [B.issue msg (path @ [D.number field_index])]) (B.indexed (D.items variable))))
      (B.indexed (D.items (D.get input side)))) B.sides
let templates (input:D.json) (row:nat) (column:nat) : Tot (list D.json) =
  let generator = B.mapi (fun index message ->
    D.object [("text",D.get message "content");("role",D.get message "role");("path",D.array (B.value_path input "input" row column @ [D.number index;D.string "content"]))]) (B.messages input row column) in
  generator @ (if not (D.boolean (D.get input "judge")) then [] else
    [D.object [("text",B.value_default input "judge_system" row column (D.string ""));("role",D.string "system");("path",D.array (B.value_path input "judge_system" row column))]] @
    B.mapi (fun index criterion -> D.object [("text",D.get criterion "text");("role",D.string "user");("path",D.array (B.value_path input "judge_criteria" row column @ [D.number index;D.string "text"]))]) (B.criteria input row column))
let preview_records (input:D.json) (side:string) : Tot (list D.json) =
  let records = D.items (D.get input side) in if records = [] then [D.JNull] else records
let cell_templates (input:D.json) : Tot (list (nat & nat & D.json)) =
  B.flatmap (fun (row,_) -> B.flatmap (fun (column,_) -> L.map (fun template -> (row,column,template)) (templates input row column)) (B.indexed (preview_records input "columns"))) (B.indexed (preview_records input "rows"))
let prompt_issues (input:D.json) : Tot (list D.json) =
  let index = variable_index input in
  let used_and_issues = B.flatmap (fun (row,column,template) ->
    B.flatmap (fun name ->
      let path = D.items (D.get template "path") in
      let unknown = B.issue (B.cat "Unknown prompt variable $" name) path in
      match find_slot name index with
      | None -> [("",unknown)]
      | Some (side,field_index) ->
        let field = field_for input side field_index row column in
        if B.is_null field then [("",unknown)] else
        (side,D.JNull) ::
        (if D.str (D.get template "role") = "user" || not (B.has_items (D.get field "images")) then [] else
          let msg = "Variable images can only be attached to user messages." in
          [("",B.issue msg path);("",B.issue msg [D.string side;D.number (if side = "rows" then row else column);D.string "variable";D.number field_index;D.string "images"])]))
      (tokens (D.str (D.get template "text")))) (cell_templates input) in
  let used = L.map (fun (side,_) -> side) used_and_issues in
  let token_issues = B.flatmap (fun (_,issue) -> if B.is_null issue then [] else [issue]) used_and_issues in
  let unused = B.flatmap (fun side ->
    if L.existsb (fun kind -> kind <> "variable") (P.axis_parameters input side) || B.member side used then [] else
    let records = D.items (D.get input side) in
    let active = L.filter (fun (_,field) -> not (B.is_null field)) (B.indexed (D.items (D.get (D.at records 0) "variable"))) in
    match active with
    | (field_index,_)::_ ->
      let msg = B.cat (B.cat "$" (variable_name input side field_index)) " is not used anywhere" in
      B.flatmap (fun (case_index,record) ->
        if B.is_null (D.at (D.items (D.get record "variable")) field_index) then [] else
        [B.issue msg [D.string side;D.number case_index;D.string "variable";D.number field_index;D.string "text"]]) (B.indexed records)
    | [] ->
      if records = [] then [B.issue (B.cat (B.cat "Add at least one " (if side = "rows" then "row" else "column")) " case.") [D.string side]]
      else if P.axis_parameters input side = [] ||
        not (L.existsb (fun kind -> kind <> "variable" || L.existsb (fun record -> L.existsb (fun f -> not (B.is_null f)) (D.items (D.get record "variable"))) records) (P.axis_parameters input side)) then
        [B.issue "Add a variable or click \"define multiple cases\" for a parameter." [D.string side]]
      else []) (D.strings (D.get input "caseAxes")) in
  name_issues input @ shape_issues input @ token_issues @ unused
let expand_cell (input:D.json) (row:nat) (column:nat) : Tot D.json =
  let messages = expand_messages input row column in
  let format = D.str (D.get input "format") in
  let prompt = if format = "chat-template" then D.join "\n\n" (L.map (fun message -> B.cat (B.cat (D.str (D.get message "role")) ": ") (D.str (D.get message "content"))) messages)
    else D.str (D.get (D.at messages 0) "content") in
  let settings = D.object (L.map (fun kind -> (kind,B.value input kind row column)) B.image_kinds) in
  let attachments = D.get (D.at messages 0) "images" in
  let settings = if B.is_null attachments then settings else D.set settings "input_references" (D.array (L.map (fun image -> D.get image "id") (D.items attachments))) in
  D.object ([("row",D.number row);("column",D.number column);("model",B.value_default input "model" row column (D.string ""));("effort",B.value_default input "effort" row column (D.string "default"));("prompt",D.string prompt);("messages",D.array messages);("budgetUsd",D.get input "budgetUsd");("status",D.string "pending")] @
    (if format = "image" then [("imageSettings",B.normalize_settings settings)] else []) @
    (if not (D.boolean (D.get input "judge")) then [] else [("judge",D.object [("model",B.value_default input "judge_model" row column (D.string ""));("effort",B.value_default input "judge_effort" row column (D.string "default"));("status",D.string "pending")])]))
let expand_grid (input:D.json) : Tot (list D.json) =
  B.flatmap (fun (row,_) -> L.map (fun (column,_) -> expand_cell input row column) (B.indexed (D.items (D.get input "columns")))) (B.indexed (D.items (D.get input "rows")))
