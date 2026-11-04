open Js_of_ocaml
module D = Slopgrid_Domain
module M = Slopgrid_Machine
module N = Slopgrid_Number

let fail expected =
  let error = Js.Unsafe.new_obj (Js.Unsafe.js_expr "TypeError")
    [|Js.Unsafe.inject (Js.string ("Invalid creation data: " ^ expected))|] in
  Js.Js_error.raise_ (Js.Js_error.of_error error)
let object_fields allowed = function
  | `Assoc fields ->
      let rec check seen = function
        | [] -> fields
        | (key, _) :: rest ->
            if not (List.mem key allowed) then fail ("unknown field " ^ key);
            if List.mem key seen then fail ("duplicate field " ^ key);
            check (key :: seen) rest
      in check [] fields
  | _ -> fail "expected object"
let required fields key =
  match List.assoc_opt key fields with Some value -> value | None -> fail ("missing " ^ key)
let optional decode fields key = Option.map decode (List.assoc_opt key fields)
let string = function `String value -> value | _ -> fail "expected string"
let boolean = function `Bool value -> value | _ -> fail "expected boolean"
let list decode = function `List values -> List.map decode values | _ -> fail "expected array"
let nullable decode = function `Null -> None | value -> Some (decode value)
let number = function
  | `Int value -> float_of_int value
  | `Intlit value -> (try float_of_string value with Failure _ -> fail "expected number")
  | `Float value -> value
  | _ -> fail "expected number"
let finite value = let value = number value in if N.is_finite value then value else fail "expected finite number"
let nonnegative value = let value = finite value in if value >= 0. then value else fail "expected nonnegative number"
let natural value =
  let value = finite value in
  if value < 0. || value > 9007199254740991. || floor value <> value then fail "expected safe nonnegative integer";
  Z.of_float value
let positive value = let value = natural value in if Z.sign value > 0 then value else fail "expected positive integer"
let nonempty value = let value = string value in if value = "" then fail "expected nonempty string" else value
let bounded_string bound value =
  let value = nonempty value in
  let length = Js.Unsafe.get (Js.string value) "length" in
  if length > bound then fail "string too long" else value
let format value = match string value with
  | "svg" -> D.Svg | "markdown" -> D.Markdown | "html" -> D.Html
  | "chat-template" -> D.ChatTemplate | "image" -> D.Image | _ -> fail "unknown format"
let axis value = match string value with "rows" -> D.Rows | "columns" -> D.Columns | _ -> fail "unknown axis"
let effort value = match string value with
  | "default" -> D.DefaultEffort | "none" -> D.NoEffort | "minimal" -> D.MinimalEffort
  | "low" -> D.LowEffort | "medium" -> D.MediumEffort | "high" -> D.HighEffort
  | "xhigh" -> D.ExtraHighEffort | "max" -> D.MaxEffort | _ -> fail "unknown effort"
let role value = match string value with
  | "system" -> D.SystemRole | "user" -> D.UserRole | "assistant" -> D.AssistantRole
  | "unfilled" -> D.UnfilledRole | _ -> fail "unknown role"
let parameter value = match string value with
  | "input" -> D.PInput | "model" -> D.PModel | "effort" -> D.PEffort | "size" -> D.PSize
  | "aspect_ratio" -> D.PAspectRatio | "quality" -> D.PQuality | "background" -> D.PBackground
  | "judge_model" -> D.PJudgeModel | "judge_effort" -> D.PJudgeEffort
  | "judge_criteria" -> D.PJudgeCriteria | "judge_system" -> D.PJudgeSystem
  | "variable" -> D.PVariable | _ -> fail "unknown parameter"
let common_parameter value = match parameter value with D.PVariable -> fail "variable is not common" | p -> p
let scalar_parameter value = match common_parameter value with
  | D.PInput | D.PJudgeCriteria | D.PJudgeSystem -> fail "parameter is not scalar" | p -> p
let parameter_keys = ["input"; "model"; "effort"; "size"; "aspect_ratio"; "quality"; "background";
  "judge_model"; "judge_effort"; "judge_criteria"; "judge_system"; "variable"]
