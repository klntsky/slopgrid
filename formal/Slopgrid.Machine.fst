module Slopgrid.Machine

module Domain = Slopgrid.Domain
module Number = Slopgrid.Number
module Native = Slopgrid.Native
module List = FStar.List.Tot.Base
module Input = Slopgrid.Input
module Parameters = Slopgrid.Parameters
module Policy = Slopgrid.Policy
open Slopgrid.Domain

let request_phase = phase: Domain.submission_phase { phase <> Domain.Idle }

noeq type submission = {
  request_id: pos;
  request_phase: request_phase;
  request_input: Domain.admitted_input;
  source_grid_id: option string;
  reuse_artifacts: bool;
  continue_low_balance: bool
}

type confirmation = {
  confirmation_id: pos;
  proposed_draft: Domain.draft
}

noeq type state = {
  draft: Domain.draft;
  attempted: bool;
  pending_uploads: nat;
  error: string;
  low_balance: option Number.finite;
  active: option submission;
  case_prefix: string;
  next_case: nat;
  next_confirmation: pos;
  next_request: pos;
  pending_confirmation: option confirmation;
  context: Domain.context
}

noeq type step = {
  next_state: state;
  change: Domain.change;
  commands: list Domain.command
}

let init (initial: Domain.initial) (context: Domain.context) : Tot state = {
  draft = initial.initial_draft;
  attempted = false;
  pending_uploads = 0;
  error = "";
  low_balance = None;
  active = None;
  case_prefix = initial.case_id_prefix;
  next_case = 0;
  next_confirmation = 1;
  next_request = 1;
  pending_confirmation = None;
  context = context
}

let submission_phase (model: state) : Tot Domain.submission_phase =
  match model.active with
  | None -> Domain.Idle
  | Some request -> request.request_phase

let has_submission (model: state) : Tot bool =
  match model.active with
  | None -> false
  | Some _ -> true

let owns (model: state) (id: pos) (expected: request_phase) : Tot bool =
  match model.active with
  | Some request -> request.request_id = id && request.request_phase = expected
  | None -> false

let owns_confirmation (model: state) (id: pos) : Tot bool =
  match model.pending_confirmation with
  | Some proposal -> proposal.confirmation_id = id
  | None -> false

let transition (model: state) (change: Domain.change) (commands: list Domain.command)
  : Tot step =
  { next_state = model; change = change; commands = commands }

let unchanged (model: state) : Tot step =
  transition model Domain.NoChange []

let metadata (model: state) (commands: list Domain.command) : Tot step =
  transition model Domain.MetadataChanged commands

let draft_for_comparison (draft: Domain.draft) : Tot Domain.draft =
  {
    draft with
    editable = {
      draft.editable with
      draft_layout = Input.layout_data draft.editable.draft_layout
    }
  }

let draft_equal (left: Domain.draft) (right: Domain.draft) : Tot bool =
  draft_for_comparison left = draft_for_comparison right

let edit (model: state) (draft: Domain.draft) (next_case: nat) : Tot step =
  let different = not (draft_equal draft model.draft) in
  let confirming =
    match model.pending_confirmation with
    | None -> false
    | Some _ -> true
  in
  if not different && not model.attempted && model.error = "" && not confirming
  then unchanged model
  else
    transition
      {
        model with
        draft = (if different then draft else model.draft);
        next_case = next_case;
        attempted = false;
        error = "";
        pending_confirmation = None
      }
      (if different then Domain.DraftChanged else Domain.MetadataChanged)
      (if different then [Domain.PersistDraft draft] else [])

let input_messages (value: Domain.value_for Domain.PInput) : Tot (list Domain.message) =
  match value with
  | Domain.InputValue messages -> messages

let axis_entries (layout: Domain.layout) (axis: Domain.axis) : Tot (list Domain.case_record) =
  match axis with
  | Domain.Rows -> layout.rows
  | Domain.Columns -> layout.columns

