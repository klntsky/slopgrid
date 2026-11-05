module Slopgrid.PolicyCompatibility

(* Check each cell after selecting its owned values and expanding its input.
   Required image input and judge capabilities block admission, even when
   unverified. Effort and image-setting conflicts remain advisory.
   PRODUCT.md 3.4.1 and 3.4.7. *)

module Domain = Slopgrid.Domain
open Slopgrid.Domain
module List = FStar.List.Tot.Base
open FStar.List.Tot.Base
module Native = Slopgrid.Native
module Number = Slopgrid.Number
module PolicyBase = Slopgrid.PolicyBase
module PolicyVariables = Slopgrid.PolicyVariables
module PolicyImages = Slopgrid.PolicyImages

let rec catalog_model (catalog: list Domain.catalog_model) (id: string)
  : Tot (option Domain.catalog_model) (decreases catalog) =
  match catalog with
  | [] -> None
  | h :: t ->
    match catalog_model t id with
    | Some model -> Some model
    | None -> if h.model_id = id then Some h else None

let moving_alias (id: string) : Tot bool =
  let rec latest (fuel: nat) (offset: nat) : Tot bool (decreases fuel) =
    if fuel = 0 then false
    else
      let c = Native.char_at id offset in
      ((c = "-" || c = ":") && Native.lower (Native.slice id (offset + 1) 6) = "latest" &&
       (offset + 7 = Native.length id || Native.char_at id (offset + 7) = ":")) ||
      latest (fuel - 1) (offset + 1)
  in
  Native.starts_with id "~" || latest (Native.length id) 0

(* Follow published alias targets before capability checks. Stop on a cycle or
   an unresolved moving alias rather than checking a different model by guess.
   This lookup does not rewrite the submitted model selection. *)
let resolve_model (catalog: list Domain.catalog_model) (original: string)
  : Tot (option Domain.catalog_model & option string) =
  let fail id =
    PolicyBase.cat (PolicyBase.cat "Cannot resolve " id)
      " to a concrete model. Choose a versioned model."
  in
  let rec resolve (fuel: nat) (id: string) (seen: list string)
    : Tot (option Domain.catalog_model & option string) (decreases fuel) =
    if PolicyBase.member id seen || fuel = 0 then (None, Some (fail id))
    else
      let model = catalog_model catalog id in
      let target =
        match model with
        | None -> None
        | Some m -> m.alias_target
      in
      match target with
      | Some target ->
        if target <> "" then resolve (fuel - 1) target (id :: seen)
        else (model, None)
      | None ->
        match model with
        | None -> if moving_alias id then (None, Some (fail id)) else (None, None)
        | Some _ -> (model, None)
  in
  resolve (List.length catalog + 2) original []

let effort_label (effort: Domain.effort) : Tot string =
  if effort = Domain.DefaultEffort then "Model default"
  else if effort = Domain.NoEffort then "None"
  else PolicyBase.effort_key effort

(* Model default requests no effort override, including when metadata is absent.
   Missing support information for an explicit effort produces an advisory
   unknown result, not a new prohibition. PRODUCT.md 3.4.4 and 3.4.7. *)
let effort_support (model: option Domain.catalog_model) (effort: Domain.effort)
  : Tot PolicyImages.support_state =
  match model with
  | Some m ->
    if not m.generates_text then PolicyImages.Unsupported
    else if effort = Domain.DefaultEffort then PolicyImages.Supported
    else if effort = Domain.NoEffort && m.reasoning_mandatory then PolicyImages.Unsupported
    else
      (match m.reasoning_efforts with
       | None -> PolicyImages.Unknown
       | Some es ->
         if PolicyBase.member effort es then PolicyImages.Supported else PolicyImages.Unsupported)
  | None ->
    if effort = Domain.DefaultEffort then PolicyImages.Supported else PolicyImages.Unknown

let issue (cell: Domain.preview_cell) (origins: list Domain.origin)
  (support: PolicyImages.support_state) (blocking: bool) (reason: string)
  (parameters: list Domain.parameter) : Tot Domain.compatibility_issue =
  let origins = PolicyBase.unique origins in
  {
    Domain.issue_row = cell.cell_row;
    issue_column = cell.cell_column;
    issue_parameters =
      PolicyBase.unique (parameters @ List.map (fun o -> o.Domain.origin_parameter) origins);
    origins = origins;
    support =
      (if support = PolicyImages.Unsupported then Domain.Unsupported else Domain.UnknownSupport);
    blocking = blocking;
    reason = reason
  }

(* Blame a field only when its images occur in the consumed message or rubric.
   An unused image-bearing field must not require generator vision or receive
   an unrelated attachment conflict. PRODUCT.md 3.4.2 and 3.4.7. *)
