module Slopgrid.CellMeaning

module CellSemantics = Slopgrid.CellSemantics
module VariableSemantics = Slopgrid.VariableSemantics
module Template = Slopgrid.Template
module Native = Slopgrid.Native
module List = FStar.List.Tot.Base
open Slopgrid.Domain

type environment = Template.identifier -> GTot (option variable_field)

type text_meaning = {
  expanded_bytes: list Native.byte;
  ordered_fields: list (option variable_field)
}

type message_meaning = {
  effective_role: role;
  effective_content: text_meaning;
  attached_images: list reference_image;
  effective_images: list reference_image
}

type criterion_meaning = {
  effective_criterion: text_meaning;
  expected_answer: bool;
  criterion_images: list reference_image
}

type parameter_meaning =
  | GeneratorMeaning : list message_meaning -> parameter_meaning
  | CriteriaMeaning : list criterion_meaning -> parameter_meaning
  | SystemMeaning : text_meaning -> list reference_image -> parameter_meaning
  | ScalarMeaning : value -> parameter_meaning

type cell_meaning = {
  cell_format: format;
  cell_judging: bool;
  cell_parallel_workers: option pos;
  cell_parameters: list (common_parameter & option parameter_meaning)
}

let field_bytes (env: environment) (name: Template.identifier) : GTot (list Native.byte) =
  match env name with
  | None -> []
  | Some field -> Native.byte_view field.text

let text (env: environment) (content: string) : GTot text_meaning = {
  expanded_bytes =
    Template.expand_template (field_bytes env) (Template.split_dollar (Native.byte_view content));
  ordered_fields = Template.resolve_template env (Template.split_dollar (Native.byte_view content))
}

let rec reference_images (fields: list (option variable_field)) : Tot (list reference_image) =
  match fields with
  | [] -> []
  | field :: rest ->
    List.append
      (match field with
       | None -> []
       | Some field -> CellSemantics.normalize_images field.field_images)
      (reference_images rest)

let rec deduplicate_images (images: list reference_image) (seen: list string)
  : Tot (list reference_image) =
  match images with
  | [] -> []
  | image :: rest ->
    if List.mem image.reference_id seen
    then deduplicate_images rest seen
    else image :: deduplicate_images rest (image.reference_id :: seen)

let images (meaning: text_meaning) : Tot (list reference_image) =
  deduplicate_images (reference_images meaning.ordered_fields) []

let text_resolved (meaning: text_meaning) : Tot bool =
  List.for_all (fun field -> field <> None) meaning.ordered_fields

let resolved_text (meaning: text_meaning) : Tot (option (list Native.byte)) =
  if text_resolved meaning then Some meaning.expanded_bytes else None

let message (env: environment) (message: message) : GTot message_meaning =
  let meaning = text env message.content in
  {
    effective_role = message.message_role;
    effective_content = meaning;
    attached_images = CellSemantics.normalize_images message.images;
    effective_images = deduplicate_images
      (List.append (CellSemantics.normalize_images message.images)
        (if message.message_role = UserRole
         then reference_images meaning.ordered_fields
         else []))
      []
  }

let criterion (env: environment) (criterion: criterion) : GTot criterion_meaning =
  let meaning = text env criterion.criterion_text in
  {
    effective_criterion = meaning;
    expected_answer = criterion.correct_answer;
    criterion_images = images meaning
  }

let value (env: environment) (value: value) : GTot parameter_meaning =
  match value with
  | InputValue messages -> GeneratorMeaning (Template.map_g (message env) messages)
  | JudgeCriteriaValue criteria -> CriteriaMeaning (Template.map_g (criterion env) criteria)
  | JudgeSystemValue content ->
    let meaning = text env content in
    SystemMeaning meaning (images meaning)
  | scalar -> ScalarMeaning scalar

let parameter (input: layout) (row: nat) (column: nat) (p: common_parameter)
  : GTot (option parameter_meaning) =
  match CellSemantics.resolve input row column p with
  | None -> None
  | Some resolved -> Some (value (VariableSemantics.field_for input row column) resolved)

let all_parameters : list common_parameter = [
  PInput; PModel; PEffort; PSize; PAspectRatio; PQuality; PBackground;
  PJudgeModel; PJudgeEffort; PJudgeSystem; PJudgeCriteria
]

let cell (input: layout) (row: nat) (column: nat) : GTot cell_meaning = {
  cell_format = input.output_format;
  cell_judging = input.judging;
  cell_parallel_workers = input.parallel_workers;
  cell_parameters = Template.map_g (fun p -> (p, parameter input row column p)) all_parameters
}

let message_templates_valid (meaning: message_meaning) : Tot bool =
  text_resolved meaning.effective_content &&
  (meaning.effective_role = UserRole ||
    reference_images meaning.effective_content.ordered_fields = [])

let parameter_templates_valid (meaning: parameter_meaning) : Tot bool =
  match meaning with
  | GeneratorMeaning messages -> List.for_all message_templates_valid messages
  | CriteriaMeaning criteria ->
    List.for_all (fun criterion -> text_resolved criterion.effective_criterion) criteria
  | SystemMeaning system images -> text_resolved system && images = []
  | ScalarMeaning _ -> true

let templates_valid (meaning: cell_meaning) : Tot bool =
  List.for_all
    (fun ((p, value): (common_parameter & option parameter_meaning)) ->
      if not meaning.cell_judging &&
        (p = PJudgeModel || p = PJudgeEffort || p = PJudgeSystem || p = PJudgeCriteria)
      then true
      else
        match value with
        | None -> true
        | Some value -> parameter_templates_valid value)
    meaning.cell_parameters

let observable_cell (input: layout) (row: nat) (column: nat) : GTot (option cell_meaning) =
  let meaning = cell input row column in
  if templates_valid meaning then Some meaning else None
