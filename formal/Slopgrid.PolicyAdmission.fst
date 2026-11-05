module Slopgrid.PolicyAdmission

(* Admission checks editable form data before it can become a submission.
   Check ownership and raw history structure first, then validate every cell's
   expanded generator input and selected rubric. No inference runs here.
   PRODUCT.md 3.3.6 and 3.4.1. *)

module Domain = Slopgrid.Domain
open Slopgrid.Domain
module List = FStar.List.Tot.Base
open FStar.List.Tot.Base
module Native = Slopgrid.Native
module Number = Slopgrid.Number
module Parameters = Slopgrid.Parameters
module PolicyBase = Slopgrid.PolicyBase
module PolicyVariables = Slopgrid.PolicyVariables

(* An empty ordinary model selection can remain quiet until Generate is tried.
   It still prevents a ready submission. Deferral affects when feedback appears,
   not whether the missing selection is acceptable. *)
let deferred_issue (message: string) (path: list Domain.path_segment)
  : Tot Domain.validation_issue =
  {(PolicyBase.issue message path) with deferred = true}

(* A rubric belongs to the selected common, row, or column source.
   Require every selected rubric to have questions. The criterion type already
   carries each expected answer as a boolean. PRODUCT.md 3.8.5 and 3.8.6. *)
let criteria_issues (criteria: list Domain.criterion) : Tot (list Domain.validation_issue) =
  (if criteria = [] then [PolicyBase.issue "Add at least one criterion." []] else []) @
  PolicyBase.flatmap
    (fun (i, c) ->
      if PolicyBase.nonempty c.Domain.criterion_text then []
      else
        [PolicyBase.issue "Enter a yes-or-no question for each criterion."
          [Domain.Index i; Domain.Property "text"]])
    (PolicyBase.indexed criteria)

(* Validate the supplied history, not a conversation with generated answers.
   User messages may contain only images, but unfilled messages must stay empty
   and need a supplied message before the first blank. PRODUCT.md 1.1.3. *)
let chat_issues (messages: list Domain.message) : Tot (list Domain.validation_issue) =
  if messages = [] then [PolicyBase.issue "Add a message." []]
  else
    PolicyBase.flatmap
      (fun (i, m) ->
        if PolicyBase.option_list m.Domain.images <> [] && m.message_role <> Domain.UserRole then
          [PolicyBase.issue "Images can only be attached to user messages."
            [Domain.Index i; Domain.Property "images"]]
        else [])
      (PolicyBase.indexed messages) @
    PolicyBase.flatmap
      (fun (i, m) ->
        if m.Domain.message_role <> Domain.UnfilledRole && not (PolicyBase.nonempty m.content) &&
          not (m.message_role = Domain.UserRole && PolicyBase.option_list m.images <> []) then
          [PolicyBase.issue "Enter a message or attach an image."
            [Domain.Index i; Domain.Property "content"]]
        else [])
      (PolicyBase.indexed messages) @
    PolicyBase.flatmap
      (fun (i, m) ->
        if m.Domain.message_role = Domain.UnfilledRole && m.content <> "" then
          [PolicyBase.issue "Leave unfilled messages empty."
            [Domain.Index i; Domain.Property "content"]]
        else [])
      (PolicyBase.indexed messages) @
    (match PolicyBase.at messages 0 with
     | Some m ->
       if m.message_role = Domain.UnfilledRole then
         [PolicyBase.issue "Add a message before the first unfilled message."
           [Domain.Index 0; Domain.Property "role"]]
       else []
     | None -> [])

(* Local validators report paths within one input or rubric. Prefix the chosen
   owner's path without replacing message or question indices, so common and
   case-owned failures identify the same kind of field. PRODUCT.md 3.4.2. *)
let prepend (path: list Domain.path_segment) (item: Domain.validation_issue)
  : Tot Domain.validation_issue =
  {item with issue_path = path @ item.issue_path}

