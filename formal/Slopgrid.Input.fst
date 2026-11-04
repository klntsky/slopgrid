module Slopgrid.Input

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
module N = Slopgrid.Native
module P = Slopgrid.Parameters
open Slopgrid.Data
open Prims

let cat = N.concat
let other_side (side:string) : Tot string = if side = "rows" then "columns" else "rows"
let source (input:D.json) (parameter:string) : Tot D.json = D.get (D.get input "parameters") parameter
let source_kind input parameter = D.str (D.get (source input parameter) "kind")
let entries input side = D.items (D.get input side)
let set_entries input side values = D.set input side (JArray values)
let set_source input parameter value = D.set input "parameters" (D.set (D.get input "parameters") parameter value)
let common value = JObject [("kind", JString "common"); ("value", value)]
let owned side = JObject [("kind", JString side)]
let member (value:string) (values:list string) : Tot bool = L.existsb (fun x -> x = value) values
let rec map_i_from #a #b (f:nat -> a -> Tot b) (index:nat) (values:list a) : Tot (list b) (decreases values) =
  match values with
  | [] -> []
  | value::rest -> f index value :: map_i_from f (index + 1) rest
let map_i #a #b (f:nat -> a -> Tot b) (values:list a) : Tot (list b) = map_i_from f 0 values
let rec fold #a #b (f:b -> a -> Tot b) (state:b) (values:list a) : Tot b (decreases values) =
  match values with
  | [] -> state
  | value::rest -> fold f (f state value) rest

let rec comparison_value (value:D.json) : Tot D.json (decreases value) =
  match value with
  | JArray values -> JArray (comparison_items values)
  | JObject fields -> JObject (comparison_fields fields)
  | _ -> value
and comparison_items (values:list D.json) : Tot (list D.json) (decreases values) =
  match values with
  | [] -> []
  | value::rest -> comparison_value value :: comparison_items rest
and comparison_fields (values:list (string & D.json)) : Tot (list (string & D.json)) (decreases values) =
  match values with
  | [] -> []
  | (key, child)::rest ->
    if key = "images" && D.equal child (JArray []) then comparison_fields rest
    else (key, comparison_value child)::comparison_fields rest
let parameter_values_equal left right = D.equal (comparison_value left) (comparison_value right)
let has_parameter_value parameter value =
  not (D.equal value JNull) && not (parameter_values_equal value (P.parameter_default parameter))

let case_ids input = L.map (fun entry -> D.str (D.get entry "id"))
  (L.append (entries input "rows") (entries input "columns"))
let rec available_id (fuel:nat) (ids:list string) (prefix:string) (counter:nat) : Tot (string & nat) (decreases fuel) =
  let id = cat prefix (N.nat_string counter) in
  if member id ids && fuel > 0 then available_id (fuel - 1) ids prefix (counter + 1)
  else (id, counter + 1)
let new_case input allocation counter values =
  let prefix, reserved = allocation in
  let ids = L.append reserved (case_ids input) in
  let id, next = available_id (L.length ids + 1) ids prefix counter in
  (D.set values "id" (JString id), next)

let neutral_dimension input side prefix counter =
  if P.is_case_axis input side || L.length (P.axis_parameters input side) > 0 then (input, counter)
  else match entries input side with
  | first::_ -> (set_entries input side [JObject [("id", D.get first "id")]], counter)
  | [] -> let entry, next = new_case input prefix counter (JObject []) in
      (set_entries input side [entry], next)

let remove_parameter input parameter prefix counter =
  let kind = source_kind input parameter in
  let next = D.set input "parameters" (D.omit (D.get input "parameters") parameter) in
  if kind = "" || kind = "common" then (next, counter)
  else neutral_dimension (set_entries next kind (L.map (fun entry -> D.omit entry parameter) (entries input kind))) kind prefix counter

let differing input parameter =
  let kind = source_kind input parameter in
  if kind = "" || kind = "common" then false
  else let values = L.map (fun entry -> D.get entry parameter) (entries input kind) in
    L.existsb (fun value -> not (parameter_values_equal value (D.at values 0))) values

let collapse input parameter prefix counter =
  let kind = source_kind input parameter in
  if kind = "" || kind = "common" then (input, counter)
  else let values = entries input kind in
    let value = if L.length values > 0 && not (differing input parameter)
      then let v = D.get (D.at values 0) parameter in
        if D.equal v JNull then P.parameter_default parameter else v
      else P.parameter_default parameter in
    let next, count = remove_parameter input parameter prefix counter in
    (set_source next parameter (common value), count)