let generator_messages (layout: Domain.layout) : Tot (list Domain.message) =
  match layout.parameters.input_source with
  | Domain.Common value -> input_messages value
  | Domain.OnAxis axis ->
    List.flatten
      (List.map
        (fun entry ->
          match entry.values.input_value with
          | None -> []
          | Some messages -> messages)
        (axis_entries layout axis))

let attachment_images (images: option (list Domain.reference_image))
  : Tot (list Domain.reference_image) =
  match images with
  | None -> []
  | Some images -> images

let reference_images (layout: Domain.layout) : Tot (list Domain.reference_image) =
  let messages =
    List.flatten
      (List.map
        (fun message -> attachment_images message.images)
        (generator_messages layout))
  in
  let variables =
    List.flatten
      (List.map
        (fun entry ->
          match entry.values.variable_value with
          | None -> []
          | Some fields ->
            List.flatten
              (List.map
                (fun field ->
                  match field with
                  | None -> []
                  | Some field -> attachment_images field.field_images)
                fields))
        (List.append layout.rows layout.columns))
  in
  List.append messages variables

let contains_reference (layout: Domain.layout) (id: string) : Tot bool =
  List.existsb (fun image -> image.reference_id = id) (reference_images layout)

let has_local_references (layout: Domain.layout) : Tot bool =
  List.existsb
    (fun image -> Native.starts_with image.reference_id "local-")
    (reference_images layout)

let replace_images
  (images: option (list Domain.reference_image))
  (local_id: string)
  (replacement: Domain.reference_image)
  : Tot (option (list Domain.reference_image)) =
  match images with
  | None -> None
  | Some images ->
    Some
      (List.map
        (fun image -> if image.reference_id = local_id then replacement else image)
        images)

let replace_messages
  (messages: list Domain.message)
  (local_id: string)
  (replacement: Domain.reference_image)
  : Tot (list Domain.message) =
  List.map
    (fun message ->
      { message with images = replace_images message.images local_id replacement })
    messages

let rec map_cases (f: Domain.case_record -> Tot Domain.case_record)
  (entries: list Domain.case_record)
  : Tot (result: list Domain.case_record {
      List.length result = List.length entries /\ (result = [] <==> entries = [])
    }) =
  match entries with
  | [] -> []
  | entry :: rest -> f entry :: map_cases f rest

let replace_case_messages (entry: Domain.case_record) (local_id: string)
  (replacement: Domain.reference_image) : Tot Domain.case_record =
  match entry.values.input_value with
  | None -> entry
  | Some messages ->
    {
      entry with
      values = {
        entry.values with
        input_value = Some (replace_messages messages local_id replacement)
      }
    }

let replace_case_variables (entry: Domain.case_record) (local_id: string)
  (replacement: Domain.reference_image) : Tot Domain.case_record =
  match entry.values.variable_value with
  | None -> entry
  | Some fields ->
    {
      entry with
      values = {
        entry.values with
        variable_value = Some
          (List.map
            (fun field ->
              match field with
              | None -> None
              | Some field ->
                Some {
                  field with
                  field_images = replace_images field.field_images local_id replacement
                })
            fields)
      }
    }

let replace_references (layout: Domain.layout) (local_id: string)
  (replacement: Domain.reference_image)
  : Tot (result: Domain.layout {
      (result.rows = [] <==> layout.rows = []) /\
      (result.columns = [] <==> layout.columns = [])
    }) =
  let with_input =
    match layout.parameters.input_source with
    | Domain.Common value ->
      {
        layout with
        parameters = {
          layout.parameters with
          input_source = Domain.Common
            (Domain.InputValue (replace_messages (input_messages value) local_id replacement))
        }
      }
    | Domain.OnAxis Domain.Rows ->
      {
        layout with
        rows = map_cases
          (fun entry -> replace_case_messages entry local_id replacement)
          layout.rows
      }
    | Domain.OnAxis Domain.Columns ->
      {
        layout with
        columns = map_cases
          (fun entry -> replace_case_messages entry local_id replacement)
          layout.columns
      }
  in
  {
    with_input with
    rows = map_cases
      (fun entry -> replace_case_variables entry local_id replacement)
      with_input.rows;
    columns = map_cases
      (fun entry -> replace_case_variables entry local_id replacement)
      with_input.columns
  }

