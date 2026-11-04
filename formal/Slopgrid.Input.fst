module Slopgrid.Input

module D = Slopgrid.Domain
module L = FStar.List.Tot.Base
module N = Slopgrid.Native
module P = Slopgrid.Parameters
open Slopgrid.Domain
open Prims

let cat = N.concat
let at = P.at
let entries = P.entries
let other_side (side:axis) : Tot axis = if side = Rows then Columns else Rows
let set_entries (input:layout) (side:axis) (values:list case_record) : Tot layout =
  if side = Rows then {input with rows=values} else {input with columns=values}
let set_source (input:layout) (p:common_parameter) (value:source p) : Tot layout =
  {input with parameters=P.set_source input.parameters p value}
let member (#a:eqtype) (value:a) (values:list a) : Tot bool = L.existsb (fun x -> x = value) values
let rec map_i_from #a #b (f:nat -> a -> Tot b) (index:nat) (values:list a) : Tot (list b) (decreases values) =
  match values with | [] -> [] | value::rest -> f index value :: map_i_from f (index + 1) rest
let map_i #a #b (f:nat -> a -> Tot b) (values:list a) : Tot (list b) = map_i_from f 0 values
let rec fold #a #b (f:b -> a -> Tot b) (state:b) (values:list a) : Tot b (decreases values) =
  match values with | [] -> state | value::rest -> fold f (f state value) rest
let rec replace_at #a (values:list a) (index:nat) (value:a) : Tot (list a) =
  match values with | [] -> [] | first::rest -> if index = 0 then value::rest else first::replace_at rest (index - 1) value
let rec remove_at #a (values:list a) (index:nat) : Tot (list a) =
  match values with | [] -> [] | first::rest -> if index = 0 then rest else first::remove_at rest (index - 1)
let rec insert_at #a (values:list a) (index:nat) (value:a) : Tot (list a) =
  match values with | [] -> [value] | first::rest -> if index = 0 then value::values else first::insert_at rest (index - 1) value
let move #a (values:list a) (index:nat) (target:nat) : Tot (list a) =
  if target >= L.length values || index = target then values else
  match at values index with | None -> values | Some value -> insert_at (remove_at values index) target value
let option_list #a (value:option (list a)) : Tot (list a) = match value with | None -> [] | Some values -> values
let case_axes (input:layout) : Tot (list axis) = match input.case_ownership with
  | NoCaseAxes -> [] | OneCaseAxis side -> [side] | BothCaseAxes first -> [first; other_side first]
let remove_case_axis (input:layout) (side:axis) : Tot layout =
  {input with case_ownership=match input.case_ownership with
    | NoCaseAxes -> NoCaseAxes | OneCaseAxis owner -> if owner = side then NoCaseAxes else OneCaseAxis owner
    | BothCaseAxes _ -> OneCaseAxis (other_side side)}
let add_case_axis (input:layout) (side:axis) : Tot layout =
  {input with case_ownership=match input.case_ownership with
    | NoCaseAxes -> OneCaseAxis side | OneCaseAxis owner -> if owner = side then OneCaseAxis owner else BothCaseAxes owner
    | BothCaseAxes first -> BothCaseAxes first}
let normalize_messages (messages:list message) : Tot (list message) =
  L.map (fun message -> {message with images=match message.images with | Some [] -> None | other -> other}) messages
let normalize_fields (fields:list (option variable_field)) : Tot (list (option variable_field)) =
  L.map (fun field -> match field with | None -> None | Some field -> Some {field with field_images=match field.field_images with | Some [] -> None | other -> other}) fields
let comparison_value (value:value) : Tot (value_for (value_parameter value)) = match value with
  | InputValue messages -> InputValue (normalize_messages messages)
  | VariableValue fields -> VariableValue (normalize_fields fields)
  | other -> other
let parameter_values_equal (left:value) (right:value) : Tot bool = comparison_value left = comparison_value right
let optional_values_equal (p:parameter) (left:option (value_for p)) (right:option (value_for p)) : Tot bool = match left,right with
  | None,None -> true | Some left,Some right -> parameter_values_equal left right | _ -> false
let has_parameter_value (p:parameter) (value:option (value_for p)) : Tot bool =
  match value with | None -> false | Some value -> not (parameter_values_equal value (P.parameter_default p))
let case_ids (input:layout) : Tot (list string) = L.map (fun entry -> entry.case_id) (L.append input.rows input.columns)
let rec available_id (fuel:nat) (ids:list string) (prefix:string) (counter:nat) : Tot (string & nat) (decreases fuel) =
  let id = cat prefix (N.nat_string counter) in
  if member id ids && fuel > 0 then available_id (fuel - 1) ids prefix (counter + 1) else (id,counter + 1)
let new_case (input:layout) (allocation:string & list string) (counter:nat) (values:case_values) : Tot (case_record & nat) =
  let prefix,reserved = allocation in
  let ids = L.append reserved (case_ids input) in
  let id,next = available_id (L.length ids + 1) ids prefix counter in
  ({case_id=id; case_name=None; values=values},next)
let neutral_dimension (input:layout) (side:axis) allocation counter =
  if P.is_case_axis input side || L.length (P.axis_parameters input side) > 0 then (input,counter)
  else match entries input side with
    | first::_ -> (set_entries input side [{first with case_name=None; values=P.empty_case_values}],counter)
    | [] -> let entry,next = new_case input allocation counter P.empty_case_values in (set_entries input side [entry],next)
let rec differs_from (p:common_parameter) (reference:option (value_for p)) (values:list case_record) : Tot bool =
  match values with | [] -> false | entry::rest ->
    not (optional_values_equal p (P.get_case_value entry.values p) reference) || differs_from p reference rest
let differing (input:layout) (p:common_parameter) : Tot bool =
  match P.get_source input.parameters p with
  | Some (OnAxis side) ->
    (match entries input side with | [] -> false | first::_ ->
      differs_from p (P.get_case_value first.values p) (entries input side))
  | _ -> false
let collapse (input:layout) (p:common_parameter) allocation counter =
  match P.get_source input.parameters p with
  | Some (OnAxis side) ->
    let value = if differing input p then P.parameter_default p else
      match at (entries input side) 0 with | None -> P.parameter_default p | Some entry ->
        (match P.get_case_value entry.values p with | None -> P.parameter_default p | Some value -> value) in
    let next = set_source input p (Common value) in
    let next = {next with parameters={next.parameters with source_order=L.append (L.filter (fun (key:common_parameter) -> key<>p) next.parameters.source_order) [p]}} in
    neutral_dimension (set_entries next side (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) (entries input side))) side allocation counter
  | _ -> (input,counter)