let strip_variables input side =
  let names = D.omit (D.get input "variableNames") side in
  let next = if L.length (D.fields names) = 0 then D.omit input "variableNames"
    else D.set input "variableNames" names in
  set_entries next side (L.map (fun entry -> D.omit (D.omit entry "variable") "name") (entries input side))

let case_defaults input side =
  JObject (L.map (fun parameter ->
    let value = if parameter = "variable" then
      JArray (L.map (fun field -> if D.equal field JNull then JNull else JObject [("text", JString "")])
        (D.items (D.get (D.at (entries input side) 0) "variable")))
      else P.parameter_default parameter in
    (parameter, value)) (P.axis_parameters input side))

let own input parameter side prefix counter =
  let kind = source_kind input parameter in
  if kind = side || (kind <> "" && kind <> "common") then (input, counter)
  else let value = if kind = "common" then D.get (source input parameter) "value" else P.parameter_default parameter in
    let values, count = if L.length (entries input side) > 0 then (entries input side, counter)
      else let entry, next = new_case input prefix counter (case_defaults input side) in ([entry], next) in
    (set_entries (set_source input parameter (owned side)) side
      (L.map (fun entry -> D.set entry parameter value) values), count)

let collapse_parameters input parameters prefix counter =
  fold (fun (current, count) parameter ->
    if parameter = "variable" then (current, count) else collapse current parameter prefix count)
    (input, counter) parameters

let generated_name (side:string) (index:nat) : Tot string = cat (if side = "rows" then "ROW" else "COLUMN") (N.nat_string (index + 1))
let variable_name input side index =
  let name = D.at (D.items (D.get (D.get input "variableNames") side)) index in
  if D.equal name JNull then generated_name side index else D.str name
let variable_index input : Tot (list (string & string & nat)) =
  fold (fun result side ->
    fold (fun acc (index, field) ->
      if D.equal field JNull then acc else
      let name = variable_name input side index in
      if L.existsb (fun (n, _, _) -> n = name) acc then acc
      else L.append acc [(name, side, index)]) result
      (map_i (fun i field -> (i, field)) (D.items (D.get (D.at (entries input side) 0) "variable"))))
    [] (D.strings (D.get input "caseAxes"))

let ascii_token_char c =
  member c ["A"; "B"; "C"; "D"; "E"; "F"; "G"; "H"; "I"; "J"; "K"; "L"; "M";
    "N"; "O"; "P"; "Q"; "R"; "S"; "T"; "U"; "V"; "W"; "X"; "Y"; "Z";
    "0"; "1"; "2"; "3"; "4"; "5"; "6"; "7"; "8"; "9"; "_"]
let rec token_length (fuel:nat) (text:string) (position:nat) : Tot nat (decreases fuel) =
  if fuel = 0 || not (ascii_token_char (N.char_at text position)) then 0
  else 1 + token_length (fuel - 1) text (position + 1)
let token_at text position =
  if N.char_at text position <> "$" then None else
  let count = token_length (N.length text) text (position + 1) in
  let last = position + 1 + count in
  if count = 0 || N.char_at text last = "_" || N.unicode_alphanumeric_at text last then None
  else Some (N.slice text (position + 1) count, count + 1)
let rec rewrite_scan (fuel:nat) (rename:string -> Tot string) (text:string) (position:nat) : Tot string (decreases fuel) =
  if fuel = 0 || position >= N.length text then "" else
  match token_at text position with
  | Some (name, count) -> cat (cat "$" (rename name)) (rewrite_scan (fuel - 1) rename text (position + count))
  | None -> cat (N.char_at text position) (rewrite_scan (fuel - 1) rename text (position + 1))
let rewrite_text rename text = rewrite_scan (N.length text) rename text 0
let rec token_scan (fuel:nat) (text:string) (position:nat) : Tot (list string) (decreases fuel) =
  if fuel = 0 || position >= N.length text then [] else
  match token_at text position with
  | Some (name, count) -> name :: token_scan (fuel - 1) text (position + count)
  | None -> token_scan (fuel - 1) text (position + 1)
let variable_tokens text = token_scan (N.length text) text 0

let rewrite_array_field rename values key = JArray (L.map (fun value -> D.set value key (JString (rewrite_text rename (D.str (D.get value key))))) (D.items values))
let rewrite_case rename entry =
  let next = if D.has entry "input" then D.set entry "input" (rewrite_array_field rename (D.get entry "input") "content") else entry in
  let next = if D.has entry "judge_system" then D.set next "judge_system" (JString (rewrite_text rename (D.str (D.get entry "judge_system")))) else next in
  if D.has entry "judge_criteria" then D.set next "judge_criteria" (rewrite_array_field rename (D.get entry "judge_criteria") "text") else next
