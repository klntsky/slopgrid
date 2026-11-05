module Slopgrid.CellSemantics

module Domain = Slopgrid.Domain
open Slopgrid.Domain

(* Describe which stored setting a cell should read before variable expansion.
   Keep this description separate from the getters used by the form. Otherwise
   the same lookup bug could appear on both sides of an ownership proof.
   PRODUCT.md 3.1.10 and 3.3.9. *)

let source_for (sources: parameter_sources) (p: common_parameter)
  : Tot (option (source p)) =
  match p with
  | PInput -> Some sources.input_source
  | PModel -> Some sources.model_source
  | PEffort -> sources.effort_source
  | PSize -> sources.size_source
  | PAspectRatio -> sources.aspect_ratio_source
  | PQuality -> sources.quality_source
  | PBackground -> sources.background_source
  | PJudgeModel -> sources.judge_model_source
  | PJudgeEffort -> sources.judge_effort_source
  | PJudgeCriteria -> sources.judge_criteria_source
  | PJudgeSystem -> sources.judge_system_source

let case_value (values: case_values) (p: parameter) : Tot (option (value_for p)) =
  match p with
  | PInput ->
    (match values.input_value with
     | None -> None
     | Some v -> Some (InputValue v))
  | PModel ->
    (match values.model_value with
     | None -> None
     | Some v -> Some (ModelValue v))
  | PEffort ->
    (match values.effort_value with
     | None -> None
     | Some v -> Some (EffortValue v))
  | PSize ->
    (match values.size_value with
     | None -> None
     | Some v -> Some (SizeValue v))
  | PAspectRatio ->
    (match values.aspect_ratio_value with
     | None -> None
     | Some v -> Some (AspectRatioValue v))
  | PQuality ->
    (match values.quality_value with
     | None -> None
     | Some v -> Some (QualityValue v))
  | PBackground ->
    (match values.background_value with
     | None -> None
     | Some v -> Some (BackgroundValue v))
  | PJudgeModel ->
    (match values.judge_model_value with
     | None -> None
     | Some v -> Some (JudgeModelValue v))
  | PJudgeEffort ->
    (match values.judge_effort_value with
     | None -> None
     | Some v -> Some (JudgeEffortValue v))
  | PJudgeCriteria ->
    (match values.judge_criteria_value with
     | None -> None
     | Some v -> Some (JudgeCriteriaValue v))
  | PJudgeSystem ->
    (match values.judge_system_value with
     | None -> None
     | Some v -> Some (JudgeSystemValue v))
  | PVariable ->
    (match values.variable_value with
     | None -> None
     | Some v -> Some (VariableValue v))

let rec entry_at (entries: list case_record) (index: nat) : Tot (option case_record) =
  match entries with
  | [] -> None
  | entry :: rest ->
    if index = 0 then Some entry else entry_at rest (index - 1)

let axis_entries (layout: layout) (side: axis) : Tot (list case_record) =
  match side with
  | Rows -> layout.rows
  | Columns -> layout.columns

(* Pick one row or column case, then read its setting. A missing case or value
   stays missing. Do not borrow a value from another case or from the old
   shared control. PRODUCT.md 3.3.9 and 3.8.9. *)

let axis_value (layout: layout) (side: axis) (index: nat) (p: parameter)
  : Tot (option (value_for p)) =
  match entry_at (axis_entries layout side) index with
  | None -> None
  | Some entry -> case_value entry.values p

(* A shared prompt is the same stored value for every cell. A row-owned prompt
   comes from that row, and a column-owned prompt comes from that column.
   Expansion happens later, so any of those prompts may still refer to
   variable fields on both axes. PRODUCT.md 3.3.9. *)

let resolve (layout: layout) (row: nat) (column: nat) (p: common_parameter)
  : Tot (option (value_for p)) =
  match source_for layout.parameters p with
  | None -> None
  | Some (Common value) -> Some value
  | Some (OnAxis Rows) -> axis_value layout Rows row p
  | Some (OnAxis Columns) -> axis_value layout Columns column p

(* No image list and an empty image list both mean no attachments. Use that
   meaning when deciding whether case inputs agree before returning them to
   the shared prompt. PRODUCT.md 3.3.9. *)

let normalize_images (images: option (list reference_image)) : Tot (list reference_image) =
  match images with
  | None -> []
  | Some images -> images

let normalize_messages (messages: list message) : Tot (list message) =
  FStar.List.Tot.Base.map
    (fun message ->
      let images = normalize_images message.images in
      { message with images = if images = [] then None else Some images })
    messages

let normalize_fields (fields: list (option variable_field))
  : Tot (list (option variable_field)) =
  FStar.List.Tot.Base.map
    (fun field ->
      match field with
      | None -> None
      | Some field ->
        let images = normalize_images field.field_images in
        Some { field with field_images = if images = [] then None else Some images })
    fields

let canonical_value (value: value) : Tot (value_for (value_parameter value)) =
  match value with
  | InputValue messages -> InputValue (normalize_messages messages)
  | VariableValue fields -> VariableValue (normalize_fields fields)
  | other -> other

(* Compare complete input values after removing empty image-list differences.
   This does not ignore different text, message roles, or real attachments.
   A loss-free return to a shared value needs this agreement in every case.
   PRODUCT.md 3.1.10 and 3.3.9. *)

let equivalent (p: parameter) (left: option (value_for p)) (right: option (value_for p))
  : Tot bool =
  match left, right with
  | None, None -> true
  | Some left, Some right -> canonical_value left = canonical_value right
  | _ -> false
