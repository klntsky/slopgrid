module Slopgrid.PolicyCompatibility

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module B = Slopgrid.PolicyBase
module V = Slopgrid.PolicyVariables
module Images = Slopgrid.PolicyImages

let rec catalog_model (catalog:list D.json) (id:string) : Tot D.json (decreases catalog) =
  match catalog with | [] -> D.JNull | h::t ->
  let later = catalog_model t id in
  if not (B.is_null later) then later else if D.str (D.get h "id") = id then h else D.JNull
let moving_alias (id:string) : Tot bool =
  let rec latest (fuel:nat) (offset:nat) : Tot bool (decreases fuel) =
    if fuel = 0 then false else
    let c = N.char_at id offset in
    ((c = "-" || c = ":") && N.lower (N.slice id (offset+1) 6) = "latest" && (offset+7 = N.length id || N.char_at id (offset+7) = ":")) || latest (fuel-1) (offset+1) in
  N.starts_with id "~" || latest (N.length id) 0
let resolve_model (catalog:list D.json) (original:string) : Tot (D.json & option string) =
  let fail id = B.cat (B.cat "Cannot resolve " id) " to a concrete model. Choose a versioned model." in
  let rec resolve (fuel:nat) (id:string) (seen:list string) : Tot (D.json & option string) (decreases fuel) =
    if B.member id seen || fuel = 0 then (D.JNull,Some (fail id)) else
    let model = catalog_model catalog id in
    let target = D.str (D.get model "aliasTarget") in
    if target <> "" then resolve (fuel-1) target (id::seen)
    else if B.is_null model && moving_alias id then (D.JNull,Some (fail id))
    else (model,None) in
  resolve (L.length catalog+2) original []
let effort_label (effort:string) : Tot string = if effort = "default" then "Model default" else if effort = "none" then "None" else effort
let effort_support (model:D.json) (effort:string) : Tot string =
  if not (B.is_null model) && not (D.boolean (D.get model "text")) then "unsupported"
  else if effort = "default" then "supported"
  else if B.is_null model then "unknown"
  else if effort = "none" && D.boolean (D.get model "reasoningMandatory") then "unsupported"
  else if not (D.has model "reasoningEfforts") then "unknown"
  else if B.member effort (D.strings (D.get model "reasoningEfforts")) then "supported" else "unsupported"
let issue (cell:D.json) (origins:list D.json) (support:string) (blocking:bool) (reason:string) (parameters:list string) : Tot D.json =
  let origins = B.unique_json origins in
  D.object [("row",D.get cell "row");("column",D.get cell "column");
    ("parameters",D.array (L.map D.string (D.unique_strings (parameters @ L.map (fun o -> D.str (D.get o "parameter")) origins))));
    ("origins",D.array origins);("support",D.string support);("blocking",D.JBool blocking);("reason",D.string reason)]
let variable_image_origins (text:string) (input:D.json) (cell:D.json) (consumed:list string) : Tot (list D.json) =
  B.unique_json (B.flatmap (fun reference ->
    if not (L.existsb (fun image -> B.member (D.str (D.get image "id")) consumed) (D.items (D.get (D.get reference "field") "images"))) then [] else
    let path = D.items (D.get reference "path") in
    [D.object [("parameter",D.string "variable");("source",D.at path 0);("caseIndex",D.at path 1);("fieldIndex",D.at path 3)]])
    (V.references text input (D.natural (D.get cell "row")) (D.natural (D.get cell "column"))))
let generator_context (input:D.json) (cell:D.json) : Tot (list string & list D.json) =
  let messages = D.items (D.get cell "messages") in
  let consumed = D.unique_strings (B.flatmap (fun message -> L.map (fun image -> D.str (D.get image "id")) (D.items (D.get message "images"))) messages) in
  let origins = B.flatmap (fun (index,message) ->
    let images = L.map (fun image -> D.str (D.get image "id")) (D.items (D.get (D.at messages index) "images")) in
    if images = [] then [] else
    [D.set (B.origin input cell "input") "messageIndex" (D.number index)] @
    variable_image_origins (D.str (D.get message "content")) input cell images)
    (B.indexed (B.messages input (D.natural (D.get cell "row")) (D.natural (D.get cell "column")))) in
  (consumed,B.unique_json origins)