let rewrite_references input rename =
  let next = fold (fun current parameter ->
    if source_kind input parameter <> "common" then current else
    let value = D.get (source input parameter) "value" in
    let rewritten = if parameter = "judge_system" then JString (rewrite_text rename (D.str value))
      else rewrite_array_field rename value (if parameter = "input" then "content" else "text") in
    set_source current parameter (common rewritten)) input ["input"; "judge_criteria"; "judge_system"] in
  fold (fun current side -> set_entries current side (L.map (rewrite_case rename) (entries input side))) next ["rows"; "columns"]
let referenced_names input =
  let from_value parameter value = if parameter = "judge_system" then variable_tokens (D.str value)
    else L.collect (fun item -> variable_tokens (D.str (D.get item (if parameter = "input" then "content" else "text")))) (D.items value) in
  let common_names = L.collect (fun parameter -> if source_kind input parameter = "common" then from_value parameter (D.get (source input parameter) "value") else [])
    ["input"; "judge_criteria"; "judge_system"] in
  D.unique_strings (L.append common_names (L.collect (fun side -> L.collect (fun entry ->
    L.collect (fun parameter -> from_value parameter (D.get entry parameter)) ["input"; "judge_criteria"; "judge_system"])
    (entries input side)) ["rows"; "columns"]))

let rec trim_null_end (values:list D.json) : Tot (list D.json) =
  match values with
  | [] -> []
  | value::rest -> let tail = trim_null_end rest in
    if D.equal value JNull && L.length tail = 0 then [] else value::tail
let rec fill_to (count:nat) (values:list D.json) : Tot (list D.json) (decreases count) =
  if count = 0 then values else match values with
  | [] -> JNull :: fill_to (count - 1) []
  | value::rest -> value :: fill_to (count - 1) rest
let set_variable_name input side index name =
  let names = D.items (D.get (D.get input "variableNames") side) in
  let names = trim_null_end (D.replace_at (fill_to (index + 1) names) index name) in
  let all = if L.length names = 0 then D.omit (D.get input "variableNames") side
    else D.set (D.get input "variableNames") side (JArray names) in
  if L.length (D.fields all) = 0 then D.omit input "variableNames" else D.set input "variableNames" all
let valid_variable_name name = N.length name > 0 && token_length (N.length name) name 0 = N.length name
let variable_rename_valid input side index name =
  (name = "" || valid_variable_name name) &&
  (let effective = if name = "" then generated_name side index else name in
  not (L.existsb (fun (n, s, i) -> n = effective && (s <> side || i <> index)) (variable_index input)))
let rec unused_name (fuel:nat) (side:string) (index:nat) (used:list string) : Tot string (decreases fuel) =
  let name = generated_name side index in
  if member name used && fuel > 0 then unused_name (fuel - 1) side (index + 1) used else name
let unused_generated_name side index used = unused_name (L.length used + 1) side index used

let edit_messages (messages:list D.json) (edit:D.json) : Tot (list D.json) =
  let kind = D.str (D.get edit "type") in
  let index = D.natural (D.get edit "index") in
  let image_index = D.natural (D.get edit "imageIndex") in
  if kind = "prompt-content" then
    [D.set (D.set (D.at messages 0) "role" (JString "user")) "content" (D.get edit "content")]
  else if kind = "prompt-append-images" || kind = "prompt-remove-image" then
    let message = D.at messages 0 in
    let images = D.items (D.get message "images") in
    let images = if kind = "prompt-append-images" then L.append images (D.items (D.get edit "images"))
      else D.remove_at images image_index in
    [D.set (D.set (D.set message "role" (JString "user")) "content"
       (if D.has message "content" then D.get message "content" else JString "")) "images" (JArray images)]
  else if kind = "insert" then
    let previous_role = if index = 0 then "" else D.str (D.get (D.at messages (index - 1)) "role") in
    D.insert_at messages index (JObject [("role", JString (if previous_role = "user" then "unfilled" else "user")); ("content", JString "")])
  else if kind = "remove" then D.remove_at messages index
  else if kind = "move" then D.move messages index (D.natural (D.get edit "to"))
  else map_i (fun i message ->
    if i <> index then message
    else if kind = "content" then D.set message "content" (D.get edit "content")
    else if kind = "append-images" then D.set message "images" (JArray (L.append (D.items (D.get message "images")) (D.items (D.get edit "images"))))
    else if kind = "remove-image" then
      if D.has message "images" then D.set message "images" (JArray (D.remove_at (D.items (D.get message "images")) image_index)) else message
    else if kind = "cycle-role" && L.length (D.items (D.get message "images")) = 0 then
      let previous = D.str (D.get message "role") in
      let role = if previous = "system" then "user" else if previous = "user" then "assistant"
        else if previous = "assistant" then "unfilled" else "system" in
      let content = if role = "unfilled" then JString ""
        else if previous = "unfilled" && D.has edit "rememberedContent" then D.get edit "rememberedContent"
        else D.get message "content" in
      D.set (D.set message "role" (JString role)) "content" content
    else message) messages