let variable_image_origins (text: string) (g: Domain.layout) (cell: Domain.preview_cell)
  (consumed: list string) : Tot (list Domain.origin) =
  PolicyBase.unique
    (PolicyBase.flatmap
      (fun r ->
        if not (List.existsb
          (fun image -> PolicyBase.member image.Domain.reference_id consumed)
          (PolicyBase.option_list r.PolicyVariables.field.field_images)) then []
        else
          [{
            Domain.origin_parameter = Domain.PVariable;
            origin_source = Domain.AxisOrigin r.PolicyVariables.side;
            case_index = Some r.PolicyVariables.record_index;
            field_index = Some r.PolicyVariables.field_index;
            message_index = None
          }])
      (PolicyVariables.references text g cell.cell_row cell.cell_column))

(* Inspect all supplied messages, including turns after an unfilled reply.
   Use expanded attachments to count consumed images, but raw templates to
   find the message and variable controls that supplied them. Judge criteria
   are deliberately absent from this generator context. PRODUCT.md 3.4.7. *)
let generator_context (g: Domain.layout) (cell: Domain.preview_cell)
  : Tot (list string & list Domain.origin) =
  let messages = PolicyBase.option_list cell.messages in
  let consumed =
    PolicyBase.unique
      (PolicyBase.flatmap
        (fun message ->
          List.map (fun image -> image.Domain.reference_id) (PolicyBase.option_list message.Domain.images))
        messages)
  in
  let origins =
    PolicyBase.flatmap
      (fun (index, message) ->
        let images =
          match PolicyBase.at messages index with
          | None -> []
          | Some m -> List.map (fun image -> image.Domain.reference_id) (PolicyBase.option_list m.images)
        in
        if images = [] then []
        else
          [{(PolicyBase.origin g cell Domain.PInput) with message_index = Some index}] @
          variable_image_origins message.Domain.content g cell images)
      (PolicyBase.indexed (PolicyBase.messages g cell.cell_row cell.cell_column))
  in
  (consumed, PolicyBase.unique origins)

let effort_issues (g: Domain.layout) (cell: Domain.preview_cell)
  (model: option Domain.catalog_model) (effort: Domain.effort)
  (model_parameter: Domain.common_parameter) (effort_parameter: Domain.common_parameter)
  : Tot (list Domain.compatibility_issue) =
  let support = effort_support model effort in
  if support = PolicyImages.Supported then []
  else
    let reason =
      if support = PolicyImages.Unknown then
        let name =
          match model with
          | Some m -> m.model_name
          | None ->
            if model_parameter = Domain.PModel then cell.cell_model
            else
              match cell.judge with
              | None -> ""
              | Some j -> j.judge_model
        in
        PolicyBase.cat
          (PolicyBase.cat (PolicyBase.cat "Thinking effort " (effort_label effort))
            " support is unknown for ")
          (PolicyBase.cat name ".")
      else
        let name =
          match model with
          | Some m -> m.model_name
          | None -> "The selected model"
        in
        PolicyBase.cat (PolicyBase.cat name " does not support thinking effort ")
          (PolicyBase.cat (effort_label effort) ".")
    in
    [issue cell
      [PolicyBase.origin g cell model_parameter; PolicyBase.origin g cell effort_parameter]
      support false reason []]

(* A judge must have verified text and structured-output support.
   It also needs vision for SVG or Image output, or for images in the generator
   context or its own rubric. This is setup eligibility, not judge execution.
   PRODUCT.md 3.8.5. *)
let judge_model_issue (judge: option Domain.catalog_model) (format: Domain.format) (images: bool)
  : Tot (option string) =
  if format = Domain.Html then Some "Websites do not support a judge yet."
  else
    match judge with
    | None -> Some "The judge model must support structured outputs."
    | Some j ->
      if not j.generates_text || j.structured_outputs <> Some true then
        Some "The judge model must support structured outputs."
      else if (format = Domain.Svg || format = Domain.Image) && not j.accepts_images then
        Some "The judge model must support image inputs for SVG and Image outputs."
      else if images && not j.accepts_images then
        Some "The judge model must support image inputs."
      else None

