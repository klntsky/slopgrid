module Slopgrid.PolicyVariables

module D = Slopgrid.Domain
open Slopgrid.Domain
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module Num = Slopgrid.Number
module P = Slopgrid.Parameters
module I = Slopgrid.Input
module B = Slopgrid.PolicyBase

let variable_name = I.variable_name
let variable_index = I.variable_index
let tokens = I.variable_tokens
let rec find_slot (name:string) (index:list (string & D.axis & nat)) : Tot (option (D.axis & nat)) (decreases index) =
  match index with | [] -> None | (n,s,i)::rest -> if n = name then Some (s,i) else find_slot name rest
let fields (record:option D.case_record) : Tot (option (list (option D.variable_field))) =
  match record with | None -> None | Some r -> r.values.variable_value
let field_for (g:D.layout) (side:D.axis) (field:nat) (row:nat) (column:nat) : Tot (option D.variable_field) =
  match B.at (B.option_list (fields (B.at (B.records g side) (if side = D.Rows then row else column)))) field with
  | None -> None | Some f -> f
let resolve (g:D.layout) (name:string) (row:nat) (column:nat) : Tot (option D.variable_field) =
  match find_slot name (variable_index g) with | None -> None | Some (s,i) -> field_for g s i row column
let merge_images (groups:list (list D.reference_image)) : Tot (list D.reference_image) =
  let rec loop (xs:list D.reference_image) (seen:list string) : Tot (list D.reference_image) (decreases xs) =
    match xs with | [] -> [] | h::t ->
    if B.member h.reference_id seen then loop t seen else h :: loop t (h.reference_id::seen) in
  loop (L.flatten groups) []
type reference = { field:D.variable_field; side:D.axis; record_index:nat; field_index:nat }
let reference_path (r:reference) : Tot (list D.path_segment) =
  [D.Property (B.axis_key r.side);D.Index r.record_index;D.Property "variable";D.Index r.field_index]
let references (text:string) (g:D.layout) (row:nat) (column:nat) : Tot (list reference) =
  B.unique (B.flatmap (fun name -> match find_slot name (variable_index g) with
    | None -> []
    | Some (s,i) -> match field_for g s i row column with | None -> [] | Some f ->
      [{field=f;side=s;record_index=(if s = D.Rows then row else column);field_index=i}]) (tokens text))
let interpolate (text:string) (g:D.layout) (row:nat) (column:nat) : Tot (string & list D.reference_image) =
  let rec expand (fuel:nat) (offset:nat) : Tot string (decreases fuel) =
    if fuel = 0 || offset >= N.length text then "" else
    match I.token_at text offset with
    | None -> B.cat (N.char_at text offset) (expand (fuel-1) (offset+1))
    | Some (name,count) ->
      B.cat (match resolve g name row column with | None -> B.cat "$" name | Some f -> f.text)
        (expand (fuel-1) (offset + (if count = 0 then 1 else count))) in
  (expand (N.length text) 0, merge_images (L.map (fun r -> B.option_list r.field.field_images) (references text g row column)))
let expand_messages (g:D.layout) (row:nat) (column:nat) : Tot (list D.message) =
  L.map (fun message ->
    let text,images = interpolate message.D.content g row column in
    let merged = merge_images [B.option_list message.images; if message.message_role = D.UserRole then images else []] in
    {message with content=text;images=(if merged = [] then message.images else Some merged)}) (B.messages g row column)
let resolve_criteria (g:D.layout) (row:nat) (column:nat) : Tot (list D.criterion & list D.reference_image) =
  let expanded = L.map (fun criterion ->
    let text,images = interpolate criterion.D.criterion_text g row column in
    ({criterion with criterion_text=text},images)) (B.criteria g row column) in
  (L.map (fun (c,_) -> c) expanded,merge_images (L.map (fun (_,images) -> images) expanded))
let names (g:D.layout) (side:D.axis) : Tot (list (option string)) =
  match g.variable_names with | None -> [] | Some ns -> B.option_list (if side = D.Rows then ns.row_names else ns.column_names)