let dropped_parameters input action =
  let kind = D.str (D.get action "type") in
  let side = D.str (D.get action "side") in
  let parameter = D.str (D.get action "parameter") in
  let removed = if kind = "single" then P.axis_parameters input side
    else if kind = "to-common" then [parameter]
    else if kind = "dimension" then L.filter (fun p -> p <> parameter) (P.axis_parameters input side)
    else [] in
  L.filter (fun p ->
    if p <> "variable" then differing input p
    else (kind = "single" || kind = "dimension") &&
      L.existsb (fun entry -> L.existsb (fun field ->
        not (D.equal field JNull) &&
        (N.length (D.str (D.get field "text")) > 0 || L.length (D.items (D.get field "images")) > 0))
        (D.items (D.get entry "variable"))) (entries input side)) removed

let confirmation (input:D.json) (event:D.json) : Tot (option string) =
  let dropped = dropped_parameters input event in
  if L.length dropped = 0 then None else
  let restored = L.filter (fun p -> p <> "variable") dropped in
  Some (cat (cat "Changing the " (D.join ", " (L.map P.parameter_name dropped)))
    (cat " setup will discard values. Drop these values?"
      (cat (if member "variable" dropped then " The prompt-variable text and images will be discarded." else "")
        (if L.length restored = 0 then ""
         else cat " " (cat (D.join ", " (L.map P.parameter_name restored)) " will return to their common defaults.")))))

let rec take_match (parameter:string) (value:D.json) (values:list D.json) : Tot (option D.json & list D.json) =
  match values with
  | [] -> (None, [])
  | entry::rest ->
    if parameter_values_equal (D.get entry parameter) value then (Some entry, rest)
    else let found, remaining = take_match parameter value rest in (found, entry::remaining)
let rec match_values (parameter:string) (values:list D.json) (remaining:list D.json)
  : Tot (list (option D.json) & list D.json) (decreases values) =
  match values with
  | [] -> ([], remaining)
  | value::rest ->
    let found, left = take_match parameter value remaining in
    let matches, final = match_values parameter rest left in
    (found::matches, final)
let rec fill_values input side parameter prefix counter values matches remaining
  : Tot (list D.json & nat) (decreases values) =
  match values with
  | [] -> ([], counter)
  | value::rest ->
    let matched = match matches with | [] -> None | found::_ -> found in
    let matches = match matches with | [] -> [] | _::tail -> tail in
    let entry, remaining, next = match matched with
      | Some entry -> (entry, remaining, counter)
      | None -> match remaining with
        | entry::tail -> (entry, tail, counter)
        | [] -> let entry, next = new_case input prefix counter (case_defaults input side) in (entry, [], next) in
    let tail, count = fill_values input side parameter prefix next rest matches remaining in
    (D.set entry parameter value :: tail, count)

let swap_numeric_name name =
  let prefix, target = if N.starts_with name "ROW" then ("ROW", "COLUMN")
    else if N.starts_with name "COLUMN" then ("COLUMN", "ROW") else ("", "") in
  let suffix = N.slice name (N.length prefix) (N.length name) in
  let rec digits (fuel:nat) (index:nat) : Tot bool (decreases fuel) =
    if fuel = 0 then true
    else member (N.char_at suffix index) ["0"; "1"; "2"; "3"; "4"; "5"; "6"; "7"; "8"; "9"] && digits (fuel - 1) (index + 1) in
  if prefix <> "" && N.length suffix > 0 && N.char_at suffix 0 <> "0" && digits (N.length suffix) 0
  then cat target suffix else name