let cell_issues (g: Domain.layout) (catalog: list Domain.catalog_model) (cell: Domain.preview_cell)
  : Tot (list Domain.compatibility_issue) =
  let format = g.output_format in
  let model_id = cell.cell_model in
  let model, failure = resolve_model catalog model_id in
  let consumed, generator_origins = generator_context g cell in
  let model_issues =
    match failure with
    | Some reason ->
      [issue cell [PolicyBase.origin g cell Domain.PModel] PolicyImages.Unknown true reason []]
    | None ->
      if model_id = "" then []
      (* Unknown ordinary model metadata is not itself a blocker. Consumed
         images change that: generation needs verified image-input support.
         No pricing or token-budget calculation happens here. PRODUCT.md 3.4.7. *)
      else
        (if consumed <> [] &&
           (match model with
            | Some m -> not m.accepts_images
            | None -> true) then
           let unsupported =
             match model with
             | Some m -> not m.accepts_images
             | None -> false
           in
           [issue cell ([PolicyBase.origin g cell Domain.PModel] @ generator_origins)
             (if unsupported then PolicyImages.Unsupported else PolicyImages.Unknown) true
             (if unsupported then "The selected model does not support image inputs."
              else "The selected model's image input support is unverified.")
             []]
         else []) @
        (if format = Domain.Image then []
         else effort_issues g cell model cell.cell_effort Domain.PModel Domain.PEffort)
  in
  let image_issues =
    if format <> Domain.Image || PolicyVariables.active failure then []
    else
      let endpoints =
        match model with
        | None -> []
        | Some m -> PolicyBase.option_list m.image_endpoints
      in
      match cell.image_settings with
      | None -> []
      | Some settings ->
        List.map
          (fun conflict ->
            let parameters = conflict.PolicyImages.parameters in
            (* Attribute a combination failure only to settings in that
               conflict. An image-count conflict follows the actual message
               and field attachments, not every input control. PRODUCT.md 3.4.6. *)
            let origins =
              (if conflict.PolicyImages.model_dependent then
                 [PolicyBase.origin g cell Domain.PModel]
               else []) @
              PolicyBase.flatmap
                (fun parameter ->
                  if parameter = PolicyImages.InputReferences then generator_origins
                  else [PolicyBase.origin g cell (PolicyImages.parameter parameter)])
                parameters
            in
            issue cell origins conflict.PolicyImages.support false conflict.PolicyImages.reason
              (PolicyBase.flatmap
                (fun p ->
                  if p = PolicyImages.InputReferences then [] else [PolicyImages.parameter p])
                parameters))
          (PolicyImages.image_conflicts endpoints settings)
  in
  let judge_issues =
    match cell.judge with
    | None -> []
    | Some judge_cell ->
      let judge_id = judge_cell.judge_model in
      if judge_id = "" then []
      else
        let judge, failure = resolve_model catalog judge_id in
        match failure with
        | Some reason ->
          [issue cell [PolicyBase.origin g cell Domain.PJudgeModel] PolicyImages.Unknown true reason []]
        | None ->
          (* Criterion images belong to the judge, never to the generator.
             The judge also receives generator context, so either source can
             require its image-input capability. PRODUCT.md 3.3.5 and 3.8.5. *)
          let _, criterion_images = PolicyVariables.resolve_criteria g cell.cell_row cell.cell_column in
          let criterion_ids = List.map (fun image -> image.Domain.reference_id) criterion_images in
          (match judge_model_issue judge format (consumed <> [] || criterion_ids <> []) with
           | None -> []
           | Some reason ->
             let needs_vision =
               format <> Domain.Html &&
               (match judge with
                | Some j -> j.generates_text && j.structured_outputs = Some true
                | None -> false)
             in
             let origins =
               [PolicyBase.origin g cell Domain.PJudgeModel] @
               (if needs_vision && format <> Domain.Svg && format <> Domain.Image then
                  generator_origins @
                  (if criterion_ids = [] then []
                   else
                     [PolicyBase.origin g cell Domain.PJudgeCriteria] @
                     PolicyBase.flatmap
                       (fun criterion ->
                         variable_image_origins criterion.Domain.criterion_text g cell criterion_ids)
                       (PolicyBase.criteria g cell.cell_row cell.cell_column))
                else [])
             in
             let unsupported =
               format = Domain.Html ||
               (match judge with
                | None -> false
                | Some j ->
                  if needs_vision then not j.accepts_images
                  else not j.generates_text || j.structured_outputs = Some false)
             in
             [issue cell origins
               (if unsupported then PolicyImages.Unsupported else PolicyImages.Unknown)
               true reason []]) @
          effort_issues g cell judge judge_cell.judge_effort Domain.PJudgeModel Domain.PJudgeEffort
  in
  model_issues @ image_issues @ judge_issues

(* These cells describe resolved combinations used for setup feedback.
   Calling this on a completed layout checks its actual intersections. The
   form may supply an editing preview while a dimension is still empty.
   PRODUCT.md 3.4.1 and 3.4.2. *)
let analyze (g: Domain.layout) (budget: option Number.finite) (catalog: list Domain.catalog_model)
  : Tot (list Domain.preview_cell & list Domain.compatibility_issue) =
  let cells = PolicyVariables.expand_grid g budget in
  (cells, PolicyBase.flatmap (cell_issues g catalog) cells)