let generate (model: state) (continue_low_balance: bool) : Tot step =
  if has_submission model
  then unchanged model
  else
    let policy = Policy.evaluate model.draft model.attempted model.pending_uploads
      (submission_phase model) model.context
    in
    match policy.decision with
    | Domain.CannotAttempt _ -> unchanged model
    | Domain.IncompleteSelection ->
      if model.attempted then unchanged model else metadata { model with attempted = true } []
    | Domain.ReadyToSubmit input ->
      let request = {
        request_id = model.next_request;
        request_phase = Domain.Preparing;
        request_input = input;
        source_grid_id = model.draft.source_grid_id;
        reuse_artifacts =
          (match model.draft.reuse_artifacts with
           | None -> true
           | Some value -> value);
        continue_low_balance = continue_low_balance
      } in
      metadata
        {
          model with
          attempted = true;
          error = "";
          active = Some request;
          next_request = model.next_request + 1
        }
        [Domain.PrepareReferences request.request_id input]

let references_prepared (model: state) (id: pos) : Tot step =
  if not (owns model id Domain.Preparing)
  then unchanged model
  else
    match model.active with
    | None -> unchanged model
    | Some request ->
      if has_local_references request.request_input.admitted_layout
      then unchanged model
      else
        metadata
          { model with active = Some { request with request_phase = Domain.Submitting } }
          [Domain.SubmitGrid request.request_id request.request_input request.source_grid_id
            request.reuse_artifacts request.continue_low_balance]

let submission_succeeded (model: state) (id: pos) (grid_id: string) : Tot step =
  if not (owns model id Domain.Submitting)
  then unchanged model
  else
    match model.active with
    | None -> unchanged model
    | Some request ->
      metadata
        {
          model with
          low_balance = None;
          active = Some { request with request_phase = Domain.Completed }
        }
        [Domain.CreationCompleted id grid_id]

let submission_failed (model: state) (id: pos) (message: string)
  (balance: option Number.finite) : Tot step =
  match model.active with
  | None -> unchanged model
  | Some request ->
    if request.request_id <> id || request.request_phase = Domain.Completed
    then unchanged model
    else
      match balance with
      | None -> metadata { model with active = None; error = message } []
      | Some balance -> metadata { model with active = None; error = ""; low_balance = Some balance } []

let completion_failed (model: state) (id: pos) (message: string) : Tot step =
  if not (owns model id Domain.Completed)
  then unchanged model
  else metadata { model with active = None; error = message } []

let confirmation_resolved (model: state) (id: pos) (accepted: bool) : Tot step =
  if not (owns_confirmation model id)
  then unchanged model
  else
    match model.pending_confirmation with
    | None -> unchanged model
    | Some proposal ->
      if accepted
      then edit model proposal.proposed_draft model.next_case
      else metadata { model with pending_confirmation = None } []

let reference_uploaded (model: state) (id: pos) (local_id: string)
  (image: Domain.reference_image) : Tot step =
  if not (owns model id Domain.Preparing)
  then unchanged model
  else
    match model.active with
    | None -> unchanged model
    | Some request ->
      if not (Native.starts_with local_id "local-") ||
        Native.starts_with image.reference_id "local-" ||
        not (contains_reference request.request_input.admitted_layout local_id)
      then unchanged model
      else
        let input = {
          request.request_input with
          admitted_layout = replace_references request.request_input.admitted_layout local_id image
        } in
        let editable = model.draft.editable in
        let result =
          if contains_reference editable.draft_layout local_id
          then edit model
            {
              model.draft with
              editable = {
                editable with
                draft_layout = replace_references editable.draft_layout local_id image
              }
            }
            model.next_case
          else unchanged model
        in
        let next = { result.next_state with active = Some { request with request_input = input } } in
        transition next
          (if result.change = Domain.DraftChanged then Domain.DraftChanged else Domain.MetadataChanged)
          (List.append result.commands [Domain.RemoveReferenceFile local_id])

