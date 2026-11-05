module Slopgrid.PolicyVariables

(* Resolve templates for a row-column configuration, not for an axis in
   isolation. Complete generator inputs and judge rubrics can each read fields
   from either axis. PRODUCT.md 3.3.2 and 3.8.9. *)

module Domain = Slopgrid.Domain
open Slopgrid.Domain
module List = FStar.List.Tot.Base
open FStar.List.Tot.Base
module Native = Slopgrid.Native
module Number = Slopgrid.Number
module Parameters = Slopgrid.Parameters
module Input = Slopgrid.Input
module PolicyBase = Slopgrid.PolicyBase

let variable_name = Input.variable_name

let variable_index = Input.variable_index

let tokens = Input.variable_tokens

let rec find_slot (name: string) (index: list (string & Domain.axis & nat))
  : Tot (option (Domain.axis & nat)) (decreases index) =
  match index with
  | [] -> None
  | (n, s, i) :: rest -> if n = name then Some (s, i) else find_slot name rest

let fields (record: option Domain.case_record)
  : Tot (option (list (option Domain.variable_field))) =
  match record with
  | None -> None
  | Some r -> r.values.variable_value

let field_for (g: Domain.layout) (side: Domain.axis) (field: nat) (row: nat) (column: nat)
  : Tot (option Domain.variable_field) =
  match PolicyBase.at
    (PolicyBase.option_list
      (fields (PolicyBase.at (PolicyBase.records g side)
        (if side = Domain.Rows then row else column))))
    field with
  | None -> None
  | Some f -> f

let resolve (g: Domain.layout) (name: string) (row: nat) (column: nat)
  : Tot (option Domain.variable_field) =
  match find_slot name (variable_index g) with
  | None -> None
  | Some (s, i) -> field_for g s i row column

(* An image referenced twice still appears once in the receiving message.
   Compare reference IDs and keep the first occurrence's attachment record.
   This does not inspect image bytes or store uploads. PRODUCT.md 3.3.4. *)
let merge_images (groups: list (list Domain.reference_image)) : Tot (list Domain.reference_image) =
  let rec loop (xs: list Domain.reference_image) (seen: list string)
    : Tot (list Domain.reference_image) (decreases xs) =
    match xs with
    | [] -> []
    | h :: t ->
      if PolicyBase.member h.reference_id seen then loop t seen
      else h :: loop t (h.reference_id :: seen)
  in
  loop (List.flatten groups) []

type reference = {
  field: Domain.variable_field;
  side: Domain.axis;
  record_index: nat;
  field_index: nat
}

let reference_path (r: reference) : Tot (list Domain.path_segment) =
  [Domain.Property (PolicyBase.axis_key r.side); Domain.Index r.record_index;
   Domain.Property "variable"; Domain.Index r.field_index]

let references (text: string) (g: Domain.layout) (row: nat) (column: nat)
  : Tot (list reference) =
  PolicyBase.unique
    (PolicyBase.flatmap
      (fun name ->
        match find_slot name (variable_index g) with
        | None -> []
        | Some (s, i) ->
          match field_for g s i row column with
          | None -> []
          | Some f ->
            [{
              field = f;
              side = s;
              record_index = (if s = Domain.Rows then row else column);
              field_index = i
            }])
      (tokens text))

(* Scan only the original template. Insert field text literally and never scan
   that inserted text for another variable. Leave unknown tokens visible here.
   prompt_issues rejects them separately. PRODUCT.md 3.3.4. *)
let interpolate (text: string) (g: Domain.layout) (row: nat) (column: nat)
  : Tot (string & list Domain.reference_image) =
  let rec expand (fuel: nat) (offset: nat) : Tot string (decreases fuel) =
    if fuel = 0 || offset >= Native.length text then ""
    else
      match Input.token_at text offset with
      | None -> PolicyBase.cat (Native.char_at text offset) (expand (fuel - 1) (offset + 1))
      | Some (name, count) ->
        PolicyBase.cat
          (match resolve g name row column with
           | None -> PolicyBase.cat "$" name
           | Some f -> f.text)
          (expand (fuel - 1) (offset + (if count = 0 then 1 else count)))
  in
  (expand (Native.length text) 0,
   merge_images
     (List.map (fun r -> PolicyBase.option_list r.field.field_images)
       (references text g row column)))