let swap input =
  let names, renamed, used = fold (fun (names, renamed, used) side ->
    if not (P.is_case_axis input side) then (names, renamed, used) else
    let other = other_side side in
    let names = if D.has (D.get input "variableNames") side then
      D.set names other (D.get (D.get input "variableNames") side) else names in
    fold (fun (names, renamed, used) (index, field) ->
      let custom = D.str (D.at (D.items (D.get (D.get input "variableNames") side)) index) in
      if D.equal field JNull || custom = "" then (names, renamed, used)
      else (names, L.append renamed [(custom, custom)], L.append used [custom]))
      (names, renamed, used) (map_i (fun i field -> (i, field)) (D.items (D.get (D.at (entries input side) 0) "variable"))))
    (JObject [], [], []) ["rows"; "columns"] in
  let index = variable_index input in
  let unresolved, used = fold (fun (mapping, used) name ->
    if L.existsb (fun (n, _, _) -> n = name) index then (mapping, used) else
    let swapped = swap_numeric_name name in
    let target = if member swapped used then name else swapped in
    (L.append mapping [(name, target)], L.append used [target])) ([], used) (referenced_names input) in
  let names, renamed, _ = fold (fun (names, renamed, used) side ->
    if not (P.is_case_axis input side) then (names, renamed, used) else
    let other = other_side side in
    fold (fun (names, renamed, used) (index, field) ->
      let custom = D.str (D.at (D.items (D.get (D.get input "variableNames") side)) index) in
      if D.equal field JNull || custom <> "" then (names, renamed, used) else
      let name = unused_generated_name other index used in
      let names = if name = generated_name other index then names else
        D.set names other (JArray (D.replace_at (fill_to (index + 1) (D.items (D.get names other))) index (JString name))) in
      (names, L.append renamed [(variable_name input side index, name)], L.append used [name]))
      (names, renamed, used) (map_i (fun i field -> (i, field)) (D.items (D.get (D.at (entries input side) 0) "variable"))))
    (names, renamed, used) ["rows"; "columns"] in
  let lookup mapping name = fold (fun found (key, value) -> if key = name then Some value else found) None mapping in
  let rewritten = rewrite_references input (fun name ->
    match lookup renamed name with
    | Some value -> value
    | None -> match lookup unresolved name with | Some value -> value | None -> name) in
  let parameters = JObject (L.map (fun (parameter, value) ->
    let kind = D.str (D.get value "kind") in
    (parameter, (if kind = "rows" || kind = "columns" then owned (other_side kind) else value))) (D.fields (D.get rewritten "parameters"))) in
  let next = D.set (D.set rewritten "parameters" parameters) "caseAxes"
    (JArray (L.map (fun side -> JString (other_side (D.str side))) (D.items (D.get input "caseAxes")))) in
  let next = if L.length (D.fields names) > 0 then D.set next "variableNames" names else next in
  D.set (D.set next "rows" (D.get rewritten "columns")) "columns" (D.get rewritten "rows")