let propose_draft (model: state) (draft: Domain.draft) (next_case: nat)
  (message: option string) : Tot step =
  match message with
  | None -> edit model draft next_case
  | Some text ->
    let id = model.next_confirmation in
    metadata
      {
        model with
        next_case = next_case;
        next_confirmation = id + 1;
        pending_confirmation = Some { confirmation_id = id; proposed_draft = draft }
      }
      [Domain.Confirm id text]

let edit_input (model: state) (action: Domain.input_action) : Tot step =
  let before = model.draft.editable.draft_layout in
  let after, counter = Input.reduce before action model.case_prefix model.next_case in
  let comparable = {
    model.draft with
    editable = { model.draft.editable with draft_layout = after }
  } in
  if draft_equal model.draft comparable
  then edit model model.draft model.next_case
  else propose_draft model comparable counter (Input.confirmation before action)

let select_format (model: state) (format: Domain.format) : Tot step =
  let draft, counter, dropped = Input.select_format model.draft format model.context.catalog
    model.case_prefix model.next_case
  in
  let message =
    match dropped with
    | [] -> None
    | _ ->
      Some (Native.concat "Changing format will discard incompatible or differing "
        (Native.concat (Input.join ", " (List.map Parameters.parameter_name dropped))
          " settings and case values. Differing values that become common will return to their defaults. Continue?"))
  in
  propose_draft model draft counter message

let update_step (model: state) (event: Domain.event) : Tot step =
  match event with
  | Domain.InputAction action -> edit_input model action
  | Domain.SelectFormat format -> select_format model format
  | Domain.ClearFormat ->
    let result = edit model { model.draft with format_selected = false } model.next_case in
    { result with commands = List.append result.commands [Domain.NavigateHome] }
  | Domain.ChangeBudget value ->
    edit model
      { model.draft with editable = { model.draft.editable with budget_text = value } }
      model.next_case
  | Domain.ChangeArtifactReuse value ->
    edit model { model.draft with reuse_artifacts = Some value } model.next_case
  | Domain.ObserveProvider provider ->
    if model.context.provider = provider
    then unchanged model
    else metadata { model with context = { model.context with provider = provider } } []
  | Domain.ReferenceUploaded id local_id image -> reference_uploaded model id local_id image
  | Domain.UploadStatus busy ->
    let pending =
      if busy then model.pending_uploads + 1
      else if model.pending_uploads = 0 then 0
      else model.pending_uploads - 1
    in
    if pending = model.pending_uploads
    then unchanged model
    else metadata { model with pending_uploads = pending } []
  | Domain.ConfirmationResolved id accepted -> confirmation_resolved model id accepted
  | Domain.GenerateRequested continue_low_balance -> generate model continue_low_balance
  | Domain.ReferencesPrepared id -> references_prepared model id
  | Domain.SubmissionSucceeded id grid_id -> submission_succeeded model id grid_id
  | Domain.SubmissionFailed id message balance -> submission_failed model id message balance
  | Domain.CompletionFailed id message -> completion_failed model id message
  | Domain.DismissLowBalance ->
    match model.low_balance with
    | None -> unchanged model
    | Some _ -> metadata { model with low_balance = None } []

let update (model: state) (event: Domain.event) : Tot (state & Domain.output) =
  let result = update_step model event in
  result.next_state, { Domain.change = result.change; Domain.commands = result.commands }

let view (model: state) : Tot Domain.view = {
  view_draft = model.draft;
  attempted = model.attempted;
  pending_uploads = model.pending_uploads;
  error = model.error;
  low_balance = model.low_balance;
  submission_phase = submission_phase model;
  policy = Policy.evaluate model.draft model.attempted model.pending_uploads
    (submission_phase model) model.context
}
