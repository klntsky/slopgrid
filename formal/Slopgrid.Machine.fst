module Slopgrid.Machine

module D = Slopgrid.Domain
module Num = Slopgrid.Number
module N = Slopgrid.Native
module L = FStar.List.Tot.Base
module I = Slopgrid.Input
module P = Slopgrid.Parameters
module Policy = Slopgrid.Policy
open Slopgrid.Domain

let request_phase = phase:D.submission_phase{phase <> D.Idle}
noeq type submission = {
  request_id:pos;
  request_phase:request_phase;
  request_input:D.admitted_input;
  source_grid_id:option string;
  reuse_artifacts:bool;
  continue_low_balance:bool
}
type confirmation = { confirmation_id:pos; proposed_draft:D.draft }
noeq type state = {
  draft:D.draft;
  attempted:bool;
  pending_uploads:nat;
  error:string;
  low_balance:option Num.finite;
  active:option submission;
  case_prefix:string;
  next_case:nat;
  next_confirmation:pos;
  next_request:pos;
  pending_confirmation:option confirmation;
  context:D.context
}
noeq type step = { next_state:state; change:D.change; commands:list D.command }

let init (initial:D.initial) (context:D.context) : Tot state = {
  draft=initial.initial_draft; attempted=false; pending_uploads=0; error="";
  low_balance=None; active=None; case_prefix=initial.case_id_prefix;
  next_case=0; next_confirmation=1; next_request=1;
  pending_confirmation=None; context=context
}

let submission_phase (model:state) : Tot D.submission_phase =
  match model.active with | None -> D.Idle | Some request -> request.request_phase

let has_submission (model:state) : Tot bool =
  match model.active with | None -> false | Some _ -> true

let owns (model:state) (id:pos) (expected:request_phase) : Tot bool =
  match model.active with
  | Some request -> request.request_id = id && request.request_phase = expected
  | None -> false

let owns_confirmation (model:state) (id:pos) : Tot bool =
  match model.pending_confirmation with
  | Some proposal -> proposal.confirmation_id = id
  | None -> false

let transition (model:state) (change:D.change) (commands:list D.command) : Tot step =
  {next_state=model; change=change; commands=commands}
let unchanged (model:state) : Tot step = transition model D.NoChange []
let metadata (model:state) (commands:list D.command) : Tot step =
  transition model D.MetadataChanged commands

let draft_for_comparison (draft:D.draft) : Tot D.draft =
  {draft with editable={draft.editable with draft_layout=I.layout_data draft.editable.draft_layout}}
let draft_equal (left:D.draft) (right:D.draft) : Tot bool =
  draft_for_comparison left = draft_for_comparison right

let edit (model:state) (draft:D.draft) (next_case:nat) : Tot step =
  let different = not (draft_equal draft model.draft) in
  let confirming = match model.pending_confirmation with | None -> false | Some _ -> true in
  if not different && not model.attempted && model.error = "" && not confirming
  then unchanged model
  else transition {
    model with draft=(if different then draft else model.draft);
    next_case=next_case; attempted=false; error=""; pending_confirmation=None
  } (if different then D.DraftChanged else D.MetadataChanged)
    (if different then [D.PersistDraft draft] else [])

let input_messages (value:D.value_for D.PInput) : Tot (list D.message) =
  match value with | D.InputValue messages -> messages

let axis_entries (layout:D.layout) (axis:D.axis) : Tot (list D.case_record) =
  match axis with | D.Rows -> layout.rows | D.Columns -> layout.columns

let generator_messages (layout:D.layout) : Tot (list D.message) =
  match layout.parameters.input_source with
  | D.Common value -> input_messages value
  | D.OnAxis axis -> L.flatten (L.map (fun entry ->
      match entry.values.input_value with | None -> [] | Some messages -> messages)
      (axis_entries layout axis))

let attachment_images (images:option (list D.reference_image)) : Tot (list D.reference_image) =
  match images with | None -> [] | Some images -> images

let reference_images (layout:D.layout) : Tot (list D.reference_image) =
  let messages = L.flatten (L.map (fun message -> attachment_images message.images)
    (generator_messages layout)) in
  let variables = L.flatten (L.map (fun entry ->
    match entry.values.variable_value with
    | None -> []
    | Some fields -> L.flatten (L.map (fun field ->
      match field with | None -> [] | Some field -> attachment_images field.field_images) fields))
    (L.append layout.rows layout.columns)) in
  L.append messages variables

let contains_reference (layout:D.layout) (id:string) : Tot bool =
  L.existsb (fun image -> image.reference_id = id) (reference_images layout)
let has_local_references (layout:D.layout) : Tot bool =
  L.existsb (fun image -> N.starts_with image.reference_id "local-") (reference_images layout)