let judge_parameters = ["judge_model"; "judge_effort"; "judge_system"; "judge_criteria"]
let reduce (input:D.json) (event:D.json) (prefix:string) (counter:nat) : Tot (D.json & nat) =
  let prefix = (prefix, case_ids input) in
  let kind = D.str (D.get event "type") in
  let side = D.str (D.get event "side") in
  let parameter = D.str (D.get event "parameter") in
  let index = D.natural (D.get event "index") in
  let value = D.get event "value" in
  let values = entries input side in
  let active_field = not (D.equal (D.at (D.items (D.get (D.at values 0) "variable")) index) JNull) in
  if kind = "rename-variable" then
    let name = D.str (D.get event "name") in
    if not (P.is_case_axis input side) || not active_field || not (variable_rename_valid input side index name)
    then (input, counter) else
    let previous = variable_name input side index in
    let next = set_variable_name input side index (if name = "" then JNull else JString name) in
    let name = variable_name next side index in
    (rewrite_references next (fun token -> if token = previous then name else token), counter)
  else if kind = "rename-case" then
    if not (P.is_case_axis input side) || index >= L.length values then (input, counter) else
    let name = N.trim (D.str (D.get event "name")) in
    (set_entries input side (map_i (fun i entry -> if i <> index then entry
      else if name = "" then D.omit entry "name" else D.set entry "name" (JString name)) values), counter)
  else if kind = "edit-input" then
    let kind = source_kind input "input" in
    if kind <> D.str (D.get event "source") then (input, counter)
    else if kind = "common" then
      (set_source input "input" (common (JArray (edit_messages (D.items (D.get (source input "input") "value")) (D.get event "edit")))), counter)
    else let case_index = D.natural (D.get event "caseIndex") in
      if not (D.has event "caseIndex") || case_index >= L.length (entries input kind) then (input, counter)
      else (set_entries input kind (map_i (fun i entry -> if i <> case_index then entry else
        D.set entry "input" (JArray (edit_messages (D.items (D.get entry "input")) (D.get event "edit")))) (entries input kind)), counter)
  else if kind = "common" then
    ((if source_kind input parameter = "common" then set_source input parameter (common value) else input), counter)
  else if kind = "to-axis" then
    if not (P.is_case_axis input side) || source_kind input parameter <> "common" then (input, counter)
    else own input parameter side prefix counter
  else if kind = "to-common" then collapse input parameter prefix counter
  else if kind = "single" then
    let next = D.set input "caseAxes" (JArray (L.filter (fun item -> D.str item <> side) (D.items (D.get input "caseAxes")))) in
    let next, count = collapse_parameters next (P.axis_parameters input side) prefix counter in
    neutral_dimension (strip_variables next side) side prefix count
  else if kind = "dimension" then
    if parameter = "variable" then
      if P.is_case_axis input side then (input, counter) else
      let next, count = collapse_parameters input (P.axis_parameters input side) prefix counter in
      let entry, count = new_case next prefix count (JObject []) in
      (set_entries (D.set next "caseAxes" (JArray (L.append (D.items (D.get next "caseAxes")) [JString side]))) side [entry], count)
    else let owner = source_kind input parameter in
      if owner = other_side side || owner = "" || parameter = "judge_criteria" || parameter = "judge_system" || parameter = "input"
        || (owner = side && not (P.is_case_axis input side)) then (input, counter)
      else let retained = if owner = side then Some (L.map (fun entry -> JObject [("id", D.get entry "id"); (parameter, D.get entry parameter)]) values) else None in
        let next = D.set input "caseAxes" (JArray (L.filter (fun item -> D.str item <> side) (D.items (D.get input "caseAxes")))) in
        let next, count = collapse_parameters next (P.axis_parameters input side) prefix counter in
        let next = set_source (strip_variables next side) parameter (owned side) in
        match retained with
        | Some retained -> (set_entries next side retained, count)
        | None ->
          let value = if owner = "common" then D.get (source input parameter) "value" else P.parameter_default parameter in
          if (parameter = "model" || parameter = "judge_model") && D.str value = ""
          then (set_entries next side [], count)
          else let entry, count = new_case next prefix count (JObject [(parameter, value)]) in
            (set_entries next side [entry], count)
  else if kind = "case-value" then
    if (if parameter = "variable" then not (P.is_case_axis input side) || not (P.axis_has_variables input side)
        else source_kind input parameter <> side) then (input, counter)
    else (set_entries input side (map_i (fun i entry -> if i = index then D.set entry parameter value else entry) values), counter)
  else if kind = "case-values" then
    if source_kind input parameter <> side || P.is_case_axis input side || L.length (P.axis_parameters input side) <> 1 then (input, counter)
    else let selected = D.items (D.get event "values") in
      let matches, remaining = match_values parameter selected values in
      let values, count = fill_values input side parameter prefix counter selected matches remaining in
      (set_entries input side values, count)
  else if kind = "add-case" then
    ((if P.is_case_axis input side then set_entries input side (L.append values [value]) else input), counter)
  else if kind = "remove-case" then
    ((if P.is_case_axis input side && L.length values > 1 then set_entries input side (D.remove_at values index) else input), counter)
  else if kind = "add-variable" then
    if not (P.is_case_axis input side) || L.length values = 0 then (input, counter)
    else let index = L.length (D.items (D.get (D.at values 0) "variable")) in
      let used = L.append
        (L.filter (fun name -> name <> "") (L.collect (fun (_, names) -> L.map D.str (D.items names)) (D.fields (D.get input "variableNames"))))
        (L.collect (fun s -> if not (P.is_case_axis input s) then [] else
          L.collect (fun (i, field) -> if D.equal field JNull then [] else [variable_name input s i])
            (map_i (fun i field -> (i, field)) (D.items (D.get (D.at (entries input s) 0) "variable")))) ["rows"; "columns"]) in
      let name = unused_generated_name side index used in
      let next = set_entries input side (L.map (fun entry -> D.set entry "variable"
        (JArray (L.append (D.items (D.get entry "variable")) [JObject [("text", JString "")]]))) values) in
      (set_variable_name next side index (if name = generated_name side index then JNull else JString name), counter)
  else if kind = "remove-variable" then
    if not (P.is_case_axis input side) || not active_field then (input, counter)
    else (set_entries input side (L.map (fun entry -> D.set entry "variable"
      (JArray (D.replace_at (D.items (D.get entry "variable")) index JNull))) values), counter)
  else if kind = "move-case" then
    ((if P.is_case_axis input side then set_entries input side (D.move values index (D.natural (D.get event "to"))) else input), counter)
  else if kind = "swap" then (swap input, counter)
  else if kind = "judge" then
    let enabled = D.boolean (D.get event "enabled") in
    if enabled = D.boolean (D.get input "judge") || (enabled && D.str (D.get input "format") = "html") then (input, counter)
    else if enabled then
      (fold (fun current p -> set_source current p (common (P.parameter_default p))) (D.set input "judge" (JBool true)) judge_parameters, counter)
    else let next = fold (fun current p -> D.set current "parameters" (D.omit (D.get current "parameters") p)) (D.set input "judge" (JBool false)) judge_parameters in
      let next = fold (fun current s -> set_entries current s (L.map (fun entry -> fold D.omit entry judge_parameters) (entries input s))) next ["rows"; "columns"] in
      fold (fun (current, count) s -> neutral_dimension current s prefix count) (next, counter) ["rows"; "columns"]
  else (input, counter)