let name_issues (g:D.layout) : Tot (list D.validation_issue) =
  let invalid = B.flatmap (fun side -> B.flatmap (fun (index,name) ->
    match name with | None -> [] | Some n ->
    if n <> "" && B.all_chars n "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" then [] else
    [B.issue "Variable names must contain only A-Z, digits, or underscore." [D.Property "variableNames";D.Property (B.axis_key side);D.Index index]])
    (B.indexed (names g side))) B.sides in
  let slots = B.flatmap (fun side ->
    if not (P.is_case_axis g side) then [] else
    B.flatmap (fun (i,field) -> match field with | None -> [] | Some _ -> [(variable_name g side i,side,i)])
      (B.indexed (B.option_list (fields (B.at (B.records g side) 0))))) B.sides in
  invalid @ B.flatmap (fun name ->
    let matching = L.filter (fun (n,_,_) -> n = name) slots in
    if L.length matching < 2 then [] else
    L.map (fun (_,side,index) -> B.issue (B.cat (B.cat "Variable name " name) " is already in use.") [D.Property "variableNames";D.Property (B.axis_key side);D.Index index]) matching)
    (B.unique (L.map (fun (name,_,_) -> name) slots))
let active (#a:Type) (v:option a) : Tot bool = match v with | None -> false | Some _ -> true
let shape_issues (g:D.layout) : Tot (list D.validation_issue) =
  B.flatmap (fun side ->
    if not (P.axis_has_variables g side) then [] else
    let first = fields (B.at (B.records g side) 0) in
    B.flatmap (fun (case_index,record) ->
      let variable = record.D.values.variable_value in
      let path = [D.Property (B.axis_key side);D.Index case_index;D.Property "variable"] in
      let msg = "Variable values must have the same active fields." in
      (if not (active first) || not (active variable) || L.length (B.option_list variable) <> L.length (B.option_list first) then [B.issue msg path] else []) @
      (match first,variable with | Some fs,Some vs ->
        B.flatmap (fun (field_index,field) ->
          let original = match B.at fs field_index with | None -> None | Some f -> f in
          if active field = (field_index >= L.length fs || active original) then [] else [B.issue msg (path @ [D.Index field_index])]) (B.indexed vs)
       | _ -> [])) (B.indexed (B.records g side))) B.sides
type template = { template_text:string; template_role:D.role; template_path:list D.path_segment }
let templates (g:D.layout) (row:nat) (column:nat) : Tot (list template) =
  let generator = B.mapi (fun index message ->
    {template_text=message.D.content;template_role=message.message_role;template_path=B.value_path g D.PInput row column @ [D.Index index;D.Property "content"]}) (B.messages g row column) in
  generator @ (if not g.judging then [] else
    [{template_text=B.text g D.PJudgeSystem row column;template_role=D.SystemRole;template_path=B.value_path g D.PJudgeSystem row column}] @
    B.mapi (fun index criterion -> {template_text=criterion.D.criterion_text;template_role=D.UserRole;template_path=B.value_path g D.PJudgeCriteria row column @ [D.Index index;D.Property "text"]}) (B.criteria g row column))
let preview_indices (g:D.layout) (side:D.axis) : Tot (list nat) =
  match B.records g side with | [] -> [0] | rs -> B.mapi (fun i _ -> i) rs
let cell_templates (g:D.layout) : Tot (list (nat & nat & template)) =
  B.flatmap (fun row -> B.flatmap (fun column -> L.map (fun t -> (row,column,t)) (templates g row column)) (preview_indices g D.Columns)) (preview_indices g D.Rows)
let prompt_issues (g:D.layout) : Tot (list D.validation_issue) =
  let index = variable_index g in
  let used_and_issues = B.flatmap (fun (row,column,t) ->
    B.flatmap (fun name ->
      let unknown = B.issue (B.cat "Unknown prompt variable $" name) t.template_path in
      match find_slot name index with
      | None -> [(None,Some unknown)]
      | Some (side,field_index) ->
        match field_for g side field_index row column with | None -> [(None,Some unknown)] | Some field ->
        (Some side,None) ::
        (if t.template_role = D.UserRole || B.option_list field.field_images = [] then [] else
          let msg = "Variable images can only be attached to user messages." in
          [(None,Some (B.issue msg t.template_path));(None,Some (B.issue msg [D.Property (B.axis_key side);D.Index (if side = D.Rows then row else column);D.Property "variable";D.Index field_index;D.Property "images"]))]))
      (tokens t.template_text)) (cell_templates g) in
  let used = B.flatmap (fun (side,_) -> match side with | None -> [] | Some s -> [s]) used_and_issues in
  let token_issues = B.flatmap (fun (_,issue) -> match issue with | None -> [] | Some i -> [i]) used_and_issues in
  let unused = B.flatmap (fun side ->
    if L.existsb (fun kind -> kind <> D.PVariable) (P.axis_parameters g side) || B.member side used then [] else
    let records = B.records g side in
    let active_fields = L.filter (fun (_,f) -> active f) (B.indexed (B.option_list (fields (B.at records 0)))) in
    match active_fields with
    | (field_index,_)::_ ->
      let msg = B.cat (B.cat "$" (variable_name g side field_index)) " is not used anywhere" in
      B.flatmap (fun (case_index,_) ->
        if not (active (field_for g side field_index case_index case_index)) then [] else
        [B.issue msg [D.Property (B.axis_key side);D.Index case_index;D.Property "variable";D.Index field_index;D.Property "text"]]) (B.indexed records)
    | [] ->
      if records = [] then [B.issue (B.cat (B.cat "Add at least one " (if side = D.Rows then "row" else "column")) " case.") [D.Property (B.axis_key side)]]
      else if P.axis_parameters g side = [] ||
        not (L.existsb (fun kind -> kind <> D.PVariable || L.existsb (fun r -> L.existsb active (B.option_list r.D.values.variable_value)) records) (P.axis_parameters g side)) then
        [B.issue "Add a variable or click \"define multiple cases\" for a parameter." [D.Property (B.axis_key side)]] else []) (B.case_axes g) in
  name_issues g @ shape_issues g @ token_issues @ unused
let image_setting (g:D.layout) (p:D.parameter) (r:nat) (c:nat) : Tot (option string) =
  match B.value g p r c with | None -> None | Some v -> Some (B.text_value v)
let expand_cell (g:D.layout) (budget:option Num.finite) (row:nat) (column:nat) : Tot D.preview_cell =
  let messages = expand_messages g row column in
  let first = B.at messages 0 in
  let prompt = if g.output_format = D.ChatTemplate then B.join "\n\n" (L.map (fun m -> B.cat (B.cat (B.role_key m.D.message_role) ": ") m.content) messages)
    else match first with | None -> "" | Some m -> m.content in
  let settings = {D.image_size=image_setting g D.PSize row column;image_aspect_ratio=image_setting g D.PAspectRatio row column;
    image_quality=image_setting g D.PQuality row column;image_background=image_setting g D.PBackground row column;
    input_references=(match first with | None -> None | Some m -> match m.images with | None -> None | Some images -> Some (L.map (fun i -> i.D.reference_id) images))} in
  {D.cell_row=row;cell_column=column;cell_model=B.text g D.PModel row column;cell_effort=B.effort g D.PEffort row column;prompt=prompt;
   messages=Some messages;preview_budget=budget;image_settings=(if g.output_format = D.Image then Some (B.normalize_settings settings) else None);
   judge=(if not g.judging then None else Some {D.judge_model=B.text g D.PJudgeModel row column;judge_effort=B.effort g D.PJudgeEffort row column;criteria=None})}
let expand_grid (g:D.layout) (budget:option Num.finite) : Tot (list D.preview_cell) =
  B.flatmap (fun (row,_) -> L.map (fun (column,_) -> expand_cell g budget row column) (B.indexed g.columns)) (B.indexed g.rows)