let replace_images (images:option (list D.reference_image)) (local_id:string)
  (replacement:D.reference_image) : Tot (option (list D.reference_image)) =
  match images with
  | None -> None
  | Some images -> Some (L.map (fun image ->
      if image.reference_id = local_id then replacement else image) images)

let replace_messages (messages:list D.message) (local_id:string)
  (replacement:D.reference_image) : Tot (list D.message) =
  L.map (fun message -> {message with images=replace_images message.images local_id replacement}) messages

let rec map_cases (f:D.case_record -> Tot D.case_record) (entries:list D.case_record)
  : Tot (result:list D.case_record{
    L.length result = L.length entries /\ (result = [] <==> entries = [])}) =
  match entries with
  | [] -> []
  | entry::rest -> f entry :: map_cases f rest

let replace_case_messages (entry:D.case_record) (local_id:string)
  (replacement:D.reference_image) : Tot D.case_record =
  match entry.values.input_value with
  | None -> entry
  | Some messages -> {entry with values={entry.values with
      input_value=Some (replace_messages messages local_id replacement)}}

let replace_case_variables (entry:D.case_record) (local_id:string)
  (replacement:D.reference_image) : Tot D.case_record =
  match entry.values.variable_value with
  | None -> entry
  | Some fields -> {entry with values={entry.values with variable_value=Some
      (L.map (fun field -> match field with
        | None -> None
        | Some field -> Some {field with field_images=replace_images field.field_images local_id replacement}) fields)}}

let replace_references (layout:D.layout) (local_id:string) (replacement:D.reference_image)
  : Tot (result:D.layout{
    (result.rows = [] <==> layout.rows = []) /\
    (result.columns = [] <==> layout.columns = [])}) =
  let with_input = match layout.parameters.input_source with
    | D.Common value -> {layout with parameters={layout.parameters with
        input_source=D.Common (D.InputValue (replace_messages (input_messages value) local_id replacement))}}
    | D.OnAxis D.Rows -> {layout with rows=map_cases
        (fun entry -> replace_case_messages entry local_id replacement) layout.rows}
    | D.OnAxis D.Columns -> {layout with columns=map_cases
        (fun entry -> replace_case_messages entry local_id replacement) layout.columns} in
  {with_input with
    rows=map_cases (fun entry -> replace_case_variables entry local_id replacement) with_input.rows;
    columns=map_cases (fun entry -> replace_case_variables entry local_id replacement) with_input.columns}

let generate (model:state) (continue_low_balance:bool) : Tot step =
  if has_submission model then unchanged model
  else
    let policy = Policy.evaluate model.draft model.attempted model.pending_uploads
      (submission_phase model) model.context in
    match policy.decision with
    | D.CannotAttempt _ -> unchanged model
    | D.IncompleteSelection ->
      if model.attempted then unchanged model else metadata {model with attempted=true} []
    | D.ReadyToSubmit input ->
      let request = {
        request_id=model.next_request; request_phase=D.Preparing; request_input=input;
        source_grid_id=model.draft.source_grid_id;
        reuse_artifacts=(match model.draft.reuse_artifacts with | None -> true | Some value -> value);
        continue_low_balance=continue_low_balance
      } in
      metadata {model with attempted=true; error=""; active=Some request;
        next_request=model.next_request + 1}
        [D.PrepareReferences request.request_id input]

let references_prepared (model:state) (id:pos) : Tot step =
  if not (owns model id D.Preparing) then unchanged model
  else match model.active with
  | None -> unchanged model
  | Some request ->
    if has_local_references request.request_input.admitted_layout then unchanged model
    else metadata {model with active=Some {request with request_phase=D.Submitting}}
      [D.SubmitGrid request.request_id request.request_input request.source_grid_id
        request.reuse_artifacts request.continue_low_balance]

let submission_succeeded (model:state) (id:pos) (grid_id:string) : Tot step =
  if not (owns model id D.Submitting) then unchanged model
  else match model.active with
  | None -> unchanged model
  | Some request -> metadata {model with low_balance=None;
      active=Some {request with request_phase=D.Completed}}
      [D.CreationCompleted id grid_id]

let submission_failed (model:state) (id:pos) (message:string)
  (balance:option Num.finite) : Tot step =
  match model.active with
  | None -> unchanged model
  | Some request ->
    if request.request_id <> id || request.request_phase = D.Completed then unchanged model
    else match balance with
      | None -> metadata {model with active=None; error=message} []
      | Some balance -> metadata {model with active=None; error=""; low_balance=Some balance} []

let completion_failed (model:state) (id:pos) (message:string) : Tot step =
  if not (owns model id D.Completed) then unchanged model
  else metadata {model with active=None; error=message} []