let default_grid format allocation counter =
  let image = format = "image" in
  let model_rows = image || format = "svg" || format = "html" in
  let input = JObject [
    ("inputVersion", D.number 3); ("format", JString format); ("budgetUsd", JString "3");
    ("judge", JBool false); ("caseAxes", JArray []);
    ("parameters", JObject (L.append [
      ("input", common (P.parameter_default "input"));
      ("model", owned (if model_rows then "rows" else "columns"))]
      (if image then [
        ("quality", owned "columns"); ("size", common (JString "auto"));
        ("aspect_ratio", common (JString "auto")); ("background", common (JString "auto"))]
      else [("effort", owned (if model_rows then "columns" else "rows"))])));
    ("rows", JArray []); ("columns", JArray [])] in
  let entry, next = new_case input allocation counter
    (JObject [((if image then "quality" else "effort"), JString (if image then "auto" else "default"))]) in
  (set_entries input (if model_rows then "columns" else "rows") [entry], next)

let without_case_ids input =
  fold (fun current side -> set_entries current side (L.map (fun entry -> D.omit entry "id") (entries input side)))
    input ["rows"; "columns"]
let add_dropped dropped parameter = if member parameter dropped then dropped else L.append dropped [parameter]

let strip_format_cases input side dropped =
  let cases, dropped = fold (fun (cases, dropped) entry ->
    let entry, dropped = fold (fun (current, dropped) (key, value) ->
      if key = "id" || (key = "name" && P.is_case_axis input side) then (current, dropped)
      else if key = "name" then (D.omit current key, dropped)
      else if (key = "variable" && P.is_case_axis input side) ||
              (key <> "variable" && source_kind input key = side)
      then (current, dropped)
      else (D.omit current key, (if has_parameter_value key value then add_dropped dropped key else dropped)))
      (entry, dropped) (D.fields entry) in
    (L.append cases [entry], dropped)) ([], dropped) (entries input side) in
  (set_entries input side cases, dropped)

let rec find_model (models:list D.json) (id:string) : Tot (option D.json) =
  match models with
  | [] -> None
  | model::rest -> if D.str (D.get model "id") = id then Some model else find_model rest id
let format_model_compatible models format parameter value =
  let id = D.str value in
  if id = "" then true else match find_model models id with
  | None -> true
  | Some model ->
    if parameter <> "judge_model" then D.boolean (D.get model (if format = "image" then "image" else "text"))
    else if not (D.has model "structuredOutputs") then
      D.boolean (D.get model "text") && ((format <> "svg" && format <> "image") || D.boolean (D.get model "imageInput"))
    else format <> "html" && D.boolean (D.get model "text") && D.boolean (D.get model "structuredOutputs") &&
      ((format <> "svg" && format <> "image") || D.boolean (D.get model "imageInput"))