let trim_kinds =
  [Domain.PModel; Domain.PJudgeModel; Domain.PSize; Domain.PAspectRatio;
   Domain.PQuality; Domain.PBackground]

let trim_criteria (cs: list Domain.criterion) : Tot (list Domain.criterion) =
  List.map (fun c -> {c with Domain.criterion_text = Native.trim c.Domain.criterion_text}) cs

let normalize_value (v: Domain.value) : Tot (Domain.value_for (Domain.value_parameter v)) =
  match v with
  | Domain.ModelValue s -> Domain.ModelValue (Native.trim s)
  | Domain.JudgeModelValue s -> Domain.JudgeModelValue (Native.trim s)
  | Domain.SizeValue s -> Domain.SizeValue (Native.trim s)
  | Domain.AspectRatioValue s -> Domain.AspectRatioValue (Native.trim s)
  | Domain.QualityValue s -> Domain.QualityValue (Native.trim s)
  | Domain.BackgroundValue s -> Domain.BackgroundValue (Native.trim s)
  | _ -> v

(* Trim identifiers, setting labels, and criterion questions for admission.
   Leave prompt bodies and variable values alone: their whitespace is input
   text, not a label to clean up. PRODUCT.md 1.1.3. *)
let normalize (g: Domain.layout) : Tot Domain.layout =
  let parameters =
    List.fold_left
      (fun ps p ->
        match Parameters.get_source ps p with
        | Some (Domain.Common v) -> Parameters.set_source ps p (Domain.Common (normalize_value v))
        | _ -> ps)
      g.parameters Parameters.common_parameters
  in
  let parameters =
    if not g.judging then parameters
    else
      match parameters.judge_criteria_source with
      | Some (Domain.Common (Domain.JudgeCriteriaValue cs)) ->
        {parameters with
          judge_criteria_source = Some (Domain.Common (Domain.JudgeCriteriaValue (trim_criteria cs)))
        }
      | _ -> parameters
  in
  let g = {g with parameters = parameters} in
  List.fold_left
    (fun current side ->
      PolicyBase.set_records current side
        (List.map
          (fun record ->
            let name =
              match record.Domain.case_name with
              | None -> None
              | Some s ->
                let s = Native.trim s in
                if s = "" then None else Some s
            in
            let values =
              List.fold_left
                (fun vs p ->
                  match Parameters.get_case_value vs p with
                  | None -> vs
                  | Some v -> Parameters.set_case_value vs (normalize_value v))
                record.values trim_kinds
            in
            let values =
              if g.judging && PolicyBase.source_axis g Domain.PJudgeCriteria = Some side then
                match values.judge_criteria_value with
                | None -> values
                | Some cs -> {values with judge_criteria_value = Some (trim_criteria cs)}
              else values
            in
            {record with case_name = name; values = values})
          (PolicyBase.records current side)))
    g PolicyBase.sides

let applicable (g: Domain.layout) (p: Domain.parameter) : Tot bool =
  PolicyBase.member p [Domain.PInput; Domain.PModel; Domain.PVariable] ||
  (if g.output_format = Domain.Image then PolicyBase.member p PolicyBase.image_kinds
   else p = Domain.PEffort) ||
  (g.judging &&
   PolicyBase.member p
     [Domain.PJudgeModel; Domain.PJudgeEffort; Domain.PJudgeCriteria; Domain.PJudgeSystem])

let axis_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  PolicyBase.flatmap
    (fun side ->
      if PolicyBase.records g side <> [] then []
      else
        if not (Parameters.is_case_axis g side) &&
          (PolicyBase.source_axis g Domain.PModel = Some side ||
           PolicyBase.source_axis g Domain.PJudgeModel = Some side) then
          [deferred_issue "Select at least one model" [Domain.Property (PolicyBase.axis_key side)]]
        else
          [PolicyBase.issue "Too small: expected array to have >=1 items"
            [Domain.Property (PolicyBase.axis_key side)]])
    PolicyBase.sides