let remove_parameter (input:layout) (p:common_parameter{p <> PInput /\ p <> PModel}) allocation counter =
  let owner = P.get_source input.parameters p in
  let next = {input with parameters=P.remove_source input.parameters p} in
  match owner with | Some (OnAxis side) ->
    neutral_dimension (set_entries next side (L.map (fun entry -> {entry with values=P.remove_case_value entry.values p}) (entries input side))) side allocation counter
  | _ -> (next,counter)
let name_fields (input:layout) (side:axis) : Tot (option (list (option string))) =
  match input.variable_names with | None -> None | Some names -> if side = Rows then names.row_names else names.column_names
let put_name_fields (input:layout) (side:axis) (fields:option (list (option string))) : Tot layout =
  let names = match input.variable_names with | None -> {row_names=None; column_names=None} | Some names -> names in
  let names = if side = Rows then {names with row_names=fields} else {names with column_names=fields} in
  {input with variable_names=if names.row_names=None && names.column_names=None then None else Some names}
let strip_variables (input:layout) (side:axis) : Tot layout =
  let next = put_name_fields input side None in
  set_entries next side (L.map (fun entry -> {entry with case_name=None; values=P.remove_case_value entry.values PVariable}) (entries input side))
let variable_fields (input:layout) (side:axis) : Tot (list (option variable_field)) =
  match at (entries input side) 0 with | None -> [] | Some entry -> option_list entry.values.variable_value
let case_defaults (input:layout) (side:axis) : Tot case_values =
  fold (fun values p -> P.set_case_value values (if p = PVariable then
    VariableValue (L.map (fun field -> match field with | None -> None | Some _ -> Some {text=""; field_images=None}) (variable_fields input side))
    else P.parameter_default p)) P.empty_case_values (P.axis_parameters input side)
let own_value (input:layout) (p:common_parameter) (side:axis) (value:value_for p) allocation counter =
  let values,count = match entries input side with | [] -> let entry,next = new_case input allocation counter (case_defaults input side) in ([entry],next) | values -> (values,counter) in
  (set_entries (set_source input p (OnAxis side)) side (L.map (fun entry -> {entry with values=P.set_case_value entry.values value}) values),count)
let own (input:layout) (p:common_parameter) (side:axis) allocation counter =
  match P.get_source input.parameters p with
  | Some (OnAxis _) -> (input,counter)
  | Some (Common value) -> own_value input p side value allocation counter
  | None -> own_value input p side (P.parameter_default p) allocation counter
let collapse_parameters (input:layout) (parameters:list parameter) allocation counter =
  fold (fun (current,count) (p:parameter) -> if p = PVariable then (current,count) else collapse current p allocation count) (input,counter) parameters
let generated_name (side:axis) (index:nat) : Tot string = cat (if side = Rows then "ROW" else "COLUMN") (N.nat_string (index + 1))
let variable_name (input:layout) (side:axis) (index:nat) : Tot string =
  match at (option_list (name_fields input side)) index with | Some (Some name) -> name | _ -> generated_name side index
let variable_index (input:layout) : Tot (list (string & axis & nat)) =
  fold (fun result side -> fold (fun acc (index,field) -> match field with | None -> acc | Some _ ->
    let name = variable_name input side index in
    if L.existsb (fun (n,_,_) -> n=name) acc then acc else L.append acc [(name,side,index)]) result (map_i (fun i field -> (i,field)) (variable_fields input side))) [] (case_axes input)
let ascii_token_byte (value:int) : Tot bool =
  (value >= 65 && value <= 90) || (value >= 48 && value <= 57) || value=95