let convert_format_models input models format dropped =
  fold (fun (current, dropped) parameter ->
    let kind = source_kind current parameter in
    if kind = "common" then
      if format_model_compatible models format parameter (D.get (source current parameter) "value")
      then (current, dropped)
      else (set_source current parameter (common (JString "")), add_dropped dropped parameter)
    else if kind = "" then (current, dropped)
    else let cases, dropped = fold (fun (cases, dropped) entry ->
      if format_model_compatible models format parameter (D.get entry parameter)
      then (L.append cases [entry], dropped)
      else (L.append cases [D.set entry parameter (JString "")], add_dropped dropped parameter))
      ([], dropped) (entries current kind) in
      (set_entries current kind cases, dropped)) (input, dropped) ["model"; "judge_model"]

let normalize_format_axes input allocation counter dropped =
  fold (fun (current, count, dropped) side ->
    if P.is_case_axis current side then (current, count, dropped) else
    let parameters = P.axis_parameters current side in
    let native = fold (fun selected parameter ->
      if selected <> "" || parameter = "judge_criteria" || parameter = "judge_system" then selected else parameter) "" parameters in
    let current, count, dropped = fold (fun (current, count, dropped) parameter ->
      if parameter = native || parameter = "variable" then (current, count, dropped) else
      let dropped = fold add_dropped dropped
        (dropped_parameters current (JObject [("type", JString "to-common"); ("parameter", JString parameter)])) in
      let next, count = collapse current parameter allocation count in (next, count, dropped))
      (current, count, dropped) parameters in
    let next, count = neutral_dimension current side allocation count in (next, count, dropped))
    (input, counter, dropped) ["rows"; "columns"]

let valid_prompt_messages value =
  let messages = D.items value in
  L.length messages = 1 && D.str (D.get (D.at messages 0) "role") = "user"
let normalize_prompt_format input format dropped =
  if format = "chat-template" then (input, dropped) else
  let kind = source_kind input "input" in
  if kind = "common" then
    if valid_prompt_messages (D.get (source input "input") "value") then (input, dropped)
    else (set_source input "input" (common (P.parameter_default "input")), add_dropped dropped "input")
  else let cases, dropped = fold (fun (cases, dropped) entry ->
    if valid_prompt_messages (D.get entry "input") then (L.append cases [entry], dropped)
    else (L.append cases [D.set entry "input" (P.parameter_default "input")], add_dropped dropped "input"))
    ([], dropped) (entries input kind) in
    (set_entries input kind cases, dropped)

let select_format (draft:D.json) (format:string) (catalog:D.json) (prefix:string) (counter:nat)
  : Tot (D.json & nat & list string) =
  let previous = D.get draft "input" in
  if D.str (D.get previous "format") = format then (D.set draft "formatSelected" (JBool true), counter, [])
  else let allocation = (prefix, case_ids previous) in
    let defaults, counter = default_grid format allocation counter in
    let previous_defaults, counter = default_grid (D.str (D.get previous "format")) allocation counter in
    if parameter_values_equal (without_case_ids previous) (without_case_ids previous_defaults)
    then (D.set (D.set draft "input" defaults) "formatSelected" (JBool true), counter, [])
    else let applicable = L.append (L.map (fun (key, _) -> key) (D.fields (D.get defaults "parameters")))
      (if D.boolean (D.get previous "judge") && format <> "html" then judge_parameters else []) in
      let input = D.set (D.set previous "format" (JString format)) "judge"
        (JBool (D.boolean (D.get previous "judge") && format <> "html")) in
      let input, counter, dropped = fold (fun (current, count, dropped) (parameter, value) ->
        if member parameter applicable then (current, count, dropped) else
        let kind = D.str (D.get value "kind") in
        let lost = if kind = "common" then has_parameter_value parameter (D.get value "value")
          else L.existsb (fun entry -> has_parameter_value parameter (D.get entry parameter)) (entries current kind) in
        let dropped = if lost then add_dropped dropped parameter else dropped in
        let next, count = remove_parameter current parameter allocation count in (next, count, dropped))
        (input, counter, []) (D.fields (D.get input "parameters")) in
      let input, dropped = fold (fun (current, dropped) side -> strip_format_cases current side dropped)
        (input, dropped) ["rows"; "columns"] in
      let input = fold (fun current parameter ->
        if D.has (D.get current "parameters") parameter then current
        else set_source current parameter (common (P.parameter_default parameter))) input applicable in
      let input, dropped = convert_format_models input (D.items catalog) format dropped in
      let input, counter, dropped = normalize_format_axes input allocation counter dropped in
      let input, dropped = normalize_prompt_format input format dropped in
      (D.set (D.set draft "input" input) "formatSelected" (JBool true), counter, dropped)