let parameter_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  (if g.judging && g.output_format = Domain.Html then
     [PolicyBase.issue "Websites do not support a judge yet." [Domain.Property "judge"]]
   else []) @
  PolicyBase.flatmap
    (fun (p: Domain.parameter) ->
      if p = Domain.PVariable then []
      else
        let kind = Parameters.parameter_key p in
        let path = [Domain.Property "parameters"; Domain.Property kind] in
        match PolicyBase.source g.parameters p with
        | None ->
          if applicable g p then
            [PolicyBase.issue (PolicyBase.cat "Choose a source for " (PolicyBase.cat kind ".")) path]
          else []
        | Some _ ->
          if not (applicable g p) then
            [PolicyBase.issue (PolicyBase.cat kind " is not applicable to this grid.") path]
          else
            PolicyBase.flatmap #(nat & option (Domain.value_for p)) #Domain.validation_issue
              (fun (index, value) ->
                let path = PolicyBase.value_path g p index index in
                match value with
                | None ->
                  [PolicyBase.issue
                    (PolicyBase.cat (PolicyBase.cat "Add " kind)
                      (PolicyBase.cat
                        (PolicyBase.cat " to every " (PolicyBase.source_kind g p)) " case."))
                    path]
                | Some v ->
                  if PolicyBase.member p [Domain.PModel; Domain.PJudgeModel] &&
                    not (PolicyBase.nonempty (PolicyBase.text_value v)) then
                    [PolicyBase.issue
                      (if p = Domain.PModel then "Select a model." else "Select a judge model.")
                      path]
                  else if PolicyBase.member p PolicyBase.image_kinds &&
                    not (PolicyBase.valid_image p (PolicyBase.text_value v)) then
                    [PolicyBase.issue
                      (if p = Domain.PSize then "Use a resolution or a size such as 1536x1024"
                       else "Unknown image setting")
                      path]
                  else [])
              (PolicyBase.values g p))
    PolicyBase.kinds

(* The selected source is the only owner. Reject leftover values on another
   axis rather than treating them as a fallback when the owner is incomplete.
   Judge parameters use the same rule. PRODUCT.md 3.3.1 and 3.8.9. *)
let ownership_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  PolicyBase.flatmap
    (fun side ->
      let owned =
        Parameters.axis_parameters g side @
        (if Parameters.is_case_axis g side then [Domain.PVariable] else [])
      in
      let rec records (rest: list Domain.case_record) (index: nat) (ids: list string)
        : Tot (list Domain.validation_issue) (decreases rest) =
        match rest with
        | [] -> []
        | record :: tail ->
          (if PolicyBase.member record.case_id ids then
             [PolicyBase.issue "Case IDs must be distinct within an axis."
               [Domain.Property (PolicyBase.axis_key side); Domain.Index index; Domain.Property "id"]]
           else []) @
          PolicyBase.flatmap
            (fun p ->
              if PolicyBase.member p owned then []
              else
                [PolicyBase.issue
                  (PolicyBase.cat (Parameters.parameter_key p)
                    (PolicyBase.cat " is not owned by "
                      (PolicyBase.cat (PolicyBase.axis_key side) ".")))
                  [Domain.Property (PolicyBase.axis_key side); Domain.Index index;
                   Domain.Property (Parameters.parameter_key p)]])
            (Parameters.case_parameters record.values) @
          records tail (index + 1) (record.case_id :: ids)
      in
      records (PolicyBase.records g side) 0 [])
    PolicyBase.sides

let first_path_index (path: list Domain.path_segment) : Tot nat =
  match path with
  | Domain.Index i :: _ -> i
  | _ -> 0

let message_text (ms: list Domain.message) (i: nat) : Tot string =
  match PolicyBase.at ms i with
  | None -> ""
  | Some m -> m.content