let rec token_length (fuel:nat) (text:string) (position:nat) : Tot nat (decreases fuel) =
  if fuel=0 || not (ascii_token_byte (N.byte_at text position)) then 0 else 1 + token_length (fuel - 1) text (position + 1)
let token_at (text:string) (position:nat) : Tot (option (string & nat)) =
  if N.byte_at text position <> 36 then None else
  let count = token_length (N.length text) text (position + 1) in
  let last = position + 1 + count in
  if count=0 || N.byte_at text last=95 || N.unicode_alphanumeric_at text last then None else Some (N.slice text (position + 1) count,count + 1)
let rec rewrite_scan (fuel:nat) (rename:string -> Tot string) (text:string) (position:nat) : Tot string (decreases fuel) =
  if fuel=0 || position >= N.length text then "" else match token_at text position with
  | Some (name,count) -> cat (cat "$" (rename name)) (rewrite_scan (fuel - 1) rename text (position + count))
  | None -> cat (N.char_at text position) (rewrite_scan (fuel - 1) rename text (position + 1))
let rewrite_text rename text = rewrite_scan (N.length text) rename text 0
let rec token_scan (fuel:nat) (text:string) (position:nat) : Tot (list string) (decreases fuel) =
  if fuel=0 || position >= N.length text then [] else match token_at text position with
  | Some (name,count) -> name :: token_scan (fuel - 1) text (position + count)
  | None -> token_scan (fuel - 1) text (position + 1)
let variable_tokens text = token_scan (N.length text) text 0
let rewrite_value (rename:string -> Tot string) (value:value) : Tot (value_for (value_parameter value)) =
  match value with
  | InputValue messages -> InputValue (L.map (fun message -> {message with content=rewrite_text rename message.content}) messages)
  | JudgeCriteriaValue criteria -> JudgeCriteriaValue (L.map (fun criterion -> {criterion with criterion_text=rewrite_text rename criterion.criterion_text}) criteria)
  | JudgeSystemValue text -> JudgeSystemValue (rewrite_text rename text)
  | other -> other
let text_parameters : list common_parameter = [PInput; PJudgeCriteria; PJudgeSystem]
let rec map_preserving #a #b (f:a -> Tot b) (values:list a) : Tot (result:list b{L.length result=L.length values}) =
  match values with | [] -> [] | value::rest -> f value :: map_preserving f rest
let rewrite_case_values (rename:string -> Tot string) (values:case_values) : Tot case_values =
  {values with
    input_value=(match values.input_value with | None -> None | Some messages ->
      Some (L.map (fun message -> {message with content=rewrite_text rename message.content}) messages));
    judge_criteria_value=(match values.judge_criteria_value with | None -> None | Some criteria ->
      Some (L.map (fun criterion -> {criterion with criterion_text=rewrite_text rename criterion.criterion_text}) criteria));
    judge_system_value=(match values.judge_system_value with | None -> None | Some text -> Some (rewrite_text rename text))}
let rewrite_sources (rename:string -> Tot string) (sources:parameter_sources) : Tot parameter_sources =
  {sources with
    input_source=(match sources.input_source with | Common value -> Common (rewrite_value rename value) | OnAxis side -> OnAxis side);
    judge_criteria_source=(match sources.judge_criteria_source with | Some (Common value) -> Some (Common (rewrite_value rename value)) | other -> other);
    judge_system_source=(match sources.judge_system_source with | Some (Common value) -> Some (Common (rewrite_value rename value)) | other -> other)}
let rewrite_references (input:layout) (rename:string -> Tot string)
  : Tot (result:layout{L.length result.rows=L.length input.rows /\ L.length result.columns=L.length input.columns}) =
  let rewrite_case entry = {entry with values=rewrite_case_values rename entry.values} in
  {input with parameters=rewrite_sources rename input.parameters;
    rows=map_preserving rewrite_case input.rows; columns=map_preserving rewrite_case input.columns}
let value_tokens (value:value) : Tot (list string) = match value with
  | InputValue messages -> L.collect (fun message -> variable_tokens message.content) messages
  | JudgeCriteriaValue criteria -> L.collect (fun criterion -> variable_tokens criterion.criterion_text) criteria
  | JudgeSystemValue text -> variable_tokens text | _ -> []