let common_keys = List.filter ((<>) "variable") parameter_keys
let reference value : D.reference_image =
  let f = object_fields ["id"; "name"; "width"; "height"] value in
  let dimensions = match optional positive f "width", optional positive f "height" with
    | None, None -> None | Some width, Some height -> Some { D.width; height }
    | _ -> fail "reference dimensions require width and height"
  in { D.reference_id = bounded_string 80 (required f "id");
       reference_name = bounded_string 255 (required f "name"); reference_dimensions = dimensions }
let message value : D.message =
  let f = object_fields ["role"; "content"; "images"] value in
  { D.message_role = role (required f "role"); content = string (required f "content");
    images = optional (list reference) f "images" }
let variable_field value : D.variable_field =
  let f = object_fields ["text"; "images"] value in
  { D.text = string (required f "text"); field_images = optional (list reference) f "images" }
let criterion value : D.criterion =
  let f = object_fields ["text"; "correctAnswer"] value in
  { D.criterion_text = string (required f "text"); correct_answer = boolean (required f "correctAnswer") }
let value p json = match p with
  | D.PInput -> D.InputValue (list message json) | D.PModel -> D.ModelValue (string json)
  | D.PEffort -> D.EffortValue (effort json) | D.PSize -> D.SizeValue (string json)
  | D.PAspectRatio -> D.AspectRatioValue (string json) | D.PQuality -> D.QualityValue (string json)
  | D.PBackground -> D.BackgroundValue (string json) | D.PJudgeModel -> D.JudgeModelValue (string json)
  | D.PJudgeEffort -> D.JudgeEffortValue (effort json)
  | D.PJudgeCriteria -> D.JudgeCriteriaValue (list criterion json)
  | D.PJudgeSystem -> D.JudgeSystemValue (string json)
  | D.PVariable -> D.VariableValue (list (nullable variable_field) json)
let source p json =
  let f = object_fields ["kind"; "value"] json in
  match string (required f "kind") with
  | "common" -> D.Common (value p (required f "value"))
  | ("rows" | "columns") as side ->
      if List.mem_assoc "value" f then fail "axis source has no value";
      D.OnAxis (axis (`String side))
  | _ -> fail "unknown source"
let sources json : D.parameter_sources =
  let f = object_fields common_keys json in
  { D.source_order = List.map (fun (key, _) -> parameter (`String key)) f;
    input_source = source D.PInput (required f "input");
    model_source = source D.PModel (required f "model");
    effort_source = optional (source D.PEffort) f "effort";
    size_source = optional (source D.PSize) f "size";
    aspect_ratio_source = optional (source D.PAspectRatio) f "aspect_ratio";
    quality_source = optional (source D.PQuality) f "quality";
    background_source = optional (source D.PBackground) f "background";
    judge_model_source = optional (source D.PJudgeModel) f "judge_model";
    judge_effort_source = optional (source D.PJudgeEffort) f "judge_effort";
    judge_criteria_source = optional (source D.PJudgeCriteria) f "judge_criteria";
    judge_system_source = optional (source D.PJudgeSystem) f "judge_system" }