let confirmation_resolved (model:state) (id:pos) (accepted:bool) : Tot step =
  if not (owns_confirmation model id) then unchanged model
  else match model.pending_confirmation with
  | None -> unchanged model
  | Some proposal ->
    if accepted then edit model proposal.proposed_draft model.next_case
    else metadata {model with pending_confirmation=None} []

let reference_uploaded (model:state) (id:pos) (local_id:string)
  (image:D.reference_image) : Tot step =
  if not (owns model id D.Preparing) then unchanged model
  else match model.active with
  | None -> unchanged model
  | Some request ->
    if not (N.starts_with local_id "local-") || N.starts_with image.reference_id "local-" ||
      not (contains_reference request.request_input.admitted_layout local_id)
    then unchanged model
    else
      let input = {request.request_input with admitted_layout=
        replace_references request.request_input.admitted_layout local_id image} in
      let editable = model.draft.editable in
      let result = if contains_reference editable.draft_layout local_id then
        edit model {model.draft with editable={editable with draft_layout=
          replace_references editable.draft_layout local_id image}} model.next_case
        else unchanged model in
      let next = {result.next_state with active=Some {request with request_input=input}} in
      transition next (if result.change = D.DraftChanged then D.DraftChanged else D.MetadataChanged)
        (L.append result.commands [D.RemoveReferenceFile local_id])

let propose_draft (model:state) (draft:D.draft) (next_case:nat)
  (message:option string) : Tot step =
  match message with
  | None -> edit model draft next_case
  | Some text ->
    let id = model.next_confirmation in
    metadata {model with next_case=next_case; next_confirmation=id + 1;
      pending_confirmation=Some {confirmation_id=id; proposed_draft=draft}}
      [D.Confirm id text]

let edit_input (model:state) (action:D.input_action) : Tot step =
  let before = model.draft.editable.draft_layout in
  let after,counter = I.reduce before action model.case_prefix model.next_case in
  let comparable = {model.draft with editable={model.draft.editable with draft_layout=after}} in
  if draft_equal model.draft comparable then edit model model.draft model.next_case
  else propose_draft model comparable counter (I.confirmation before action)

let select_format (model:state) (format:D.format) : Tot step =
  let draft,counter,dropped = I.select_format model.draft format model.context.catalog
    model.case_prefix model.next_case in
  let message = match dropped with
    | [] -> None
    | _ -> Some (N.concat "Changing format will discard incompatible or differing "
        (N.concat (I.join ", " (L.map P.parameter_name dropped))
          " settings and case values. Differing values that become common will return to their defaults. Continue?")) in
  propose_draft model draft counter message

let update_step (model:state) (event:D.event) : Tot step =
  match event with
  | D.InputAction action -> edit_input model action
  | D.SelectFormat format -> select_format model format
  | D.ClearFormat ->
    let result = edit model {model.draft with format_selected=false} model.next_case in
    {result with commands=L.append result.commands [D.NavigateHome]}
  | D.ChangeBudget value ->
    edit model {model.draft with editable={model.draft.editable with budget_text=value}} model.next_case
  | D.ChangeArtifactReuse value -> edit model {model.draft with reuse_artifacts=Some value} model.next_case
  | D.ObserveProvider provider ->
    if model.context.provider = provider then unchanged model
    else metadata {model with context={model.context with provider=provider}} []
  | D.ReferenceUploaded id local_id image -> reference_uploaded model id local_id image
  | D.UploadStatus busy ->
    let pending = if busy then model.pending_uploads + 1
      else if model.pending_uploads = 0 then 0 else model.pending_uploads - 1 in
    if pending = model.pending_uploads then unchanged model
    else metadata {model with pending_uploads=pending} []
  | D.ConfirmationResolved id accepted -> confirmation_resolved model id accepted
  | D.GenerateRequested continue_low_balance -> generate model continue_low_balance
  | D.ReferencesPrepared id -> references_prepared model id
  | D.SubmissionSucceeded id grid_id -> submission_succeeded model id grid_id
  | D.SubmissionFailed id message balance -> submission_failed model id message balance
  | D.CompletionFailed id message -> completion_failed model id message
  | D.DismissLowBalance ->
    match model.low_balance with | None -> unchanged model
    | Some _ -> metadata {model with low_balance=None} []

let update (model:state) (event:D.event) : Tot (state & D.output) =
  let result = update_step model event in
  result.next_state,{D.change=result.change; D.commands=result.commands}

let view (model:state) : Tot D.view = {
  view_draft=model.draft; attempted=model.attempted; pending_uploads=model.pending_uploads;
  error=model.error; low_balance=model.low_balance; submission_phase=submission_phase model;
  policy=Policy.evaluate model.draft model.attempted model.pending_uploads
    (submission_phase model) model.context
}