let unique (#a:eqtype) (values:list a) : Tot (list a) = fold (fun acc value -> if member value acc then acc else L.append acc [value]) [] values
let referenced_names (input:layout) : Tot (list string) =
  let common_names = L.collect (fun p -> match P.get_source input.parameters p with | Some (Common value) -> value_tokens value | _ -> []) text_parameters in
  unique (L.append common_names (L.collect (fun side -> L.collect (fun entry -> L.collect (fun (p:common_parameter) -> match P.get_case_value entry.values p with | None -> [] | Some value -> value_tokens value) text_parameters) (entries input side)) [Rows; Columns]))
let rec trim_null_end #a (values:list (option a)) : Tot (list (option a)) = match values with
  | [] -> [] | value::rest -> let tail=trim_null_end rest in match value with | None -> if L.length tail=0 then [] else value::tail | Some _ -> value::tail
let rec fill_to #a (count:nat) (values:list (option a)) : Tot (list (option a)) (decreases count) =
  if count=0 then values else match values with | [] -> None::fill_to (count - 1) [] | value::rest -> value::fill_to (count - 1) rest
let set_variable_name input side index name =
  let names=trim_null_end (replace_at (fill_to (index + 1) (option_list (name_fields input side))) index name) in
  put_name_fields input side (if L.length names=0 then None else Some names)
let valid_variable_name name = N.length name > 0 && token_length (N.length name) name 0 = N.length name
let variable_rename_valid input side index name =
  (name="" || valid_variable_name name) &&
  (let effective=if name="" then generated_name side index else name in
   not (L.existsb (fun (n,s,i) -> n=effective && (s<>side || i<>index)) (variable_index input)))
let rec unused_name (fuel:nat) (side:axis) (index:nat) (used:list string) : Tot string (decreases fuel) =
  let name=generated_name side index in if member name used && fuel>0 then unused_name (fuel - 1) side (index + 1) used else name
let unused_generated_name side index used = unused_name (L.length used + 1) side index used
let empty_message : message = {message_role=UserRole; content=""; images=None}
let edit_messages (messages:list message) (edit:message_edit) : Tot (list message) =
  let first=match at messages 0 with | None -> empty_message | Some message -> message in
  match edit with
  | PromptContent content -> [{first with message_role=UserRole; content=content}]
  | AppendPromptImages images -> [{first with message_role=UserRole; images=Some (L.append (option_list first.images) images)}]
  | RemovePromptImage index -> [{first with message_role=UserRole; images=Some (remove_at (option_list first.images) index)}]
  | InsertMessage index ->
    let previous=if index=0 then None else at messages (index - 1) in
    insert_at messages index {empty_message with message_role=match previous with | Some message -> if message.message_role=UserRole then UnfilledRole else UserRole | None -> UserRole}
  | RemoveMessage index -> remove_at messages index
  | MoveMessage index target -> move messages index target
  | _ -> map_i (fun i message -> match edit with
    | MessageContent index content -> if i=index then {message with content=content} else message
    | AppendMessageImages index images -> if i=index then {message with images=Some (L.append (option_list message.images) images)} else message
    | RemoveMessageImage index image_index -> if i=index then {message with images=match message.images with | None -> None | Some images -> Some (remove_at images image_index)} else message
    | CycleRole index remembered -> if i<>index || L.length (option_list message.images)>0 then message else
      let role=match message.message_role with | SystemRole -> UserRole | UserRole -> AssistantRole | AssistantRole -> UnfilledRole | UnfilledRole -> SystemRole in
      {message with message_role=role; content=if role=UnfilledRole then "" else if message.message_role=UnfilledRole then (match remembered with | None -> message.content | Some content -> content) else message.content}
    | _ -> message) messages
let dropped_parameters (input:layout) (action:input_action) : Tot (list parameter) =
  let removed : list parameter = match action with | SingleDimension side -> P.axis_parameters input side | MoveToCommon p -> [(p <: parameter)]
    | SelectDimension side p -> L.filter (fun key -> key<>p) (P.axis_parameters input side) | _ -> [] in
  L.filter (fun (p:parameter) -> if p<>PVariable then differing input p else match action with
    | SingleDimension side | SelectDimension side _ -> L.existsb (fun entry -> L.existsb (fun field -> match field with | None -> false | Some field -> N.length field.text>0 || L.length (option_list field.field_images)>0) (option_list entry.values.variable_value)) (entries input side)
    | _ -> false) removed
let rec join (separator:string) (values:list string) : Tot string = match values with | [] -> "" | [value] -> value | value::rest -> cat value (cat separator (join separator rest))
let confirmation (input:layout) (action:input_action) : Tot (option string) =
  let dropped=dropped_parameters input action in if L.length dropped=0 then None else
  let restored=L.filter (fun p -> p<>PVariable) dropped in
  Some (cat (cat "Changing the " (join ", " (L.map P.parameter_name dropped)))
    (cat " setup will discard values. Drop these values?"
      (cat (if member PVariable dropped then " The prompt-variable text and images will be discarded." else "")
        (if L.length restored=0 then "" else cat " " (cat (join ", " (L.map P.parameter_name restored)) " will return to their common defaults.")))))

let rec take_match (p:parameter) (value:value_for p) (values:list case_record) : Tot (option case_record & list case_record) =
  match values with | [] -> (None,[]) | entry::rest ->
    if optional_values_equal p (P.get_case_value entry.values p) (Some value) then (Some entry,rest)
    else let found,remaining=take_match p value rest in (found,entry::remaining)
let rec match_values (p:parameter) (values:list (value_for p)) (remaining:list case_record) : Tot (list (option case_record) & list case_record) =
  match values with | [] -> ([],remaining) | value::rest ->
    let found,left=take_match p value remaining in
    let matches,final=match_values p rest left in (found::matches,final)
let rec fill_values (input:layout) (side:axis) (p:parameter) allocation counter (values:list (value_for p)) (matches:list (option case_record)) (remaining:list case_record)
  : Tot (list case_record & nat) (decreases values) =
  match values with | [] -> ([],counter) | value::rest ->
    let matched=match matches with | [] -> None | found::_ -> found in
    let matches=match matches with | [] -> [] | _::tail -> tail in
    let entry,remaining,next=match matched with | Some entry -> (entry,remaining,counter) | None ->
      (match remaining with | entry::tail -> (entry,tail,counter)
       | [] -> let entry,next=new_case input allocation counter (case_defaults input side) in (entry,[],next)) in
    let tail,count=fill_values input side p allocation next rest matches remaining in
    ({entry with values=P.set_case_value entry.values value}::tail,count)
let rec decimal_digits (fuel:nat) (text:string) (position:nat) : Tot bool (decreases fuel) =
  if fuel=0 then true else
  let value=N.byte_at text position in
  value>=48 && value<=57 && decimal_digits (fuel - 1) text (position + 1)
let swap_numeric_name name =
  let prefix,target=if N.starts_with name "ROW" then ("ROW","COLUMN") else if N.starts_with name "COLUMN" then ("COLUMN","ROW") else ("","") in
  let suffix=N.slice name (N.length prefix) (N.length name) in
  if prefix<>"" && N.length suffix>0 && N.byte_at suffix 0<>48 && decimal_digits (N.length suffix) suffix 0 then cat target suffix else name
let swap_source (#p:common_parameter) (owner:source p) : Tot (source p) =
  match owner with | Common value -> Common value | OnAxis side -> OnAxis (other_side side)
let swap_sources (sources:parameter_sources) : Tot parameter_sources =
  {sources with
    input_source=swap_source sources.input_source;
    model_source=swap_source sources.model_source;
    effort_source=(match sources.effort_source with | None -> None | Some source -> Some (swap_source source));
    size_source=(match sources.size_source with | None -> None | Some source -> Some (swap_source source));
    aspect_ratio_source=(match sources.aspect_ratio_source with | None -> None | Some source -> Some (swap_source source));
    quality_source=(match sources.quality_source with | None -> None | Some source -> Some (swap_source source));
    background_source=(match sources.background_source with | None -> None | Some source -> Some (swap_source source));
    judge_model_source=(match sources.judge_model_source with | None -> None | Some source -> Some (swap_source source));
    judge_effort_source=(match sources.judge_effort_source with | None -> None | Some source -> Some (swap_source source));
    judge_criteria_source=(match sources.judge_criteria_source with | None -> None | Some source -> Some (swap_source source));
    judge_system_source=(match sources.judge_system_source with | None -> None | Some source -> Some (swap_source source))}
let rec custom_names_from (fields:list (option variable_field)) (names:list (option string)) : Tot (list string) =
  match fields,names with
  | field::fields,name::names ->
    let rest=custom_names_from fields names in
    (match field,name with | Some _,Some name -> name::rest | _ -> rest)
  | _ -> []
let custom_names_on (input:layout) (side:axis) : Tot (list string) =
  if P.is_case_axis input side then
    custom_names_from (variable_fields input side) (option_list (name_fields input side)) else []
let custom_variable_names (input:layout) : Tot (list string) =
  L.append (custom_names_on input Rows) (custom_names_on input Columns)
let swap_rename (input:layout) (name:string) : Tot string =
  let swapped=swap_numeric_name name in
  let custom=custom_variable_names input in
  if member name custom || member swapped custom then name else swapped
let swapped_name_entry (input:layout) (side:axis) (index:nat) (custom:option string) : Tot (option string) =
  match at (variable_fields input side) index with
  | Some (Some _) ->
    let name=swap_rename input (variable_name input side index) in
    if custom=None && name=generated_name (other_side side) index then None else Some name
  | _ -> custom
let swap_name_fields (input:layout) (side:axis) : Tot (option (list (option string))) =
  if not (P.is_case_axis input side) then name_fields input side else
  let fields=variable_fields input side in
  let names=fill_to (L.length fields) (option_list (name_fields input side)) in
  let names=map_i (swapped_name_entry input side) names in
  let names=trim_null_end names in
  if names=[] then None else Some names
let swap (input:layout) : Tot (result:layout{L.length result.rows=L.length input.columns /\ L.length result.columns=L.length input.rows}) =
  let row_names=swap_name_fields input Columns in
  let column_names=swap_name_fields input Rows in
  let rewritten=rewrite_references input (swap_rename input) in
  {rewritten with parameters=swap_sources rewritten.parameters;
    rows=rewritten.columns; columns=rewritten.rows;
    case_ownership=(match input.case_ownership with | NoCaseAxes -> NoCaseAxes | OneCaseAxis side -> OneCaseAxis (other_side side) | BothCaseAxes first -> BothCaseAxes (other_side first));
    variable_names=if row_names=None && column_names=None then None else Some {row_names=row_names; column_names=column_names}}
let judge_parameters : list (p:common_parameter{p<>PInput /\ p<>PModel}) =
  [PJudgeModel; PJudgeEffort; PJudgeSystem; PJudgeCriteria]
let source_on_axis (input:layout) (p:parameter) (side:axis) : Tot bool =
  if p=PVariable then false else match P.get_source input.parameters p with | Some (OnAxis owner) -> owner=side | _ -> false
let reduce (input:layout) (action:input_action) (prefix:string) (counter:nat) : Tot (layout & nat) =
  let allocation=(prefix,case_ids input) in
  match action with
  | RenameVariable side index name ->
    if not (P.is_case_axis input side) || (match at (variable_fields input side) index with | Some (Some _) -> false | _ -> true)
      || not (variable_rename_valid input side index name) then (input,counter) else
    let previous=variable_name input side index in
    let next=set_variable_name input side index (if name="" then None else Some name) in
    let name=variable_name next side index in
    (rewrite_references next (fun token -> if token=previous then name else token),counter)
  | RenameCase side index name ->
    if not (P.is_case_axis input side) then (input,counter) else let name=N.trim name in
    (set_entries input side (map_i (fun i entry -> if i<>index then entry else {entry with case_name=if name="" then None else Some name}) (entries input side)),counter)
  | EditInput target edit ->
    (match target,input.parameters.input_source with
     | CommonInput,Common (InputValue messages) -> (set_source input PInput (Common (InputValue (edit_messages messages edit))),counter)
     | CaseInput side index,OnAxis owner -> if side<>owner then (input,counter) else
       (set_entries input side (map_i (fun i entry -> if i<>index then entry else
         {entry with values=P.set_case_value entry.values (InputValue (edit_messages (option_list entry.values.input_value) edit))}) (entries input side)),counter)
     | _ -> (input,counter))
  | SetCommon value ->
    let p=value_parameter value in
    ((match P.get_source input.parameters p with | Some (Common _) -> set_source input p (Common value) | _ -> input),counter)
  | MoveToAxis p side ->
    if not (P.is_case_axis input side) then (input,counter) else
    (match P.get_source input.parameters p with | Some (Common _) -> own input p side allocation counter | _ -> (input,counter))
  | MoveToCommon p -> collapse input p allocation counter
  | SingleDimension side ->
    let next=remove_case_axis input side in
    let next,count=collapse_parameters next (P.axis_parameters input side) allocation counter in
    neutral_dimension (strip_variables next side) side allocation count
  | SelectDimension side p ->
    if p=PVariable then
      if P.is_case_axis input side then (input,counter) else
      let next,count=collapse_parameters input (P.axis_parameters input side) allocation counter in
      let entry,count=new_case next allocation count P.empty_case_values in
      (set_entries (add_case_axis next side) side [entry],count)
    else
      (match P.get_source input.parameters p with
       | None -> (input,counter)
       | Some owner ->
         if p=PJudgeCriteria || p=PJudgeSystem || p=PInput || source_on_axis input p (other_side side)
           || (source_on_axis input p side && not (P.is_case_axis input side)) then (input,counter) else
         let retained=if source_on_axis input p side then Some (L.map (fun entry ->
           {entry with case_name=None; values=match P.get_case_value entry.values p with | None -> P.empty_case_values | Some value -> P.set_case_value P.empty_case_values value}) (entries input side)) else None in
         let next=remove_case_axis input side in
         let next,count=collapse_parameters next (P.axis_parameters input side) allocation counter in
         let next=set_source (strip_variables next side) p (OnAxis side) in
         match retained with | Some values -> (set_entries next side values,count) | None ->
           let value=match owner with | Common value -> value | OnAxis _ -> P.parameter_default p in
           if (match value with | ModelValue "" | JudgeModelValue "" -> true | _ -> false) then (set_entries next side [],count)
           else let entry,count=new_case next allocation count (P.set_case_value P.empty_case_values value) in (set_entries next side [entry],count))
  | SetCaseValue side index value ->
    let p=value_parameter value in
    if (if p=PVariable then not (P.is_case_axis input side) || not (P.axis_has_variables input side) else not (source_on_axis input p side)) then (input,counter)
    else (set_entries input side (map_i (fun i entry -> if i=index then {entry with values=P.set_case_value entry.values value} else entry) (entries input side)),counter)
  | SetCaseValues p side selected ->
    if not (source_on_axis input p side) || P.is_case_axis input side || L.length (P.axis_parameters input side)<>1 then (input,counter) else
    let matches,remaining=match_values p selected (entries input side) in
    let values,count=fill_values input side p allocation counter selected matches remaining in
    (set_entries input side values,count)
  | AddCase side value -> ((if P.is_case_axis input side then set_entries input side (L.append (entries input side) [value]) else input),counter)
  | RemoveCase side index -> ((if P.is_case_axis input side && L.length (entries input side)>1 then set_entries input side (remove_at (entries input side) index) else input),counter)
  | MoveCase side index target -> ((if P.is_case_axis input side then set_entries input side (move (entries input side) index target) else input),counter)
  | AddVariable side ->
    if not (P.is_case_axis input side) || L.length (entries input side)=0 then (input,counter) else
    let index=L.length (variable_fields input side) in
    let used=L.append (L.collect (fun s -> L.collect (fun name -> match name with | Some name -> if name="" then [] else [name] | None -> []) (option_list (name_fields input s))) [Rows;Columns])
      (L.collect (fun s -> if not (P.is_case_axis input s) then [] else L.collect (fun (i,field) -> match field with | None -> [] | Some _ -> [variable_name input s i]) (map_i (fun i field -> (i,field)) (variable_fields input s))) [Rows;Columns]) in
    let name=unused_generated_name side index used in
    let next=set_entries input side (L.map (fun entry -> {entry with values=P.set_case_value entry.values (VariableValue (L.append (option_list entry.values.variable_value) [Some {text=""; field_images=None}]))}) (entries input side)) in
    (set_variable_name next side index (if name=generated_name side index then None else Some name),counter)
  | RemoveVariable side index ->
    if not (P.is_case_axis input side) || (match at (variable_fields input side) index with | Some (Some _) -> false | _ -> true) then (input,counter) else
    (set_entries input side (L.map (fun entry -> {entry with values=P.set_case_value entry.values (VariableValue (replace_at (option_list entry.values.variable_value) index None))}) (entries input side)),counter)
  | SwapAxes -> (swap input,counter)
  | SetJudging enabled ->
    if enabled=input.judging || (enabled && input.output_format=Html) then (input,counter)
    else if enabled then (fold (fun current (p:common_parameter{p<>PInput /\ p<>PModel}) -> set_source current p (Common (P.parameter_default p))) {input with judging=true} judge_parameters,counter)
    else
      let next=fold (fun current p -> {current with parameters=P.remove_source current.parameters p}) {input with judging=false} judge_parameters in
      let next=fold (fun current side -> set_entries current side (L.map (fun entry -> {entry with values=fold (fun values (p:common_parameter{p<>PInput /\ p<>PModel}) -> P.remove_case_value values p) entry.values judge_parameters}) (entries current side))) next [Rows;Columns] in
      fold (fun (current,count) side -> neutral_dimension current side allocation count) (next,counter) [Rows;Columns]

let default_grid (format:format) allocation counter : Tot (draft_input & nat) =
  let image=format=Image in
  let model_rows=image || format=Svg || format=Html in
  let input : layout = {
    output_format=format; case_ownership=NoCaseAxes; rows=[]; columns=[];
    variable_names=None; judging=false; parallel_workers=None;
    parameters={
      source_order=(if image then [PInput;PModel;PQuality;PSize;PAspectRatio;PBackground] else [PInput;PModel;PEffort]);
      input_source=Common (P.parameter_default PInput);
      model_source=OnAxis (if model_rows then Rows else Columns);
      effort_source=(if image then None else Some (OnAxis (if model_rows then Columns else Rows)));
      quality_source=(if image then Some (OnAxis Columns) else None);
      size_source=(if image then Some (Common (SizeValue "auto")) else None);
      aspect_ratio_source=(if image then Some (Common (AspectRatioValue "auto")) else None);
      background_source=(if image then Some (Common (BackgroundValue "auto")) else None);
      judge_model_source=None; judge_effort_source=None; judge_criteria_source=None; judge_system_source=None}} in
  let entry,next=new_case input allocation counter (P.set_case_value P.empty_case_values (if image then QualityValue "auto" else EffortValue DefaultEffort)) in
  ({draft_layout=set_entries input (if model_rows then Columns else Rows) [entry]; budget_text="3"},next)
let layout_data (input:layout) : Tot layout =
  let normalize_case entry = {entry with values={entry.values with value_order=[]}} in
  {input with parameters={input.parameters with source_order=[]};
    rows=L.map normalize_case input.rows; columns=L.map normalize_case input.columns}
let without_case_ids (input:layout) : Tot layout =
  let next=layout_data input in
  let normalize_case entry = {entry with case_id=""; values=fold (fun values p -> match P.get_case_value values p with
    | None -> values | Some value -> P.set_case_value values (comparison_value value)) entry.values P.parameter_names} in
  let next={next with rows=L.map normalize_case next.rows; columns=L.map normalize_case next.columns} in
  let next=fold (fun current p -> match P.get_source current.parameters p with
    | Some (Common value) -> set_source current p (Common (comparison_value value)) | _ -> current) next P.common_parameters in
  layout_data next
let add_dropped (dropped:list parameter) (p:parameter) : Tot (list parameter) = if member p dropped then dropped else L.append dropped [p]
let strip_format_cases (input:layout) (side:axis) (dropped:list parameter) : Tot (layout & list parameter) =
  let cases,dropped=fold (fun (cases,dropped) entry ->
    let values,dropped=fold (fun (values,dropped) p ->
      if (p=PVariable && P.is_case_axis input side) || source_on_axis input p side then (values,dropped) else
      (P.remove_case_value values p,(if has_parameter_value p (P.get_case_value entry.values p) then add_dropped dropped p else dropped)))
      (entry.values,dropped) (P.case_parameters entry.values) in
    (L.append cases [{entry with values=values; case_name=if P.is_case_axis input side then entry.case_name else None}],dropped))
    ([],dropped) (entries input side) in
  (set_entries input side cases,dropped)
let rec find_model (models:list catalog_model) (id:string) : Tot (option catalog_model) =
  match models with | [] -> None | model::rest -> if model.model_id=id then Some model else find_model rest id
let format_model_compatible (models:list catalog_model) (format:format) (p:parameter) (id:string) : Tot bool =
  if id="" then true else match find_model models id with | None -> true | Some model ->
    if p<>PJudgeModel then (if format=Image then model.generates_images else model.generates_text)
    else match model.structured_outputs with
      | None -> model.generates_text && ((format<>Svg && format<>Image) || model.accepts_images)
      | Some structured -> format<>Html && model.generates_text && structured && ((format<>Svg && format<>Image) || model.accepts_images)
let model_id_value (value:value) : Tot string = match value with | ModelValue id | JudgeModelValue id -> id | _ -> ""
let convert_format_models (input:layout) models format dropped =
  fold (fun (current,dropped) (p:common_parameter) -> match P.get_source current.parameters p with
    | Some (Common value) -> if format_model_compatible models format p (model_id_value value) then (current,dropped)
      else (set_source current p (Common (P.parameter_default p)),add_dropped dropped p)
    | None -> (current,dropped)
    | Some (OnAxis side) ->
      let cases,dropped=fold (fun (cases,dropped) entry ->
        let id=match P.get_case_value entry.values p with | None -> "" | Some value -> model_id_value value in
        if format_model_compatible models format p id then (L.append cases [entry],dropped)
        else (L.append cases [{entry with values=P.set_case_value entry.values (P.parameter_default p)}],add_dropped dropped p)) ([],dropped) (entries current side) in
      (set_entries current side cases,dropped)) (input,dropped) ([PModel;PJudgeModel] <: list common_parameter)
let normalize_format_axes input allocation counter dropped =
  fold (fun (current,count,dropped) side ->
    if P.is_case_axis current side then (current,count,dropped) else
    let parameters=P.axis_parameters current side in
    let native=fold (fun selected p -> match selected with | Some _ -> selected | None -> if p=PJudgeCriteria || p=PJudgeSystem then None else Some p) None parameters in
    let current,count,dropped=fold (fun (current,count,dropped) (p:parameter) ->
      if native=Some p || p=PVariable then (current,count,dropped) else
      let dropped=fold add_dropped dropped (dropped_parameters current (MoveToCommon p)) in
      let next,count=collapse current p allocation count in (next,count,dropped)) (current,count,dropped) parameters in
    let next,count=neutral_dimension current side allocation count in (next,count,dropped)) (input,counter,dropped) [Rows;Columns]
let valid_prompt_messages (messages:list message) : Tot bool =
  match messages with | [message] -> message.message_role=UserRole | _ -> false
let normalize_prompt_format (input:layout) format dropped =
  if format=ChatTemplate then (input,dropped) else match input.parameters.input_source with
  | Common (InputValue messages) -> if valid_prompt_messages messages then (input,dropped)
    else (set_source input PInput (Common (P.parameter_default PInput)),add_dropped dropped PInput)
  | OnAxis side ->
    let cases,dropped=fold (fun (cases,dropped) entry ->
      if valid_prompt_messages (option_list entry.values.input_value) then (L.append cases [entry],dropped)
      else (L.append cases [{entry with values=P.set_case_value entry.values (P.parameter_default PInput)}],add_dropped dropped PInput)) ([],dropped) (entries input side) in
    (set_entries input side cases,dropped)
let select_format (draft:draft) (format:format) (catalog:list catalog_model) (prefix:string) (counter:nat) : Tot (D.draft & nat & list parameter) =
  let previous=draft.editable.draft_layout in
  if previous.output_format=format then ({draft with format_selected=true},counter,[]) else
  let allocation=(prefix,case_ids previous) in
  let defaults,counter=default_grid format allocation counter in
  let previous_defaults,counter=default_grid previous.output_format allocation counter in
  if draft.editable.budget_text=previous_defaults.budget_text && without_case_ids previous=without_case_ids previous_defaults.draft_layout
  then ({draft with editable=defaults; format_selected=true},counter,[]) else
  let applicable=L.append (P.source_parameters defaults.draft_layout.parameters) (if previous.judging && format<>Html then L.map (fun (p:common_parameter{p<>PInput /\ p<>PModel}) -> (p <: common_parameter)) judge_parameters else []) in
  let input={previous with output_format=format; judging=previous.judging && format<>Html} in
  let input,counter,dropped=fold (fun (current,count,dropped) (p:common_parameter) ->
    if member p applicable then (current,count,dropped) else
    if p=PInput || p=PModel then (current,count,dropped) else
    let lost=match P.get_source current.parameters p with
      | None -> false | Some (Common value) -> has_parameter_value p (Some value)
      | Some (OnAxis side) -> L.existsb (fun entry -> has_parameter_value p (P.get_case_value entry.values p)) (entries current side) in
    let dropped=if lost then add_dropped dropped p else dropped in
    let next,count=remove_parameter current p allocation count in (next,count,dropped))
    (input,counter,[]) (P.source_parameters input.parameters) in
  let input,dropped=fold (fun (current,dropped) side -> strip_format_cases current side dropped) (input,dropped) [Rows;Columns] in
  let input=fold (fun current p -> match P.get_source current.parameters p with
    | Some _ -> current | None -> set_source current p (Common (P.parameter_default p))) input applicable in
  let input,dropped=convert_format_models input catalog format dropped in
  let input,counter,dropped=normalize_format_axes input allocation counter dropped in
  let input,dropped=normalize_prompt_format input format dropped in
  ({draft with editable={draft.editable with draft_layout=input}; format_selected=true},counter,dropped)