let effort_issues (input:D.json) (cell:D.json) (model:D.json) (effort:string) (model_parameter:string) (effort_parameter:string) : Tot (list D.json) =
  let support = effort_support model effort in
  if support = "supported" then [] else
  let reason = if support = "unknown" then
    let name = if D.has model "name" then D.str (D.get model "name") else
      if model_parameter = "model" then D.str (D.get cell "model") else D.str (D.get (D.get cell "judge") "model") in
    B.cat (B.cat (B.cat "Thinking effort " (effort_label effort)) " support is unknown for ") (B.cat name ".")
  else let name = if D.has model "name" then D.str (D.get model "name") else "The selected model" in
    B.cat (B.cat name " does not support thinking effort ") (B.cat (effort_label effort) ".") in
  [issue cell [B.origin input cell model_parameter;B.origin input cell effort_parameter] support false reason []]
let judge_model_issue (judge:D.json) (format:string) (images:bool) : Tot (option string) =
  if format = "html" then Some "Websites do not support a judge yet."
  else if not (D.boolean (D.get judge "text")) || D.get judge "structuredOutputs" <> D.JBool true then Some "The judge model must support structured outputs."
  else if (format = "svg" || format = "image") && D.get judge "imageInput" <> D.JBool true then Some "The judge model must support image inputs for SVG and Image outputs."
  else if images && D.get judge "imageInput" <> D.JBool true then Some "The judge model must support image inputs."
  else None
let cell_issues (input:D.json) (catalog:list D.json) (cell:D.json) : Tot (list D.json) =
  let format = D.str (D.get input "format") in
  let model_id = D.str (D.get cell "model") in
  let model,failure = resolve_model catalog model_id in
  let consumed,generator_origins = generator_context input cell in
  let model_issues = match failure with
    | Some reason -> [issue cell [B.origin input cell "model"] "unknown" true reason []]
    | None -> if model_id = "" then [] else
      (if consumed <> [] && D.get model "imageInput" <> D.JBool true then
        [issue cell ([B.origin input cell "model"] @ generator_origins)
          (if D.get model "imageInput" = D.JBool false then "unsupported" else "unknown") true
          (if D.get model "imageInput" = D.JBool false then "The selected model does not support image inputs." else "The selected model's image input support is unverified.") []] else []) @
      (if format = "image" then [] else effort_issues input cell model (D.str (D.get cell "effort")) "model" "effort") in
  let image_issues = if format <> "image" || (match failure with | None -> false | Some _ -> true) then [] else
    L.map (fun conflict ->
      let parameters = D.strings (D.get conflict "parameters") in
      let origins = (if D.boolean (D.get conflict "modelDependent") then [B.origin input cell "model"] else []) @
        B.flatmap (fun parameter -> if parameter = "input_references" then generator_origins else [B.origin input cell parameter]) parameters in
      issue cell origins (D.str (D.get conflict "support")) false (D.str (D.get conflict "reason")) (L.filter (fun p -> p <> "input_references") parameters))
      (Images.image_conflicts (D.items (D.get model "imageEndpoints")) (D.get cell "imageSettings")) in
  let judge_cell = D.get cell "judge" in
  let judge_id = D.str (D.get judge_cell "model") in
  let judge_issues = if judge_id = "" then [] else
    let judge,failure = resolve_model catalog judge_id in
    match failure with
    | Some reason -> [issue cell [B.origin input cell "judge_model"] "unknown" true reason []]
    | None ->
      let _,criterion_images = V.resolve_criteria input (D.natural (D.get cell "row")) (D.natural (D.get cell "column")) in
      let criterion_ids = L.map (fun image -> D.str (D.get image "id")) criterion_images in
      (match judge_model_issue judge format (consumed <> [] || criterion_ids <> []) with
      | None -> []
      | Some reason ->
        let needs_vision = format <> "html" && D.get judge "text" = D.JBool true && D.get judge "structuredOutputs" = D.JBool true in
        let origins = [B.origin input cell "judge_model"] @
          (if needs_vision && format <> "svg" && format <> "image" then
            generator_origins @ (if criterion_ids = [] then [] else [B.origin input cell "judge_criteria"] @
              B.flatmap (fun criterion -> variable_image_origins (D.str (D.get criterion "text")) input cell criterion_ids) (B.criteria input (D.natural (D.get cell "row")) (D.natural (D.get cell "column")))) else []) in
        let support = if format = "html" || (if needs_vision then D.get judge "imageInput" = D.JBool false else D.get judge "text" = D.JBool false || D.get judge "structuredOutputs" = D.JBool false) then "unsupported" else "unknown" in
        [issue cell origins support true reason []]) @
      effort_issues input cell judge (D.str (D.get judge_cell "effort")) "judge_model" "judge_effort" in
  model_issues @ image_issues @ judge_issues
let analyze (input:D.json) (catalog:list D.json) : Tot (list D.json & list D.json) =
  let cells = V.expand_grid input in
  (cells,B.flatmap (cell_issues input catalog) cells)