(* Raw validation catches roles and history shape before variable expansion.
   Defer supplied-message emptiness to the expanded cell checks: an image-only
   variable substitution can make a user message valid. PRODUCT.md 3.3.6. *)
let raw_input_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  PolicyBase.flatmap #(nat & option (Domain.value_for Domain.PInput)) #Domain.validation_issue
    (fun (index, value) ->
      let messages =
        match value with
        | Some (Domain.InputValue ms) -> ms
        | None -> []
      in
      let path = PolicyBase.value_path g Domain.PInput index index in
      (if g.output_format <> Domain.ChatTemplate &&
         (match messages with
          | [m] -> m.message_role <> Domain.UserRole
          | _ -> true) then
         [PolicyBase.issue "Prompt formats require exactly one user message." path]
       else []) @
      List.map (prepend path)
        (List.filter
          (fun item ->
            not (PolicyBase.member (Domain.Property "content") item.Domain.issue_path) ||
            (match PolicyBase.at messages (first_path_index item.issue_path) with
             | Some m -> m.message_role = Domain.UnfilledRole
             | None -> false))
          (chat_issues messages)))
    (PolicyBase.values g Domain.PInput)

let raw_criteria_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  if not g.judging then []
  else
    PolicyBase.flatmap #(nat & option (Domain.value_for Domain.PJudgeCriteria)) #Domain.validation_issue
      (fun (index, criteria) ->
        let cs =
          match criteria with
          | Some (Domain.JudgeCriteriaValue cs) -> cs
          | None -> []
        in
        List.map (prepend (PolicyBase.value_path g Domain.PJudgeCriteria index index))
          (criteria_issues cs))
      (PolicyBase.values g Domain.PJudgeCriteria)

(* Report a bad expanded body at its owning message or question and at the
   referenced fields that contributed to it. Keep the original template for
   this lookup. Inserted field text is literal, not another template.
   PRODUCT.md 3.3.4 and 3.4.2. *)
let expanded_issue (g: Domain.layout) (row: nat) (column: nat) (path: list Domain.path_segment)
  (template: string) (item: Domain.validation_issue) : Tot (list Domain.validation_issue) =
  [prepend path item] @
  (if PolicyBase.member (Domain.Property "content") item.issue_path ||
     PolicyBase.member (Domain.Property "text") item.issue_path then
     List.map
       (fun r -> PolicyBase.issue item.issue_message (PolicyVariables.reference_path r @ [Domain.Property "text"]))
       (PolicyVariables.references template g row column)
   else [])

(* A row-owned history or rubric may read column fields, so validation must
   inspect every intersection. Validate questions after substitution as well
   as messages, preserving each error's owning input path.
   PRODUCT.md 3.3.6 and 3.8.9. *)
let expanded_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  PolicyBase.flatmap
    (fun (row, _) ->
      PolicyBase.flatmap
        (fun (column, _) ->
          let raw = PolicyBase.messages g row column in
          let messages = PolicyVariables.expand_messages g row column in
          let path = PolicyBase.value_path g Domain.PInput row column in
          PolicyBase.flatmap
            (fun item ->
              expanded_issue g row column path
                (message_text raw (first_path_index item.Domain.issue_path)) item)
            (chat_issues messages) @
          (if g.output_format = Domain.Image && not (PolicyBase.nonempty (message_text messages 0)) then
             expanded_issue g row column path (message_text raw 0)
               (PolicyBase.issue "Enter a prompt."
                 (if messages = [] then [] else [Domain.Index 0; Domain.Property "content"]))
           else []) @
          (if not g.judging then []
           else
             let criteria, _ = PolicyVariables.resolve_criteria g row column in
             PolicyBase.flatmap
               (fun item ->
                 let template =
                   match PolicyBase.at (PolicyBase.criteria g row column)
                     (first_path_index item.Domain.issue_path) with
                   | None -> ""
                   | Some c -> c.criterion_text
                 in
                 expanded_issue g row column
                   (PolicyBase.value_path g Domain.PJudgeCriteria row column) template item)
               (criteria_issues criteria)))
        (PolicyBase.indexed g.columns))
    (PolicyBase.indexed g.rows)