let case_record json : D.case_record =
  let f = object_fields ("id" :: "name" :: parameter_keys) json in
  { D.case_id = nonempty (required f "id"); case_name = optional string f "name";
    values = {
      D.value_order = List.filter_map (fun (key, _) -> if List.mem key parameter_keys then Some (parameter (`String key)) else None) f;
      input_value = optional (list message) f "input"; model_value = optional string f "model";
      effort_value = optional effort f "effort"; size_value = optional string f "size";
      aspect_ratio_value = optional string f "aspect_ratio"; quality_value = optional string f "quality";
      background_value = optional string f "background"; judge_model_value = optional string f "judge_model";
      judge_effort_value = optional effort f "judge_effort";
      judge_criteria_value = optional (list criterion) f "judge_criteria";
      judge_system_value = optional string f "judge_system";
      variable_value = optional (list (nullable variable_field)) f "variable" } }
let variable_names json : D.variable_names =
  let f = object_fields ["rows"; "columns"] json in
  { D.row_names = optional (list (nullable string)) f "rows";
    column_names = optional (list (nullable string)) f "columns" }
let layout_keys = ["inputVersion"; "format"; "caseAxes"; "rows"; "columns"; "variableNames";
  "parameters"; "judge"; "parallelWorkers"; "budgetUsd"]
let layout f : D.layout =
  if natural (required f "inputVersion") <> Z.of_int 3 then fail "expected inputVersion 3";
  let ownership = match list axis (required f "caseAxes") with
    | [] -> D.NoCaseAxes | [side] -> D.OneCaseAxis side
    | [first; second] when first <> second -> D.BothCaseAxes first
    | _ -> fail "caseAxes must contain distinct axes"
  in { D.output_format = format (required f "format"); case_ownership = ownership;
       rows = list case_record (required f "rows"); columns = list case_record (required f "columns");
       variable_names = optional variable_names f "variableNames";
       parameters = sources (required f "parameters"); judging = boolean (required f "judge");
       parallel_workers = optional positive f "parallelWorkers" }
let draft_input json : D.draft_input =
  let f = object_fields layout_keys json in
  { D.draft_layout = layout f; budget_text = string (required f "budgetUsd") }
let draft json : D.draft =
  let f = object_fields ["formatSelected"; "input"; "sourceGridId"; "reuseArtifacts"] json in
  { D.format_selected = boolean (required f "formatSelected"); editable = draft_input (required f "input");
    source_grid_id = optional string f "sourceGridId"; reuse_artifacts = optional boolean f "reuseArtifacts" }
let provider json : D.provider_observation =
  let f = object_fields ["connected"; "capacity"] json in
  let c = object_fields ["format"; "status"; "parallelWorkers"] (required f "capacity") in
  let format = format (required c "format") in
  let workers = nullable positive (required c "parallelWorkers") in
  let capacity = match string (required c "status") with
    | "pending" -> D.CapacityPending (format, workers) | "ready" -> D.CapacityReady (format, workers)
    | "error" -> D.CapacityError (format, workers) | _ -> fail "unknown capacity status"
  in { D.connected = boolean (required f "connected"); capacity }
let capability json =
  let f = object_fields ["type"; "values"; "min"; "max"] json in
  match string (required f "type") with
  | "enum" -> ignore (object_fields ["type"; "values"] json); D.EnumCapability (list string (required f "values"))
  | "range" -> ignore (object_fields ["type"; "min"; "max"] json); D.RangeCapability (finite (required f "min"), finite (required f "max"))
  | "boolean" -> ignore (object_fields ["type"] json); D.BooleanCapability
  | other -> ignore (object_fields ["type"] json); D.OtherCapability other
let price json : D.endpoint_price =
  let f = object_fields ["billable"; "unit"; "cost_usd"; "variant"] json in
  { D.billable = string (required f "billable"); unit = string (required f "unit");
    cost_usd = nonnegative (required f "cost_usd"); variant = optional string f "variant" }
let endpoint json : D.image_endpoint =
  let f = object_fields ["provider_name"; "supported_parameters"; "pricing"] json in
  let capabilities = match required f "supported_parameters" with
    | `Assoc fields ->
        ignore (object_fields (List.map fst fields) (`Assoc fields));
        List.map (fun (key, json) -> key, capability json) fields
    | _ -> fail "expected capabilities object"
  in let name = Slopgrid_Native.trim (string (required f "provider_name")) in
  if name = "" then fail "expected provider name";
  { D.provider_name = name; capabilities; pricing = list price (required f "pricing") }
let catalog_model json : D.catalog_model =
  let f = object_fields ["id"; "aliasTarget"; "canonicalSlug"; "name"; "image"; "imageInput"; "text";
    "reasoning"; "reasoningMandatory"; "structuredOutputs"; "reasoningEfforts"; "imageEndpoints"] json in
  { D.model_id = string (required f "id"); alias_target = optional string f "aliasTarget";
    canonical_slug = optional string f "canonicalSlug"; model_name = string (required f "name");
    generates_images = boolean (required f "image"); accepts_images = boolean (required f "imageInput");
    generates_text = boolean (required f "text"); reasoning = boolean (required f "reasoning");
    reasoning_mandatory = boolean (required f "reasoningMandatory");
    structured_outputs = optional boolean f "structuredOutputs";
    reasoning_efforts = optional (list effort) f "reasoningEfforts";
    image_endpoints = optional (list endpoint) f "imageEndpoints" }
let context json : D.context =
  let f = object_fields ["catalog"; "provider"] json in
  { D.catalog = list catalog_model (required f "catalog"); provider = provider (required f "provider") }
let initial json : D.initial =
  let f = object_fields ["draft"; "caseIdPrefix"] json in
  { D.initial_draft = draft (required f "draft"); case_id_prefix = string (required f "caseIdPrefix") }
let message_edit json =
  let tag = string (required (object_fields ["type"; "index"; "content"; "to"; "rememberedContent"; "images"; "imageIndex"] json) "type") in
  let fields keys = object_fields ("type" :: keys) json in
  match tag with
  | "content" -> let f = fields ["index"; "content"] in D.MessageContent (natural (required f "index"), string (required f "content"))
  | "insert" -> let f = fields ["index"] in D.InsertMessage (natural (required f "index"))
  | "remove" -> let f = fields ["index"] in D.RemoveMessage (natural (required f "index"))
  | "move" -> let f = fields ["index"; "to"] in D.MoveMessage (natural (required f "index"), natural (required f "to"))
  | "cycle-role" -> let f = fields ["index"; "rememberedContent"] in D.CycleRole (natural (required f "index"), optional string f "rememberedContent")
  | "append-images" -> let f = fields ["index"; "images"] in D.AppendMessageImages (natural (required f "index"), list reference (required f "images"))
  | "remove-image" -> let f = fields ["index"; "imageIndex"] in D.RemoveMessageImage (natural (required f "index"), natural (required f "imageIndex"))
  | "prompt-content" -> let f = fields ["content"] in D.PromptContent (string (required f "content"))
  | "prompt-append-images" -> let f = fields ["images"] in D.AppendPromptImages (list reference (required f "images"))
  | "prompt-remove-image" -> let f = fields ["imageIndex"] in D.RemovePromptImage (natural (required f "imageIndex"))
  | _ -> fail "unknown message edit"
let event json =
  let all_keys = ["type"; "parameter"; "value"; "values"; "side"; "index"; "to"; "source";
    "caseIndex"; "edit"; "name"; "enabled"; "format"; "provider"; "id"; "localId"; "image";
    "busy"; "accepted"; "continueWithLowBalance"; "gridId"; "message"; "balanceUsd"] in
  let tag = string (required (object_fields all_keys json) "type") in
  let fields keys = object_fields ("type" :: keys) json in
  let input action = D.InputAction action in
  match tag with
  | "common" -> let f = fields ["parameter"; "value"] in let p = common_parameter (required f "parameter") in input (D.SetCommon (value p (required f "value")))
  | "case-value" -> let f = fields ["parameter"; "value"; "side"; "index"] in let p = parameter (required f "parameter") in input (D.SetCaseValue (axis (required f "side"), natural (required f "index"), value p (required f "value")))
  | "case-values" -> let f = fields ["parameter"; "values"; "side"] in let p = scalar_parameter (required f "parameter") in input (D.SetCaseValues (p, axis (required f "side"), list (value p) (required f "values")))
  | "edit-input" ->
      let f = fields ["source"; "caseIndex"; "edit"] in
      let target = match string (required f "source") with
        | "common" -> if List.mem_assoc "caseIndex" f then fail "common input has no caseIndex"; D.CommonInput
        | ("rows" | "columns") as side -> D.CaseInput (axis (`String side), natural (required f "caseIndex"))
        | _ -> fail "unknown input target"
      in input (D.EditInput (target, message_edit (required f "edit")))
  | "to-axis" -> let f = fields ["parameter"; "side"] in input (D.MoveToAxis (common_parameter (required f "parameter"), axis (required f "side")))
  | "to-common" -> let f = fields ["parameter"] in input (D.MoveToCommon (common_parameter (required f "parameter")))
  | "dimension" -> let f = fields ["parameter"; "side"] in input (D.SelectDimension (axis (required f "side"), parameter (required f "parameter")))
  | "single" -> let f = fields ["side"] in input (D.SingleDimension (axis (required f "side")))
  | "add-case" -> let f = fields ["side"; "value"] in input (D.AddCase (axis (required f "side"), case_record (required f "value")))
  | "remove-case" -> let f = fields ["side"; "index"] in input (D.RemoveCase (axis (required f "side"), natural (required f "index")))
  | "move-case" -> let f = fields ["side"; "index"; "to"] in input (D.MoveCase (axis (required f "side"), natural (required f "index"), natural (required f "to")))
  | "add-variable" -> let f = fields ["side"] in input (D.AddVariable (axis (required f "side")))
  | "remove-variable" -> let f = fields ["side"; "index"] in input (D.RemoveVariable (axis (required f "side"), natural (required f "index")))
  | "rename-variable" -> let f = fields ["side"; "index"; "name"] in input (D.RenameVariable (axis (required f "side"), natural (required f "index"), string (required f "name")))
  | "rename-case" -> let f = fields ["side"; "index"; "name"] in input (D.RenameCase (axis (required f "side"), natural (required f "index"), string (required f "name")))
  | "swap" -> ignore (fields []); input D.SwapAxes
  | "judge" -> let f = fields ["enabled"] in input (D.SetJudging (boolean (required f "enabled")))
  | "format-selected" -> let f = fields ["format"] in D.SelectFormat (format (required f "format"))
  | "format-cleared" -> ignore (fields []); D.ClearFormat
  | "budget-changed" -> let f = fields ["value"] in D.ChangeBudget (string (required f "value"))
  | "reuse-artifacts-changed" -> let f = fields ["value"] in D.ChangeArtifactReuse (boolean (required f "value"))
  | "provider-observed" -> let f = fields ["provider"] in D.ObserveProvider (provider (required f "provider"))
  | "reference-uploaded" -> let f = fields ["id"; "localId"; "image"] in D.ReferenceUploaded (positive (required f "id"), string (required f "localId"), reference (required f "image"))
  | "upload-status-changed" -> let f = fields ["busy"] in D.UploadStatus (boolean (required f "busy"))
  | "confirmation-resolved" -> let f = fields ["id"; "accepted"] in D.ConfirmationResolved (positive (required f "id"), boolean (required f "accepted"))
  | "generate-requested" -> let f = fields ["continueWithLowBalance"] in D.GenerateRequested (boolean (required f "continueWithLowBalance"))
  | "references-prepared" -> let f = fields ["id"] in D.ReferencesPrepared (positive (required f "id"))
  | "submission-succeeded" -> let f = fields ["id"; "gridId"] in D.SubmissionSucceeded (positive (required f "id"), string (required f "gridId"))
  | "submission-failed" -> let f = fields ["id"; "message"; "balanceUsd"] in D.SubmissionFailed (positive (required f "id"), string (required f "message"), nullable finite (required f "balanceUsd"))
  | "completion-failed" -> let f = fields ["id"; "message"] in D.CompletionFailed (positive (required f "id"), string (required f "message"))
  | "low-balance-dismissed" -> ignore (fields []); D.DismissLowBalance
  | _ -> fail "unknown event"

let jstring value = `String value
let jbool value = `Bool value
let jnat value = `Intlit (Z.to_string value)
let jnumber value = if N.is_finite value then `Float (if value = 0. then 0. else value) else fail "nonfinite machine number"
let jlist encode values = `List (List.map encode values)
let jnullable encode = function None -> `Null | Some value -> encode value
let field key encode = function None -> [] | Some value -> [key, encode value]
let jformat = function D.Svg -> "svg" | D.Markdown -> "markdown" | D.Html -> "html" | D.ChatTemplate -> "chat-template" | D.Image -> "image"
let jaxis = function D.Rows -> "rows" | D.Columns -> "columns"
let jeffort = function D.DefaultEffort -> "default" | D.NoEffort -> "none" | D.MinimalEffort -> "minimal" | D.LowEffort -> "low" | D.MediumEffort -> "medium" | D.HighEffort -> "high" | D.ExtraHighEffort -> "xhigh" | D.MaxEffort -> "max"
let jrole = function D.SystemRole -> "system" | D.UserRole -> "user" | D.AssistantRole -> "assistant" | D.UnfilledRole -> "unfilled"
let jparameter = function
  | D.PInput -> "input" | D.PModel -> "model" | D.PEffort -> "effort" | D.PSize -> "size"
  | D.PAspectRatio -> "aspect_ratio" | D.PQuality -> "quality" | D.PBackground -> "background"
  | D.PJudgeModel -> "judge_model" | D.PJudgeEffort -> "judge_effort" | D.PJudgeCriteria -> "judge_criteria"
  | D.PJudgeSystem -> "judge_system" | D.PVariable -> "variable"
let jreference (image:D.reference_image) =
  `Assoc (["id", jstring image.D.reference_id; "name", jstring image.D.reference_name] @
    match image.D.reference_dimensions with None -> [] | Some d -> ["width", jnat d.D.width; "height", jnat d.D.height])
let jmessage (message:D.message) =
  `Assoc (["role", jstring (jrole message.D.message_role); "content", jstring message.D.content] @ field "images" (jlist jreference) message.D.images)
let jvariable (variable:D.variable_field) =
  `Assoc (["text", jstring variable.D.text] @ field "images" (jlist jreference) variable.D.field_images)
let jcriterion (criterion:D.criterion) =
  `Assoc ["text", jstring criterion.D.criterion_text; "correctAnswer", jbool criterion.D.correct_answer]
let jvalue = function
  | D.InputValue v -> jlist jmessage v | D.ModelValue v -> jstring v | D.EffortValue v -> jstring (jeffort v)
  | D.SizeValue v | D.AspectRatioValue v | D.QualityValue v | D.BackgroundValue v
  | D.JudgeModelValue v | D.JudgeSystemValue v -> jstring v
  | D.JudgeEffortValue v -> jstring (jeffort v) | D.JudgeCriteriaValue v -> jlist jcriterion v
  | D.VariableValue v -> jlist (jnullable jvariable) v
let jsource = function
  | D.Common v -> `Assoc ["kind", jstring "common"; "value", jvalue v]
  | D.OnAxis side -> `Assoc ["kind", jstring (jaxis side)]
let source_field (s:D.parameter_sources) = function
  | D.PInput -> Some s.D.input_source | D.PModel -> Some s.D.model_source
  | D.PEffort -> s.D.effort_source | D.PSize -> s.D.size_source | D.PAspectRatio -> s.D.aspect_ratio_source
  | D.PQuality -> s.D.quality_source | D.PBackground -> s.D.background_source
  | D.PJudgeModel -> s.D.judge_model_source | D.PJudgeEffort -> s.D.judge_effort_source
  | D.PJudgeCriteria -> s.D.judge_criteria_source | D.PJudgeSystem -> s.D.judge_system_source
  | D.PVariable -> fail "variable source in domain"
let jsources (s:D.parameter_sources) =
  `Assoc (List.concat_map (fun p -> field (jparameter p) jsource (source_field s p)) s.D.source_order)
let value_field (v:D.case_values) = function
  | D.PInput -> Option.map (fun x -> D.InputValue x) v.D.input_value
  | D.PModel -> Option.map (fun x -> D.ModelValue x) v.D.model_value
  | D.PEffort -> Option.map (fun x -> D.EffortValue x) v.D.effort_value
  | D.PSize -> Option.map (fun x -> D.SizeValue x) v.D.size_value
  | D.PAspectRatio -> Option.map (fun x -> D.AspectRatioValue x) v.D.aspect_ratio_value
  | D.PQuality -> Option.map (fun x -> D.QualityValue x) v.D.quality_value
  | D.PBackground -> Option.map (fun x -> D.BackgroundValue x) v.D.background_value
  | D.PJudgeModel -> Option.map (fun x -> D.JudgeModelValue x) v.D.judge_model_value
  | D.PJudgeEffort -> Option.map (fun x -> D.JudgeEffortValue x) v.D.judge_effort_value
  | D.PJudgeCriteria -> Option.map (fun x -> D.JudgeCriteriaValue x) v.D.judge_criteria_value
  | D.PJudgeSystem -> Option.map (fun x -> D.JudgeSystemValue x) v.D.judge_system_value
  | D.PVariable -> Option.map (fun x -> D.VariableValue x) v.D.variable_value
let jcase (c:D.case_record) =
  `Assoc (["id", jstring c.D.case_id] @ field "name" jstring c.D.case_name @
    List.concat_map (fun p -> field (jparameter p) jvalue (value_field c.D.values p)) c.D.values.D.value_order)
let jvariable_names (names:D.variable_names) =
  `Assoc (field "rows" (jlist (jnullable jstring)) names.D.row_names @ field "columns" (jlist (jnullable jstring)) names.D.column_names)
let jlayout (g:D.layout) budget =
  let axes = match g.D.case_ownership with D.NoCaseAxes -> [] | D.OneCaseAxis side -> [side]
    | D.BothCaseAxes D.Rows -> [D.Rows; D.Columns] | D.BothCaseAxes D.Columns -> [D.Columns; D.Rows]
  in `Assoc (["inputVersion", `Int 3; "format", jstring (jformat g.D.output_format);
    "caseAxes", jlist (fun side -> jstring (jaxis side)) axes; "rows", jlist jcase g.D.rows;
    "columns", jlist jcase g.D.columns; "parameters", jsources g.D.parameters;
    "judge", jbool g.D.judging; "budgetUsd", budget] @
    field "variableNames" jvariable_names g.D.variable_names @ field "parallelWorkers" jnat g.D.parallel_workers)
let jdraft (d:D.draft) =
  `Assoc (["formatSelected", jbool d.D.format_selected;
    "input", jlayout d.D.editable.D.draft_layout (jstring d.D.editable.D.budget_text)] @
    field "sourceGridId" jstring d.D.source_grid_id @ field "reuseArtifacts" jbool d.D.reuse_artifacts)
let jadmitted (input:D.admitted_input) = jlayout input.D.admitted_layout (jnumber input.D.budget_usd)
let jpath = function D.Property key -> jstring key | D.Index index -> jnat index
let jvalidation (issue:D.validation_issue) = `Assoc ["message", jstring issue.D.issue_message; "path", jlist jpath issue.D.issue_path]
let jorigin (origin:D.origin) =
  let source = match origin.D.origin_source with D.CommonOrigin -> "common" | D.AxisOrigin side -> jaxis side in
  `Assoc (["parameter", jstring (jparameter origin.D.origin_parameter); "source", jstring source] @
    field "caseIndex" jnat origin.D.case_index @ field "fieldIndex" jnat origin.D.field_index @ field "messageIndex" jnat origin.D.message_index)
let jcompatibility (issue:D.compatibility_issue) =
  `Assoc ["row", jnat issue.D.issue_row; "column", jnat issue.D.issue_column;
    "parameters", jlist (fun p -> jstring (jparameter p)) issue.D.issue_parameters;
    "origins", jlist jorigin issue.D.origins;
    "support", jstring (match issue.D.support with D.Unsupported -> "unsupported" | D.UnknownSupport -> "unknown");
    "blocking", jbool issue.D.blocking; "reason", jstring issue.D.reason]
let jimage_settings (settings:D.image_settings) =
  `Assoc (field "size" jstring settings.D.image_size @ field "aspect_ratio" jstring settings.D.image_aspect_ratio @
    field "quality" jstring settings.D.image_quality @ field "background" jstring settings.D.image_background @
    field "input_references" (jlist jstring) settings.D.input_references)
let jjudge (judge:D.judge_preview) =
  `Assoc (["model", jstring judge.D.judge_model; "effort", jstring (jeffort judge.D.judge_effort);
    "status", jstring "pending"] @ field "criteria" (jlist jcriterion) judge.D.criteria)
let jcell (cell:D.preview_cell) =
  `Assoc (["row", jnat cell.D.cell_row; "column", jnat cell.D.cell_column;
    "model", jstring cell.D.cell_model; "effort", jstring (jeffort cell.D.cell_effort);
    "prompt", jstring cell.D.prompt; "budgetUsd", jnullable jnumber cell.D.preview_budget;
    "status", jstring "pending"] @ field "messages" (jlist jmessage) cell.D.messages @
    field "imageSettings" jimage_settings cell.D.image_settings @ field "judge" jjudge cell.D.judge)
let jview (view:D.view) =
  let decision = view.D.policy.D.decision in
  `Assoc ["draft", jdraft view.D.view_draft; "attempted", jbool view.D.attempted;
    "pendingUploads", jnat view.D.pending_uploads; "error", jstring view.D.error;
    "lowBalance", jnullable jnumber view.D.low_balance;
    "submissionPhase", jstring (match view.D.submission_phase with D.Idle -> "idle" | D.Preparing -> "preparing" | D.Submitting -> "submitting" | D.Completed -> "completed");
    "validationIssues", jlist jvalidation view.D.policy.D.validation_issues;
    "compatibilityIssues", jlist jcompatibility view.D.policy.D.compatibility_issues;
    "compatibilityCells", jlist jcell view.D.policy.D.compatibility_cells;
    "eligibility", `Assoc ["canAttempt", jbool (D.can_attempt decision); "canSubmit", jbool (D.can_submit decision);
      "reasons", jlist jstring (D.decision_reasons decision); "parallelWorkers", jnullable jnat view.D.policy.D.selected_workers]]
let jcommand = function
  | D.PersistDraft draft -> `Assoc ["type", jstring "persist-draft"; "draft", jdraft draft]
  | D.Confirm (id, message) -> `Assoc ["type", jstring "confirm"; "id", jnat id; "message", jstring message]
  | D.PrepareReferences (id, input) -> `Assoc ["type", jstring "prepare-references"; "id", jnat id; "input", jadmitted input]
  | D.SubmitGrid (id, input, source, reuse, continue) ->
      `Assoc (["type", jstring "submit-grid"; "id", jnat id; "input", jadmitted input;
        "reuseArtifacts", jbool reuse; "continueWithLowBalance", jbool continue] @ field "sourceGridId" jstring source)
  | D.CreationCompleted (id, grid_id) -> `Assoc ["type", jstring "creation-completed"; "id", jnat id; "gridId", jstring grid_id]
  | D.NavigateHome -> `Assoc ["type", jstring "navigate-home"]
  | D.RemoveReferenceFile id -> `Assoc ["type", jstring "remove-reference-file"; "localId", jstring id]
let joutput (output:D.output) =
  `Assoc ["outcome", `Assoc ["stateChanged", jbool (D.state_changed output.D.change); "draftChanged", jbool (D.draft_changed output.D.change)];
    "commands", jlist jcommand output.D.commands]
let read_json decode value =
  let json = try Yojson.Safe.from_string (Js.to_string value)
    with Yojson.Json_error message -> fail message in
  decode json
let write_json value = Js.string (Yojson.Safe.to_string value)
let init initial_json context_json =
  let initial = read_json initial initial_json in
  let context = read_json context context_json in
  Js.Unsafe.inject (M.init initial context)
let update state event_json =
  let event = read_json event event_json in
  let next, output = M.update (Obj.magic state) event in
  Js.Unsafe.obj [|"state", Js.Unsafe.inject next; "output", Js.Unsafe.inject (write_json (joutput output))|]
let view state = write_json (jview (M.view (Obj.magic state)))
let () = Js.export "creationMachine" (Js.Unsafe.obj [|
  "init", Js.Unsafe.inject (Js.wrap_callback init);
  "update", Js.Unsafe.inject (Js.wrap_callback update);
  "view", Js.Unsafe.inject (Js.wrap_callback view)
|])
