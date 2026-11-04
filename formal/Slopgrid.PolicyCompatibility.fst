module Slopgrid.PolicyCompatibility

module D = Slopgrid.Domain
open Slopgrid.Domain
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module N = Slopgrid.Native
module Num = Slopgrid.Number
module B = Slopgrid.PolicyBase
module V = Slopgrid.PolicyVariables
module Images = Slopgrid.PolicyImages

let rec catalog_model (catalog:list D.catalog_model) (id:string) : Tot (option D.catalog_model) (decreases catalog) =
  match catalog with | [] -> None | h::t ->
  match catalog_model t id with | Some model -> Some model | None -> if h.model_id = id then Some h else None
let moving_alias (id:string) : Tot bool =
  let rec latest (fuel:nat) (offset:nat) : Tot bool (decreases fuel) =
    if fuel = 0 then false else
    let c = N.char_at id offset in
    ((c = "-" || c = ":") && N.lower (N.slice id (offset+1) 6) = "latest" && (offset+7 = N.length id || N.char_at id (offset+7) = ":")) || latest (fuel-1) (offset+1) in
  N.starts_with id "~" || latest (N.length id) 0
let resolve_model (catalog:list D.catalog_model) (original:string) : Tot (option D.catalog_model & option string) =
  let fail id = B.cat (B.cat "Cannot resolve " id) " to a concrete model. Choose a versioned model." in
  let rec resolve (fuel:nat) (id:string) (seen:list string) : Tot (option D.catalog_model & option string) (decreases fuel) =
    if B.member id seen || fuel = 0 then (None,Some (fail id)) else
    let model = catalog_model catalog id in
    let target = match model with | None -> None | Some m -> m.alias_target in
    match target with
    | Some target -> if target <> "" then resolve (fuel-1) target (id::seen) else (model,None)
    | None -> match model with | None -> if moving_alias id then (None,Some (fail id)) else (None,None) | Some _ -> (model,None) in
  resolve (L.length catalog+2) original []
let effort_label (effort:D.effort) : Tot string = if effort = D.DefaultEffort then "Model default" else if effort = D.NoEffort then "None" else B.effort_key effort
let effort_support (model:option D.catalog_model) (effort:D.effort) : Tot Images.support_state =
  match model with
  | Some m -> if not m.generates_text then Images.Unsupported
    else if effort = D.DefaultEffort then Images.Supported
    else if effort = D.NoEffort && m.reasoning_mandatory then Images.Unsupported
    else (match m.reasoning_efforts with | None -> Images.Unknown | Some es -> if B.member effort es then Images.Supported else Images.Unsupported)
  | None -> if effort = D.DefaultEffort then Images.Supported else Images.Unknown
let issue (cell:D.preview_cell) (origins:list D.origin) (support:Images.support_state) (blocking:bool) (reason:string) (parameters:list D.parameter) : Tot D.compatibility_issue =
  let origins = B.unique origins in
  {D.issue_row=cell.cell_row;issue_column=cell.cell_column;
   issue_parameters=B.unique (parameters @ L.map (fun o -> o.D.origin_parameter) origins);origins=origins;
   support=(if support = Images.Unsupported then D.Unsupported else D.UnknownSupport);blocking=blocking;reason=reason}
let variable_image_origins (text:string) (g:D.layout) (cell:D.preview_cell) (consumed:list string) : Tot (list D.origin) =
  B.unique (B.flatmap (fun r ->
    if not (L.existsb (fun image -> B.member image.D.reference_id consumed) (B.option_list r.V.field.field_images)) then [] else
    [{D.origin_parameter=D.PVariable;origin_source=D.AxisOrigin r.V.side;case_index=Some r.V.record_index;field_index=Some r.V.field_index;message_index=None}])
    (V.references text g cell.cell_row cell.cell_column))
let generator_context (g:D.layout) (cell:D.preview_cell) : Tot (list string & list D.origin) =
  let messages = B.option_list cell.messages in
  let consumed = B.unique (B.flatmap (fun message -> L.map (fun image -> image.D.reference_id) (B.option_list message.D.images)) messages) in
  let origins = B.flatmap (fun (index,message) ->
    let images = match B.at messages index with | None -> [] | Some m -> L.map (fun image -> image.D.reference_id) (B.option_list m.images) in
    if images = [] then [] else
    [{(B.origin g cell D.PInput) with message_index=Some index}] @ variable_image_origins message.D.content g cell images)
    (B.indexed (B.messages g cell.cell_row cell.cell_column)) in
  (consumed,B.unique origins)