(* Select this cell's complete history before expanding each message.
   Field images join only their referencing user message. Judge-only fields
   never enter this generator history. PRODUCT.md 3.3.5 and 3.3.9. *)
let expand_messages (g: Domain.layout) (row: nat) (column: nat) : Tot (list Domain.message) =
  List.map
    (fun message ->
      let text, images = interpolate message.Domain.content g row column in
      let merged =
        merge_images
          [PolicyBase.option_list message.images;
           if message.message_role = Domain.UserRole then images else []]
      in
      {message with
        content = text;
        images = (if merged = [] then message.images else Some merged)
      })
    (PolicyBase.messages g row column)

(* Resolve the selected rubric separately from the generator history.
   Preserve each question's expected answer while gathering the images that
   this cell's judge consumes. PRODUCT.md 3.3.5 and 3.8.9. *)
let resolve_criteria (g: Domain.layout) (row: nat) (column: nat)
  : Tot (list Domain.criterion & list Domain.reference_image) =
  let expanded =
    List.map
      (fun criterion ->
        let text, images = interpolate criterion.Domain.criterion_text g row column in
        ({criterion with criterion_text = text}, images))
      (PolicyBase.criteria g row column)
  in
  (List.map (fun (c, _) -> c) expanded,
   merge_images (List.map (fun (_, images) -> images) expanded))

let names (g: Domain.layout) (side: Domain.axis) : Tot (list (option string)) =
  match g.variable_names with
  | None -> []
  | Some ns ->
    PolicyBase.option_list (if side = Domain.Rows then ns.row_names else ns.column_names)

let name_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  let invalid =
    PolicyBase.flatmap
      (fun side ->
        PolicyBase.flatmap
          (fun (index, name) ->
            match name with
            | None -> []
            | Some n ->
              if n <> "" && PolicyBase.all_chars n "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" then []
              else
                [PolicyBase.issue "Variable names must contain only A-Z, digits, or underscore."
                  [Domain.Property "variableNames"; Domain.Property (PolicyBase.axis_key side);
                   Domain.Index index]])
          (PolicyBase.indexed (names g side)))
      PolicyBase.sides
  in
  let slots =
    PolicyBase.flatmap
      (fun side ->
        if not (Parameters.is_case_axis g side) then []
        else
          PolicyBase.flatmap
            (fun (i, field) ->
              match field with
              | None -> []
              | Some _ -> [(variable_name g side i, side, i)])
            (PolicyBase.indexed
              (PolicyBase.option_list (fields (PolicyBase.at (PolicyBase.records g side) 0)))))
      PolicyBase.sides
  in
  invalid @
  PolicyBase.flatmap
    (fun name ->
      let matching = List.filter (fun (n, _, _) -> n = name) slots in
      if List.length matching < 2 then []
      else
        List.map
          (fun (_, side, index) ->
            PolicyBase.issue (PolicyBase.cat (PolicyBase.cat "Variable name " name) " is already in use.")
              [Domain.Property "variableNames"; Domain.Property (PolicyBase.axis_key side);
               Domain.Index index])
          matching)
    (PolicyBase.unique (List.map (fun (name, _, _) -> name) slots))

let active (#a: Type) (v: option a) : Tot bool =
  match v with
  | None -> false
  | Some _ -> true

(* Cases on one axis share field positions, including deleted slots.
   Compare the active slots as well as list lengths so a field cannot silently
   refer to a different column of the case editor in another case. *)
let shape_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  PolicyBase.flatmap
    (fun side ->
      if not (Parameters.axis_has_variables g side) then []
      else
        let first = fields (PolicyBase.at (PolicyBase.records g side) 0) in
        PolicyBase.flatmap
          (fun (case_index, record) ->
            let variable = record.Domain.values.variable_value in
            let path =
              [Domain.Property (PolicyBase.axis_key side); Domain.Index case_index;
               Domain.Property "variable"]
            in
            let msg = "Variable values must have the same active fields." in
            (if not (active first) || not (active variable) ||
               List.length (PolicyBase.option_list variable) <>
                 List.length (PolicyBase.option_list first) then
               [PolicyBase.issue msg path]
             else []) @
            (match first, variable with
             | Some fs, Some vs ->
               PolicyBase.flatmap
                 (fun (field_index, field) ->
                   let original =
                     match PolicyBase.at fs field_index with
                     | None -> None
                     | Some f -> f
                   in
                   if active field = (field_index >= List.length fs || active original) then []
                   else [PolicyBase.issue msg (path @ [Domain.Index field_index])])
                 (PolicyBase.indexed vs)
             | _ -> []))
          (PolicyBase.indexed (PolicyBase.records g side)))
    PolicyBase.sides

type template = {
  template_text: string;
  template_role: Domain.role;
  template_path: list Domain.path_segment
}

(* Keep each template's owning field path before inspecting its tokens.
   Treat criterion questions as user text for image references, but reject
   image-bearing references in judge system text. PRODUCT.md 3.4.2 and 3.7.3. *)
let templates (g: Domain.layout) (row: nat) (column: nat) : Tot (list template) =
  let generator =
    PolicyBase.mapi
      (fun index message ->
        {
          template_text = message.Domain.content;
          template_role = message.message_role;
          template_path =
            PolicyBase.value_path g Domain.PInput row column @
            [Domain.Index index; Domain.Property "content"]
        })
      (PolicyBase.messages g row column)
  in
  generator @
  (if not g.judging then []
   else
     [{
       template_text = PolicyBase.text g Domain.PJudgeSystem row column;
       template_role = Domain.SystemRole;
       template_path = PolicyBase.value_path g Domain.PJudgeSystem row column
     }] @
     PolicyBase.mapi
       (fun index criterion ->
         {
           template_text = criterion.Domain.criterion_text;
           template_role = Domain.UserRole;
           template_path =
             PolicyBase.value_path g Domain.PJudgeCriteria row column @
             [Domain.Index index; Domain.Property "text"]
         })
       (PolicyBase.criteria g row column))

(* An unfinished model axis still needs token feedback for the existing input.
   Index zero here is only an editing fallback. expand_grid below enumerates
   records actually present in the layout. *)
let preview_indices (g: Domain.layout) (side: Domain.axis) : Tot (list nat) =
  match PolicyBase.records g side with
  | [] -> [0]
  | rs -> PolicyBase.mapi (fun i _ -> i) rs

let cell_templates (g: Domain.layout) : Tot (list (nat & nat & template)) =
  PolicyBase.flatmap
    (fun row ->
      PolicyBase.flatmap
        (fun column -> List.map (fun t -> (row, column, t)) (templates g row column))
        (preview_indices g Domain.Columns))
    (preview_indices g Domain.Rows)

(* Check a reference where its template is used, against both cases at that
   coordinate. A field name present elsewhere is not enough if this case lacks
   its value. Unknown and deleted references block admission. PRODUCT.md 3.3.6. *)
let prompt_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  let index = variable_index g in
  let used_and_issues =
    PolicyBase.flatmap
      (fun (row, column, t) ->
        PolicyBase.flatmap
          (fun name ->
            let unknown =
              PolicyBase.issue (PolicyBase.cat "Unknown prompt variable $" name) t.template_path
            in
            match find_slot name index with
            | None -> [(None, Some unknown)]
            | Some (side, field_index) ->
              match field_for g side field_index row column with
              | None -> [(None, Some unknown)]
              | Some field ->
                (Some side, None) ::
                (if t.template_role = Domain.UserRole ||
                   PolicyBase.option_list field.field_images = [] then []
                 else
                   let msg = "Variable images can only be attached to user messages." in
                   [(None, Some (PolicyBase.issue msg t.template_path));
                    (None, Some (PolicyBase.issue msg
                      [Domain.Property (PolicyBase.axis_key side);
                       Domain.Index (if side = Domain.Rows then row else column);
                       Domain.Property "variable"; Domain.Index field_index;
                       Domain.Property "images"]))]))
          (tokens t.template_text))
      (cell_templates g)
  in
  let used =
    PolicyBase.flatmap
      (fun (side, _) ->
        match side with
        | None -> []
        | Some s -> [s])
      used_and_issues
  in
  let token_issues =
    PolicyBase.flatmap
      (fun (_, issue) ->
        match issue with
        | None -> []
        | Some i -> [i])
      used_and_issues
  in
  (* A case dimension must affect generator or judge input. Owning a consumed
     parameter counts without a dummy variable. Otherwise a referenced field
     makes the dimension meaningful. Unused extra fields are allowed.
     PRODUCT.md 3.3.6. *)
  let unused =
    PolicyBase.flatmap
      (fun side ->
        if List.existsb (fun kind -> kind <> Domain.PVariable) (Parameters.axis_parameters g side) ||
          PolicyBase.member side used then []
        else
          let records = PolicyBase.records g side in
          let active_fields =
            List.filter (fun (_, f) -> active f)
              (PolicyBase.indexed (PolicyBase.option_list (fields (PolicyBase.at records 0))))
          in
          match active_fields with
          | (field_index, _) :: _ ->
            let msg =
              PolicyBase.cat (PolicyBase.cat "$" (variable_name g side field_index))
                " is not used anywhere"
            in
            PolicyBase.flatmap
              (fun (case_index, _) ->
                if not (active (field_for g side field_index case_index case_index)) then []
                else
                  [PolicyBase.issue msg
                    [Domain.Property (PolicyBase.axis_key side); Domain.Index case_index;
                     Domain.Property "variable"; Domain.Index field_index; Domain.Property "text"]])
              (PolicyBase.indexed records)
          | [] ->
            if records = [] then
              [PolicyBase.issue
                (PolicyBase.cat
                  (PolicyBase.cat "Add at least one " (if side = Domain.Rows then "row" else "column"))
                  " case.")
                [Domain.Property (PolicyBase.axis_key side)]]
            else if Parameters.axis_parameters g side = [] ||
              not (List.existsb
                (fun kind ->
                  kind <> Domain.PVariable ||
                  List.existsb
                    (fun r -> List.existsb active (PolicyBase.option_list r.Domain.values.variable_value))
                    records)
                (Parameters.axis_parameters g side)) then
              [PolicyBase.issue "Add a variable or click \"define multiple cases\" for a parameter."
                [Domain.Property (PolicyBase.axis_key side)]]
            else [])
      (PolicyBase.case_axes g)
  in
  name_issues g @ shape_issues g @ token_issues @ unused

let image_setting (g: Domain.layout) (p: Domain.parameter) (r: nat) (c: nat)
  : Tot (option string) =
  match PolicyBase.value g p r c with
  | None -> None
  | Some v -> Some (PolicyBase.text_value v)

(* Build the inputs used by compatibility checks for this coordinate.
   The joined Chat text is a preview. The ordered expanded messages retain
   roles and per-message attachments for the actual checks. PRODUCT.md 3.4.1. *)
let expand_cell (g: Domain.layout) (budget: option Number.finite) (row: nat) (column: nat)
  : Tot Domain.preview_cell =
  let messages = expand_messages g row column in
  let first = PolicyBase.at messages 0 in
  let prompt =
    if g.output_format = Domain.ChatTemplate then
      PolicyBase.join "\n\n"
        (List.map
          (fun m -> PolicyBase.cat (PolicyBase.cat (PolicyBase.role_key m.Domain.message_role) ": ") m.content)
          messages)
    else
      match first with
      | None -> ""
      | Some m -> m.content
  in
  let settings = {
    Domain.image_size = image_setting g Domain.PSize row column;
    image_aspect_ratio = image_setting g Domain.PAspectRatio row column;
    image_quality = image_setting g Domain.PQuality row column;
    image_background = image_setting g Domain.PBackground row column;
    input_references =
      (match first with
       | None -> None
       | Some m ->
         match m.images with
         | None -> None
         | Some images -> Some (List.map (fun i -> i.Domain.reference_id) images))
  } in
  {
    Domain.cell_row = row;
    cell_column = column;
    cell_model = PolicyBase.text g Domain.PModel row column;
    cell_effort = PolicyBase.effort g Domain.PEffort row column;
    prompt = prompt;
    messages = Some messages;
    preview_budget = budget;
    image_settings =
      (if g.output_format = Domain.Image then Some (PolicyBase.normalize_settings settings)
       else None);
    judge =
      (if not g.judging then None
       else Some {
         Domain.judge_model = PolicyBase.text g Domain.PJudgeModel row column;
         judge_effort = PolicyBase.effort g Domain.PJudgeEffort row column;
         criteria = None
       })
  }

(* Enumerate only existing row-column intersections, not every model paired
   with every value found somewhere in the form. PRODUCT.md 3.4.2. *)
let expand_grid (g: Domain.layout) (budget: option Number.finite)
  : Tot (list Domain.preview_cell) =
  PolicyBase.flatmap
    (fun (row, _) ->
      List.map (fun (column, _) -> expand_cell g budget row column) (PolicyBase.indexed g.columns))
    (PolicyBase.indexed g.rows)