let semantic_issues (g: Domain.layout) : Tot (list Domain.validation_issue) =
  PolicyBase.distinct_issues
    (axis_issues g @ parameter_issues g @ Parameters.parameter_layout_issues g @
     ownership_issues g @ raw_input_issues g @
     (if g.rows = [] || g.columns = [] then raw_criteria_issues g else []) @
     PolicyVariables.prompt_issues g @ expanded_issues g)

let budget_value (text: string) : Tot (option Number.finite) =
  let n = Number.parse text in
  if Native.trim text <> "" && Number.is_finite n then Some n else None

(* Image generation ignores the text budget, even if a restored draft kept an
   invalid budget string. Text formats require a finite positive amount here.
   This does not calculate token allowances or parallelism. PRODUCT.md 3.5.1. *)
let budget_issues (g: Domain.layout) (text: string) (budget: option Number.finite)
  : Tot (list Domain.validation_issue) =
  if g.output_format = Domain.Image then []
  else
    match budget with
    | Some n ->
      if Number.lt Number.zero n then []
      else
        [PolicyBase.issue "Too small: expected number to be >0" [Domain.Property "budgetUsd"]]
    | None ->
      let parsed = Number.parse text in
      let received =
        if Native.trim text = "" || Number.is_nan parsed then "NaN"
        else if Number.lt parsed Number.zero then "-Infinity"
        else "Infinity"
      in
      [PolicyBase.issue (PolicyBase.cat "Invalid input: expected number, received " received)
        [Domain.Property "budgetUsd"]]

(* Prepare a normalized submission record and report its issues separately.
   Keep the original layout for editing previews. Neither returned candidate
   permits submission until evaluate has rejected all remaining issues. *)
let admit_input (input: Domain.draft_input)
  : Tot (Domain.layout & option Number.finite & option Domain.admitted_input &
         list Domain.validation_issue) =
  let g = input.draft_layout in
  let budget = budget_value input.budget_text in
  let base_errors = budget_issues g input.budget_text budget in
  let normalized = normalize g in
  let positive_budget : option Number.positive =
    match budget with
    | Some n ->
      if Number.lt Number.zero n then Some n
      (* The admitted record requires a positive budget even for Image.
         Supply that required field without making an invalid text budget
         block Image admission. PRODUCT.md 3.5.1. *)
      else if g.output_format = Domain.Image then Some (Number.small_positive 3)
      else None
    | None ->
      if g.output_format = Domain.Image then Some (Number.small_positive 3) else None
  in
  let issues = if base_errors = [] then semantic_issues normalized else base_errors in
  let admitted =
    match positive_budget with
    | Some n ->
      if normalized.rows <> [] && normalized.columns <> [] then
        Some {Domain.admitted_layout = normalized; budget_usd = n}
      else None
    | None -> None
  in
  (g, budget, admitted, issues)

(* Supply one default record only for compatibility feedback on an unfinished
   dimension. This does not add a case to the draft or make it admissible.
   Completed layouts pass through with their real row-column intersections. *)
let preview (g: Domain.layout) : Tot Domain.layout =
  List.fold_left
    (fun current side ->
      if PolicyBase.records current side <> [] then current
      else
        let values =
          List.fold_left
            (fun vs p -> Parameters.set_case_value vs (Parameters.parameter_default p))
            Parameters.empty_case_values (Parameters.axis_parameters g side)
        in
        PolicyBase.set_records current side
          [{
            Domain.case_id = PolicyBase.cat "compatibility-preview-" (PolicyBase.axis_key side);
            case_name = None;
            values = values
          }])
    g PolicyBase.sides