let effort_issues (g:D.layout) (cell:D.preview_cell) (model:option D.catalog_model) (effort:D.effort) (model_parameter:D.common_parameter) (effort_parameter:D.common_parameter) : Tot (list D.compatibility_issue) =
  let support = effort_support model effort in
  if support = Images.Supported then [] else
  let reason = if support = Images.Unknown then
    let name = match model with | Some m -> m.model_name | None ->
      if model_parameter = D.PModel then cell.cell_model else match cell.judge with | None -> "" | Some j -> j.judge_model in
    B.cat (B.cat (B.cat "Thinking effort " (effort_label effort)) " support is unknown for ") (B.cat name ".")
  else let name = match model with | Some m -> m.model_name | None -> "The selected model" in
    B.cat (B.cat name " does not support thinking effort ") (B.cat (effort_label effort) ".") in
  [issue cell [B.origin g cell model_parameter;B.origin g cell effort_parameter] support false reason []]
let judge_model_issue (judge:option D.catalog_model) (format:D.format) (images:bool) : Tot (option string) =
  if format = D.Html then Some "Websites do not support a judge yet." else
  match judge with
  | None -> Some "The judge model must support structured outputs."
  | Some j -> if not j.generates_text || j.structured_outputs <> Some true then Some "The judge model must support structured outputs."
    else if (format = D.Svg || format = D.Image) && not j.accepts_images then Some "The judge model must support image inputs for SVG and Image outputs."
    else if images && not j.accepts_images then Some "The judge model must support image inputs." else None
let cell_issues (g:D.layout) (catalog:list D.catalog_model) (cell:D.preview_cell) : Tot (list D.compatibility_issue) =
  let format = g.output_format in
  let model_id = cell.cell_model in
  let model,failure = resolve_model catalog model_id in
  let consumed,generator_origins = generator_context g cell in
  let model_issues = match failure with
    | Some reason -> [issue cell [B.origin g cell D.PModel] Images.Unknown true reason []]
    | None -> if model_id = "" then [] else
      (if consumed <> [] && (match model with | Some m -> not m.accepts_images | None -> true) then
        let unsupported = match model with | Some m -> not m.accepts_images | None -> false in
        [issue cell ([B.origin g cell D.PModel] @ generator_origins) (if unsupported then Images.Unsupported else Images.Unknown) true
          (if unsupported then "The selected model does not support image inputs." else "The selected model's image input support is unverified.") []] else []) @
      (if format = D.Image then [] else effort_issues g cell model cell.cell_effort D.PModel D.PEffort) in
  let image_issues = if format <> D.Image || V.active failure then [] else
    let endpoints = match model with | None -> [] | Some m -> B.option_list m.image_endpoints in
    match cell.image_settings with | None -> [] | Some settings ->
    L.map (fun conflict ->
      let parameters = conflict.Images.parameters in
      let origins = (if conflict.Images.model_dependent then [B.origin g cell D.PModel] else []) @
        B.flatmap (fun parameter -> if parameter = Images.InputReferences then generator_origins else [B.origin g cell (Images.parameter parameter)]) parameters in
      issue cell origins conflict.Images.support false conflict.Images.reason (B.flatmap (fun p -> if p = Images.InputReferences then [] else [Images.parameter p]) parameters))
      (Images.image_conflicts endpoints settings) in
  let judge_issues = match cell.judge with | None -> [] | Some judge_cell ->
    let judge_id = judge_cell.judge_model in
    if judge_id = "" then [] else
    let judge,failure = resolve_model catalog judge_id in
    match failure with
    | Some reason -> [issue cell [B.origin g cell D.PJudgeModel] Images.Unknown true reason []]
    | None ->
      let _,criterion_images = V.resolve_criteria g cell.cell_row cell.cell_column in
      let criterion_ids = L.map (fun image -> image.D.reference_id) criterion_images in
      (match judge_model_issue judge format (consumed <> [] || criterion_ids <> []) with
      | None -> []
      | Some reason ->
        let needs_vision = format <> D.Html && (match judge with | Some j -> j.generates_text && j.structured_outputs = Some true | None -> false) in
        let origins = [B.origin g cell D.PJudgeModel] @
          (if needs_vision && format <> D.Svg && format <> D.Image then
            generator_origins @ (if criterion_ids = [] then [] else [B.origin g cell D.PJudgeCriteria] @
              B.flatmap (fun criterion -> variable_image_origins criterion.D.criterion_text g cell criterion_ids) (B.criteria g cell.cell_row cell.cell_column)) else []) in
        let unsupported = format = D.Html || (match judge with | None -> false | Some j ->
          if needs_vision then not j.accepts_images else not j.generates_text || j.structured_outputs = Some false) in
        [issue cell origins (if unsupported then Images.Unsupported else Images.Unknown) true reason []]) @
      effort_issues g cell judge judge_cell.judge_effort D.PJudgeModel D.PJudgeEffort in
  model_issues @ image_issues @ judge_issues
let analyze (g:D.layout) (budget:option Num.finite) (catalog:list D.catalog_model) : Tot (list D.preview_cell & list D.compatibility_issue) =
  let cells = V.expand_grid g budget in
  (cells,B.flatmap (cell_issues g catalog) cells)
